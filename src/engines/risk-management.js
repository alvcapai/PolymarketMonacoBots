import { logger } from "../logging/logger.js";
import { getSideWinRate, recordOutcome } from "./side-performance.js";

export const MIN_NET_EDGE = 0.08; // was 0.05
export const MAX_EDGE = 0.50;
const TAKER_FEE_BPS = 156; // conservative upper bound for 15m market taker fee (~1.56%)
export const MIN_PROB = 0.62; // was 0.56
export const MIN_MARKET_PROB = 0.56;
const MAX_STAKE_PCT = 0.10;      // reduced from 15% -> 10% per trade
export const MAX_ENTRY_PRICE = 0.65; // NEW: refuse entries when best-ask > 0.65
const MAX_STAKE_ABSOLUTE = 10.0; // hard cap regardless of bankroll size
export const MAX_POSITIONS = 1;
export const MAX_EXPOSURE_PCT = 1.0;
export const WITHDRAWAL_TRIGGER = 150;
export const WITHDRAWAL_AMOUNT = 100;
export const BANKROLL_RESET_TO = 50;
export const MIN_TRADE_SIZE = 1.0;

const MIN_SHARES = 5;            // Polymarket minimum share size
const BANKROLL_RISK_CAP = 0.15;    // max 15% of bankroll per trade
const TRADE_SLIPPAGE_DEFAULT = 0.01;

const CYCLE_FLOOR = {
  initial: 0,
  recurring: 0
};

function recalcExposure(state) {
  let total = 0;
  for (const pos of state.positions.values()) {
    total += Number(pos.stakeUsed) || 0;
  }
  state.openPositions = state.positions.size;
  state.totalExposure = total;
}

function toFiniteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function createBankrollState(initialBankroll = 20) {
  return {
    bankroll: initialBankroll,
    cycleNumber: 1,
    losingStreak: 0,
    paused: false,
    cycleEnded: false,
    totalWithdrawn: 0,
    openPositions: 0,
    totalExposure: 0,
    positions: new Map()
  };
}

export function syncBankroll(state, realBalance) {
  if (Number.isFinite(realBalance) && realBalance > 0) {
    state.bankroll = realBalance;
  }
}

export function checkWithdrawal(state) {
  const freeCapital = state.bankroll - state.totalExposure;
  if (freeCapital >= WITHDRAWAL_TRIGGER) {
    return {
      shouldWithdraw: true,
      withdrawAmount: WITHDRAWAL_AMOUNT,
      resetTo: state.bankroll - WITHDRAWAL_AMOUNT
    };
  }
  return { shouldWithdraw: false, withdrawAmount: 0, resetTo: 0 };
}

export function recordWithdrawal(state) {
  state.totalWithdrawn += WITHDRAWAL_AMOUNT;
  state.bankroll = BANKROLL_RESET_TO;
  state.cycleNumber += 1;
  state.losingStreak = 0;
  state.paused = false;
  state.cycleEnded = false;
}

export function checkCycleFloor(state) {
  const floor = state.cycleNumber === 1 ? CYCLE_FLOOR.initial : CYCLE_FLOOR.recurring;
  if (state.bankroll < floor) {
    state.cycleEnded = true;
    return {
      cycleEnded: true,
      floor,
      reason: `bankroll_${state.bankroll.toFixed(2)}_below_floor_${floor}`
    };
  }
  // Bankroll recovered above floor — reset flag so trading resumes
  state.cycleEnded = false;
  return { cycleEnded: false, floor, reason: null };
}

function computeMaxStake(bankroll) {
  return Math.min(bankroll * MAX_STAKE_PCT, MAX_STAKE_ABSOLUTE);
}

export function edgeMultiplier(edge) {
  if (!Number.isFinite(edge) || edge < MIN_NET_EDGE) return 0;
  if (edge < 0.06) return 0.4;
  if (edge < 0.09) return 0.6;
  if (edge < 0.12) return 0.8;
  return 1.0;
}

export function stakeBase(bankroll) {
  if (!Number.isFinite(bankroll) || bankroll <= 0) return MIN_TRADE_SIZE;
  const pct = 0.15; // Flat 15% rate, avoiding sudden cliffs
  return Math.max(bankroll * pct, MIN_TRADE_SIZE);
}

export function computeStake(state, edge, basisStdDev = null) {
  const mult = edgeMultiplier(edge);
  if (mult === 0) return 0;

  const maxStake = computeMaxStake(state.bankroll);
  let stake = stakeBase(state.bankroll) * mult;

  if (typeof basisStdDev === 'number' && basisStdDev > 40) {
    stake *= 0.5;
    logger.info(`[risk] basis_stddev=${basisStdDev.toFixed(1)} > 40 -> stake halved`);
  }

  if (state.losingStreak >= 3) {
    stake *= 0.5;
  }
  stake = Math.max(stake, MIN_TRADE_SIZE);
  return Math.min(stake, maxStake);
}

export function decideEntry(state, {
  probModelUp,
  probModelDown,
  marketProbUp,
  marketProbDown,
  marketSlug,
  priceUp = null,
  priceDown = null,
  slippage = TRADE_SLIPPAGE_DEFAULT,
  basisStdDev = null
}) {
  // Re-evaluate floor on every entry attempt so cycleEnded is always
  // coherent with the current bankroll, regardless of when checkCycleFloor
  // was last called in the main loop.
  checkCycleFloor(state);

  const modelUp = toFiniteOrNull(probModelUp);
  const modelDown = toFiniteOrNull(probModelDown);
  const mktUp = toFiniteOrNull(marketProbUp);
  const mktDown = toFiniteOrNull(marketProbDown);

  if (modelUp === null || modelDown === null || mktUp === null || mktDown === null) {
    return {
      canEnter: false,
      reason: "missing_probabilities",
      side: null,
      probModel: null,
      probMarket: null,
      edge: null,
      edgeUp: modelUp !== null && mktUp !== null ? modelUp - mktUp : null,
      edgeDown: modelDown !== null && mktDown !== null ? modelDown - mktDown : null,
      stake: 0
    };
  }

  const edgeUp = modelUp - mktUp;
  const edgeDown = modelDown - mktDown;
  const side = edgeUp >= edgeDown ? "UP" : "DOWN";
  const probModel = side === "UP" ? modelUp : modelDown;
  const probMarket = side === "UP" ? mktUp : mktDown;
  const rawEdge = side === "UP" ? edgeUp : edgeDown;

  // Net edge: subtract taker fee + slippage expressed as a probability cost.
  // cost = (fee + slippage) / (1 - tokenPrice) — approximation of break-even premium.
  const tokenMarketProb = side === "UP" ? mktUp : mktDown;
  const denominator = Math.max(1 - tokenMarketProb, 0.01); // guard against price → 1
  const costAsProb = (TAKER_FEE_BPS / 10000 + slippage) / denominator;
  const netEdge = rawEdge - costAsProb;

  // Hard guard: entry price cap
  const rawPrice = toFiniteOrNull(side === "UP" ? priceUp : priceDown);
  const tokenPrice = rawPrice !== null ? rawPrice + slippage : null;
  if (tokenPrice !== null && tokenPrice > MAX_ENTRY_PRICE) {
    return {
      canEnter: false,
      reason: `entry_price_too_high (price=${tokenPrice.toFixed(3)} > cap=${MAX_ENTRY_PRICE})`,
      side, probModel, probMarket, edge: netEdge, rawEdge, edgeUp, edgeDown, stake: 0
    };
  }

  let stake = computeStake(state, netEdge, basisStdDev);

  const sideStats = getSideWinRate(side);
  if (sideStats.rate !== null && sideStats.rate < 0.40) {
    stake *= 0.5;
    logger.warn(
      `[risk] side=${side} winrate=${(sideStats.rate*100).toFixed(0)}% ` +
      `over last ${sideStats.sample} -> stake halved`
    );
  }

  if (state.cycleEnded) {
    return { canEnter: false, reason: "cycle_ended", side, probModel, probMarket, edge: netEdge, rawEdge, edgeUp, edgeDown, stake: 0 };
  }
  if (state.openPositions >= MAX_POSITIONS) {
    return {
      canEnter: false,
      reason: `max_positions_${MAX_POSITIONS}_reached`,
      side,
      probModel,
      probMarket,
      edge: netEdge,
      rawEdge,
      edgeUp,
      edgeDown,
      stake: 0
    };
  }
  if (marketSlug) {
    for (const pos of state.positions.values()) {
      if (pos.marketSlug === marketSlug) {
        return {
          canEnter: false,
          reason: `position_already_open_for_market_${marketSlug}`,
          side,
          probModel,
          probMarket,
          edge: netEdge,
          rawEdge,
          edgeUp,
          edgeDown,
          stake: 0
        };
      }
    }
  }

  if (probModel < MIN_PROB) {
    return {
      canEnter: false,
      reason: `prob_model_${probModel.toFixed(4)}_below_${MIN_PROB}`,
      side,
      probModel,
      probMarket,
      edge: netEdge,
      rawEdge,
      edgeUp,
      edgeDown,
      stake: 0
    };
  }
  if (probMarket < MIN_MARKET_PROB) {
    return {
      canEnter: false,
      reason: `prob_market_${probMarket.toFixed(4)}_below_${MIN_MARKET_PROB}`,
      side,
      probModel,
      probMarket,
      edge: netEdge,
      rawEdge,
      edgeUp,
      edgeDown,
      stake: 0
    };
  }
  if (netEdge < MIN_NET_EDGE || rawEdge > MAX_EDGE) {
    return {
      canEnter: false,
      reason: `net_edge_${netEdge.toFixed(4)}_out_of_range_${MIN_NET_EDGE}_${MAX_EDGE}`,
      side,
      probModel,
      probMarket,
      edge: netEdge,
      rawEdge,
      edgeUp,
      edgeDown,
      stake: 0
    };
  }
  // Gate #10.5: three-way stake decision
  // 1. Compute the minimum viable stake (MIN_SHARES platform minimum).
  // 2. If that minimum exceeds our risk cap (15% bankroll), skip the trade.
  // 3. Otherwise use max(kellyStake, minViable) capped at riskCap.
  const riskCap = state.bankroll * BANKROLL_RISK_CAP;
  // rawPrice redefined earlier in entry price guard
  if (rawPrice !== null && rawPrice > 0) {
    const targetPrice = Math.min(Math.round((rawPrice + slippage) * 100) / 100, 0.97);
    const minViableStake = MIN_SHARES * targetPrice; // exactly enough to buy 5 shares at target price
    if (minViableStake > riskCap) {
      return {
        canEnter: false,
        reason: `min_ticket_${minViableStake.toFixed(2)}_exceeds_risk_cap_${riskCap.toFixed(2)}_bankroll_${state.bankroll.toFixed(2)}`,
        side, probModel, probMarket, edge: netEdge, rawEdge, edgeUp, edgeDown, stake: 0
      };
    }
    stake = Math.min(Math.max(stake, minViableStake), riskCap);
  }

  if (!Number.isFinite(stake) || stake < MIN_TRADE_SIZE) {
    return {
      canEnter: false,
      reason: `stake_${stake}_below_min_${MIN_TRADE_SIZE}`,
      side,
      probModel,
      probMarket,
      edge: netEdge,
      rawEdge,
      edgeUp,
      edgeDown,
      stake: 0
    };
  }

  const maxExposure = state.bankroll * MAX_EXPOSURE_PCT;
  const nextExposure = state.totalExposure + stake;
  if (nextExposure > maxExposure) {
    return {
      canEnter: false,
      reason: `exposure_${nextExposure.toFixed(2)}_exceeds_${maxExposure.toFixed(2)}_${(MAX_EXPOSURE_PCT * 100).toFixed(0)}pct`,
      side,
      probModel,
      probMarket,
      edge: netEdge,
      rawEdge,
      edgeUp,
      edgeDown,
      stake: 0
    };
  }

  return {
    canEnter: true,
    reason: "ok",
    side,
    probModel,
    probMarket,
    edge: netEdge,
    rawEdge,
    edgeUp,
    edgeDown,
    stake
  };
}

export function recordOpenPosition(state, {
  tokenId,
  marketSlug,
  side,
  stakeUsed,
  openedAtMs = Date.now(),
  ...metadata
}) {
  const key = String(tokenId ?? "").trim();
  const stake = Number(stakeUsed);
  if (!key || !Number.isFinite(stake) || stake <= 0) {
    return { recorded: false, reason: "invalid_position_data" };
  }
  if (state.positions.has(key)) {
    return { recorded: false, reason: "token_already_open" };
  }

  state.positions.set(key, {
    tokenId: key,
    marketSlug: String(marketSlug ?? ""),
    side: String(side ?? ""),
    stakeUsed: stake,
    openedAtMs,
    ...metadata
  });
  recalcExposure(state);
  return { recorded: true, reason: "ok" };
}

export function recordOutcomeByToken(state, tokenId, won) {
  const key = String(tokenId ?? "").trim();
  if (!key || !state.positions.has(key)) {
    return { updated: false, reason: "token_not_open" };
  }

  const pos = state.positions.get(key);
  state.positions.delete(key);
  recalcExposure(state);

  if (won) {
    state.losingStreak = 0;
  } else {
    state.losingStreak += 1;
  }

  recordOutcome(pos.side, won);

  return {
    updated: true,
    reason: "ok",
    tokenId: key,
    won: Boolean(won),
    stakeUsed: pos.stakeUsed,
    position: pos
  };
}

export function formatDiagnostics(state, decision) {
  return [
    `bankroll=$${(state.bankroll ?? 0).toFixed(2)}`,
    `cycle=${state.cycleNumber}`,
    `open_pos=${state.openPositions}`,
    `exposure=$${(state.totalExposure ?? 0).toFixed(2)}`,
    `losing_streak=${state.losingStreak}`,
    `cycle_ended=${state.cycleEnded}`,
    `side=${decision.side ?? "null"}`,
    `prob_model=${decision.probModel !== null && Number.isFinite(decision.probModel) ? decision.probModel.toFixed(4) : "null"}`,
    `prob_market=${decision.probMarket !== null && Number.isFinite(decision.probMarket) ? decision.probMarket.toFixed(4) : "null"}`,
    `raw_edge=${decision.rawEdge !== null && Number.isFinite(decision.rawEdge) ? decision.rawEdge.toFixed(4) : "null"}`,
    `net_edge=${decision.edge !== null && Number.isFinite(decision.edge) ? decision.edge.toFixed(4) : "null"}`,
    `stake=$${(decision.stake ?? 0).toFixed(2)}`,
    `decision=${decision.canEnter ? "ENTER" : `NO_TRADE_${decision.reason}`}`,
    `withdrawn=$${(state.totalWithdrawn ?? 0).toFixed(2)}`
  ].join(" | ");
}
