import { executeSell } from "./executor.js";
import { logger } from "../logging/logger.js";

const MIN_TIME_LEFT_MIN = 1;       // hold in final 1 min — let settlement pay $1 (was 2)
const STOP_LOSS_FACTOR = 0.40;     // sell if position dropped to 40% of entry price (−60%)
const MIN_TIME_FOR_STOP_LOSS = 5;  // don't cut losses if <5 min left — let it settle
const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST || "https://clob.polymarket.com";
const TRADE_MOCK = String(process.env.TRADE_MOCK_MODE ?? "true").toLowerCase() === "true";

// Dynamic sell threshold. All three components return a price level; we sell
// when currentMidPrice >= max of all three.
function computeSellThreshold({ entryPrice, probModel, remainingMinutes }) {
  const remClamped = Math.max(0, Math.min(remainingMinutes ?? 15, 15));

  const minGainFloor = entryPrice * 1.15; // never exit for <15% gain
  const modelConvictionCap = Math.min((probModel ?? 0.5) + 0.10, 0.99); // market priced 10 cents above model
  
  // As remaining time approaches 0, we demand a higher price to sell early,
  // scaling parabolically from minGainFloor up to 0.99.
  const timeProgress = 1.0 - (remClamped / 15);
  const timeDecayFloor = minGainFloor + (0.99 - minGainFloor) * (timeProgress * timeProgress);

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

function removePositionFromState(bankrollState, tokenId, pos) {
  if (pos && bankrollState.positions.has(tokenId)) {
    bankrollState.openPositions = Math.max(0, bankrollState.openPositions - 1);
    bankrollState.totalExposure = Math.max(0, bankrollState.totalExposure - (pos.stakeUsed ?? 0));
    bankrollState.positions.delete(tokenId);
  }
}

export async function checkTakeProfit(bankrollState, { settlementLeftMin = null } = {}) {
  const events = [];
  const openPositions = [...bankrollState.positions.entries()];
  if (!openPositions.length) return { events };

  // Fetch prices concurrently to prevent sequential blocking
  const pricePromises = openPositions.map(async ([tokenId, pos]) => {
    const entryPrice = Number(pos.entryPrice ?? 0);
    const shareSize = Number(pos.shareSize ?? 0);
    
    if (!entryPrice || !shareSize) return null;
    const currentPrice = await fetchMidPrice(tokenId);
    
    if (currentPrice === null || currentPrice <= 0 || currentPrice >= 1) return null;
    return { tokenId, pos, entryPrice, shareSize, currentPrice };
  });

  const resolvedPrices = await Promise.all(pricePromises);
  const activeEvaluations = resolvedPrices.filter(Boolean);

  for (const { tokenId, pos, entryPrice, shareSize, currentPrice } of activeEvaluations) {
    const remainingMinutes = settlementLeftMin;

    let slReason = null;
    if (remainingMinutes !== null) {
      const remainingSeconds = remainingMinutes * 60;
      const slRatio = currentPrice / entryPrice;

      if (remainingSeconds <= 90 && currentPrice < 0.30) {
        slReason = 'hard_exit_final_90s_below_30c';
      } else if (remainingMinutes >= 10 && slRatio <= 0.70) {
        slReason = 'stop_loss_layer_A_early_30pct';
      } else if (remainingMinutes >= 3 && slRatio <= 0.50) {
        slReason = 'stop_loss_layer_B_mid_50pct';
      } else if (remainingMinutes >= 1 && slRatio <= 0.40) {
        slReason = 'stop_loss_layer_C_late_60pct';
      }
    }

    if (slReason) {
      const proceeds = currentPrice * shareSize;
      try {
        await doSell(tokenId, shareSize, currentPrice, slReason);
      } catch (err) {
        logger.error({ component: "take-profit", tokenId: tokenId.slice(0, 20), err: err.message }, "Stop-loss sell error");
        if (err.message && err.message.toLowerCase().includes("balance")) {
          logger.warn({ component: "take-profit", tokenId: tokenId.slice(0, 20) }, "Dropping stale token with zero balance");
          removePositionFromState(bankrollState, tokenId, pos);
        }
        continue;
      }
      
      removePositionFromState(bankrollState, tokenId, pos);
      events.push({
        tokenId,
        won: false,
        closeReason: slReason,
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
      if (err.message && err.message.toLowerCase().includes("balance")) {
        logger.warn({ component: "take-profit", tokenId: tokenId.slice(0, 20) }, "Dropping stale token with zero balance");
        removePositionFromState(bankrollState, tokenId, pos);
      }
      continue;
    }

    removePositionFromState(bankrollState, tokenId, pos);
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
