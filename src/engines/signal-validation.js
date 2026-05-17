function clamp01(x) {
  if (!Number.isFinite(x)) return null;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/*
 * LEGACY_CALIBRATION_75_TRADES (2026-04)
 * Non-monotonic empirical lookup from 75 closed 15m trades. Retired because
 * raw 0.70–0.80 → 0.55 is weaker than 0.60–0.70 → 0.58 (inverted), and
 * ≥ 0.80 → 0.42 penalises high-conviction signals below MIN_PROB, killing
 * all strong-signal trades.
 *
 * function empiricalConfidence(raw) {
 *   if (raw < 0.60) return 0.50;
 *   if (raw < 0.70) return 0.58;
 *   if (raw < 0.80) return 0.55;
 *   return 0.42;
 * }
 *
 * export function calibrateModelProbabilities(adjustedUp) {
 *   const up = clamp01(Number(adjustedUp));
 *   if (up === null) {
 *     return { ok: false, probModelUp: null, probModelDown: null, reason: "invalid_adjusted_up" };
 *   }
 *   const winSideRaw = Math.max(up, 1 - up);
 *   const winSideCal = empiricalConfidence(winSideRaw);
 *   const probModelUp = up >= 0.5 ? winSideCal : clamp01(1 - winSideCal);
 *   const probModelDown = clamp01(1 - probModelUp);
 *   return { ok: true, probModelUp, probModelDown };
 * }
 */

// Platt-style logistic calibration — monotonically shrinks toward 0.5.
// a = 6.0 matches standard Platt notation: calibratedUp = sigmoid(a * (rawUp - 0.5)).
// TODO: refit once 500+ labeled trades are collected.
export function calibrateModelProbabilities(rawUp) {
  const up = clamp01(Number(rawUp));
  if (up === null) {
    return { probModelUp: null, probModelDown: null };
  }

  // a = 8.8 (equivalent to a=2.2 * 4) -> steeper sigmoid, separates high-conviction
  const a = 8.8;
  const calibratedUp = 1 / (1 + Math.exp(-a * (up - 0.5)));

  return {
    probModelUp: calibratedUp,
    probModelDown: 1 - calibratedUp
  };
}
