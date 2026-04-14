/**
 * risk-management.js
 *
 * Gestão de banca, ciclo, sizing e proteção.
 * Todas as funções são puras ou operam sobre um objeto de estado explícito.
 * Sem I/O. Pode ser testado isoladamente.
 *
 * Ativado via ENABLE_RISK_LAYER=true em .env.
 *
 * ─── Regras de ciclo ────────────────────────────────────────────────────────
 *   Banca inicial:    20 USD
 *   Gatilho de saque: saldo >= 150 USD
 *   Ao sacar:         saca 100 USD, reseta banca operacional para 50 USD
 *   Repetição:        mesma regra a cada vez que banca chega a 150 USD
 *
 * ─── Floor de ciclo ─────────────────────────────────────────────────────────
 *   Ciclo 1 (inicial, ~20 USD): encerrar se banca < 8 USD
 *   Ciclos 2+ (de 50 USD):      encerrar se banca < 20 USD
 *
 * ─── Stake base ─────────────────────────────────────────────────────────────
 *   bankroll < 50  → 20% do bankroll
 *   bankroll >= 50 → 25% do bankroll
 *
 * ─── Multiplicador por edge ─────────────────────────────────────────────────
 *   edge < 0.04           → não entra (retorna 0)
 *   0.04 <= edge < 0.06   → 40% da stake base
 *   0.06 <= edge < 0.09   → 60% da stake base
 *   0.09 <= edge < 0.12   → 80% da stake base
 *   edge >= 0.12          → 100% da stake base
 *
 * ─── Proteções ──────────────────────────────────────────────────────────────
 *   Máx 2 posições simultâneas
 *   Exposição total máx = 35% do bankroll
 *   3 perdas seguidas → stake × 50%
 *   5 perdas seguidas → pausar novas entradas
 *
 * ─── Win/loss tracking ──────────────────────────────────────────────────────
 *   TODO: Integrar com redeemer.js para rastrear outcomes reais.
 *   Chamar recordOutcome(state, won, stake) quando uma posição é resgatada
 *   (won=true) ou expira sem redenção (won=false).
 *   Enquanto não integrado, losingStreak permanece em 0 e não penaliza.
 */

// ─── Constantes ──────────────────────────────────────────────────────────────

export const MIN_EDGE          = 0.04;
export const MIN_PROB          = 0.75;
export const MAX_POSITIONS     = 2;
export const MAX_EXPOSURE_PCT  = 0.35;
export const WITHDRAWAL_TRIGGER = 150;
export const WITHDRAWAL_AMOUNT  = 100;
export const BANKROLL_RESET_TO  = 50;
export const MIN_TRADE_SIZE     = 1.0;

const CYCLE_FLOOR = {
  initial:   8,   // ciclo 1 (banca inicial ~20)
  recurring: 20,  // ciclos 2+ (banca resetada a 50)
};

// ─── Estado ──────────────────────────────────────────────────────────────────

/**
 * Cria o estado inicial de banca.
 * Chame uma vez em main() e passe o objeto para todas as funções.
 *
 * @param {number} [initialBankroll=20] - Banca de partida em USD
 * @returns {BankrollState}
 */
export function createBankrollState(initialBankroll = 20) {
  return {
    bankroll:       initialBankroll, // Banca operacional atual (sincronizada com saldo real)
    cycleNumber:    1,               // 1 = ciclo inicial, 2+ = ciclos subsequentes
    losingStreak:   0,               // Perdas consecutivas
    openPositions:  0,               // Posições abertas (não liquidadas)
    totalExposure:  0,               // USD atualmente em risco
    paused:         false,           // true quando losingStreak >= 5
    totalWithdrawn: 0,               // Lucro total sacado (acumulado)
    cycleEnded:     false,           // true quando bankroll abaixo do floor
  };
}

// ─── Sincronização de saldo ──────────────────────────────────────────────────

/**
 * Sincroniza a banca operacional com o saldo on-chain real.
 * Chame após cada refreshBalance().
 *
 * @param {BankrollState} state
 * @param {number|null} realBalance - Saldo USDC da API
 */
export function syncBankroll(state, realBalance) {
  if (Number.isFinite(realBalance) && realBalance >= 0) {
    state.bankroll = realBalance;
  }
}

// ─── Regra de saque ──────────────────────────────────────────────────────────

/**
 * Verifica se o saque automático deve ser disparado.
 *
 * @param {BankrollState} state
 * @returns {{ shouldWithdraw: boolean, withdrawAmount: number, resetTo: number }}
 */
export function checkWithdrawal(state) {
  if (state.bankroll >= WITHDRAWAL_TRIGGER) {
    return { shouldWithdraw: true, withdrawAmount: WITHDRAWAL_AMOUNT, resetTo: BANKROLL_RESET_TO };
  }
  return { shouldWithdraw: false, withdrawAmount: 0, resetTo: 0 };
}

/**
 * Registra o saque após confirmação on-chain.
 * Atualiza estado: reseta banca, incrementa ciclo, limpa streak.
 *
 * @param {BankrollState} state
 */
export function recordWithdrawal(state) {
  state.totalWithdrawn += WITHDRAWAL_AMOUNT;
  state.bankroll        = BANKROLL_RESET_TO;
  state.cycleNumber    += 1;
  state.losingStreak    = 0;
  state.paused          = false;
  state.cycleEnded      = false;
}

// ─── Floor de ciclo ──────────────────────────────────────────────────────────

/**
 * Verifica se o ciclo deve ser encerrado por banca abaixo do floor.
 * Atualiza state.cycleEnded se aplicável.
 *
 * @param {BankrollState} state
 * @returns {{ cycleEnded: boolean, reason: string|null, floor: number }}
 */
export function checkCycleFloor(state) {
  const floor = state.cycleNumber === 1 ? CYCLE_FLOOR.initial : CYCLE_FLOOR.recurring;
  if (state.bankroll < floor) {
    state.cycleEnded = true;
    return { cycleEnded: true, reason: `bankroll_${state.bankroll.toFixed(2)}_below_floor_${floor}`, floor };
  }
  return { cycleEnded: false, reason: null, floor };
}

// ─── Sizing ──────────────────────────────────────────────────────────────────

/**
 * Multiplica a stake base de acordo com a edge.
 * Retorna 0 se edge < MIN_EDGE (não entra).
 *
 * @param {number} edge
 * @returns {number} Multiplicador [0, 1]
 */
export function edgeMultiplier(edge) {
  if (!Number.isFinite(edge) || edge < MIN_EDGE) return 0;
  if (edge < 0.06) return 0.40;
  if (edge < 0.09) return 0.60;
  if (edge < 0.12) return 0.80;
  return 1.00;
}

/**
 * Calcula a stake base para o bankroll atual (sem multiplicador de edge).
 *
 * @param {number} bankroll
 * @returns {number} Stake base em USD
 */
export function stakeBase(bankroll) {
  if (!Number.isFinite(bankroll) || bankroll <= 0) return MIN_TRADE_SIZE;
  const pct = bankroll < 50 ? 0.20 : 0.25;
  return Math.max(bankroll * pct, MIN_TRADE_SIZE);
}

/**
 * Calcula a stake final: base × multiplicador de edge × penalidade de streak.
 * Retorna 0 se a edge for insuficiente para entrada.
 *
 * @param {BankrollState} state
 * @param {number} edge - Edge positiva para o lado escolhido
 * @returns {number} Stake em USD (0 = não entra)
 */
export function computeStake(state, edge) {
  const mult = edgeMultiplier(edge);
  if (mult === 0) return 0;

  const base  = stakeBase(state.bankroll);
  let   stake = base * mult;

  // Após 3 perdas consecutivas: stake pela metade
  if (state.losingStreak >= 3) {
    stake *= 0.5;
  }

  return Math.max(stake, MIN_TRADE_SIZE);
}

// ─── Checagem de entrada ─────────────────────────────────────────────────────

/**
 * Verifica todas as condições de entrada antes de disparar a ordem.
 *
 * @param {BankrollState} state
 * @param {number} probModel - Probabilidade do modelo para o lado escolhido [0, 1]
 * @param {number} edge      - Edge positiva para o lado escolhido
 * @returns {{ canEnter: boolean, reason: string }}
 */
export function checkEntry(state, probModel, edge) {
  if (state.cycleEnded) {
    return { canEnter: false, reason: "cycle_ended" };
  }
  if (state.paused) {
    return { canEnter: false, reason: "paused_losing_streak_5" };
  }
  if (state.openPositions >= MAX_POSITIONS) {
    return { canEnter: false, reason: `max_positions_${MAX_POSITIONS}_reached` };
  }
  if (!Number.isFinite(probModel) || probModel < MIN_PROB) {
    return { canEnter: false, reason: `prob_model_${probModel?.toFixed(4) ?? "null"}_below_${MIN_PROB}` };
  }
  if (!Number.isFinite(edge) || edge < MIN_EDGE) {
    return { canEnter: false, reason: `edge_${edge?.toFixed(4) ?? "null"}_below_${MIN_EDGE}` };
  }

  // Verificação de exposição máxima
  const proposedStake = computeStake(state, edge);
  const newExposure   = state.totalExposure + proposedStake;
  const maxExposure   = state.bankroll * MAX_EXPOSURE_PCT;
  if (newExposure > maxExposure) {
    return {
      canEnter: false,
      reason:   `exposure_${newExposure.toFixed(2)}_exceeds_${maxExposure.toFixed(2)}_${(MAX_EXPOSURE_PCT * 100).toFixed(0)}pct`
    };
  }

  return { canEnter: true, reason: "ok" };
}

// ─── Registro de posições ────────────────────────────────────────────────────

/**
 * Registra abertura de posição.
 * Chame imediatamente após executeTrade() ter sucesso.
 *
 * @param {BankrollState} state
 * @param {number} stakeUsed - Valor da ordem executada
 */
export function recordOpenPosition(state, stakeUsed) {
  state.openPositions  = Math.min(state.openPositions + 1, MAX_POSITIONS);
  state.totalExposure += stakeUsed;
}

/**
 * Registra resultado de uma posição liquidada.
 *
 * TODO: Integrar com redeemer.js — chamar esta função quando:
 *   - won=true:  posição foi resgatada com lucro (runAutoRedeem encontrou a posição)
 *   - won=false: posição expirou sem resgate (detectar via timeout ou saldo)
 *
 * Enquanto não integrado, não chame esta função. O losingStreak permanece
 * em 0 e as proteções de streak ficam inativas — comportamento conservador.
 *
 * @param {BankrollState} state
 * @param {boolean} won      - true=ganhou, false=perdeu
 * @param {number} stakeUsed - Valor que estava em risco
 */
export function recordOutcome(state, won, stakeUsed) {
  state.openPositions  = Math.max(state.openPositions - 1, 0);
  state.totalExposure  = Math.max(state.totalExposure - stakeUsed, 0);

  if (won) {
    state.losingStreak = 0;
  } else {
    state.losingStreak += 1;
    if (state.losingStreak >= 5) {
      state.paused = true;
    }
  }
}

// ─── Diagnóstico ─────────────────────────────────────────────────────────────

/**
 * Formata uma linha de log com todos os parâmetros relevantes.
 *
 * @param {BankrollState} state
 * @param {number|null} probModel
 * @param {number|null} edge
 * @param {number|null} probMarket
 * @param {number|null} stake
 * @returns {string}
 */
export function formatDiagnostics(state, probModel, edge, probMarket, stake) {
  return [
    `bankroll=$${(state.bankroll ?? 0).toFixed(2)}`,
    `prob_model=${probModel !== null && Number.isFinite(probModel) ? probModel.toFixed(4) : "null"}`,
    `prob_market=${probMarket !== null && Number.isFinite(probMarket) ? probMarket.toFixed(4) : "null"}`,
    `edge=${edge !== null && Number.isFinite(edge) ? edge.toFixed(4) : "null"}`,
    `stake=$${(stake ?? 0).toFixed(2)}`,
    `losing_streak=${state.losingStreak}`,
    `open_pos=${state.openPositions}`,
    `exposure=$${(state.totalExposure ?? 0).toFixed(2)}`,
    `paused=${state.paused}`,
    `cycle=${state.cycleNumber}`,
    `withdrawn=$${(state.totalWithdrawn ?? 0).toFixed(2)}`,
  ].join(" | ");
}
