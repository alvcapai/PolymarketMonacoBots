import { logger } from "../logging/logger.js";
import { getConfig } from "../config-loader.js";
import { StateManager, serializeState, deserializeState } from "./state-manager.js";
import { getSideWinRate, recordOutcome } from "./side-performance.js";

// Dynamic configuration getters
export function getMinNetEdge() { return getConfig().limits.min_net_edge; }
export function getMaxEdge() { return getConfig().limits.max_edge; }
export function getMinProb() { return getConfig().limits.min_prob; }
export function getMinMarketProb() { return getConfig().limits.min_market_prob; }
export function getMaxStakePct() { return getConfig().limits.max_stake_pct; }
export function getMaxStakeAbsolute() { return getConfig().limits.max_stake_absolute; }
export function getMaxEntryPrice() { return getConfig().limits.max_entry_price; }
export function getMaxPositions() { return getConfig().limits.max_positions; }
export function getMaxExposurePct() { return getConfig().limits.max_exposure_pct; }
export function getMinTradeSize() { return getConfig().limits.min_trade_size; }
export function getTakerFeeBps() { return getConfig().market.taker_fee_bps; }
export function getTradeSlippageDefault() { return getConfig().market.trade_slippage_default; }
export function getWithdrawalTrigger() { return getConfig().bankroll.withdrawal_trigger; }
export function getWithdrawalAmount() { return getConfig().bankroll.withdrawal_amount; }
export function getBankrollResetTo() { return getConfig().bankroll.bankroll_reset_to; }
export function getBankrollRiskCap() { 
  const val = getConfig().bankroll.risk_cap; 
  return val !== undefined ? val : 1.0; 
}
export function getMinShares() { return getConfig().shares.min_shares; }

let stateManager = null;

export function initStateManager(stateFilePath) {
  stateManager = new StateManager(stateFilePath);
}

export function loadBankrollState(initialBankroll = 20) {
  if (!stateManager) {
    throw new Error("State manager not initialized");
  }
  
  const defaultState = createBankrollState(initialBankroll);
  const serialized = stateManager.loadState(serializeState(defaultState));
  return deserializeState(serialized);
}

export function saveBankrollState(state) {
  if (!stateManager) {
    throw new Error("State manager not initialized");
  }
  
  stateManager.saveState(serializeState(state));
}

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
  if (freeCapital >= getWithdrawalTrigger()) {
    return {
      shouldWithdraw: true,
      withdrawAmount: getWithdrawalAmount(),
      resetTo: state.bankroll - getWithdrawalAmount()
    };
  }
  return { shouldWithdraw: false, withdrawAmount: 0, resetTo: 0 };
}

export function recordWithdrawal(state) {
  state.totalWithdrawn += getWithdrawalAmount();
  state.bankroll = getBankrollResetTo();
  state.cycleNumber += 1;
  state.losingStreak = 0;
  state.paused = false;
  state.cycleEnded = false;
}

export function checkCycleFloor(state) {
  const cfg = getConfig();
  const floor = state.cycleNumber === 1 ? cfg.cycle.floor_initial : cfg.cycle.floor_recurring;
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
  return Math.min(bankroll * getMaxStakePct(), getMaxStakeAbsolute());
}

export function edgeMultiplier(edge) {
  if (!Number.isFinite(edge) || edge < getMinNetEdge()) return 0;
  if (edge < 0.06) return 0.4;
  if (edge < 0.09) return 0.6;
  if (edge < 0.12) return 0.8;
  return 1.0;
}

export function stakeBase(bankroll) {
  if (!Number.isFinite(bankroll) || bankroll <= 0) return getMinTradeSize();
  const pct = 0.15; // Flat 15% rate, avoiding sudden cliffs
  return Math.max(bankroll * pct, getMinTradeSize());
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
  stake = Math.max(stake, getMinTradeSize());
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
  slippage = getTradeSlippageDefault(),
  basisStdDev = null,
  trend = null,
  rsiNow = null,
  vwapDist = null
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
  const costAsProb = (getTakerFeeBps() / 10000 + slippage) / denominator;
  const netEdge = rawEdge - costAsProb;

  // ── Guardrail de Exaustão (RSI Extremos) ──────────────────────────────────
  if (rsiNow !== null) {
    if (side === "UP" && rsiNow > 75) {
      return {
        canEnter: false,
        reason: `exhaustion_guard_up_rejected (rsi=${rsiNow.toFixed(1)} > 75)`,
        side, probModel, probMarket, edge: netEdge, rawEdge, edgeUp, edgeDown, stake: 0
      };
    }
    if (side === "DOWN" && rsiNow < 25) {
      return {
        canEnter: false,
        reason: `exhaustion_guard_down_rejected (rsi=${rsiNow.toFixed(1)} < 25)`,
        side, probModel, probMarket, edge: netEdge, rawEdge, edgeUp, edgeDown, stake: 0
      };
    }
  }

  // ── Zona de Compressão / No-Trade Box (Lateralização de Preço) ─────────────
  if (vwapDist !== null) {
    const absDist = Math.abs(vwapDist);
    if (absDist < 0.0005) { // 0.05% de distância máxima da média (VWAP)
      return {
        canEnter: false,
        reason: `vwap_compression_zone_rejected (vwapDist=${(absDist * 100).toFixed(4)}% < 0.05%)`,
        side, probModel, probMarket, edge: netEdge, rawEdge, edgeUp, edgeDown, stake: 0
      };
    }
  }

  if (trend !== null && trend !== side) {
    return {
      canEnter: false,
      reason: `counter_trend_rejected (side=${side} vs trend=${trend})`,
      side, probModel, probMarket, edge: netEdge, rawEdge, edgeUp, edgeDown, stake: 0
    };
  }

  // Hard guard: entry price cap
  const rawPrice = toFiniteOrNull(side === "UP" ? priceUp : priceDown);
  const tokenPrice = rawPrice !== null ? rawPrice + slippage : null;
  if (tokenPrice !== null && tokenPrice > getMaxEntryPrice()) {
    return {
      canEnter: false,
      reason: `entry_price_too_high (price=${tokenPrice.toFixed(3)} > cap=${getMaxEntryPrice()})`,
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
  if (state.openPositions >= getMaxPositions()) {
    return {
      canEnter: false,
      reason: `max_positions_${getMaxPositions()}_reached`,
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

  if (probModel < getMinProb()) {
    return {
      canEnter: false,
      reason: `prob_model_${probModel.toFixed(4)}_below_${getMinProb()}`,
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
  if (probMarket < getMinMarketProb()) {
    return {
      canEnter: false,
      reason: `prob_market_${probMarket.toFixed(4)}_below_${getMinMarketProb()}`,
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
  if (netEdge < getMinNetEdge() || rawEdge > getMaxEdge()) {
    return {
      canEnter: false,
      reason: `net_edge_${netEdge.toFixed(4)}_out_of_range_${getMinNetEdge()}_${getMaxEdge()}`,
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
  const riskCap = state.bankroll * getBankrollRiskCap();
  // rawPrice redefined earlier in entry price guard
  if (rawPrice !== null && rawPrice > 0) {
    const targetPrice = Math.min(Math.round((rawPrice + slippage) * 100) / 100, 0.97);
    const minViableStake = getMinShares() * targetPrice;
    if (minViableStake > riskCap) {
      return {
        canEnter: false,
        reason: `min_ticket_${minViableStake.toFixed(2)}_exceeds_risk_cap_${riskCap.toFixed(2)}_bankroll_${state.bankroll.toFixed(2)}`,
        side, probModel, probMarket, edge: netEdge, rawEdge, edgeUp, edgeDown, stake: 0
      };
    }
    stake = Math.min(Math.max(stake, minViableStake), riskCap);
  }

  if (!Number.isFinite(stake) || stake < getMinTradeSize()) {
    return {
      canEnter: false,
      reason: `stake_${stake}_below_min_${getMinTradeSize()}`,
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

  const maxExposure = state.bankroll * getMaxExposurePct();
  const nextExposure = state.totalExposure + stake;
  if (nextExposure > maxExposure) {
    return {
      canEnter: false,
      reason: `exposure_${nextExposure.toFixed(2)}_exceeds_${maxExposure.toFixed(2)}_${(getMaxExposurePct() * 100).toFixed(0)}pct`,
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
