# Bot Logic — Decision Making, Indicators & Guardrails

> **AUTHORITATIVE REFERENCE** — This document reflects the system as of **2026-05-17**, following the comprehensive Global Application Refactor (Zero-Latency, Risk Override fixes, and Dynamic TP Scaling).

This document serves as the complete reference for how the BTC-15m and ETH-15m bots evaluate signals, decide to trade, and manage risk. It is designed to be the primary source of truth for strategy formulation and profitability analysis.

---

## 1. Architecture Overview

The bot runs a **1-second polling loop** (`pollIntervalMs = 1000`). Each tick:

1. **Every 2 minutes**: Checks for settled positions to redeem (`runAutoRedeem`).
2. **Every 30 seconds**: Syncs real USDC balance from the API (`fetchUsdcBalance`).
3. **Every cycle**:
   - Evaluates capital state (`checkCycleFloor`, `checkWithdrawal`).
   - Fetches TA data (Binance 1m Klines) and pricing data (Chainlink, Polymarket order book).
   - Runs the signal pipeline (Indicators → Scoring → Probability Calibration → Edge Calculation).
   - Consults the risk manager (`decideEntry`).
   - **If approved**: Executes trade instantly (`executeTrade`) without HTTP pre-flight delays.
4. **Every 10 seconds**: Evaluates open positions for Stop-Loss or Take-Profit (`checkTakeProfit`).

### Data Sources
| Source | Used for | Latency Model |
|---|---|---|
| **Binance REST (`/klines`)** | 240 × 1m candles for all Technical Analysis | ~200 ms |
| **Binance WS** | Spot price for display only | streaming |
| **Chainlink (Polymarket WS → HTTP)** | Settlement-truth price anchor for TA scoring | ~100 ms |
| **Polymarket Gamma API** | Auto-select live market, outcome prices | ~300 ms |
| **Polymarket CLOB** | Best-ask prices + order-book summaries | ~300 ms |

---

## 2. Signal Pipeline

The core logic transforms raw market data into a calibrated "Edge" (Expected Value).

```
klines (240 × 1m, Binance)
  │
  ├─ computeVwapSeries  → vwapNow, vwapSlope
  ├─ computeRsi (14)    → rsiNow, rsiSlope (last 3)
  ├─ computeMacd 12/26/9→ hist, histDelta, macd line
  └─ computeHeikenAshi  → color, consecutiveCount
        │
        ▼
scoreDirection(price=chainlinkPrice, vwap, vwapMargin, rsi, macd, heiken, failedVwapReclaim)
  → { upScore, downScore, rawUp }
  │
  ▼
applyTimeAwareness(rawUp, remainingMinutes, 15)
  → adjustedUp  [shrunk toward 0.5 as t → 0]
  │
  ▼
calibrateModelProbabilities(adjustedUp)
  Platt logistic calibration: a=1.5, calibratedUp = σ(6 × (adjustedUp − 0.5))
  → { probModelUp, probModelDown }
  │
  ▼
computeEdge({ modelUp, modelDown, marketYes, marketNo })
  marketUp  = priceUP  / (priceUP + priceDOWN)   [vig-normalized]
  rawEdge   = probModel − marketSide
  netEdge   = rawEdge − (TAKER_FEE_BPS/10000 + slippage) / (1 − tokenPrice)
  → { marketUp, marketDown, rawEdge, netEdge }
```

### Score Table (Maximum Upside Signals)
| Indicator | Condition | Weight |
|---|---|---|
| Price vs VWAP | price > vwap + vwapMargin | +2 UP |
| VWAP slope | slope > 0 | +2 UP |
| RSI | > 55 and rising | +2 UP |
| MACD histogram | expanding green | +2 UP |
| MACD line | > 0 | +1 UP |
| Heiken Ashi | ≥ 2 consecutive green | +1 UP |
| Failed VWAP reclaim | − | +3 DOWN (strongest bearish) |
| Base | − | 1 each |

### Basis Tracking
Every cycle, the bot calculates `basis = binanceClose − chainlinkPrice`. A rolling 30-candle stddev is computed. If `stddev > 25`, a `vwapMargin = 0.5 × stddev` is enforced, preventing noisy basis deviations from triggering false VWAP crossover signals.

---

## 3. Risk Management & Stake Sizing

Risk parameters are strictly enforced to protect capital and prevent liquidation.

### Strict Stake Sizing Rules
The bot wagers a flat percentage of the bankroll per trade, adjusted by consecutive losses and edge strength.

```
MAX_STAKE_PCT = 10% (Strict hard cap, reduced from 15%)

stakeBase = max(bankroll * 15%, $1.00)

edgeMultiplier (on netEdge):
  < MIN_NET_EDGE (0.05) → 0.0 (No trade)
  < 0.06                → 0.4
  < 0.09                → 0.6
  < 0.12                → 0.8
  ≥ 0.12                → 1.0

stake = stakeBase * edgeMultiplier
stake = stake * 0.5   [if basisStdDev > 40]
stake = stake * 0.5   [if losingStreak ≥ 3]
stake = stake * 0.5   [if side win rate over last 10 trades < 40%]

// The bot verifies that the minimum allowed size (5 shares) 
// fits inside the 15% risk cap. If it doesn't, the trade is rejected.
stake = max(stake, minViableStake)
```

### Session-Level Guardrails

| Rule | Threshold | Effect |
|---|---|---|
| **Cycle Floor** | bankroll < $0 | `cycleEnded=true`, no entries |
| **Losing Streak Half-Stake** | streak ≥ 3 | stake × 0.5 |
| **Losing Streak Pause** | streak ≥ 5 | `paused=true`, no entries |
| **Max Positions** | 1 | No concurrent trades allowed |
| **Max Exposure** | 100% | Never risk more than total bankroll |

### Smart Withdrawals (Monaco Rule)
The bot protects accrued profits by sweeping funds back to the user automatically.
- **Trigger**: Free Capital (`bankroll - totalExposure`) ≥ `$150`.
- **Action**: Sweeps `$100` via on-chain USDC transfer.
- **Why Free Capital?**: This prevents withdrawal failures by ensuring locked capital in open trades is ignored.

---

## 4. Position Lifecycle & Dynamic Take-Profit

### Opening
Execution is **Zero-Latency**. `executeTrade` fires immediately upon `decideEntry` approval, without waiting for HTTP allowance syncs. 

### Take-Profit (every 10s)
The bot fetches order book midpoints concurrently (`Promise.all`) to avoid blocking. The exit threshold is highly dynamic, scaling parabolically as time runs out:

```javascript
threshold = max(
  entryPrice * 1.15,           // minGainFloor: Never exit for <15% gain
  probModel + 0.10,            // modelConvictionCap: Market reached our conviction + 10c
  timeDecayFloor               // Parabolic scale from minGainFloor up to $0.99
)
```
*As `remainingMinutes` approaches 0, `timeDecayFloor` forces the bot to demand higher prices (up to 0.99). This allows early scalping at 15% gains, but forces holding for the full $1.00 payout if the settlement is imminent.*

### Stop-Loss & Hard Exit
- **Hard Exit**: If `remainingMinutes * 60 ≤ 90` and `currentPrice < 0.30`, position is dumped at market.
- **Layer A**: Sell if `currentPrice ≤ entryPrice * 0.70` (30% drop) and `remainingMinutes ≥ 10`.
- **Layer B**: Sell if `currentPrice ≤ entryPrice * 0.50` (50% drop) and `remainingMinutes ≥ 3`.
- **Layer C**: Sell if `currentPrice ≤ entryPrice * 0.40` (60% drop) and `remainingMinutes ≥ 1`.

### Settlement
Every 2 minutes, `redeemer.js` queries the Polymarket API.
- WIN (`curPrice = 1`) → Redeem via CTF contract, `losingStreak = 0`.
- LOSS (`curPrice = 0`) → Record loss, `losingStreak += 1`.

---

## 5. Constants & Hyperparameters (Strategy Tuning)

The following constants are ripe for tuning by an external AI or strategy backtester to maximize profitability:

| Constant | Value | File | Description |
|---|---|---|---|
| `MIN_PROB` | 0.62 | risk-management.js | Minimum model probability required. |
| `MIN_MARKET_PROB` | 0.56 | risk-management.js | Minimum market probability required. |
| `MIN_NET_EDGE` | 0.08 | risk-management.js | Minimum required edge after fees/slippage. |
| `MAX_ENTRY_PRICE` | 0.65 | risk-management.js | Maximum allowed best-ask entry price. |
| `TAKER_FEE_BPS` | 156 | risk-management.js | Conservative upper bound fee estimation. |
| `TRADE_SLIPPAGE_DEFAULT` | 0.01 | risk-management.js | 1 cent slippage assumption. |
| `MAX_STAKE_PCT` | 10% | risk-management.js | Risk cap per trade. |
| `WITHDRAWAL_TRIGGER` | $150 | risk-management.js | Required free capital to trigger auto-sweep. |
| `WITHDRAWAL_AMOUNT` | $100 | risk-management.js | Amount swept to cold storage. |
| `minGainFloor` | 1.15 | take-profit.js | Min multiplier for early profit taking (15%). |
| `modelConvictionCap` | +0.10 | take-profit.js | Threshold delta above model prediction. |
| Calibration `a` | 8.8 | signal-validation.js | Sigmoid aggressiveness scalar. |
