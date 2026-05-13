# Current System Reference

Describes the bot **as it stands after the 2026-04-19 bug-fix + structural
refactor commits**. For the rebuild blueprint see `REBUILD-SPEC.md`.

---

## 1. Architecture

```
1-second polling loop (src/index.js)
  ├─ every 2 min   → runAutoRedeem (redeemer.js)
  ├─ every 30 s    → fetchUsdcBalance → syncBankroll
  ├─ every cycle   → checkCycleFloor / checkWithdrawal
  ├─ every cycle   → fetchKlines + fetchChainlinkBtcUsd + fetchPolymarketSnapshot
  ├─ every 10 s    → checkTakeProfit
  ├─ every cycle   → TA pipeline → decideEntry
  ├─ on ENTER      → executeTrade → recordOpenPosition
  └─ every cycle   → appendCsvRow (signals) + logCounterfactual
```

**Data sources used in each cycle:**

| Source | Used for | Latency model |
|---|---|---|
| Binance REST (`/klines`) | 240 × 1m candles for all TA | ~200 ms |
| Binance WS | Spot price for display only | streaming |
| Chainlink (Polymarket WS → Chainlink WS → HTTP fallback) | Settlement-truth price anchor for TA scoring | ~100 ms |
| Polymarket Gamma API | Auto-select live market, outcome prices | ~300 ms |
| Polymarket CLOB | Best-ask prices + order-book summaries | ~300 ms |

---

## 2. Signal pipeline

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
calibrateModelProbabilities(adjustedUp)            [signal-validation.js]
  Platt logistic: a=1.5, calibratedUp = σ(6 × (adjustedUp − 0.5))
  TUNABLE — refit `a` once 500+ labeled trades collected
  → { probModelUp, probModelDown }
  │
  ▼
computeEdge({ modelUp, modelDown, marketYes, marketNo })   [edge.js]
  marketUp  = priceUP  / (priceUP + priceDOWN)   [vig-normalized]
  rawEdge   = probModel − marketSide
  netEdge   = rawEdge − (TAKER_FEE_BPS/10000 + slippage) / (1 − tokenPrice)
  TUNABLE — costAsProb formula is an approximation
  → { marketUp, marketDown, rawEdge, netEdge }
```

### Score table (maximum upside signals)

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

**Max possible:** upScore=11, downScore=1 → rawUp ≈ 0.917

### Basis tracking (Improvement 5)

Every cycle: `basis = binanceClose − chainlinkPrice`. Rolling 30-candle
stddev is computed. If `stddev > 25`, `vwapMargin = 0.5 × stddev` is added
to the VWAP comparison threshold before counting as a +2 signal.
This prevents noisy basis from triggering false VWAP signals.

---

## 3. Risk management

### Entry gate sequence (`decideEntry`, risk-management.js)

| # | Condition | Block reason |
|---|---|---|
| 1 | Any probability is null | `missing_probabilities` |
| 2 | `cycleEnded` (bankroll < floor) | `cycle_ended` |
| 3 | Bankroll ≥ SESSION_CEILING | `bankroll_X_at_or_above_ceiling_25` |
| 4 | `paused` (losing streak ≥ 5) | `paused_losing_streak_5` |
| 5 | Open positions ≥ MAX_POSITIONS | `max_positions_1_reached` |
| 6 | Market slug already has open position | `position_already_open_for_market_X` |
| 7 | `probModel < MIN_PROB` | `prob_model_X_below_0.56` |
| 8 | `probMarket < MIN_MARKET_PROB` | `prob_market_X_below_0.56` |
| 9 | `netEdge < MIN_NET_EDGE` or `rawEdge > MAX_EDGE` | `net_edge_X_out_of_range_0.05_0.5` |
| 10.5 | minViableStake > maxStakeNow (price too high) | `price_X_requires_Y_above_max_stake_Z` |
| 10 | Computed stake < MIN_TRADE_SIZE | `stake_X_below_min_1.0` |
| 11 | Would exceed 100% bankroll exposure | `exposure_X_exceeds_Y_100pct` |

### Stake sizing

```
maxStake = min(bankroll × 5%, $10.00)

stakeBase = max(bankroll × 12%, $1.00)   [bankroll < $50]
stakeBase = max(bankroll × 15%, $1.00)   [bankroll ≥ $50]

edgeMultiplier (on netEdge):
  < MIN_NET_EDGE → 0 (no trade)
  < 0.06         → 0.4
  < 0.09         → 0.6
  < 0.12         → 0.8
  ≥ 0.12         → 1.0

stake = stakeBase × edgeMultiplier
stake = stake × 0.5   [if losingStreak ≥ 3]
stake = max(stake, minViableStake, MIN_TRADE_SIZE)
stake = min(stake, maxStake)
```

### Session-level guardrails

| Rule | Threshold | Effect |
|---|---|---|
| Cycle floor | bankroll < $15 | `cycleEnded=true`, no entries |
| Session ceiling | bankroll ≥ $25 | no entries |
| Losing streak half-stake | streak ≥ 3 | stake × 0.5 |
| Losing streak pause | streak ≥ 5 | `paused=true`, no entries |
| Withdrawal (Monaco Rule) | bankroll ≥ $150 | transfer $100, reset bankroll to $50 |

---

## 4. Position lifecycle

### Opening

`executeTrade → recordOpenPosition` stores: tokenId, marketSlug, side,
stakeUsed, entryPrice, shareSize, probModel, probMarket, edge (netEdge),
rawEdge, tradeId.

### Take-profit (every 10 s, take-profit.js)

Dynamic threshold replaces fixed 50% gain:

```
threshold = max(
  entryPrice × 1.15,          // never sell for <15% gain  [TUNABLE]
  probModel + 0.10,            // market 10¢ above model conviction [TUNABLE]
  1.0 − (remainingMin / 15) × 0.15  // rises from 0.85 → 1.0 as t → 0 [TUNABLE]
)

Sell when currentMidPrice ≥ threshold AND remainingMinutes ≥ 1
```

**Soft stop-loss**: sell if `currentMidPrice ≤ entryPrice × 0.40` AND
`remainingMinutes ≥ 5` (free capital when deeply underwater with time left).

**Hold window**: final 1 minute — let settlement pay $1.00.

### Settlement / redeem (every 2 min, redeemer.js)

Queries `data-api.polymarket.com/positions`. `curPrice = 1` → WIN → redeem
via CTF contract. `curPrice = 0` → LOSS → recorded, no redeem.

Gnosis Safe redemptions use EIP-712 `execTransaction`. Transaction errors
(`already known`, `GS026`, gapped nonce) are on-chain management issues
and do not affect new bets.

### Outcome recording

WIN → `losingStreak = 0`, `paused = false`
LOSS → `losingStreak += 1`; if ≥ 5 → `paused = true`

---

## 5. Constants table

| Constant | Value | File |
|---|---|---|
| `MIN_PROB` | 0.56 | risk-management.js |
| `MIN_MARKET_PROB` | 0.56 | risk-management.js |
| `MIN_NET_EDGE` | 0.05 | risk-management.js |
| `MAX_EDGE` | 0.50 | risk-management.js |
| `TAKER_FEE_BPS` | 156 | risk-management.js |
| `TRADE_SLIPPAGE_DEFAULT` | 0.01 | risk-management.js |
| `MIN_SHARES` | 5 | risk-management.js |
| `MAX_STAKE_PCT` | 0.05 (5%) | risk-management.js |
| `MAX_STAKE_ABSOLUTE` | $10.00 | risk-management.js |
| `MAX_POSITIONS` | 1 | risk-management.js |
| `MAX_EXPOSURE_PCT` | 1.0 (100%) | risk-management.js |
| `SESSION_CEILING` | $25.00 | risk-management.js |
| `CYCLE_FLOOR` | $15.00 | risk-management.js |
| `WITHDRAWAL_TRIGGER` | $150.00 | risk-management.js |
| `WITHDRAWAL_AMOUNT` | $100.00 | risk-management.js |
| `BANKROLL_RESET_TO` | $50.00 | risk-management.js |
| `MIN_TRADE_SIZE` | $1.00 | risk-management.js |
| Calibration `a` coefficient | 1.5 | signal-validation.js **TUNABLE** |
| TP `minGainFloor` multiplier | 1.15 | take-profit.js **TUNABLE** |
| TP `modelConvictionCap` offset | +0.10 | take-profit.js **TUNABLE** |
| TP `timeDecayFloor` slope | 0.15 | take-profit.js **TUNABLE** |
| TP soft stop-loss factor | 0.40 | take-profit.js **TUNABLE** |
| Basis stddev threshold | $25 | index.js **TUNABLE** |
| VWAP basis margin multiplier | 0.5 | index.js **TUNABLE** |
| `pollIntervalMs` | 1 s | config.js |
| `candleWindowMinutes` | 15 | config.js |
| RSI period | 14 | config.js |
| MACD | 12/26/9 | config.js |
| Klines fetched | 240 × 1m | index.js |

---

## 6. Known limitations and open questions

- **Calibration coefficient is guessed.** `a = 1.5` in the logistic scaler
  was chosen conservatively. It must be refit on 500+ labeled trades.
  The `logs/counterfactual.csv` file accumulates the data needed.

- **TAKER_FEE_BPS = 156 is an upper bound.** Actual fees vary by market and
  volume tier. Lower fees mean the real net edge is better than computed.

- **costAsProb formula is an approximation.** The formula
  `(fee + slippage) / (1 − price)` is a first-order expansion. It
  over-penalises at low prices (< 0.20) and under-penalises at high prices
  (> 0.80). A full EV model would be more accurate but adds complexity.

- **Take-profit thresholds are guessed.** 1.15×, +0.10, and 0.15 slope
  are priors with no backtesting. All marked TUNABLE.

- **No test suite.** No unit or integration tests exist. Pure math functions
  (`scoreDirection`, `calibrate`, `computeEdge`, `decideEntry`) are directly
  testable; see `REBUILD-SPEC.md` for a proposed test plan.

- **Single concurrent position.** `MAX_POSITIONS = 1` caps capital at one
  market. With a 15m settlement cycle, max exposure is ~$10 (at $100 bankroll)
  per 15-minute window.

- **Market maker disadvantage.** Sub-second latency professional market makers
  run 500+ orders per round. We compete only on selectivity (edge ≥ MIN_NET_EDGE
  after fees), not speed.

- **One trade per market per session.** `tradedMarketSlugs` prevents re-entry
  after a loss in the same 15m window. This prevents doubling into losers but
  also prevents a recovery trade if the position was an early exit.
