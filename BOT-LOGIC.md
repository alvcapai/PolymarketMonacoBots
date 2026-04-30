# Bot Logic — Decision Making, Indicators & Guardrails

> **SUPERSEDED** — This document reflects the system as of 2026-04-18.
> After the 2026-04-19 bug-fix + structural refactor, the authoritative
> reference is **[docs/CURRENT-SYSTEM.md](docs/CURRENT-SYSTEM.md)**.
>
> Key changes not reflected below:
> - Calibration: non-monotonic lookup → Platt logistic (Bug 1)
> - Stake sizing: gate #10.5 min-shares check added (Bug 2)
> - Edge: `netEdge = rawEdge − fees − slippage`; `MIN_NET_EDGE = 0.03` (Bug 3)
> - Take-profit: dynamic threshold replaces fixed 50%; stop-loss added (Imp 4)
> - Chainlink used as TA anchor; basis stddev widens VWAP margin (Imp 5)
> - `MAX_STAKE`: dynamic `min(bankroll × 5%, $10)` replaces `$1.00` (Imp 6)
> - Counterfactual CSV logged every cycle for calibration data (Imp 7)

Complete reference for how the BTC-15m and ETH-15m bots evaluate signals, decide to trade, and manage risk.

---

## 1. Architecture overview

The bot runs a **1-second polling loop** (`pollIntervalMs = 1000`). Each tick:

1. Checks for settled positions to redeem (every 2 min)
2. Syncs real USDC balance from the API (cached 30 s)
3. Runs cycle floor / withdrawal checks
4. Fetches market data (Binance klines, Polymarket prices, Chainlink price)
5. Checks take-profit on open positions (every 10 s)
6. Computes TA indicators → scores → calibrated model probabilities
7. Computes edge vs. the market
8. Runs risk checks → decides ENTER or NO_TRADE
9. If ENTER: executes the trade on-chain via Polymarket CLOB
10. Logs to CSV and renders the console dashboard

---

## 2. Data sources

### Price feeds (priority order)

| Source | Used for | Fallback |
|---|---|---|
| Polymarket WS (`wss://ws-live-data.polymarket.com`) | Current asset price (same feed shown on Polymarket UI) | First |
| Chainlink WS (Polygon RPC) | On-chain aggregator price | Second |
| Chainlink HTTP (Polygon RPC) | On-chain aggregator price | Third |
| Binance WS (`BTCUSDT` / `ETHUSDT`) | Spot price for display | Reference only |

The **current price** (Chainlink) is displayed on the dashboard but **not used directly in the entry decision**. The TA engine uses Binance 1m klines.

### Klines (Binance)

- `240 × 1m candles` fetched per cycle
- Used for all TA indicators (Heiken Ashi, RSI, MACD, VWAP)

### Polymarket market data

- Auto-selects the **latest live 15m market** from the series (by `endDate`)
- Fetches CLOB best-ask prices for UP and DOWN tokens
- Fetches order book summaries (bid/ask/spread/liquidity) for each token

---

## 3. Technical indicators

### Heiken Ashi

Computed on all 240 × 1m candles.

```
haClose = (open + high + low + close) / 4
haOpen  = (prevHaOpen + prevHaClose) / 2   [first candle: (open + close) / 2]
haHigh  = max(high, haOpen, haClose)
haLow   = min(low, haOpen, haClose)
```

`countConsecutive` counts how many candles from the end share the same color (green = bullish, red = bearish). Contributes **+1** to UP or DOWN score when ≥ 2 consecutive candles.

### RSI (period 14)

Standard Wilder's RSI on the 1m close series.

- `rsiSlope` = slope of the last 3 RSI values (linear regression)
- Contributes **+2** to UP if RSI > 55 and slope > 0
- Contributes **+2** to DOWN if RSI < 45 and slope < 0

### MACD (12 / 26 / 9)

Standard MACD on 1m closes. The signal used is the **histogram and histogram delta**:

- `expandingGreen` (hist > 0 and histDelta > 0): **+2 UP**
- `expandingRed` (hist < 0 and histDelta < 0): **+2 DOWN**
- `macd line > 0`: **+1 UP** (minor)
- `macd line < 0`: **+1 DOWN** (minor)

### VWAP

Volume-weighted average price computed on all 240 × 1m candles. Used in:

- **Price vs. VWAP**: if close > VWAP → **+2 UP**; if close < VWAP → **+2 DOWN**
- **VWAP slope** (over last 5 min for 15m, 3 min for 5m): positive → **+2 UP**; negative → **+2 DOWN**
- **Failed VWAP reclaim**: if previous candle was above VWAP but current is below → **+3 DOWN** (strong bearish signal)
- **VWAP cross count** (last 20 candles): used for regime detection only (not in scoring)

---

## 4. Probability engine

### Step 1 — Raw direction score (`scoreDirection`)

Each indicator votes with a point weight. The raw UP probability is:

```
rawUp = upScore / (upScore + downScore)
```

Base scores start at `up = 1, down = 1` so the minimum `rawUp` when all signals agree is never 0.

**Maximum possible score (all UP signals):**
- Base: 1 each
- Price > VWAP: +2 UP
- VWAP slope up: +2 UP
- RSI > 55 and rising: +2 UP
- MACD expanding green: +2 UP
- MACD line > 0: +1 UP
- Heiken ≥ 2 green: +1 UP
- → upScore = 11, downScore = 1 → rawUp ≈ 0.917

**Failed VWAP reclaim** (+3 DOWN) is the single strongest bearish signal.

### Step 2 — Time decay (`applyTimeAwareness`)

As the 15-minute candle window approaches settlement, conviction fades toward 50%:

```
timeDecay   = clamp(remainingMinutes / 15, 0, 1)
adjustedUp  = 0.5 + (rawUp - 0.5) × timeDecay
```

- At 15 min left: `adjustedUp = rawUp` (full signal)
- At 7.5 min left: signal is half-attenuated
- At 0 min left: `adjustedUp = 0.5` (neutral)

This means the bot becomes progressively less likely to enter as settlement approaches.

### Step 3 — Empirical calibration (`calibrateModelProbabilities`)

The raw adjusted score is **not used directly**. It is mapped through an empirical lookup table derived from 75 closed 15m trades:

| adjustedUp (winning side raw) | Calibrated output |
|---|---|
| < 0.60 | 0.50 (neutral — treated as no signal) |
| 0.60 – 0.70 | 0.58 |
| 0.70 – 0.80 | 0.55 |
| ≥ 0.80 | 0.42 (overconfident — actively penalised) |

The calibration reflects that **high raw scores historically overfit** — the model is most reliable in the 0.60–0.80 range. Scores ≥ 0.80 are penalised to 0.42, which is below the entry threshold and will always block a trade.

The output is a symmetric pair:
```
probModelUp   = calibrated value (for the winning side)
probModelDown = 1 - probModelUp
```

---

## 5. Edge computation

The edge is model probability minus market-implied probability (normalized):

```
marketUp   = priceUP  / (priceUP + priceDOWN)   [normalized to remove vig]
marketDown = priceDOWN / (priceUP + priceDOWN)

edgeUp   = probModelUp   - marketUp
edgeDown = probModelDown - marketDown
```

The **side** to bet is whichever edge is larger (`edgeUp >= edgeDown` → UP, else DOWN).

---

## 6. Entry decision — full gate sequence

`decideEntry` runs checks in this exact order. The first failing check blocks the trade:

| # | Check | Block reason in log |
|---|---|---|
| 1 | Missing probabilities (any null) | `missing_probabilities` |
| 2 | Cycle ended (bankroll < floor) | `cycle_ended` |
| 3 | Bankroll ≥ session ceiling ($25) | `bankroll_X_at_or_above_ceiling_25` |
| 4 | Bot paused (losing streak ≥ 5) | `paused_losing_streak_5` |
| 5 | Max concurrent positions reached (1) | `max_positions_1_reached` |
| 6 | This market slug already has an open position | `position_already_open_for_market_X` |
| 7 | `probModel < 0.54` | `prob_model_X_below_0.54` |
| 8 | `probMarket < 0.55` | `prob_market_X_below_0.55` |
| 9 | Edge out of range `[0.05, 0.50]` | `edge_X_out_of_range_0.05_0.5` |
| 10 | Computed stake < $1.00 | `stake_X_below_min_1.0` |
| 11 | Total exposure would exceed 100% of bankroll | `exposure_X_exceeds_Y_100pct` |

If all gates pass → `canEnter: true`, reason: `ok`.

### Key thresholds

| Parameter | Value | Meaning |
|---|---|---|
| `MIN_PROB` | 0.54 | Minimum model confidence to enter |
| `MIN_MARKET_PROB` | 0.55 | Minimum market-implied probability for the target side |
| `MIN_EDGE` | 0.05 | Minimum model-vs-market edge |
| `MAX_EDGE` | 0.50 | Maximum edge (avoid obvious mispricings / traps) |
| `MAX_POSITIONS` | 1 | Only one open position at a time |
| `MAX_EXPOSURE_PCT` | 1.0 | Total exposure cannot exceed 100% of bankroll |
| `SESSION_CEILING` | $25 | Bot stops entering if bankroll is at or above this |

### Why `MIN_MARKET_PROB = 0.55`?

This gate ensures the market also prices the outcome as likely — it avoids entering when the model says UP but the crowd only prices it at e.g. 20¢. At very low market prices (e.g. 0.06 for ETH DOWN at 19:00 today), even a good model signal is blocked here.

---

## 7. Stake sizing

```
stakeBase = max(bankroll × 12%, $1.00)   [if bankroll < $50]
stakeBase = max(bankroll × 15%, $1.00)   [if bankroll ≥ $50]

edgeMultiplier:
  edge < 0.05  → 0   (no trade)
  edge < 0.06  → 0.4
  edge < 0.09  → 0.6
  edge < 0.12  → 0.8
  edge ≥ 0.12  → 1.0

stake = stakeBase × edgeMultiplier
stake = stake × 0.5   [if losingStreak ≥ 3]
stake = max(stake, $1.00)
stake = min(stake, $1.00)   ← MAX_STAKE hard cap
```

The `MAX_STAKE = $1.00` hard cap currently overrides all sizing logic — every trade risks exactly $1 regardless of bankroll or edge. The base/multiplier math is computed but then clamped to $1.

**Consequence**: at high SHORT token prices (e.g. 0.27¢ per share), a $1 stake buys ~3.7 shares, which is below the Polymarket minimum of 5 shares — causing the `Size (X) lower than minimum: 5` API rejection seen in today's logs.

---

## 8. Trade execution

### Pre-execution checks (in `index.js` before calling executor)

- Polymarket market must be available (`poly.ok`)
- Market slug must not already appear in `tradedMarketSlugs` (one trade per market per session)
- Token ID must not already be in `tradedTokens` (session-level dedup)
- Token ID must be valid
- Price must be finite and > 0
- Stake must be ≥ `MIN_TRADE_SIZE` ($1.00)
- No other order must be in-flight (`isPlacingOrder`)

### Price with slippage

```
targetPrice = min(round(bestAsk + 0.01, 2), 0.97)
```

A 1% slippage buffer is added to the best ask price to improve fill probability. Hard cap at 0.97 to avoid paying ≥ $1 per share (guaranteed loss).

### Order type

- Always `BUY` (the bot never shorts — it buys the DOWN token to express bearish views)
- Order type: `GTC` (Good Till Cancelled)
- Fee rate: `1000 bps` (10%)
- Share size: `ceil(stake / price × 100) / 100` (rounded up to ensure notional ≥ minimum)

### One trade per market

Once a market slug is traded, it is added to `tradedMarketSlugs`. The bot will not re-enter that market for the rest of the process lifetime (until restart). This prevents doubling into a losing position mid-candle.

---

## 9. Position lifecycle

### Opening

`recordOpenPosition` stores: tokenId, marketSlug, side, stakeUsed, entryPrice, shareSize, probModel, probMarket, edge, tradeId.

### Take-profit (checked every 10 s)

If a position's **current mid-price has risen ≥ 50% above entry price**, and ≥ 2 minutes remain before settlement, the bot sells all shares at market:

```
gain = (currentPrice - entryPrice) / entryPrice
trigger when gain ≥ 0.50
```

In the last 2 minutes, the bot holds — a winning position will settle at $1.00 (full payout), which is better than selling early.

### Settlement / redeem (checked every 2 min)

**`runAutoRedeem`** queries `data-api.polymarket.com/positions` for the wallet. If a position's `curPrice` is exactly `0` or `1`, it is settled:
- `curPrice = 1` → WIN → triggers `redeemPositions` on the Conditional Token Framework contract
- `curPrice = 0` → LOSS → recorded, no redeem needed

For Gnosis Safe wallets (`SIGNATURE_TYPE = 2`): redemption is executed via `execTransaction` on the Safe contract, signed EIP-712. This is the source of the `already known` / `GS026` / `gapped-nonce` redeem errors — these are on-chain transaction management issues and do not affect new bets.

**`reconcileStalePositions`** runs alongside `runAutoRedeem` every 2 min and handles a second failure mode: *ghost positions* from GTC orders that were accepted by the CLOB but never filled. Because the user holds no actual shares on-chain, those positions never appear in `data-api.polymarket.com/positions` and `runAutoRedeem` cannot detect them. Without this reconciliation they would block future trades indefinitely (`max_positions_1_reached`).

For each position in `bankrollState` older than 25 minutes it determines the outcome in two steps:
1. **CLOB midpoint** (`clob.polymarket.com/midpoint?token_id=…`) — returns 0 or 1 for resolved tokens.
2. **Gamma API fallback** (`gamma-api.polymarket.com/markets?slug=…&closed=true`) — parses `clobTokenIds` + `outcomePrices` (JSON strings) to find the winning token.

If neither resolves the outcome the position is left untouched until the next cycle.

### Outcome recording

`recordOutcomeByToken` removes the position, updates `losingStreak`:
- WIN → `losingStreak = 0`
- LOSS → `losingStreak += 1`; if `losingStreak ≥ 5` → `paused = true` (blocks all entries)

---

## 10. Bankroll & cycle management

### Balance sync

Every 30 seconds, the bot fetches the real USDC collateral balance from the Polymarket CLOB API (`/balance-allowance`). `syncBankroll` overwrites the in-memory bankroll with this real figure. This is why the bankroll accurately reflects on-chain state.

### Cycle floor

Checked every loop cycle:

```
floor = $15 (cycle 1 and all subsequent cycles)
if bankroll < floor → cycleEnded = true → all entries blocked
```

If the bankroll recovers above $15 (e.g. after a top-up and balance sync), `cycleEnded` resets to `false` and trading resumes automatically.

### Session ceiling

```
if bankroll ≥ $25 → entries blocked (reason: bankroll_at_or_above_ceiling)
```

Prevents the bot from risking more capital when it's running hot within a session.

### Withdrawal trigger

```
if bankroll ≥ $150:
  transfer $100 USDC → withdrawal address
  reset operational bankroll to $50
  cycleNumber += 1
  losingStreak = 0, paused = false, cycleEnded = false
```

This is the profit-taking / "Monaco Rule": keep $50 working capital, pocket the rest.

### Losing streak pause

| Streak | Effect |
|---|---|
| ≥ 3 losses | Stake halved |
| ≥ 5 losses | `paused = true` — all entries blocked |
| Win | `losingStreak = 0`, `paused = false` |

---

## 11. Why the bots are idle right now (2026-04-18 ~19:00)

Both bots consistently output `prob_model=0.5000` — the neutral/default value.

The calibration table maps any `winSideRaw < 0.60` to 0.50. For that threshold to be reached, the raw score must place ≥ 60% probability on one side. With the current indicator mix (MACD, RSI, VWAP, Heiken all near-neutral), the raw score sits near 0.50, which maps to calibrated 0.50 — below the `MIN_PROB = 0.54` gate, so no entry ever fires.

Additionally, `prob_market` for ETH DOWN is 0.06 — far below `MIN_MARKET_PROB = 0.55` — so even if the model fired, the market gate would block it.

---

## 12. Configuration constants reference

| Constant | Value | File |
|---|---|---|
| `MIN_PROB` | 0.54 | `risk-management.js` |
| `MIN_MARKET_PROB` | 0.55 | `risk-management.js` |
| `MIN_EDGE` | 0.05 | `risk-management.js` |
| `MAX_EDGE` | 0.50 | `risk-management.js` |
| `MAX_STAKE` | $1.00 | `risk-management.js` |
| `MIN_TRADE_SIZE` | $1.00 | `risk-management.js` |
| `MAX_POSITIONS` | 1 | `risk-management.js` |
| `MAX_EXPOSURE_PCT` | 1.0 (100%) | `risk-management.js` |
| `SESSION_CEILING` | $25.00 | `risk-management.js` |
| `CYCLE_FLOOR` | $15.00 | `risk-management.js` |
| `WITHDRAWAL_TRIGGER` | $150.00 | `risk-management.js` |
| `WITHDRAWAL_AMOUNT` | $100.00 | `risk-management.js` |
| `BANKROLL_RESET_TO` | $50.00 | `risk-management.js` |
| `TAKE_PROFIT_THRESHOLD` | 50% gain | `take-profit.js` |
| `TRADE_SLIPPAGE` | 0.01 (1%) | `index.js` (env) |
| `pollIntervalMs` | 1 s | `config.js` |
| `candleWindowMinutes` | 15 min | `config.js` |
| `vwapSlopeLookbackMinutes` | 5 min | `config.js` |
| RSI period | 14 | `config.js` |
| MACD | 12/26/9 | `config.js` |
| Klines fetched | 240 × 1m | `index.js` |
