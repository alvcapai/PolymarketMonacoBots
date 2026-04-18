import { executeSell } from "./executor.js";

export const TAKE_PROFIT_THRESHOLD = 0.50; // 50% gain on entry price
const MIN_TIME_LEFT_MIN = 2;               // don't sell in last 2 min (let it settle for $1)
const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST || "https://clob.polymarket.com";
const TRADE_MOCK = String(process.env.TRADE_MOCK_MODE ?? "true").toLowerCase() === "true";

const takenProfitTokens = new Set();

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

export async function checkTakeProfit(bankrollState, { settlementLeftMin = null } = {}) {
  const events = [];
  const openPositions = [...bankrollState.positions.entries()];
  if (!openPositions.length) return { events };

  // Near settlement — let the position resolve naturally for full $1 payout
  if (settlementLeftMin !== null && settlementLeftMin < MIN_TIME_LEFT_MIN) return { events };

  for (const [tokenId, pos] of openPositions) {
    if (takenProfitTokens.has(tokenId)) continue;

    const entryPrice = Number(pos.entryPrice ?? 0);
    const shareSize  = Number(pos.shareSize  ?? 0);
    if (!entryPrice || !shareSize) continue;

    const currentPrice = await fetchMidPrice(tokenId);
    if (currentPrice === null || currentPrice <= 0 || currentPrice >= 1) continue;

    const gain = (currentPrice - entryPrice) / entryPrice;
    if (gain < TAKE_PROFIT_THRESHOLD) continue;

    const proceeds = currentPrice * shareSize;

    process.stderr.write(
      `\x1b[32m[TAKE-PROFIT] token=${tokenId.slice(0, 20)}... ` +
      `entry=${entryPrice.toFixed(2)} cur=${currentPrice.toFixed(2)} ` +
      `gain=${(gain * 100).toFixed(1)}% proceeds=$${proceeds.toFixed(2)}` +
      `${TRADE_MOCK ? " [MOCK]" : ""}\x1b[0m\n`
    );

    if (!TRADE_MOCK) {
      try {
        await executeSell(tokenId, shareSize, currentPrice);
      } catch (err) {
        process.stderr.write(`\x1b[31m[TAKE-PROFIT] Erro ao vender ${tokenId.slice(0, 20)}...: ${err.message}\x1b[0m\n`);
        continue;
      }
    }

    takenProfitTokens.add(tokenId);
    events.push({
      tokenId,
      won: true,
      closeReason: "take_profit",
      redeemed: false,
      marketSettlementPrice: currentPrice,
      proceeds,
      gain,
      source: "take_profit"
    });
  }

  return { events };
}
