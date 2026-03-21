from flask import Flask, render_template, jsonify, request
import requests
import anthropic
import json
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import os
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

POLYMARKET_API = "https://data-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))


def fetch_all_trades(wallet: str) -> tuple:
    """Fetch complete activity via /activity, returning (trades, redeems).
    Both are needed: trades for cost/proceeds, redeems for actual payouts on won positions.
    """
    all_trades = []
    all_redeems = []
    offset = 0
    limit = 500
    max_pages = 100  # safety cap: 100 × 500 = 50 000 activity records max
    for _ in range(max_pages):
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
            break          # last page — API exhausted
        offset += limit
    return all_trades, all_redeems


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
    """Simple keyword-based theme extractor."""
    title_lower = title.lower()

    keyword_themes = {
        "Esports": ["counter-strike", "cs2", "csgo", "dota 2", "dota2", "valorant", "rocket league", "overwatch", "fortnite", "league of legends", "lol:", "esports", "esport", "starcraft"],
        "Bitcoin & Crypto": ["bitcoin", "btc", "ethereum", "eth", "crypto", "solana", "sol", "bnb", "xrp", "doge", "fdv", "satoshi", "zcash", "defi", "nft", "airdrop", "memecoin"],
        "Coleccionables": ["pokemon", "psa 10", "card sale", "wagner", "illustrator"],
        "Entretenimiento": ["bruno mars", "taylor swift", "grammy", "oscar", "billboard"],
        "Middle East Conflict": ["iran", "iranian", "israel", "israeli", "gaza", "hamas", "hezbollah", "lebanon", "lebanese", "irgc", "idf", "west bank", "occupied", "ceasefire", "hostage", "sinwar", "netanyahu"],
        "Russia-Ukraine": ["russia", "ukraine", "putin", "zelensky", "nato", "kyiv", "moscow"],
        "US Politics": ["trump", "biden", "harris", "republican", "democrat", "election", "congress", "senate", "president"],
        "AI & Tech": ["openai", "gpt", "claude", "llm", "ai model", "chatgpt", "google", "microsoft", "apple", "nvidia", "semiconductor", "earnings call", "tesla", "meta"],
        "Sports": ["nfl", "nba", "fifa", "world cup", "super bowl", "champions", "championship", "tournament"],
        "Economy & Markets": ["fed", "interest rate", "inflation", "recession", "gdp", "unemployment", "stock", "nasdaq", "dow"],
        "China & Taiwan": ["china", "taiwan", "xi jinping", "beijing", "taiwan strait"],
    }

    for theme, keywords in keyword_themes.items():
        if any(kw in title_lower for kw in keywords):
            return theme

    # Generic fallback: use first 3 significant words
    words = [w for w in title.split() if len(w) > 3][:2]
    return " ".join(words) if words else "Other"


def analyze_strategy_with_claude(theme: str, markets: dict, trades: list) -> str:
    """Use Claude to analyze the trading strategy for a theme group."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return "⚠️ Set ANTHROPIC_API_KEY to enable AI analysis."

    # Build per-market position summary
    markets_summary = []
    for mid, m in markets.items():
        markets_summary.append({
            "title": m["title"],
            "outcome": m["outcome"],
            "avg_entry_price": round(m["avgPrice"], 4),
            "shares": round(m["size"], 2),
            "total_invested": round(m["initialValue"], 2) if m.get("initialValue") else round(m["size"] * m["avgPrice"], 2),
            "current_value": round(m["currentValue"], 2),
            "profit_loss": round(m["profit"], 2),
            "roi_pct": round(m.get("roiPct", 0), 1),
            "closed": m["closed"],
            "end_date": m["endDate"],
        })

    # Build compact trade log grouped by market
    trades_by_market: dict = defaultdict(list)
    for t in trades:
        key = f"{t['title']} [{t['outcome']}]" if t.get("outcome") else t["title"]
        trades_by_market[key].append(t)

    trade_log_lines = []
    for market_key, mtrades in trades_by_market.items():
        trade_log_lines.append(f"\n  {market_key}:")
        for t in mtrades:
            dt = datetime.utcfromtimestamp(t["timestamp"]).strftime("%Y-%m-%d") if t.get("timestamp") else "?"
            trade_log_lines.append(f"    {dt} {t['side']:4s} {t['size']:8.2f} shares @ {t['price']:.4f}")

    trade_log = "\n".join(trade_log_lines) if trade_log_lines else "  (no individual trade data available)"

    prompt = f"""Responde siempre en español.

You are an expert Polymarket analyst reverse-engineering a wallet's trading strategy.

THEME: "{theme}"
TOTAL TRADES: {len(trades)}

━━━ POSITION SUMMARY ━━━
{json.dumps(markets_summary, indent=2)}

━━━ TRADE-BY-TRADE LOG (chronological) ━━━
{trade_log}

━━━ IMPORTANT: HOW POLYMARKET ORDER FILLS WORK ━━━
A single limit order placed by a user can be filled by MANY counterparties in small fragments.
This means you may see dozens or hundreds of consecutive trades at the exact same price (or
within 0.001) in the same market — these all represent ONE strategic decision by the user,
not multiple separate orders, not automation, not scalping. Only consider it a new strategic
decision when the price changes significantly or there is a clear time gap. Do NOT label a
position as "scalping" or "automated" solely because of multiple fills at the same price.

━━━ ANALYSIS TASK ━━━
Write exactly 3 short paragraphs, no titles, no bold, no bullet points. Total: 150 words max.
Use the same language as the market titles.

Paragraph 1: What strategy is this? (directional / accumulation / market-making / hedging / diversified coverage)
Cite ONE concrete piece of evidence — only mention a price or size if it's the only way to make the point.

Paragraph 2: What outcome is this wallet betting on? Is the goal resolution or active trading?

Paragraph 3: One sentence — does this strategy show real edge or not, and why?

No preamble, no summary, no generic observations. Be direct."""

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=300,
        messages=[{"role": "user", "content": prompt}]
    )
    return message.content[0].text


def compute_roi(markets: dict) -> dict:
    total_invested = 0
    total_current = 0
    total_pnl = 0

    for m in markets.values():
        invested = m["initialValue"] if m["initialValue"] else (m["size"] * m["avgPrice"])
        total_invested += invested
        total_current += m["currentValue"]
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
        all_trades, all_redeems = fetch_all_trades(wallet)
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

            roi = compute_roi(markets)

            theme_obj = {
                "theme": theme,
                "activeMarkets": list(active_markets.values()),
                "closedMarkets": list(closed_markets.values()),
                "tradeCount": len(theme_trades),
                "roi": roi,
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
