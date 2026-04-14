import "dotenv/config";
import { CONFIG } from "./config.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "./data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { detectRegime } from "./engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import { executeTrade, fetchUsdcBalance, transferUsdc, WITHDRAWAL_ADDRESS } from "./trade/executor.js";
import { runAutoRedeem } from "./trade/redeemer.js";
import { validateAndCalibrateSignal } from "./engines/signal-validation.js";
import {
  createBankrollState,
  syncBankroll,
  checkWithdrawal,
  recordWithdrawal,
  checkCycleFloor,
  checkEntry,
  computeStake,
  recordOpenPosition,
  formatDiagnostics,
} from "./engines/risk-management.js";
const tradedTokens = new Set();

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

applyGlobalProxyFromEnv();

function fmtTimeLeft(mins) {
  const totalSeconds = Math.max(0, Math.floor(mins * 60));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  lightRed: "\x1b[91m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m"
};

function screenWidth() {
  const w = Number(process.stdout?.columns);
  return Number.isFinite(w) && w >= 40 ? w : 80;
}

function sepLine(ch = "─") {
  const w = screenWidth();
  return `${ANSI.white}${ch.repeat(w)}${ANSI.reset}`;
}

function renderScreen(text) {
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch {
    // ignore
  }
  process.stdout.write(text);
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function padLabel(label, width) {
  const visible = stripAnsi(label).length;
  if (visible >= width) return label;
  return label + " ".repeat(width - visible);
}

function centerText(text, width) {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

const LABEL_W = 16;
function kv(label, value) {
  const l = padLabel(String(label), LABEL_W);
  return `${l}${value}`;
}

function section(title) {
  return `${ANSI.white}${title}${ANSI.reset}`;
}

function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
  if (price === null || price === undefined) {
    return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  }

  const p = Number(price);
  const prev = prevPrice === null || prevPrice === undefined ? null : Number(prevPrice);

  let color = ANSI.reset;
  let arrow = "";
  if (prev !== null && Number.isFinite(prev) && Number.isFinite(p) && p !== prev) {
    if (p > prev) {
      color = ANSI.green;
      arrow = " ↑";
    } else {
      color = ANSI.red;
      arrow = " ↓";
    }
  }

  const formatted = `${prefix}${formatNumber(p, decimals)}`;
  return `${label}: ${color}${formatted}${arrow}${ANSI.reset}`;
}

function formatSignedDelta(delta, base) {
  if (delta === null || base === null || base === 0) return `${ANSI.gray}-${ANSI.reset}`;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const pct = (Math.abs(delta) / Math.abs(base)) * 100;
  return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${pct.toFixed(2)}%`;
}

function colorByNarrative(text, narrative) {
  if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`;
  if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`;
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

function formatNarrativeValue(label, value, narrative) {
  return `${label}: ${colorByNarrative(value, narrative)}`;
}

function narrativeFromSign(x) {
  if (x === null || x === undefined || !Number.isFinite(Number(x)) || Number(x) === 0) return "NEUTRAL";
  return Number(x) > 0 ? "LONG" : "SHORT";
}

function narrativeFromRsi(rsi) {
  if (rsi === null || rsi === undefined || !Number.isFinite(Number(rsi))) return "NEUTRAL";
  const v = Number(rsi);
  if (v >= 55) return "LONG";
  if (v <= 45) return "SHORT";
  return "NEUTRAL";
}

function narrativeFromSlope(slope) {
  if (slope === null || slope === undefined || !Number.isFinite(Number(slope)) || Number(slope) === 0) return "NEUTRAL";
  return Number(slope) > 0 ? "LONG" : "SHORT";
}

function formatProbPct(p, digits = 0) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return "-";
  return `${(Number(p) * 100).toFixed(digits)}%`;
}

function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
  } catch {
    return "-";
  }
}

function getBtcSession(now = new Date()) {
  const h = now.getUTCHours();
  const inAsia = h >= 0 && h < 8;
  const inEurope = h >= 7 && h < 16;
  const inUs = h >= 13 && h < 22;

  if (inEurope && inUs) return "Europe/US overlap";
  if (inAsia && inEurope) return "Asia/Europe overlap";
  if (inAsia) return "Asia";
  if (inEurope) return "Europe";
  if (inUs) return "US";
  return "Off-hours";
}

function parsePriceToBeat(market) {
  const text = String(market?.question ?? market?.title ?? "");
  if (!text) return null;
  const m = text.match(/price\s*to\s*beat[^\d$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!m) return null;
  const raw = m[1].replace(/,/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const dumpedMarkets = new Set();
const tradedMarketSlugs = new Set();

function safeFileSlug(x) {
  return String(x ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);
}

function extractNumericFromMarket(market) {
  const directKeys = [
    "priceToBeat",
    "price_to_beat",
    "strikePrice",
    "strike_price",
    "strike",
    "threshold",
    "thresholdPrice",
    "threshold_price",
    "targetPrice",
    "target_price",
    "referencePrice",
    "reference_price"
  ];

  for (const k of directKeys) {
    const v = market?.[k];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n)) return n;
  }

  const seen = new Set();
  const stack = [{ obj: market, depth: 0 }];

  while (stack.length) {
    const { obj, depth } = stack.pop();
    if (!obj || typeof obj !== "object") continue;
    if (seen.has(obj) || depth > 6) continue;
    seen.add(obj);

    const entries = Array.isArray(obj) ? obj.entries() : Object.entries(obj);
    for (const [key, value] of entries) {
      const k = String(key).toLowerCase();
      if (value && typeof value === "object") {
        stack.push({ obj: value, depth: depth + 1 });
        continue;
      }

      if (!/(price|strike|threshold|target|beat)/i.test(k)) continue;

      const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
      if (!Number.isFinite(n)) continue;

      if (n > 1000 && n < 2_000_000) return n;
    }
  }

  return null;
}

function priceToBeatFromPolymarketMarket(market) {
  const n = extractNumericFromMarket(market);
  if (n !== null) return n;
  return parsePriceToBeat(market);
}

const marketCache = {
  market: null,
  fetchedAtMs: 0
};

async function resolveCurrentBtc15mMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }

  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < CONFIG.pollIntervalMs) {
    return marketCache.market;
  }

  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);

  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentBtc15mMarket();

  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices
    : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);

  const clobTokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

  let upTokenId = null;
  let downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());

  const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return {
      ok: false,
      reason: "missing_token_ids",
      market,
      outcomes,
      clobTokenIds,
      outcomePrices
    };
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
    upBuy = null;
    downBuy = null;
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
      up: upBuy ?? gammaYes,
      down: downBuy ?? gammaNo
    },
    orderbook: {
      up: upBookSummary,
      down: downBookSummary
    }
  };
}

async function main() {
  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({
    symbolIncludes: CONFIG.polymarket.wsSymbolFilter,
  });
  const chainlinkStream = startChainlinkPriceStream({
    aggregator: CONFIG.chainlink.assetUsdAggregator,
  });

  let prevSpotPrice = null;
  let prevCurrentPrice = null;
  let priceToBeatState = { slug: null, value: null, setAtMs: null };

  // ── Gestão de banca (Monaco Rule — legado) ──────────────────────────────
  // Usada quando ENABLE_RISK_LAYER=false (padrão). Preserva comportamento atual.
  const PROFIT_TRIGGER_USD  = 120;   // saldo que aciona o saque
  const WITHDRAWAL_AMOUNT   = 100;   // valor a sacar
  const MIN_TRADE_SIZE      = 1.0;   // mínimo de $1 por ordem (limite da rede)
  const TRADE_PCT           = 0.25;  // 25% do saldo por aposta
  const BALANCE_TTL_MS      = 30_000;

  // ── Estado de banca (nova camada de risco — ENABLE_RISK_LAYER=true) ─────
  // Encapsula ciclo, losing streak e controle de exposição.
  // Sincronizado com saldo real a cada refreshBalance().
  const bankrollState = createBankrollState(20);

  let cachedBalance      = null;
  let lastBalanceCheckMs = 0;
  let isWithdrawing      = false;    // flag anti-re-entrada

  function computeTradeSize(balanceUsdc) {
    if (!Number.isFinite(balanceUsdc) || balanceUsdc <= 0) return MIN_TRADE_SIZE;
    return Math.max(balanceUsdc * TRADE_PCT, MIN_TRADE_SIZE);
  }

  async function refreshBalance() {
    const now = Date.now();
    if (now - lastBalanceCheckMs < BALANCE_TTL_MS && cachedBalance !== null) return cachedBalance;
    const bal = await fetchUsdcBalance();
    if (bal !== null) {
      cachedBalance      = bal;
      lastBalanceCheckMs = now;
    }
    return cachedBalance;
  }

  const header = [
    "timestamp",
    "entry_minute",
    "time_left_min",
    "regime",
    "signal",
    "model_up",
    "model_down",
    "mkt_up",
    "mkt_down",
    "edge_up",
    "edge_down",
    "recommendation"
  ];

  // Resgate automático a cada 2 minutos
  const REDEEM_INTERVAL_MS = 2 * 60 * 1000;
  let lastRedeemCheckMs = 0;

  while (true) {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    // ── Auto-redeem: resgata posições vencedoras a cada 2 min ─────────────
    const nowMs = Date.now();
    if (nowMs - lastRedeemCheckMs >= REDEEM_INTERVAL_MS) {
      lastRedeemCheckMs = nowMs;
      runAutoRedeem().catch(err =>
        process.stderr.write(`\x1b[31m[REDEEM] Erro inesperado: ${err.message}\x1b[0m\n`)
      );
    }

    // ── Regra de saque ────────────────────────────────────────────────────
    // ENABLE_RISK_LAYER=true  → gatilho $150, reset para $50 (nova spec)
    // ENABLE_RISK_LAYER=false → Monaco Rule legada ($120/$100, comportamento atual)
    const currentBalance = await refreshBalance();

    if (CONFIG.enableRiskLayer) {
      // Sincroniza estado de banca com saldo real antes de qualquer checagem
      syncBankroll(bankrollState, currentBalance);

      // Verifica floor de ciclo
      const floorCheck = checkCycleFloor(bankrollState);
      if (floorCheck.cycleEnded) {
        process.stderr.write(
          `\x1b[31m[RISK] Ciclo ${bankrollState.cycleNumber} encerrado — ${floorCheck.reason}. Novas entradas bloqueadas.\x1b[0m\n`
        );
      }

      // Saque automático quando bankroll >= $150
      const withdrawalCheck = checkWithdrawal(bankrollState);
      if (withdrawalCheck.shouldWithdraw && !isWithdrawing) {
        isWithdrawing = true;
        const { withdrawAmount, resetTo } = withdrawalCheck;
        console.log(
          `\n\x1b[1m\x1b[32m╔══════════════════════════════════════════════════════════════╗\x1b[0m\n` +
          `\x1b[1m\x1b[32m║  SALDO $${(bankrollState.bankroll).toFixed(2)} ≥ $150 — INICIANDO SAQUE AUTOMÁTICO.        ║\x1b[0m\n` +
          `\x1b[1m\x1b[32m╚══════════════════════════════════════════════════════════════╝\x1b[0m\n` +
          `\x1b[32m  Transferindo $${withdrawAmount} → ${WITHDRAWAL_ADDRESS} (reset banca → $${resetTo})\x1b[0m\n`
        );
        try {
          const result = await transferUsdc(WITHDRAWAL_ADDRESS, withdrawAmount);
          console.log(
            `\n\x1b[1m\x1b[32m  ✔  SAQUE $${withdrawAmount} EXECUTADO — banca resetada para $${resetTo} (ciclo ${bankrollState.cycleNumber + 1}).\x1b[0m\n` +
            `\x1b[32m     Tx: ${result.txHash ?? "(mock)"}\x1b[0m\n`
          );
          recordWithdrawal(bankrollState);
          cachedBalance      = resetTo;
          lastBalanceCheckMs = Date.now();
        } catch (withdrawErr) {
          console.error(`\x1b[31m[SAQUE] Falha na transferência: ${withdrawErr?.message ?? String(withdrawErr)}\x1b[0m`);
        } finally {
          isWithdrawing = false;
        }
      }
    } else {
      // ── Monaco Rule legada: saca quando saldo >= $120 ──────────────────
      if (currentBalance !== null && currentBalance >= PROFIT_TRIGGER_USD && !isWithdrawing) {
        isWithdrawing = true;
        console.log(
          `\n\x1b[1m\x1b[32m╔══════════════════════════════════════════════════════════════╗\x1b[0m\n` +
          `\x1b[1m\x1b[32m║  SALDO $${currentBalance.toFixed(2)} ≥ $${PROFIT_TRIGGER_USD} — INICIANDO SAQUE AUTOMÁTICO.   ║\x1b[0m\n` +
          `\x1b[1m\x1b[32m╚══════════════════════════════════════════════════════════════╝\x1b[0m\n` +
          `\x1b[32m  Transferindo $${WITHDRAWAL_AMOUNT} → ${WITHDRAWAL_ADDRESS}\x1b[0m\n`
        );
        try {
          const result = await transferUsdc(WITHDRAWAL_ADDRESS, WITHDRAWAL_AMOUNT);
          console.log(
            `\n\x1b[1m\x1b[32m  ✔  SAQUE AUTOMÁTICO DE $${WITHDRAWAL_AMOUNT} EXECUTADO PARA CARTEIRA SEGURA.\x1b[0m\n` +
            `\x1b[32m     Tx: ${result.txHash ?? "(mock)"}\x1b[0m\n`
          );
          cachedBalance      = Math.max((cachedBalance ?? currentBalance) - WITHDRAWAL_AMOUNT, 0);
          lastBalanceCheckMs = Date.now();
        } catch (withdrawErr) {
          console.error(`\x1b[31m[SAQUE] Falha na transferência: ${withdrawErr?.message ?? String(withdrawErr)}\x1b[0m`);
        } finally {
          isWithdrawing = false;
        }
      }
    }

    const wsTick = binanceStream.getLast();
    const wsPrice = wsTick?.price ?? null;

    const polymarketWsTick = polymarketLiveStream.getLast();
    const polymarketWsPrice = polymarketWsTick?.price ?? null;

    const chainlinkWsTick = chainlinkStream.getLast();
    const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

    try {
      const chainlinkPromise = polymarketWsPrice !== null
        ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
        : chainlinkWsPrice !== null
          ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkBtcUsd();

      const [klines1m, klines5m, lastPrice, chainlink, poly] = await Promise.all([
        fetchKlines({ interval: "1m", limit: 240 }),
        fetchKlines({ interval: "5m", limit: 200 }),
        fetchLastPrice(),
        chainlinkPromise,
        fetchPolymarketSnapshot()
      ]);

      const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;

      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

      const candles = klines1m;
      const closes = candles.map((c) => c.close);

      const vwap = computeSessionVwap(candles);
      const vwapSeries = computeVwapSeries(candles);
      const vwapNow = vwapSeries[vwapSeries.length - 1];

      const lookback = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
      const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

      const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      const rsiSeries = [];
      for (let i = 0; i < closes.length; i += 1) {
        const sub = closes.slice(0, i + 1);
        const r = computeRsi(sub, CONFIG.rsiPeriod);
        if (r !== null) rsiSeries.push(r);
      }
      const rsiMa = sma(rsiSeries, CONFIG.rsiMaPeriod);
      const rsiSlope = slopeLast(rsiSeries, 3);

      const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);

      const ha = computeHeikenAshi(candles);
      const consec = countConsecutive(ha);

      const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
      const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
      const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;

      const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
        ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
        : false;

      const regimeInfo = detectRegime({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        vwapCrossCount,
        volumeRecent,
        volumeAvg
      });

      const scored = scoreDirection({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        rsi: rsiNow,
        rsiSlope,
        macd,
        heikenColor: consec.color,
        heikenCount: consec.count,
        failedVwapReclaim
      });

      const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);

      const marketUp = poly.ok ? poly.prices.up : null;
      const marketDown = poly.ok ? poly.prices.down : null;
      const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });

      const rec = decide({ remainingMinutes: timeLeftMin, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown });

      const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";

      const macdLabel = macd === null
        ? "-"
        : macd.hist < 0
          ? (macd.histDelta !== null && macd.histDelta < 0 ? "bearish (expanding)" : "bearish")
          : (macd.histDelta !== null && macd.histDelta > 0 ? "bullish (expanding)" : "bullish");

      const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
      const lastClose = lastCandle?.close ?? null;
      const close1mAgo = klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null;
      const close3mAgo = klines1m.length >= 4 ? klines1m[klines1m.length - 4]?.close ?? null : null;
      const delta1m = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
      const delta3m = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;

      const haNarrative = (consec.color ?? "").toLowerCase() === "green" ? "LONG" : (consec.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
      const rsiNarrative = narrativeFromSlope(rsiSlope);
      const macdNarrative = narrativeFromSign(macd?.hist ?? null);
      const vwapNarrative = narrativeFromSign(vwapDist);

      const pLong = timeAware?.adjustedUp ?? null;
      const pShort = timeAware?.adjustedDown ?? null;
      const predictNarrative = (pLong !== null && pShort !== null && Number.isFinite(pLong) && Number.isFinite(pShort))
        ? (pLong > pShort ? "LONG" : pShort > pLong ? "SHORT" : "NEUTRAL")
        : "NEUTRAL";
      const predictValue = `${ANSI.green}LONG${ANSI.reset} ${ANSI.green}${formatProbPct(pLong, 0)}${ANSI.reset} / ${ANSI.red}SHORT${ANSI.reset} ${ANSI.red}${formatProbPct(pShort, 0)}${ANSI.reset}`;
      const predictLine = `Predict: ${predictValue}`;

      const marketUpStr = `${marketUp ?? "-"}${marketUp === null || marketUp === undefined ? "" : "¢"}`;
      const marketDownStr = `${marketDown ?? "-"}${marketDown === null || marketDown === undefined ? "" : "¢"}`;
      const polyHeaderValue = `${ANSI.green}↑ UP${ANSI.reset} ${marketUpStr}  |  ${ANSI.red}↓ DOWN${ANSI.reset} ${marketDownStr}`;

      const heikenValue = `${consec.color ?? "-"} x${consec.count}`;
      const heikenLine = formatNarrativeValue("Heiken Ashi", heikenValue, haNarrative);

      const rsiArrow = rsiSlope !== null && rsiSlope < 0 ? "↓" : rsiSlope !== null && rsiSlope > 0 ? "↑" : "-";
      const rsiValue = `${formatNumber(rsiNow, 1)} ${rsiArrow}`;
      const rsiLine = formatNarrativeValue("RSI", rsiValue, rsiNarrative);

      const macdLine = formatNarrativeValue("MACD", macdLabel, macdNarrative);

      const delta1Narrative = narrativeFromSign(delta1m);
      const delta3Narrative = narrativeFromSign(delta3m);
      const deltaValue = `${colorByNarrative(formatSignedDelta(delta1m, lastClose), delta1Narrative)} | ${colorByNarrative(formatSignedDelta(delta3m, lastClose), delta3Narrative)}`;
      const deltaLine = `Delta 1/3Min: ${deltaValue}`;

      const vwapValue = `${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)}) | slope: ${vwapSlopeLabel}`;
      const vwapLine = formatNarrativeValue("VWAP", vwapValue, vwapNarrative);

      const signal = rec.action === "ENTER" ? (rec.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE";

      const actionLine = rec.action === "ENTER"
        ? `${rec.action} NOW (${rec.phase} ENTRY)`
        : `NO TRADE (${rec.phase})`;

      const spreadUp = poly.ok ? poly.orderbook.up.spread : null;
      const spreadDown = poly.ok ? poly.orderbook.down.spread : null;

      const spread = spreadUp !== null && spreadDown !== null ? Math.max(spreadUp, spreadDown) : (spreadUp ?? spreadDown);
      const liquidity = poly.ok
        ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null)
        : null;

      const spotPrice = wsPrice ?? lastPrice;
      const currentPrice = chainlink?.price ?? null;
      const marketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";
      const marketStartMs = poly.ok && poly.market?.eventStartTime ? new Date(poly.market.eventStartTime).getTime() : null;

      if (marketSlug && priceToBeatState.slug !== marketSlug) {
        priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
      }

      if (priceToBeatState.slug && priceToBeatState.value === null && currentPrice !== null) {
        const nowMs = Date.now();
        const okToLatch = marketStartMs === null ? true : nowMs >= marketStartMs;
        if (okToLatch) {
          priceToBeatState = { slug: priceToBeatState.slug, value: Number(currentPrice), setAtMs: nowMs };
        }
      }

      const priceToBeat = priceToBeatState.slug === marketSlug ? priceToBeatState.value : null;
      const currentPriceBaseLine = colorPriceLine({
        label: "CURRENT PRICE",
        price: currentPrice,
        prevPrice: prevCurrentPrice,
        decimals: 2,
        prefix: "$"
      });

      const ptbDelta = (currentPrice !== null && priceToBeat !== null && Number.isFinite(currentPrice) && Number.isFinite(priceToBeat))
        ? currentPrice - priceToBeat
        : null;
      const ptbDeltaColor = ptbDelta === null
        ? ANSI.gray
        : ptbDelta > 0
          ? ANSI.green
          : ptbDelta < 0
            ? ANSI.red
            : ANSI.gray;
      const ptbDeltaText = ptbDelta === null
        ? `${ANSI.gray}-${ANSI.reset}`
        : `${ptbDeltaColor}${ptbDelta > 0 ? "+" : ptbDelta < 0 ? "-" : ""}$${Math.abs(ptbDelta).toFixed(2)}${ANSI.reset}`;
      const currentPriceValue = currentPriceBaseLine.split(": ")[1] ?? currentPriceBaseLine;
      const currentPriceLine = kv("CURRENT PRICE:", `${currentPriceValue} (${ptbDeltaText})`);

      if (poly.ok && poly.market && priceToBeatState.value === null) {
        const slug = safeFileSlug(poly.market.slug || poly.market.id || "market");
        if (slug && !dumpedMarkets.has(slug)) {
          dumpedMarkets.add(slug);
          try {
            fs.mkdirSync("./logs", { recursive: true });
            fs.writeFileSync(path.join("./logs", `polymarket_market_${slug}.json`), JSON.stringify(poly.market, null, 2), "utf8");
          } catch {
            // ignore
          }
        }
      }

      const binanceSpotBaseLine = colorPriceLine({ label: "BTC (Binance)", price: spotPrice, prevPrice: prevSpotPrice, decimals: 0, prefix: "$" });
      const diffLine = (spotPrice !== null && currentPrice !== null && Number.isFinite(spotPrice) && Number.isFinite(currentPrice) && currentPrice !== 0)
        ? (() => {
          const diffUsd = spotPrice - currentPrice;
          const diffPct = (diffUsd / currentPrice) * 100;
          const sign = diffUsd > 0 ? "+" : diffUsd < 0 ? "-" : "";
          return ` (${sign}$${Math.abs(diffUsd).toFixed(2)}, ${sign}${Math.abs(diffPct).toFixed(2)}%)`;
        })()
        : "";
      const binanceSpotLine = `${binanceSpotBaseLine}${diffLine}`;
      const binanceSpotValue = binanceSpotLine.split(": ")[1] ?? binanceSpotLine;
      const binanceSpotKvLine = kv("BTC (Binance):", binanceSpotValue);

      const titleLine = poly.ok ? `${poly.market?.question ?? "-"}` : "-";
      const marketLine = kv("Market:", poly.ok ? (poly.market?.slug ?? "-") : "-");

      const timeColor = timeLeftMin >= 10 && timeLeftMin <= 15
        ? ANSI.green
        : timeLeftMin >= 5 && timeLeftMin < 10
          ? ANSI.yellow
          : timeLeftMin >= 0 && timeLeftMin < 5
            ? ANSI.red
            : ANSI.reset;
      const timeLeftLine = `⏱ Time left: ${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`;

      const polyTimeLeftColor = settlementLeftMin !== null
        ? (settlementLeftMin >= 10 && settlementLeftMin <= 15
          ? ANSI.green
          : settlementLeftMin >= 5 && settlementLeftMin < 10
            ? ANSI.yellow
            : settlementLeftMin >= 0 && settlementLeftMin < 5
              ? ANSI.red
              : ANSI.reset)
        : ANSI.reset;

      const lines = [
        titleLine,
        marketLine,
        kv("Time left:", `${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`),
        "",
        sepLine(),
        "",
        kv("TA Predict:", predictValue),
        kv("Heiken Ashi:", heikenLine.split(": ")[1] ?? heikenLine),
        kv("RSI:", rsiLine.split(": ")[1] ?? rsiLine),
        kv("MACD:", macdLine.split(": ")[1] ?? macdLine),
        kv("Delta 1/3:", deltaLine.split(": ")[1] ?? deltaLine),
        kv("VWAP:", vwapLine.split(": ")[1] ?? vwapLine),
        "",
        sepLine(),
        "",
        kv("POLYMARKET:", polyHeaderValue),
        liquidity !== null ? kv("Liquidity:", formatNumber(liquidity, 0)) : null,
        settlementLeftMin !== null ? kv("Time left:", `${polyTimeLeftColor}${fmtTimeLeft(settlementLeftMin)}${ANSI.reset}`) : null,
        priceToBeat !== null ? kv("PRICE TO BEAT: ", `$${formatNumber(priceToBeat, 0)}`) : kv("PRICE TO BEAT: ", `${ANSI.gray}-${ANSI.reset}`),
        currentPriceLine,
        "",
        sepLine(),
        "",
        binanceSpotKvLine,
        "",
        sepLine(),
        "",
        kv("ET | Session:", `${ANSI.white}${fmtEtTime(new Date())}${ANSI.reset} | ${ANSI.white}${getBtcSession(new Date())}${ANSI.reset}`),
        "",
        sepLine(),
        centerText(`${ANSI.dim}${ANSI.gray}PolymarketBTCAssistant [${CONFIG.timeframe}]${ANSI.reset}`, screenWidth())
      ].filter((x) => x !== null);

      renderScreen(lines.join("\n") + "\n");

      prevSpotPrice = spotPrice ?? prevSpotPrice;
      prevCurrentPrice = currentPrice ?? prevCurrentPrice;

      appendCsvRow(CONFIG.signalsCsv, header, [
        new Date().toISOString(),
        timing.elapsedMinutes.toFixed(3),
        timeLeftMin.toFixed(3),
        regimeInfo.regime,
        signal,
        timeAware.adjustedUp,
        timeAware.adjustedDown,
        marketUp,
        marketDown,
        edge.edgeUp,
        edge.edgeDown,
        rec.action === "ENTER" ? `${rec.side}:${rec.phase}:${rec.strength}` : "NO_TRADE"
      ]);

      // AUTO-TRADE: dispara no máximo uma ordem por marketSlug quando a confiança entra em zona extrema.
      const pLongPct  = Number.isFinite(Number(pLong))  ? Number(pLong)  * 100 : null;
      const pShortPct = Number.isFinite(Number(pShort)) ? Number(pShort) * 100 : null;
      const extremeLong  = pLongPct  !== null && pLongPct  >= CONFIG.tradeThreshold;
      const extremeShort = pShortPct !== null && pShortPct >= CONFIG.tradeThreshold;
      const canTradeThisMarket = poly.ok && marketSlug && !tradedMarketSlugs.has(marketSlug);

      // ── Log de rejeição explícito para depuração ─────────────────────────
      if (!extremeLong && !extremeShort) {
        const longStr  = pLongPct  !== null ? `LONG ${pLongPct.toFixed(1)}%`  : "LONG -";
        const shortStr = pShortPct !== null ? `SHORT ${pShortPct.toFixed(1)}%` : "SHORT -";
        process.stderr.write(
          `\x1b[90m[AUTO-TRADE] Confiança abaixo do threshold ${CONFIG.tradeThreshold}% — ${longStr} / ${shortStr} — sem ordem.\x1b[0m\n`
        );
      } else if (!canTradeThisMarket) {
        const reason = !poly.ok
          ? "mercado Polymarket indisponível"
          : !marketSlug
          ? "slug do mercado vazio"
          : `mercado já operado (${marketSlug})`;
        process.stderr.write(
          `\x1b[33m[AUTO-TRADE] Sinal atingiu threshold mas trade bloqueado: ${reason}.\x1b[0m\n`
        );
      }

      if (canTradeThisMarket && (extremeLong || extremeShort)) {
        const targetTokenId = extremeLong ? poly.tokens.upTokenId : poly.tokens.downTokenId;
        const rawPrice      = extremeLong
          ? (poly.orderbook.up.bestAsk   ?? poly.prices.up)
          : (poly.orderbook.down.bestAsk ?? poly.prices.down);
        const targetProbability = extremeLong ? pLongPct : pShortPct;
        const targetSide = extremeLong ? "LONG" : "SHORT";

        // Slippage: somar 1 tick (0.01) ao bestAsk para aumentar chance de fill.
        // O order book é lido segundos antes do envio — o mercado pode ter movido.
        // Cap em 0.97 para não pagar acima do valor justo. Configurável via TRADE_SLIPPAGE.
        const SLIPPAGE = Math.abs(Number(process.env.TRADE_SLIPPAGE ?? 0.01));
        const rawPriceNum = Number(rawPrice);
        const targetPrice = Number.isFinite(rawPriceNum)
          ? Math.min(Math.round((rawPriceNum + SLIPPAGE) * 100) / 100, 0.97)
          : rawPriceNum;

        // ── Sizing: seleciona legado ou nova camada de risco ─────────────────
        const balanceNow = await refreshBalance();
        let tradeSizeUsd;

        if (CONFIG.enableRiskLayer) {
          // ── Nova camada de risco ────────────────────────────────────────
          // 1. Validação/calibração do sinal
          const validatedSignal = CONFIG.enableSignalValidation
            ? validateAndCalibrateSignal(timeAware.adjustedUp, timeAware.adjustedDown)
            : { prob_model_up: timeAware.adjustedUp, prob_model_down: timeAware.adjustedDown, warning: "validation_disabled" };

          const probModel   = extremeLong ? validatedSignal.prob_model_up : validatedSignal.prob_model_down;
          const edgeForSide = extremeLong ? edge.edgeUp : edge.edgeDown;
          const mktProbSide = extremeLong ? edge.marketUp : edge.marketDown;

          if (validatedSignal.warning && validatedSignal.warning !== "validation_disabled") {
            process.stderr.write(`\x1b[90m[SIGNAL-VALIDATION] ${validatedSignal.warning}\x1b[0m\n`);
          }

          // 2. Verifica ciclo encerrado
          if (bankrollState.cycleEnded) {
            process.stderr.write(`\x1b[31m[RISK] Entrada bloqueada — ciclo encerrado (banca insuficiente).\x1b[0m\n`);
            tradeSizeUsd = 0; // garante que não entra
          } else {
            // 3. Calcula stake
            syncBankroll(bankrollState, balanceNow);
            tradeSizeUsd = computeStake(bankrollState, edgeForSide ?? 0);

            // 4. Verifica todas as condições de entrada
            const entryCheck = checkEntry(bankrollState, probModel, edgeForSide ?? 0);

            process.stderr.write(
              `\x1b[36m[RISK] ${formatDiagnostics(bankrollState, probModel, edgeForSide, mktProbSide, tradeSizeUsd)}\x1b[0m\n`
            );

            if (!entryCheck.canEnter) {
              process.stderr.write(
                `\x1b[33m[RISK] Entrada recusada — ${entryCheck.reason} (${targetSide})\x1b[0m\n`
              );
              tradeSizeUsd = 0; // bloqueia a execução abaixo
            }
          }
        } else {
          // ── Gestão de banca legada: 25% do saldo ───────────────────────
          if (balanceNow !== null) {
            tradeSizeUsd = computeTradeSize(balanceNow);
            process.stderr.write(
              `\x1b[36m[AUTO-TRADE] Saldo USDC: $${balanceNow.toFixed(2)} → tamanho ${(TRADE_PCT * 100).toFixed(0)}%: $${tradeSizeUsd.toFixed(2)}\x1b[0m\n`
            );
          } else {
            tradeSizeUsd = Math.max(Number(process.env.TRADE_SIZE_USDC || "5"), MIN_TRADE_SIZE);
            process.stderr.write(
              `\x1b[33m[AUTO-TRADE] AVISO — saldo USDC não consultado (API indisponível). Usando fallback: $${tradeSizeUsd.toFixed(2)}\x1b[0m\n`
            );
          }
        }

        // ── Validações pré-execução e envio da ordem ──────────────────────
        if (!targetTokenId) {
          process.stderr.write(`\x1b[31m[AUTO-TRADE] BLOQUEADO — tokenId do outcome ${targetSide} ausente (mercado: ${marketSlug}).\x1b[0m\n`);
        } else if (tradedTokens.has(targetTokenId)) {
          process.stderr.write(`\x1b[33m[AUTO-TRADE] BLOQUEADO — tokenId ${targetTokenId} já operado nesta sessão.\x1b[0m\n`);
        } else if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
          process.stderr.write(`\x1b[31m[AUTO-TRADE] BLOQUEADO — preço inválido para ${targetSide}: rawPrice=${rawPrice} (mercado: ${marketSlug}).\x1b[0m\n`);
        } else if (!Number.isFinite(tradeSizeUsd) || tradeSizeUsd < MIN_TRADE_SIZE) {
          process.stderr.write(`\x1b[31m[AUTO-TRADE] BLOQUEADO — tamanho de trade abaixo do mínimo: $${tradeSizeUsd?.toFixed(2) ?? tradeSizeUsd} < $${MIN_TRADE_SIZE} (saldo: ${balanceNow}).\x1b[0m\n`);
        } else {
          const isMockMode = String(process.env.TRADE_MOCK_MODE ?? "true").toLowerCase() === "true";
          process.stderr.write(
            `\x1b[32m[AUTO-TRADE] DISPARANDO ordem ${targetSide}${isMockMode ? " \x1b[33m[MOCK]\x1b[32m" : " \x1b[1m[REAL]\x1b[22m\x1b[32m"}` +
            ` — confiança ${targetProbability.toFixed(1)}%` +
            ` | tamanho $${tradeSizeUsd.toFixed(2)} | rawAsk ${rawPriceNum.toFixed(4)} + slippage ${SLIPPAGE} = ${targetPrice.toFixed(2)}` +
            ` | token ${targetTokenId}\x1b[0m\n`
          );
          try {
            // Marca token ANTES para evitar disparo duplo concorrente no mesmo ciclo.
            // Em caso de falha, é removido no catch para permitir nova tentativa.
            tradedTokens.add(targetTokenId);
            await executeTrade(
              targetTokenId,
              "BUY",
              tradeSizeUsd,
              targetPrice,
              Number(targetProbability)
            );
            // Só marca mercado como operado APÓS confirmação de sucesso real da API.
            tradedMarketSlugs.add(marketSlug);
            lastBalanceCheckMs = 0;
            if (CONFIG.enableRiskLayer) {
              recordOpenPosition(bankrollState, tradeSizeUsd);
            }
            process.stderr.write(`\x1b[32m[AUTO-TRADE] Ordem ${targetSide} confirmada pela API (${marketSlug}).\x1b[0m\n`);
          } catch (tradeError) {
            // Falha real: remove dos sets para permitir nova tentativa no próximo ciclo.
            tradedTokens.delete(targetTokenId);
            const errMsg = tradeError?.message ?? String(tradeError);
            process.stderr.write(
              `\x1b[31m[AUTO-TRADE] FALHA na ordem ${targetSide} — ${errMsg}\x1b[0m\n` +
              `\x1b[31m[AUTO-TRADE] Tokens sets limpos — nova tentativa no próximo ciclo com sinal ≥${CONFIG.tradeThreshold}%.\x1b[0m\n`
            );
          }
        }
      }
    } catch (err) {
      // Erro no loop principal — vai para stderr para não ser apagado pelo renderScreen
      process.stderr.write(
        `\x1b[31m[LOOP] ERRO no ciclo principal — bloco de trade pode não ter sido alcançado:\x1b[0m\n` +
        `\x1b[31m  ${err?.stack ?? err?.message ?? String(err)}\x1b[0m\n`
      );
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

main();
