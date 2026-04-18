function clamp01(x) {
  if (!Number.isFinite(x)) return null;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// Empirical map from 75 closed 15m trades (2026-04): raw pm>=0.80 is overconfident, blocks trade.
function empiricalConfidence(raw) {
  if (raw < 0.60) return 0.50;
  if (raw < 0.70) return 0.58;
  if (raw < 0.80) return 0.55;
  return 0.42;
}

export function calibrateModelProbabilities(adjustedUp) {
  const up = clamp01(Number(adjustedUp));
  if (up === null) {
    return { ok: false, probModelUp: null, probModelDown: null, reason: "invalid_adjusted_up" };
  }

  const winSideRaw = Math.max(up, 1 - up);
  const winSideCal = empiricalConfidence(winSideRaw);
  const probModelUp = up >= 0.5 ? winSideCal : clamp01(1 - winSideCal);
  const probModelDown = clamp01(1 - probModelUp);

  return {
    ok: true,
    probModelUp,
    probModelDown
  };
}
