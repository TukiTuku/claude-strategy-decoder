# ⬡ Strategy Decoder — Polymarket Wallet Intelligence

Analyze any Polymarket wallet: groups positions by theme, AI strategy analysis, price charts, ROI tracking.

## Setup

### 1. Install dependencies
```bash
pip install -r requirements.txt
```

### 2. Set your Anthropic API key
Copy `.env.example` to `.env` and fill in your key:
```bash
copy .env.example .env
```
Edit `.env`:
```
ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Run
```bash
python app.py
```

Open http://localhost:5000

---

## Features

### Phase 1 — Data & Grouping ✅
- Fetches trades + positions from Polymarket API
- Groups by semantic theme (Bitcoin, US Politics, Middle East, AI, Sports, etc.)
- Summary stats: active, closed, trades, themes

### Phase 2 — Charts ✅
- Price evolution chart per position (uses Polymarket CLOB API)
- Mock data fallback if real history unavailable
- Payout scenario calculator

### Phase 3 — AI Analysis ✅
- On-demand strategy analysis per theme group
- Uses Claude Sonnet to identify strategy type, thesis, risk profile
- Analyzes hedge vs directional vs scalp patterns

### Phase 4 — History & ROI ✅
- Toggle between Active / Closed positions
- ROI computed per theme group
- P&L breakdown per market

---

## Stack
- **Backend**: Flask + Python
- **AI**: Anthropic claude-sonnet-4-20250514
- **Data**: data-api.polymarket.com + clob.polymarket.com
- **Charts**: Chart.js 4.4
- **Font**: Space Mono + Syne

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/analyze` | POST | Fetch & group wallet data |
| `/api/analyze-theme` | POST | AI analysis for one theme |
| `/api/price-history` | GET | Price history for a market |
