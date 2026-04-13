// TIMEFRAME env var selects the bot mode. Set via npm scripts (start:15m / start:5m)
// or directly: TIMEFRAME=5m node src/index.js
const TIMEFRAME = (process.env.TIMEFRAME || "15m").trim();
const is5m = TIMEFRAME === "5m";

export const CONFIG = {
  symbol: "BTCUSDT",
  binanceBaseUrl: "https://api.binance.com",
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",

  pollIntervalMs: 1_000,
  timeframe: TIMEFRAME,
  candleWindowMinutes: is5m ? 5 : 15,

  vwapSlopeLookbackMinutes: is5m ? 3 : 5,
  rsiPeriod: 14,
  rsiMaPeriod: 14,

  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  // Path for signal CSV logs — separated by timeframe
  signalsCsv: `./logs/signals-${TIMEFRAME}.csv`,

  polymarket: {
    marketSlug: process.env.POLYMARKET_SLUG || "",
    seriesId: process.env.POLYMARKET_SERIES_ID || (is5m ? "10684" : "10192"),
    seriesSlug: process.env.POLYMARKET_SERIES_SLUG || (is5m ? "btc-up-or-down-5m" : "btc-up-or-down-15m"),
    autoSelectLatest: (process.env.POLYMARKET_AUTO_SELECT_LATEST || "true").toLowerCase() === "true",
    liveDataWsUrl: process.env.POLYMARKET_LIVE_WS_URL || "wss://ws-live-data.polymarket.com",
    upOutcomeLabel: process.env.POLYMARKET_UP_LABEL || "Up",
    downOutcomeLabel: process.env.POLYMARKET_DOWN_LABEL || "Down"
  },

  chainlink: {
    polygonRpcUrls: (process.env.POLYGON_RPC_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonRpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com",
    polygonWssUrls: (process.env.POLYGON_WSS_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonWssUrl: process.env.POLYGON_WSS_URL || "",
    btcUsdAggregator: process.env.CHAINLINK_BTC_USD_AGGREGATOR || "0xc907E116054Ad103354f2D350FD2514433D57F6f"
  }
};
