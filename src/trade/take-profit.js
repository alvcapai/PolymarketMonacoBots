import { executeSell } from "./executor.js";
import { logger } from "../logging/logger.js";

const MIN_TIME_LEFT_MIN = 1;       // hold in final 1 min — let settlement pay $1 (was 2)
const STOP_LOSS_FACTOR = 0.40;     // sell if position dropped to 40% of entry price (−60%)
const MIN_TIME_FOR_STOP_LOSS = 5;  // don't cut losses if <5 min left — let it settle
const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST || "https://clob.polymarket.com";
const TRADE_MOCK = String(process.env.TRADE_MOCK_MODE ?? "true").toLowerCase() === "true";

const takenProfitTokens = new Set();

// Dynamic sell threshold. All three components return a price level; we sell
// when currentMidPrice ≥ max of all three.
// entryPrice, probModel, remainingMinutes — TUNABLE AFTER DATA COLLECTION
function computeSellThreshold({ entryPrice, probModel, remainingMinutes }) {
  const remClamped = Math.max(0, Math.min(remainingMinutes ?? 15, 15));

  const minGainFloor = entryPrice * 1.15;             // never exit for <15% gain
  const modelConvictionCap = (probModel ?? 0.5) + 0.10; // market priced 10¢ above model
  const timeDecayFloor = 1.0 - (remClamped / 15) * 0.15; // rises from 0.85 → 1.0 as t→0

  return Math.max(minGainFloor, modelConvictionCap, timeDecayFloor);
}

async function fetchMidPrice(tokenId) {
  try {
    const res = await fetch(`${CLOB_HOST}/midpoint?token_id=${tokenId}`, {
      headers: { Accept: "application/json" }
    });
    if (!res.ok) return null;
    const body = await res.json();
    const mid = Number(body?.mid ?? body?.midpoint ?? NaN);
    return Number.isFinite(mid) ? mid : null;
  } catch {
    return null;
  }
}

async function doSell(tokenId, shareSize, currentPrice, reason) {
  logger.info({
    component: "take-profit", reason, tokenId: tokenId.slice(0, 20),
    currentPrice, proceeds: currentPrice * shareSize, mock: TRADE_MOCK,
  }, "Take-profit sell triggered");
  if (!TRADE_MOCK) {
    await executeSell(tokenId, shareSize, currentPrice);
  }
}

export async function checkTakeProfit(bankrollState, { settlementLeftMin = null } = {}) {
  const events = [];
  const openPositions = [...bankrollState.positions.entries()];
  if (!openPositions.length) return { events };

  for (const [tokenId, pos] of openPositions) {
    if (takenProfitTokens.has(tokenId)) continue;

    const entryPrice = Number(pos.entryPrice ?? 0);
    const shareSize  = Number(pos.shareSize  ?? 0);
    if (!entryPrice || !shareSize) continue;

    const currentPrice = await fetchMidPrice(tokenId);
    if (currentPrice === null || currentPrice <= 0 || currentPrice >= 1) continue;

    const remainingMinutes = settlementLeftMin;

    // Soft stop-loss: free capital if position is deeply underwater with time remaining.
    const isStopLoss = (
      currentPrice <= entryPrice * STOP_LOSS_FACTOR &&
      remainingMinutes !== null &&
      remainingMinutes >= MIN_TIME_FOR_STOP_LOSS
    );

    if (isStopLoss) {
      const proceeds = currentPrice * shareSize;
      try {
        await doSell(tokenId, shareSize, currentPrice, "STOP-LOSS");
      } catch (err) {
        logger.error({ component: "take-profit", tokenId: tokenId.slice(0, 20), err: err.message }, "Stop-loss sell error");
        continue;
      }
      takenProfitTokens.add(tokenId);
      events.push({
        tokenId,
        won: false,
        closeReason: "stop_loss",
        redeemed: false,
        marketSettlementPrice: currentPrice,
        proceeds,
        gain: (currentPrice - entryPrice) / entryPrice,
        source: "take_profit"
      });
      continue;
    }

    // Near settlement — let the position resolve naturally for full $1 payout.
    if (remainingMinutes !== null && remainingMinutes < MIN_TIME_LEFT_MIN) continue;

    const threshold = computeSellThreshold({
      entryPrice,
      probModel: pos.probModel,
      remainingMinutes
    });

    if (currentPrice < threshold) continue;

    const proceeds = currentPrice * shareSize;
    try {
      await doSell(tokenId, shareSize, currentPrice, `TAKE-PROFIT thresh=${threshold.toFixed(2)}`);
    } catch (err) {
      logger.error({ component: "take-profit", tokenId: tokenId.slice(0, 20), err: err.message }, "Take-profit sell error");
      continue;
    }

    takenProfitTokens.add(tokenId);
    events.push({
      tokenId,
      won: true,
      closeReason: "take_profit",
      redeemed: false,
      marketSettlementPrice: currentPrice,
      proceeds,
      gain: (currentPrice - entryPrice) / entryPrice,
      source: "take_profit"
    });
  }

  return { events };
}
