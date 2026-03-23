from flask import Flask, render_template, jsonify, request
import requests
import anthropic
import json
import re
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import os
from dotenv import load_dotenv

load_dotenv()

# ── Sport team → league lookup (built once at startup) ──────────────────────
# Priority (last writer wins for ambiguous names):
#   MLB → NHL → NCAA → NFL → NBA → Soccer
# Longer names ("trail blazers", "paris saint-germain") are checked before
# shorter ones so partial matches don't fire prematurely.
_TEAM_LEAGUE: dict = {}

for _t in [  # MLB
    "angels", "astros", "athletics", "blue jays", "braves", "brewers", "cubs",
    "diamondbacks", "dodgers", "guardians", "mariners", "marlins", "mets",
    "nationals", "orioles", "padres", "phillies", "pirates", "rays", "red sox",
    "rockies", "royals", "reds", "tigers", "twins", "white sox", "yankees",
]:
    _TEAM_LEAGUE[_t] = "MLB"

for _t in [  # NHL
    "avalanche", "blackhawks", "blue jackets", "blues", "bruins", "canadiens",
    "canucks", "capitals", "coyotes", "devils", "ducks", "flyers", "flames",
    "golden knights", "hurricanes", "islanders", "kraken", "lightning",
    "maple leafs", "oilers", "penguins", "predators", "rangers", "red wings",
    "sabres", "senators", "sharks", "stars", "wild",
]:
    _TEAM_LEAGUE[_t] = "NHL"

for _t in [  # NCAA college teams
    "alabama", "arkansas", "auburn", "baylor", "connecticut", "creighton",
    "duke", "florida", "gonzaga", "houston", "illinois", "iowa", "kansas",
    "kentucky", "marquette", "maryland", "michigan", "michigan state",
    "missouri", "notre dame", "ohio state", "oklahoma", "oregon", "purdue",
    "st johns", "tennessee", "texas", "tulsa", "uconn", "utah", "vanderbilt",
    "virginia", "wisconsin", "xavier",
]:
    _TEAM_LEAGUE[_t] = "NCAA"

for _t in [  # NFL
    "49ers", "bears", "bengals", "bills", "broncos", "browns", "buccaneers",
    "bucs", "cardinals", "chargers", "chiefs", "colts", "commanders", "cowboys",
    "dolphins", "eagles", "falcons", "giants", "jaguars", "jets", "lions",
    "packers", "panthers", "patriots", "raiders", "rams", "ravens", "saints",
    "seahawks", "steelers", "texans", "titans", "vikings",
]:
    _TEAM_LEAGUE[_t] = "NFL"

for _t in [  # NBA
    "76ers", "sixers", "blazers", "bucks", "bulls", "cavaliers", "cavs",
    "celtics", "clippers", "grizzlies", "hawks", "heat", "hornets", "jazz",
    "kings", "knicks", "lakers", "magic", "mavericks", "mavs", "nets",
    "nuggets", "pacers", "pelicans", "pistons", "raptors", "rockets", "spurs",
    "suns", "thunder", "timberwolves", "trail blazers", "warriors", "wizards",
    "wolves",
]:
    _TEAM_LEAGUE[_t] = "NBA"

for _t in [  # Soccer — European football (highest priority, overwrites conflicts)
    # Multi-word first (also ensures length-sort prefers them)
    "paris saint-germain", "manchester united", "manchester city",
    "atletico madrid", "inter milan", "aston villa", "west ham",
    "man united", "man city", "real madrid", "psg",
    # Single-word
    "arsenal", "atletico", "ajax", "barcelona", "benfica", "brighton",
    "celtic", "chelsea", "dortmund", "fiorentina", "juventus",
    "lazio", "liverpool", "milan", "napoli", "newcastle",
    "porto", "roma", "sevilla", "tottenham", "valencia",
]:
    _TEAM_LEAGUE[_t] = "Soccer"

# Sort by descending length so multi-word names are tried first
_TEAM_NAMES_SORTED: list = sorted(_TEAM_LEAGUE, key=len, reverse=True)

# Keywords that signal an NBA betting market (used for "spurs" disambiguation)
_NBA_BET_CTX: set = {"nba", "spread", "o/u", "over/under", "pts", "quarter", "halftime"}
# Keywords that signal a European soccer market
_SOCCER_CTX: set = {
    "premier league", "epl", "champions league", "fa cup", "ucl",
    "europa league", "ligue 1", "la liga", "serie a", "bundesliga",
    "eredivisie", "primeira liga", "scottish", "carabao",
}


def _team_league(title_lower: str) -> str | None:
    """Return the league name if any known team is found in the title, else None.

    Handles context-sensitive disambiguation:
    • "spurs"  → NBA (default) or Soccer (Tottenham) based on surrounding keywords.
    """
    # ── Disambiguation: "spurs" ───────────────────────────────────────────
    if re.search(r'\bspurs\b', title_lower):
        if any(kw in title_lower for kw in _SOCCER_CTX):
            return "Soccer"
        return "NBA"   # default: San Antonio Spurs

    # ── General team lookup (longest names first) ─────────────────────────
    for team in _TEAM_NAMES_SORTED:
        if team == "spurs":
            continue   # already handled above
        if re.search(r'\b' + re.escape(team) + r'\b', title_lower):
            return _TEAM_LEAGUE[team]
    return None
# ────────────────────────────────────────────────────────────────────────────

app = Flask(__name__)

POLYMARKET_API = "https://data-api.polymarket.com"
POLYMARKET_TOOLS_API = "https://activity.polymarket-tools.com"
CLOB_API = "https://clob.polymarket.com"

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))


def fetch_all_trades(wallet: str) -> tuple:
    """Fetch complete trade+redeem history.
    Primary: activity.polymarket-tools.com (no offset cap, full history).
    Fallback: data-api.polymarket.com (hard cap at 3500 records).
    Returns (trades, redeems, source) where source is 'polymarket-tools' or 'data-api'.
    """
    # ── Primary: polymarket-tools — full history, no cap ──
    try:
        resp = requests.post(
            f"{POLYMARKET_TOOLS_API}/api/activity",
            json={
                "wallets": [wallet],
                "filters": {
                    "types": ["TRADE", "REDEEM"],
                    "timeRange": "ALL_TIME",
                    "sortDirection": "DESC",
                },
            },
            headers={"Content-Type": "application/json"},
            timeout=90,
        )
        if resp.status_code == 200:
            data = resp.json()
            activity = data.get("activity", [])
            trades  = [r for r in activity if r.get("type") == "TRADE"]
            redeems = [r for r in activity if r.get("type") == "REDEEM"]
            if trades or redeems:
                tools_pnl = data.get("totalPnl")
                return trades, redeems, "polymarket-tools", tools_pnl
    except Exception:
        pass

    # ── Fallback: data-api.polymarket.com (hard cap: offset 3000 = max 3500 records) ──
    all_trades = []
    all_redeems = []
    offset = 0
    limit = 500
    for _ in range(7):
        resp = requests.get(
            f"{POLYMARKET_API}/activity",
            params={"user": wallet, "limit": limit, "offset": offset},
            timeout=15,
        )
        if resp.status_code != 200:
            break
        batch = resp.json()
        if isinstance(batch, dict):
            batch = batch.get("data", [])
        if not batch:
            break
        for r in batch:
            if r.get("type") == "TRADE":
                all_trades.append(r)
            elif r.get("type") == "REDEEM":
                all_redeems.append(r)
        if len(batch) < limit:
            break
        offset += limit
    return all_trades, all_redeems, "data-api", None


def fetch_positions(wallet: str) -> list:
    url = f"{POLYMARKET_API}/positions"
    resp = requests.get(url, params={"user": wallet, "limit": 500}, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, list) else data.get("data", [])


# Module-level cache: conditionId -> CLOB market data (persists across requests)
_market_resolution_cache: dict = {}


def _fetch_clob_market(condition_id: str):
    """Fetch one market from the CLOB API. Returns (conditionId, data_or_None)."""
    try:
        resp = requests.get(f"{CLOB_API}/markets/{condition_id}", timeout=10)
        if resp.status_code == 200:
            return condition_id, resp.json()
    except Exception:
        pass
    return condition_id, None


def fetch_resolution_batch(condition_ids: list) -> dict:
    """Fetch CLOB market data for multiple conditionIds in parallel, caching results."""
    to_fetch = [cid for cid in condition_ids if cid not in _market_resolution_cache]
    if to_fetch:
        with ThreadPoolExecutor(max_workers=10) as executor:
            for cid, data in executor.map(_fetch_clob_market, to_fetch):
                _market_resolution_cache[cid] = data
    return {cid: _market_resolution_cache.get(cid) for cid in condition_ids}


def get_resolution_price(clob_data: dict, user_asset: str) -> float | None:
    """Return the resolution price (1.0 win / 0.0 loss) for the user's token.
    Returns None if the market is not yet closed or data is unavailable."""
    if not clob_data or not clob_data.get("closed"):
        return None
    for token in clob_data.get("tokens", []):
        if token.get("token_id") == user_asset:
            return float(token.get("price", 0))
    return None


def _usdc(record: dict) -> float:
    """Return actual USDC value of a trade/redeem record.
    usdcSize is the on-chain amount; fall back to size*price if missing."""
    usdc = record.get("usdcSize")
    if usdc is not None:
        try:
            return float(usdc)
        except (ValueError, TypeError):
            pass
    return float(record.get("size", 0)) * float(record.get("price", 0))


def reconstruct_closed_positions(all_trades: list, all_redeems: list, open_positions: list) -> list:
    """Build closed-position records using TRADE + REDEEM activity.

    P&L formula:
      cost     = sum(usdcSize of BUY trades)
      proceeds = sum(usdcSize of SELL trades) + sum(usdcSize of REDEEM records)

    CLOB resolution is only used as fallback for markets that have remaining
    shares but zero REDEEM records (edge case: position not yet redeemed).
    """
    open_ids = {p.get("conditionId") for p in open_positions}

    by_market_trades: dict = defaultdict(list)
    for trade in all_trades:
        cid = trade.get("conditionId")
        if cid and cid not in open_ids:
            by_market_trades[cid].append(trade)

    by_market_redeems: dict = defaultdict(list)
    for redeem in all_redeems:
        cid = redeem.get("conditionId")
        if cid and cid not in open_ids:
            by_market_redeems[cid].append(redeem)

    market_stats: dict = {}
    needs_clob: list = []   # only markets with remaining AND no redeems

    for cid, trades in by_market_trades.items():
        buys  = [t for t in trades if t.get("side") == "BUY"]
        sells = [t for t in trades if t.get("side") == "SELL"]

        if not buys:
            continue

        total_cost     = sum(_usdc(t) for t in buys)
        total_sell_usdc = sum(_usdc(t) for t in sells)
        shares_bought  = sum(float(t.get("size", 0)) for t in buys)
        shares_sold    = sum(float(t.get("size", 0)) for t in sells)
        remaining      = shares_bought - shares_sold

        if total_cost == 0:
            continue

        redeems    = by_market_redeems.get(cid, [])
        redeem_usdc = sum(_usdc(r) for r in redeems)
        has_redeems = len(redeems) > 0

        last_trade = max(trades, key=lambda t: t.get("timestamp", 0))
        user_asset = next((t.get("asset") for t in buys if t.get("asset")), None)

        market_stats[cid] = {
            "total_cost":      total_cost,
            "total_sell_usdc": total_sell_usdc,
            "redeem_usdc":     redeem_usdc,
            "has_redeems":     has_redeems,
            "shares_bought":   shares_bought,
            "remaining":       remaining,
            "last_trade":      last_trade,
            "user_asset":      user_asset,
        }

        # Only hit CLOB for markets with remaining shares AND no redeem data
        if remaining > 0.5 and not has_redeems:
            needs_clob.append(cid)

    # Fetch CLOB only for the small subset that actually needs it
    resolution_map = fetch_resolution_batch(needs_clob) if needs_clob else {}

    closed = []
    for cid, s in market_stats.items():
        total_cost      = s["total_cost"]
        total_proceeds  = s["total_sell_usdc"] + s["redeem_usdc"]
        remaining       = s["remaining"]
        last_trade      = s["last_trade"]

        if remaining > 0.5 and not s["has_redeems"]:
            # No redeem data: use CLOB resolution price as fallback
            res_price = get_resolution_price(resolution_map.get(cid), s["user_asset"])
            if res_price is not None:
                total_proceeds += remaining * res_price
            # If CLOB also unavailable: proceeds stay at sell_usdc only (partial data)

        avg_price   = total_cost / s["shares_bought"] if s["shares_bought"] > 0 else 0
        realized_pnl = total_proceeds - total_cost
        roi_pct     = round((realized_pnl / total_cost * 100), 2) if total_cost > 0 else 0

        closed.append({
            "conditionId":   cid,
            "title":         last_trade.get("title", "Unknown Market"),
            "outcome":       last_trade.get("outcome", ""),
            "size":          round(s["shares_bought"], 2),
            "avgPrice":      round(avg_price, 6),
            "initialValue":  round(total_cost, 4),
            "currentValue":  round(total_proceeds, 4),
            "cashPnl":       round(realized_pnl, 4),
            "endDate":       "",
            "closed":        True,
            "winner":        None,
            "lastTradeDate": last_trade.get("timestamp", 0),
            "roiPct":        roi_pct,
        })

    return closed


def fetch_market_info(condition_id: str):
    try:
        url = f"{CLOB_API}/markets/{condition_id}"
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            return resp.json()
    except Exception:
        pass
    return {}


def group_by_theme(positions, trades):
    """Group positions and trades by market/event theme using keyword clustering."""
    groups = defaultdict(lambda: {"markets": {}, "trades": [], "keywords": set()})

    # Process positions
    for pos in positions:
        market_id = f"{pos.get('conditionId', pos.get('market', 'unknown'))}_{pos.get('outcome', '')}"
        title = pos.get("title", pos.get("market", "Unknown Market"))
        theme = extract_theme(title)
        groups[theme]["markets"][market_id] = {
            "title": title,
            "outcome": pos.get("outcome", ""),
            "size": float(pos.get("size", 0)),
            "avgPrice": float(pos.get("avgPrice", pos.get("curPrice", 0))),
            "currentValue": float(pos.get("currentValue", 0)),
            "initialValue": float(pos.get("initialValue", 0)),
            "profit": float(pos.get("cashPnl", 0)),
            "endDate": pos.get("endDate", ""),
            "closed": bool(pos.get("closed")) or bool(pos.get("redeemed")) or pos.get("winner") is not None,
            "winner": pos.get("winner", None),
            "conditionId": pos.get("conditionId", pos.get("market", "unknown")),
            "lastTradeDate": pos.get("lastTradeDate", 0),
            "roiPct": pos.get("roiPct", 0),
        }
        groups[theme]["keywords"].update(title.lower().split())

    # Attach trades to groups
    for trade in trades:
        title = trade.get("title", trade.get("market", ""))
        theme = extract_theme(title)
        if theme in groups:
            groups[theme]["trades"].append(trade)

    return dict(groups)


def extract_theme(title: str) -> str:
    """Keyword + team-name based theme extractor.

    Step 1 — team-name lookup: scan title for any known NBA/NFL/NHL/MLB team
             name and return its league immediately, regardless of title format.
             This handles 'Spread: Pistons (-4.5)', 'Clippers O/U 224.5', etc.
    Step 2 — league/topic keyword matching for everything else.
    Step 3 — generic fallback (first 2 significant words).
    """
    title_lower = title.lower()

    # ── Step 0: explicit betting-line pattern (overrides team-name lookup) ────
    # "Spread: Knicks (-4.5)", "O/U 2.5: Atletico vs River", "Over 224.5: ..."
    if re.search(r'\b(spread|o/u|over/under)\b', title_lower) and re.search(r'\d', title_lower):
        # Honour known sport leagues even for betting lines
        league = _team_league(title_lower)
        if league:
            return league
        return "Sports (Apuestas)"

    # ── Step 1: team-name lookup ──────────────────────────────────────────────
    league = _team_league(title_lower)
    if league:
        return league

    # ── Step 2: keyword matching ──────────────────────────────────────────────
    keyword_themes = {
        "Esports":           ["counter-strike", "cs2", "csgo", "dota 2", "dota2",
                              "valorant", "rocket league", "overwatch", "fortnite",
                              "league of legends", "lol:", "esports", "esport", "starcraft"],
        "Bitcoin & Crypto":  ["bitcoin", "btc", "ethereum", "eth", "crypto", "solana",
                              "sol", "bnb", "xrp", "doge", "fdv", "satoshi", "zcash",
                              "defi", "nft", "airdrop", "memecoin"],
        "Coleccionables":    ["pokemon", "psa 10", "card sale", "wagner", "illustrator"],
        "Entretenimiento":   ["bruno mars", "taylor swift", "grammy", "oscar", "billboard"],
        "Middle East Conflict": ["iran", "iranian", "israel", "israeli", "gaza", "hamas",
                                 "hezbollah", "lebanon", "lebanese", "irgc", "idf",
                                 "west bank", "ceasefire", "hostage", "sinwar", "netanyahu"],
        "Russia-Ukraine":    ["russia", "ukraine", "putin", "zelensky", "nato", "kyiv", "moscow"],
        "US Politics":       ["trump", "biden", "harris", "republican", "democrat",
                              "election", "congress", "senate", "president"],
        "AI & Tech":         ["openai", "gpt", "claude", "llm", "ai model", "chatgpt",
                              "google", "microsoft", "apple", "nvidia", "semiconductor",
                              "earnings call", "tesla", "meta"],
        # League-level keywords catch titles without a specific team name
        "NBA":               ["nba", "basketball"],
        "NFL":               ["nfl", "super bowl", "touchdown", "nfc", "afc", "quarterback"],
        "NHL":               ["nhl", "hockey", "stanley cup"],
        "MLB":               ["mlb", "baseball", "world series", "home run"],
        "NCAA":              ["ncaa", "march madness", "college basketball", "college football",
                              "cfp", "bowl game", "sec championship", "big ten", "acc tournament",
                              "pac-12", "big 12", "ncaa tournament", "final four",
                              "college world series"],
        "Soccer":            ["premier league", "champions league", "europa league", "fa cup",
                              "bundesliga", "la liga", "serie a", "ligue 1", "eredivisie",
                              "carabao cup", "epl", "ucl", "fifa", "world cup", "mls"],
        # Boxeo BEFORE MMA so "boxing fight" / "boxing bout" hits "boxing" first
        "Boxeo":             ["boxing", "wbc", "wba", "ibf", "wbo",
                              "featherweight", "welterweight", "middleweight",
                              "title fight", "championship bout", "prizefighter"],
        "MMA & UFC":         ["ufc", "mma", "octagon", "bellator", "one championship",
                              "submission", "fight night", "rear-naked",
                              "knockout", "ko", "tko", "fight", "bout", "heavyweight bout",
                              "heavyweight fight"],
        "Sports":            ["formula 1", "f1", "grand prix",
                              "tennis", "wimbledon", "us open", "french open", "australian open",
                              "golf", "masters", "pga", "nascar", "olympics"],
        "Economy & Markets": ["fed", "interest rate", "inflation", "recession", "gdp",
                              "unemployment", "stock", "nasdaq", "dow"],
        "China & Taiwan":    ["china", "taiwan", "xi jinping", "beijing", "taiwan strait"],
    }

    # Short tickers/abbreviations that need word-boundary matching to avoid
    # substring collisions (e.g. "eth" inside "method", "dow" inside "sundowns")
    _WORD_MATCH = {"eth", "sol", "bnb", "xrp", "fed", "gdp", "dow", "nft", "lol:", "ko", "tko"}

    for theme, keywords in keyword_themes.items():
        for kw in keywords:
            if kw in _WORD_MATCH:
                if re.search(r'\b' + re.escape(kw) + r'\b', title_lower):
                    return theme
            elif kw in title_lower:
                return theme

    # ── Step 3: pattern-based fallback (never use title words as category name) ─
    # Match / game titles with soccer-style context
    _SOCCER_MATCH_CTX = {
        "premier league", "liga", "serie a", "bundesliga", "ligue", "mls",
        "copa", "cup", "fc", "united", "city", "atletico", "sporting",
        "dynamo", "inter", "real", "club", "deportivo",
    }
    if re.search(r'\bvs\.?\b|\bvs\b', title_lower):
        if any(kw in title_lower for kw in _SOCCER_MATCH_CTX):
            return "Soccer"
        return "Sports"

    # Any remaining title that looks sport-adjacent
    if any(kw in title_lower for kw in ["win", "draw", "beat", "match", "game",
                                          "season", "championship", "tournament",
                                          "playoff", "final", "score", "goal",
                                          "league", "cup", "series"]):
        return "Sports"

    return "Other"


def analyze_strategy_with_claude(theme: str, markets: dict, trades: list) -> str:
    """Use Claude to analyze the trading strategy for a theme group."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return "⚠️ Set ANTHROPIC_API_KEY to enable AI analysis."

    # ── 1. Pre-calculate per-market payouts ──
    # Each Polymarket share pays $1 on resolution.
    #   win_pnl  = shares × (1 − avg_price)   [net profit if position resolves in its favour]
    #   loss_pnl = −(shares × avg_price)       [net loss if position resolves against it]
    market_rows = []
    for i, m in enumerate(markets.values()):
        shares    = float(m["size"])
        avg_price = float(m["avgPrice"])
        outcome   = m.get("outcome", "YES")
        title     = m.get("title", "")
        win_pnl   = round(shares * (1 - avg_price), 2)
        loss_pnl  = round(-(shares * avg_price), 2)
        market_rows.append({
            "idx": i,
            "title": title, "outcome": outcome,
            "shares": round(shares, 2), "avg_price": round(avg_price, 4),
            "invested": round(m.get("initialValue") or shares * avg_price, 2),
            "current_value": round(float(m.get("currentValue", 0)), 2),
            "win_pnl": win_pnl, "loss_pnl": loss_pnl,
        })

    # ── 2. Ask Claude for correlated scenario analysis + strategy label ──
    markets_for_prompt = [
        {"idx": r["idx"], "title": r["title"], "outcome": r["outcome"],
         "win_pnl": r["win_pnl"], "loss_pnl": r["loss_pnl"]}
        for r in market_rows
    ]
    prompt = f"""Eres un analista experto de Polymarket. Responde en español.

TEMA: "{theme}"
POSICIONES (idx = índice para referenciar):
{json.dumps(markets_for_prompt, ensure_ascii=False, indent=2)}

Estas posiciones pueden estar correlacionadas: mismo evento subyacente con distintas fechas límite u outcomes opuestos.
Identifica los 2-3 escenarios reales más relevantes. NO incluyas el escenario imposible "todas ganan" ni "todas pierden" si las posiciones están correlacionadas.
Para cada escenario indica qué mercados (por idx) ganan y cuáles pierden según su posición.

Responde ÚNICAMENTE con este JSON (sin markdown, sin texto extra):
{{
  "strategy": "3-5 palabras clasificando la estrategia",
  "edge": "una frase sobre la ventaja real",
  "scenarios": [
    {{
      "name": "nombre corto del escenario",
      "description": "qué ocurre en este escenario",
      "wins": [lista de idx que ganan],
      "losses": [lista de idx que pierden]
    }}
  ]
}}"""

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=600,
        messages=[{"role": "user", "content": prompt}]
    )
    raw = message.content[0].text.strip()

    # ── 3. Parse JSON and compute net P&L per scenario in Python ──
    try:
        data = json.loads(raw)
        strategy_line = f"Estrategia: {data['strategy']}"
        edge_line     = f"Edge: {data['edge']}"

        scenario_lines = ["ESCENARIOS:"]
        for sc in data["scenarios"]:
            net_pnl = (sum(market_rows[i]["win_pnl"]  for i in sc["wins"])
                     + sum(market_rows[i]["loss_pnl"] for i in sc["losses"]))
            net_pnl = round(net_pnl, 2)
            sign = "+" if net_pnl >= 0 else ""
            scenario_lines.append(f'\n📌 {sc["name"]}')
            scenario_lines.append(f'   {sc["description"]}')
            for i in sc["wins"]:
                r = market_rows[i]
                scenario_lines.append(f'   ✅ {r["title"]} [{r["outcome"]}]: +${r["win_pnl"]:,.2f}')
            for i in sc["losses"]:
                r = market_rows[i]
                scenario_lines.append(f'   ❌ {r["title"]} [{r["outcome"]}]: ${r["loss_pnl"]:,.2f}')
            scenario_lines.append(f'   → P&L neto: {sign}${net_pnl:,.2f}')

        scenario_block = "\n".join(scenario_lines)
        return f"{strategy_line}\n{edge_line}\n\n{scenario_block}"

    except (json.JSONDecodeError, KeyError, IndexError):
        # ── Fallback: simple per-market table if JSON parse fails ──
        scenario_lines = ["ESCENARIOS:"]
        for r in market_rows:
            outcome    = r["outcome"].upper()
            win_event  = "el evento SÍ ocurre" if outcome != "NO" else "el evento NO ocurre"
            lose_event = "el evento NO ocurre" if outcome != "NO" else "el evento SÍ ocurre"
            scenario_lines.append(f'\n- "{r["title"]}" [{outcome}]')
            scenario_lines.append(f'  Si {win_event}:  GANA  +${r["win_pnl"]:,.2f}')
            scenario_lines.append(f'  Si {lose_event}: PIERDE ${r["loss_pnl"]:,.2f}')
        return f"{raw}\n\n" + "\n".join(scenario_lines)


def compute_roi(markets: dict, active: bool = False) -> dict:
    total_invested = 0
    total_current = 0
    total_pnl = 0

    for m in markets.values():
        invested = m["initialValue"] if m["initialValue"] else (m["size"] * m["avgPrice"])
        total_invested += invested
        total_current += m["currentValue"]
        if active:
            # Unrealized P&L: current market value minus what was paid
            total_pnl += m["currentValue"] - invested
        else:
            # Realized P&L: already computed from trades/redeems
            total_pnl += m["profit"]

    roi_pct = ((total_pnl / total_invested) * 100) if total_invested > 0 else 0

    return {
        "totalInvested": round(total_invested, 2),
        "totalCurrent": round(total_current, 2),
        "totalPnL": round(total_pnl, 2),
        "roiPercent": round(roi_pct, 2),
    }


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/analyze", methods=["POST"])
def analyze():
    data = request.json
    wallet = data.get("wallet", "").strip().lower()

    if not wallet:
        return jsonify({"error": "Wallet address required"}), 400

    try:
        all_trades, all_redeems, data_source, tools_pnl = fetch_all_trades(wallet)
        open_positions = fetch_positions(wallet)
        closed_positions = reconstruct_closed_positions(all_trades, all_redeems, open_positions)
        all_positions = open_positions + closed_positions

        if not all_positions and not all_trades:
            return jsonify({"error": "No data found for this wallet. Make sure it's a valid Polymarket address."}), 404

        groups = group_by_theme(all_positions, all_trades)

        result = {
            "wallet": wallet,
            "totalPositions": len(all_positions),
            "totalTrades": len(all_trades),
            "dataSource": data_source,
            "polymarketToolsPnl": tools_pnl,
            "themes": []
        }

        active_count = 0
        closed_count = 0

        for theme, group_data in groups.items():
            markets = group_data["markets"]
            theme_trades = group_data["trades"]

            active_markets = {k: v for k, v in markets.items() if not v["closed"]}
            closed_markets = {k: v for k, v in markets.items() if v["closed"]}

            active_count += len(active_markets)
            closed_count += len(closed_markets)

            active_roi = compute_roi(active_markets, active=True)
            closed_roi = compute_roi(closed_markets, active=False)

            theme_obj = {
                "theme": theme,
                "activeMarkets": list(active_markets.values()),
                "closedMarkets": list(closed_markets.values()),
                "tradeCount": len(theme_trades),
                "roi": active_roi,       # kept for backwards compat
                "activeRoi": active_roi,
                "closedRoi": closed_roi,
                "analysis": None,
                "trades": [
                    {
                        "side": t.get("side"),
                        "price": round(float(t.get("price", 0)), 4),
                        "size": round(float(t.get("size", 0)), 2),
                        "timestamp": t.get("timestamp", 0),
                        "title": t.get("title", ""),
                        "outcome": t.get("outcome", ""),
                    }
                    for t in sorted(theme_trades, key=lambda x: x.get("timestamp", 0))[:150]
                ],
            }
            result["themes"].append(theme_obj)

        result["activePositions"] = active_count
        result["closedPositions"] = closed_count

        # Sort by number of markets (most activity first)
        result["themes"].sort(key=lambda x: len(x["activeMarkets"]) + len(x["closedMarkets"]), reverse=True)

        return jsonify(result)

    except requests.HTTPError as e:
        return jsonify({"error": f"Polymarket API error: {e.response.status_code}"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/analyze-theme", methods=["POST"])
def analyze_theme():
    """On-demand AI analysis for a specific theme."""
    data = request.json
    theme = data.get("theme")
    markets = data.get("markets", {})
    trades = data.get("trades", [])

    if not theme or not markets:
        return jsonify({"error": "Theme and markets required"}), 400

    # Convert markets list to dict if needed
    if isinstance(markets, list):
        markets = {m.get("conditionId", i): m for i, m in enumerate(markets)}

    try:
        analysis = analyze_strategy_with_claude(theme, markets, trades)
        return jsonify({"analysis": analysis})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/price-history", methods=["GET"])
def price_history():
    """Fetch price history for a market outcome."""
    condition_id = request.args.get("conditionId")
    if not condition_id:
        return jsonify({"error": "conditionId required"}), 400

    try:
        url = f"{CLOB_API}/prices-history"
        params = {"market": condition_id, "interval": "1d", "fidelity": 10}
        resp = requests.get(url, params=params, timeout=10)
        if resp.status_code == 200:
            return jsonify(resp.json())
        return jsonify({"history": []})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
