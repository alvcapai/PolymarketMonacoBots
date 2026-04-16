export const MIN_EDGE = 0.10;
export const MAX_EDGE = 0.15;
export const MIN_PROB = 0.80;
export const MIN_MARKET_PROB = 0.75;
export const MAX_STAKE = 1.0;
export const MAX_POSITIONS = 2;
export const MAX_EXPOSURE_PCT = 0.35;
export const WITHDRAWAL_TRIGGER = 150;
export const WITHDRAWAL_AMOUNT = 100;
export const BANKROLL_RESET_TO = 50;
export const MIN_TRADE_SIZE = 1.0;

const CYCLE_FLOOR = {
  initial: 5,
  recurring: 10
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
  if (Number.isFinite(realBalance) && realBalance >= 0) {
    state.bankroll = realBalance;
  }
}

export function checkWithdrawal(state) {
  if (state.bankroll >= WITHDRAWAL_TRIGGER) {
    return {
      shouldWithdraw: true,
      withdrawAmount: WITHDRAWAL_AMOUNT,
      resetTo: BANKROLL_RESET_TO
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

export function edgeMultiplier(edge) {
  if (!Number.isFinite(edge) || edge < MIN_EDGE) return 0;
  if (edge < 0.06) return 0.4;
  if (edge < 0.09) return 0.6;
  if (edge < 0.12) return 0.8;
  return 1.0;
}

export function stakeBase(bankroll) {
  if (!Number.isFinite(bankroll) || bankroll <= 0) return MIN_TRADE_SIZE;
  const pct = bankroll < 50 ? 0.2 : 0.25;
  return Math.max(bankroll * pct, MIN_TRADE_SIZE);
}

export function computeStake(state, edge) {
  const mult = edgeMultiplier(edge);
  if (mult === 0) return 0;

  let stake = stakeBase(state.bankroll) * mult;
  if (state.losingStreak >= 3) {
    stake *= 0.5;
  }
  stake = Math.max(stake, MIN_TRADE_SIZE);
  return Math.min(stake, MAX_STAKE);
}

export function decideEntry(state, {
  probModelUp,
  probModelDown,
  marketProbUp,
  marketProbDown,
  marketSlug
}) {
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
  const edge = side === "UP" ? edgeUp : edgeDown;
  const stake = computeStake(state, edge);

  if (state.cycleEnded) {
    return { canEnter: false, reason: "cycle_ended", side, probModel, probMarket, edge, edgeUp, edgeDown, stake: 0 };
  }
  if (state.paused) {
    return { canEnter: false, reason: "paused_losing_streak_5", side, probModel, probMarket, edge, edgeUp, edgeDown, stake: 0 };
  }
  if (state.openPositions >= MAX_POSITIONS) {
    return {
      canEnter: false,
      reason: `max_positions_${MAX_POSITIONS}_reached`,
      side,
      probModel,
      probMarket,
      edge,
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
          edge,
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
      edge,
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
      edge,
      edgeUp,
      edgeDown,
      stake: 0
    };
  }
  if (edge < MIN_EDGE || edge > MAX_EDGE) {
    return {
      canEnter: false,
      reason: `edge_${edge.toFixed(4)}_out_of_range_${MIN_EDGE}_${MAX_EDGE}`,
      side,
      probModel,
      probMarket,
      edge,
      edgeUp,
      edgeDown,
      stake: 0
    };
  }
  if (!Number.isFinite(stake) || stake < MIN_TRADE_SIZE) {
    return {
      canEnter: false,
      reason: `stake_${stake}_below_min_${MIN_TRADE_SIZE}`,
      side,
      probModel,
      probMarket,
      edge,
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
      edge,
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
    edge,
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
    if (state.losingStreak >= 5) {
      state.paused = true;
    }
  }

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
    `paused=${state.paused}`,
    `cycle_ended=${state.cycleEnded}`,
    `side=${decision.side ?? "null"}`,
    `prob_model=${decision.probModel !== null && Number.isFinite(decision.probModel) ? decision.probModel.toFixed(4) : "null"}`,
    `prob_market=${decision.probMarket !== null && Number.isFinite(decision.probMarket) ? decision.probMarket.toFixed(4) : "null"}`,
    `edge=${decision.edge !== null && Number.isFinite(decision.edge) ? decision.edge.toFixed(4) : "null"}`,
    `stake=$${(decision.stake ?? 0).toFixed(2)}`,
    `decision=${decision.canEnter ? "ENTER" : `NO_TRADE_${decision.reason}`}`,
    `withdrawn=$${(state.totalWithdrawn ?? 0).toFixed(2)}`
  ].join(" | ");
}
