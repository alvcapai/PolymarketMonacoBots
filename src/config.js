/**
 * TIMEFRAME env var seleciona o modo de operação do bot.
 * Formato: "<ativo>-<janela>"
 *   btc-15m  →  BTC 15 minutos  (padrão)
 *   btc-5m   →  BTC  5 minutos
 *   eth-15m  →  ETH 15 minutos
 *   eth-5m   →  ETH  5 minutos
 *
 * Scripts package.json:
 *   npm run start:btc15m  |  start:btc5m  |  start:eth15m  |  start:eth5m
 */

const TIMEFRAME = (process.env.TIMEFRAME || "btc-15m").trim().toLowerCase();

// Normalise legacy values: "15m" → "btc-15m", "5m" → "btc-5m"
const tfNorm = TIMEFRAME.includes("-") ? TIMEFRAME : `btc-${TIMEFRAME}`;
const [ASSET, WINDOW] = tfNorm.split("-");   // e.g. ["btc", "15m"]
const is5m   = WINDOW === "5m";
const isEth  = ASSET  === "eth";

// ─── Per-asset static config ──────────────────────────────────────────────────
const ASSET_CFG = {
  btc: {
    symbol:         "BTCUSDT",
    seriesId15m:    "10192",
    seriesSlug15m:  "btc-up-or-down-15m",
    seriesId5m:     "10684",
    seriesSlug5m:   "btc-up-or-down-5m",
    tradeThreshold: 75,
    // Chainlink BTC/USD on Polygon mainnet
    aggregator:     process.env.CHAINLINK_BTC_USD_AGGREGATOR
                    || "0xc907E116054Ad103354f2D350FD2514433D57F6f",
    wsSymbolFilter: "btc",
  },
  eth: {
    symbol:         "ETHUSDT",
    seriesId15m:    "10191",
    seriesSlug15m:  "eth-up-or-down-15m",
    seriesId5m:     "10683",
    seriesSlug5m:   "eth-up-or-down-5m",
    tradeThreshold: 75,
    // Chainlink ETH/USD on Polygon mainnet
    aggregator:     process.env.CHAINLINK_ETH_USD_AGGREGATOR
                    || "0xF9680D99D6C9589e2a93a78A04A279e509205945",
    wsSymbolFilter: "eth",
  },
};

const ac = ASSET_CFG[ASSET] ?? ASSET_CFG.btc;

export const CONFIG = {
  symbol:  process.env.BINANCE_SYMBOL || ac.symbol,
  timeframe: `${ASSET}-${WINDOW}`,
  asset:    ASSET,

  binanceBaseUrl: "https://api.binance.com",
  gammaBaseUrl:   "https://gamma-api.polymarket.com",
  clobBaseUrl:    "https://clob.polymarket.com",

  pollIntervalMs:          1_000,
  candleWindowMinutes:     is5m ? 5 : 15,
  vwapSlopeLookbackMinutes: is5m ? 3 : 5,

  rsiPeriod:   14,
  rsiMaPeriod: 14,
  macdFast:    12,
  macdSlow:    26,
  macdSignal:  9,

  // Trigger threshold (% probability)
  tradeThreshold: ac.tradeThreshold,

  // ── Feature flags de risco (opt-in) ───────────────────────────────────────
  // ENABLE_RISK_LAYER=true     → ativa bankroll cycle, stake por edge, losing streak
  // ENABLE_ASSISTANT_SIGNAL_VALIDATION=true → comprime score heurístico antes de usar como prob_modelo
  // Padrão false preserva o comportamento existente sem nenhuma mudança.
  enableRiskLayer:          (process.env.ENABLE_RISK_LAYER                      || "false").toLowerCase() === "true",
  enableSignalValidation:   (process.env.ENABLE_ASSISTANT_SIGNAL_VALIDATION     || "false").toLowerCase() === "true",

  // CSV log path — one file per mode
  signalsCsv: `./logs/signals-${ASSET}-${WINDOW}.csv`,

  polymarket: {
    marketSlug:      process.env.POLYMARKET_SLUG || "",
    seriesId:        process.env.POLYMARKET_SERIES_ID  || (is5m ? ac.seriesId5m  : ac.seriesId15m),
    seriesSlug:      process.env.POLYMARKET_SERIES_SLUG || (is5m ? ac.seriesSlug5m : ac.seriesSlug15m),
    autoSelectLatest: (process.env.POLYMARKET_AUTO_SELECT_LATEST || "true").toLowerCase() === "true",
    liveDataWsUrl:   process.env.POLYMARKET_LIVE_WS_URL || "wss://ws-live-data.polymarket.com",
    upOutcomeLabel:  process.env.POLYMARKET_UP_LABEL   || "Up",
    downOutcomeLabel: process.env.POLYMARKET_DOWN_LABEL || "Down",
    wsSymbolFilter:  ac.wsSymbolFilter,
  },

  chainlink: {
    polygonRpcUrls:   (process.env.POLYGON_RPC_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonRpcUrl:    process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com",
    polygonWssUrls:   (process.env.POLYGON_WSS_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonWssUrl:    process.env.POLYGON_WSS_URL || "",
    // Generic "asset aggregator" — automatically BTC or ETH based on TIMEFRAME
    assetUsdAggregator: ac.aggregator,
    // Keep btcUsdAggregator for backward compatibility
    btcUsdAggregator: ASSET_CFG.btc.aggregator,
  },
};
