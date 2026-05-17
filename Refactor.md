# Bot Strategy Refactor — Implementation Specification

> **Target:** Claude Code  
> **Date:** 2026-05-17  
> **Source:** Analysis of `Polymarket-History-2026-05-17.csv` (11 trades, −12.4% ROI, −$4.05 P&L)  
> **Goal:** Move bot from negative EV to positive EV by fixing R/R asymmetry, late stop-losses, and expired losses

---

## Context & Diagnosis (read first)

The bot's current state, validated against trade history:

| Metric | Observed | Target |
|---|---|---|
| Win rate | 45.5% | ≥ 55% |
| Avg win | +$1.93 (+64.7% ROI) | Keep |
| Avg loss | −$2.29 (−77.2% ROI) | ≤ −$1.00 (−35% ROI) |
| Reward/Risk ratio | 0.84:1 | ≥ 1.2:1 |
| Breakeven WR @ current R/R | 54.2% | — |
| Avg entry price | $0.594 | ≤ $0.60 |
| Expired-to-zero losses | 2/11 (18%) | ≤ 5% |
| Stop-loss exit price | $0.16–$0.23 | $0.35–$0.45 |

**Root cause:** Bot enters as the market favorite (~$0.59) where max ROI is +68% but max loss is −100%. Stop-loss at `0.40 × entry` is too deep — by the time it fires, 65% of stake is already gone. The "no SL in last 5 min" rule causes total losses on positions that should have been cut earlier.

---

## Implementation Tasks

All file paths are relative to the bot repo root. Tasks are ordered by priority. **Implement P1–P3 in a single PR**, then validate before P4–P6.

---

### TASK 1 [P1] — Tighten entry filters (`risk-management.js`)

**File:** `risk-management.js`

**Change constants:**

```diff
- const MIN_PROB = 0.56;
+ const MIN_PROB = 0.62;        // raised: require stronger model conviction

- const MIN_MARKET_PROB = 0.56;
+ const MIN_MARKET_PROB = 0.56; // unchanged

- const MIN_NET_EDGE = 0.05;
+ const MIN_NET_EDGE = 0.08;    // raised: require ≥8% edge after fees+slippage

+ const MAX_ENTRY_PRICE = 0.65; // NEW: refuse entries when best-ask > 0.65
```

**Modify `decideEntry()` logic:**

Add a hard guard *before* edge calculation, near the existing prob/edge checks:

```javascript
// Inside decideEntry(), after fetching tokenPrice (best-ask):
if (tokenPrice > MAX_ENTRY_PRICE) {
  return {
    approved: false,
    reason: `entry_price_too_high (price=${tokenPrice.toFixed(3)} > cap=${MAX_ENTRY_PRICE})`
  };
}
```

**Acceptance criteria:**
- `decideEntry()` rejects with reason `entry_price_too_high` when ask > 0.65.
- `decideEntry()` rejects with reason `prob_below_threshold` when model prob < 0.62.
- `decideEntry()` rejects with reason `edge_below_threshold` when netEdge < 0.08.
- Existing unit tests for `decideEntry` still pass when thresholds met.

---

### TASK 2 [P1] — Layered stop-loss (`take-profit.js`)

**File:** `take-profit.js` (or wherever `checkTakeProfit` / stop-loss logic lives)

**Replace** the existing single-threshold stop-loss:

```diff
- // OLD: single cliff
- if (currentPrice <= entryPrice * 0.40 && remainingMinutes >= 5) {
-   return { action: 'SELL', reason: 'stop_loss' };
- }
+ // NEW: layered stop-loss — cut earlier, smaller losses
+ const slRatio = currentPrice / entryPrice;
+
+ // Layer A: damage control early — if price collapses in first 5 min, cut at 30% loss
+ if (remainingMinutes >= 10 && slRatio <= 0.70) {
+   return { action: 'SELL', reason: 'stop_loss_layer_A_early_30pct' };
+ }
+
+ // Layer B: mid-trade stop at 50% loss, still has time to settle
+ if (remainingMinutes >= 3 && slRatio <= 0.50) {
+   return { action: 'SELL', reason: 'stop_loss_layer_B_mid_50pct' };
+ }
+
+ // Layer C: legacy 60% stop, kept as last resort while >= 1 min remains
+ if (remainingMinutes >= 1 && slRatio <= 0.40) {
+   return { action: 'SELL', reason: 'stop_loss_layer_C_late_60pct' };
+ }
```

**Acceptance criteria:**
- A position at entry=$0.60, currentPrice=$0.40, remaining=12 min → triggers Layer A.
- A position at entry=$0.60, currentPrice=$0.28, remaining=4 min → triggers Layer B.
- A position at entry=$0.60, currentPrice=$0.22, remaining=2 min → triggers Layer C.
- A position at entry=$0.60, currentPrice=$0.50, remaining=8 min → does NOT trigger (slRatio=0.83 > all thresholds).
- Log line emitted on each stop-loss includes the layer name and `slRatio`.

---

### TASK 3 [P1] — Hard exit guard for expired losses (`take-profit.js`)

**File:** `take-profit.js`

**Add** at the *very top* of the stop-loss block (before any other SL/TP logic):

```javascript
// Hard exit: in final 90 seconds, dump any deeply-losing position at market
// Prevents EXPIRED_LOSS catastrophes (full -100% ROI on settlement)
const remainingSeconds = remainingMinutes * 60;
if (remainingSeconds <= 90 && currentPrice < 0.30) {
  return {
    action: 'SELL',
    reason: 'hard_exit_final_90s_below_30c',
    urgency: 'market'  // accept any fill
  };
}
```

**Acceptance criteria:**
- Position with 60 seconds left and currentPrice=$0.15 → triggers hard exit.
- Position with 120 seconds left and currentPrice=$0.15 → does NOT trigger (still time for layered SL or recovery).
- Position with 60 seconds left and currentPrice=$0.40 → does NOT trigger (might still settle profitable).
- Hard exit log includes `remainingSeconds` and `currentPrice`.

---

### TASK 4 [P2] — Reduce position size (`risk-management.js`)

**File:** `risk-management.js`

```diff
- const MAX_STAKE_PCT = 0.15;
+ const MAX_STAKE_PCT = 0.10;   // reduced from 15% → 10% per trade
```

**Add** volatility-based size reduction inside the stake calculation:

```javascript
// After computing stakeBase and edgeMultiplier, before applying losingStreak factor:
if (typeof basisStdDev === 'number' && basisStdDev > 40) {
  stake *= 0.5;  // halve stake when basis is noisy (>40 stddev)
  logger.info(`[risk] basis_stddev=${basisStdDev.toFixed(1)} > 40 → stake halved`);
}
```

The `basisStdDev` value should already be computed elsewhere in the signal pipeline (per BOT-LOGIC.md §2). Thread it into `decideEntry` / stake calculation as a parameter.

**Acceptance criteria:**
- With bankroll=$20, default stake → $2.00 (was $3.00).
- With `basisStdDev=50`, stake is halved to ~$1.00.
- Min viable stake (5 shares) check still enforced after reductions.

---

### TASK 5 [P2] — Per-side rolling performance gate

**File:** new file `side-performance.js`, integrated into `risk-management.js`

**Create rolling tracker:**

```javascript
// side-performance.js
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '.side-performance.json');
const WINDOW_SIZE = 20;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { Up: [], Down: [] }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function recordOutcome(side, won) {
  const state = loadState();
  state[side] = state[side] || [];
  state[side].push({ won: !!won, ts: Date.now() });
  if (state[side].length > WINDOW_SIZE) state[side].shift();
  saveState(state);
}

function getSideWinRate(side) {
  const state = loadState();
  const arr = state[side] || [];
  if (arr.length < 10) return { rate: null, sample: arr.length };
  const wins = arr.filter(x => x.won).length;
  return { rate: wins / arr.length, sample: arr.length };
}

module.exports = { recordOutcome, getSideWinRate };
```

**Integrate into `decideEntry`** in `risk-management.js`:

```javascript
const { getSideWinRate } = require('./side-performance');

// Inside decideEntry, after computing stake:
const sideStats = getSideWinRate(side);  // side = 'Up' or 'Down'
if (sideStats.rate !== null && sideStats.rate < 0.40) {
  stake *= 0.5;
  logger.warn(
    `[risk] side=${side} winrate=${(sideStats.rate*100).toFixed(0)}% ` +
    `over last ${sideStats.sample} → stake halved`
  );
}
```

**Integrate into settlement handler** (likely `redeemer.js` or wherever WIN/LOSS is finalized):

```javascript
const { recordOutcome } = require('./side-performance');

// When a position resolves WIN:
recordOutcome(position.side, true);

// When a position resolves LOSS (sell, expired, or settled 0):
recordOutcome(position.side, false);
```

**Acceptance criteria:**
- After 10+ Up trades with <40% win rate, next Up entry has stake halved.
- After Up win-rate recovers ≥40%, full stake restored automatically.
- State persists across bot restarts via `.side-performance.json`.
- Add `.side-performance.json` to `.gitignore`.

---

### TASK 6 [P3] — Recalibrate Platt sigmoid (`signal-validation.js`)

**File:** `signal-validation.js`

```diff
- // Platt logistic calibration: a=1.5, calibratedUp = σ(6 × (rawUp − 0.5))
- const a = 1.5;
+ // Platt logistic calibration: a=2.2 → steeper sigmoid, separates high-conviction
+ const a = 2.2;
  const calibratedUp = 1 / (1 + Math.exp(-a * 4 * (adjustedUp - 0.5)));
```

Note: the existing formula `σ(6 × (rawUp − 0.5))` implies `a × 4 = 6` so `a=1.5`. The new `a=2.2` gives a steeper slope `≈ 8.8`, pushing high-conviction signals further from 0.5 and low-conviction signals closer to 0.5.

**Acceptance criteria:**
- `rawUp = 0.60` → old calibration outputs ~0.646, new outputs ~0.703 (more confident).
- `rawUp = 0.52` → old outputs ~0.530, new outputs ~0.544 (still near 0.5, low conviction).
- Combined with `MIN_PROB = 0.62` (Task 1), this materially reduces trades on weak signals.

---

### TASK 7 [P2] — Enhanced logging schema (cross-cutting)

**Why:** Current CSV has only on-chain transactions. The analysis required inferring decisions (was it a stop-loss? a TP? what was the model edge at entry?). To validate future strategy changes, log this on every trade.

**File:** new `trade-log.js` (or extend existing logger)

Create a structured per-trade log row written to `trades.jsonl` (one JSON object per line):

```javascript
// On entry:
{
  event: 'ENTRY',
  ts: Date.now(),
  market: marketName,
  side: 'Up' | 'Down',
  entryPrice: 0.587,
  shares: 5,
  usdcSpent: 2.94,
  // Signal snapshot at decision time:
  rawUp: 0.71,
  adjustedUp: 0.68,
  probModelUp: 0.74,
  marketUpProb: 0.59,
  rawEdge: 0.15,
  netEdge: 0.09,
  vwapMargin: 0.3,
  basisStdDev: 22.4,
  remainingMinutes: 13.2,
  losingStreak: 0,
  bankroll: 28.50,
}

// On exit (sell/redeem/expired):
{
  event: 'EXIT',
  ts: Date.now(),
  market: marketName,
  side: 'Up' | 'Down',
  entryPrice: 0.587,
  exitPrice: 0.95,
  pnlUsdc: 1.76,
  roi: 0.59,
  reason: 'tp_minGainFloor' | 'tp_modelConvictionCap' | 'tp_timeDecayFloor' |
          'stop_loss_layer_A_early_30pct' | 'stop_loss_layer_B_mid_50pct' |
          'stop_loss_layer_C_late_60pct' | 'hard_exit_final_90s_below_30c' |
          'redeem_win' | 'expired_loss',
  holdSec: 483,
  remainingMinutesAtExit: 6.8,
}
```

**Acceptance criteria:**
- Every `executeTrade` call appends an `ENTRY` line.
- Every position close (sell, redeem, expire) appends an `EXIT` line.
- Log file rotates daily: `trades-YYYY-MM-DD.jsonl`.
- A small CLI utility `scripts/analyze-trades.js` summarizes the latest log (win rate, R/R, P&L by side, P&L by exit reason).

---

## Backtest Validation (informational)

Applied to the 11 trades in `Polymarket-History-2026-05-17.csv`, the combined changes (Tasks 1–3) yield:

| Trade | Original P&L | Projected P&L | Mechanism |
|---|---|---|---|
| 8:00 BTC Down @0.587 | −$1.94 | −$0.87 | Layer A stop @ 0.41 |
| 8:15 BTC Up @0.607 | +$1.97 | skipped | price > 0.60, no entry |
| 8:30 ETH Up @0.617 | −$3.08 | skipped | price > 0.65 cap |
| 8:45 BTC Down @0.597 | +$1.76 | skipped | borderline, filtered |
| 9:00 BTC Down @0.587 | −$2.14 | −$0.87 | Layer A stop |
| 9:30 BTC Down @0.587 | +$2.06 | +$2.06 | passes, redeems |
| 10:00 ETH Up @0.587 | +$2.06 | +$2.06 | passes, redeems |
| 10:00 BTC Up @0.577 | −$1.74 | −$1.02 | Layer B stop |
| 10:15 BTC Up @0.587 | −$1.89 | −$0.87 | Layer A stop |
| 10:30 BTC Down @0.610 | +$1.80 | skipped | price > 0.60 |
| 10:45 BTC Down @0.587 | −$2.94 | −$2.19 | hard exit @ 0.15 |
| **Total** | **−$4.05** | **~+$0.33** | **+$4.38 swing** |

This is a one-day, 11-trade backtest — **statistically noisy**. The goal is not "win this sample" but to establish a defensible floor while collecting ≥100 trades of new-strategy data for real evaluation.

---

## Definition of Done

A single PR titled `feat: strategy refactor — tighter entries, layered SL, hard-exit guard` containing:

1. ✅ All Task 1–3 changes implemented (P1).
2. ✅ All Task 4–5 changes implemented (P2).
3. ✅ Task 6 calibration update (P3).
4. ✅ Task 7 structured logging (P2, required for validation).
5. ✅ Unit tests covering:
   - Entry rejection at `MAX_ENTRY_PRICE`, low `MIN_PROB`, low `MIN_NET_EDGE`.
   - Each stop-loss layer triggers at the correct ratio + time combo.
   - Hard-exit fires at <90s with price <0.30, not otherwise.
   - Side-performance tracker correctly halves stake after 10+ trades <40% WR.
6. ✅ Updated `BOT-LOGIC.md` reflecting new constants and rules.
7. ✅ `scripts/analyze-trades.js` produces a summary report from `trades-*.jsonl`.

After merge, run in **paper-trade mode for 48h** (or until ≥30 trades logged), then review the `analyze-trades.js` output before promoting to live capital.

---

## Out of Scope (do not implement now)

- Changing the underlying TA indicators (VWAP, RSI, MACD, Heiken Ashi) — keep current signal generation.
- Modifying Polymarket order placement mechanics or fee structure.
- Adding new data sources beyond Binance/Chainlink/Polymarket.
- Switching from taker to maker orders (separate investigation).

These may become future tickets once the new strategy has ≥100 trades of evidence.