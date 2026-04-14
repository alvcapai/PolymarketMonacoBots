/**
 * signal-validation.js
 *
 * IMPORTANTE: O valor `adjustedUp` gerado por probability.js é um ratio de
 * pontos heurísticos de indicadores técnicos — NÃO é uma probabilidade
 * estatisticamente calibrada.
 *
 * Exemplo: score upScore=9, downScore=5 → rawUp = 9/14 ≈ 0.643.
 * Isso representa "mais indicadores apontam para cima", mas não significa
 * que a probabilidade real de acerto seja 64.3%.
 *
 * Este módulo aplica uma compressão conservadora (shrinkage toward 0.5)
 * para refletir essa incerteza antes de usar o score como prob_modelo:
 *
 *   prob_model = 0.5 + (rawScore - 0.5) × CALIBRATION_FACTOR
 *
 * Com CALIBRATION_FACTOR = 0.85:
 *   rawScore 0.85 → prob_model ≈ 0.798
 *   rawScore 0.75 → prob_model ≈ 0.713
 *   rawScore 0.65 → prob_model ≈ 0.628
 *
 * Para um critério de entrada de prob >= 0.75, o score bruto precisa ser >= 0.794.
 * Isso é MAIS conservador que usar o score direto.
 *
 * Ativado via ENABLE_ASSISTANT_SIGNAL_VALIDATION=true.
 * Quando desativado, o chamador usa adjustedUp diretamente (comportamento legado).
 *
 * Limitação documentada: sem histórico calibrado, CALIBRATION_FACTOR é
 * uma estimativa conservadora, não um parâmetro derivado de dados.
 */

/** Fator de compressão toward 0.5. Range (0, 1]. Menor = mais conservador. */
const CALIBRATION_FACTOR = 0.85;

/**
 * Valida e calibra o score heurístico para uso como prob_modelo.
 *
 * @param {number|null} adjustedUp   - Score UP após time-decay [0, 1]
 * @param {number|null} adjustedDown - Score DOWN após time-decay [0, 1]
 * @returns {{
 *   prob_model_up:   number|null,
 *   prob_model_down: number|null,
 *   isCalibrated:    boolean,
 *   warning:         string
 * }}
 */
export function validateAndCalibrateSignal(adjustedUp, adjustedDown) {
  if (
    adjustedUp === null || adjustedDown === null ||
    !Number.isFinite(adjustedUp) || !Number.isFinite(adjustedDown)
  ) {
    return {
      prob_model_up:   null,
      prob_model_down: null,
      isCalibrated:    false,
      warning:         "missing_signal"
    };
  }

  const raw = Math.max(0, Math.min(1, adjustedUp));
  const prob_model_up   = Math.max(0, Math.min(1, 0.5 + (raw - 0.5) * CALIBRATION_FACTOR));
  const prob_model_down = 1 - prob_model_up;

  return {
    prob_model_up,
    prob_model_down,
    isCalibrated: false, // nunca mude para true sem validação empírica real
    warning: `heuristic_score_compressed_factor_${CALIBRATION_FACTOR}`
  };
}
