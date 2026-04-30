import { fetchKlines, fetchLastPrice } from "../data/binance.js";
import { fetchChainlinkBtcUsd } from "../data/chainlink.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "../data/polymarket.js";

const marketCache = {
  market: null,
  fetchedAtMs: 0
};

export async function resolveCurrentMarket(config) {
  if (config.polymarket.marketSlug) {
    return await fetchMarketBySlug(config.polymarket.marketSlug);
  }

  if (!config.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < config.pollIntervalMs) {
    return marketCache.market;
  }

  const events = await fetchLiveEventsBySeriesId({ seriesId: config.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);
  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

export async function fetchPolymarketSnapshot(config) {
  try {
    const market = await resolveCurrentMarket(config);
    if (!market) return { ok: false, reason: "market_not_found" };

    const outcomes = Array.isArray(market.outcomes)
      ? market.outcomes
      : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
    const outcomePrices = Array.isArray(market.outcomePrices)
      ? market.outcomePrices
      : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);
    const clobTokenIds = Array.isArray(market.clobTokenIds)
      ? market.clobTokenIds
      : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

    let upTokenId = null;
    let downTokenId = null;
    for (let i = 0; i < outcomes.length; i += 1) {
      const label = String(outcomes[i]).toLowerCase();
      const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
      if (!tokenId) continue;
      if (label === config.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
      if (label === config.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
    }

    const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === config.polymarket.upOutcomeLabel.toLowerCase());
    const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === config.polymarket.downOutcomeLabel.toLowerCase());
    const gammaUp = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
    const gammaDown = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

    if (!upTokenId || !downTokenId) {
      return { ok: false, reason: "missing_token_ids", market };
    }

    let upBuy = null;
    let downBuy = null;
    let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
    let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };

    try {
      const [yesBuy, noBuy, upBook, downBook] = await Promise.all([
        fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
        fetchClobPrice({ tokenId: downTokenId, side: "buy" }),
        fetchOrderBook({ tokenId: upTokenId }),
        fetchOrderBook({ tokenId: downTokenId })
      ]);
      upBuy = yesBuy;
      downBuy = noBuy;
      upBookSummary = summarizeOrderBook(upBook);
      downBookSummary = summarizeOrderBook(downBook);
    } catch {
      upBookSummary = {
        bestBid: Number(market.bestBid) || null,
        bestAsk: Number(market.bestAsk) || null,
        spread: Number(market.spread) || null,
        bidLiquidity: null,
        askLiquidity: null
      };
      downBookSummary = {
        bestBid: null,
        bestAsk: null,
        spread: Number(market.spread) || null,
        bidLiquidity: null,
        askLiquidity: null
      };
    }

    return {
      ok: true,
      market,
      tokens: { upTokenId, downTokenId },
      prices: {
        up: upBuy ?? gammaUp,
        down: downBuy ?? gammaDown
      },
      orderbook: {
        up: upBookSummary,
        down: downBookSummary
      }
    };
  } catch (err) {
    return { ok: false, reason: "exception", error: err?.message };
  }
}

export async function aggregateMarketData(config, polymarketWsPrice, polymarketWsTick, chainlinkWsPrice, chainlinkWsTick) {
  const chainlinkPromise = polymarketWsPrice !== null
    ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
    : chainlinkWsPrice !== null
      ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
      : fetchChainlinkBtcUsd().catch(() => ({ price: null, updatedAt: null, source: "error" }));

  const binanceKlinesPromise = fetchKlines({ interval: "1m", limit: 240 }).catch(() => []);
  const binanceLastPricePromise = fetchLastPrice().catch(() => null);
  const polySnapshotPromise = fetchPolymarketSnapshot(config);

  const [klines1m, lastPrice, chainlink, poly] = await Promise.all([
    binanceKlinesPromise,
    binanceLastPricePromise,
    chainlinkPromise,
    polySnapshotPromise
  ]);

  return { klines1m, lastPrice, chainlink, poly };
}
