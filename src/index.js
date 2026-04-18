import "dotenv/config";
import { CONFIG } from "./config.js";
import {
  createPrediction5mState,
  createPrediction5mConfig,
  scoreDirection5m,
  evaluateEntry,
  evaluateExit,
  ExitReason,
  sizeTrade,
  circuitReset,
  circuitRecordLoss,
} from "./prediction5min/index.js";
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
import { computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge } from "./engines/edge.js";
import { calibrateModelProbabilities } from "./engines/signal-validation.js";
import {
  syncBankroll,
  checkWithdrawal,
  recordWithdrawal,
  checkCycleFloor,
  decideEntry,
  recordOpenPosition,
  recordOutcomeByToken,
  formatDiagnostics,
  MIN_TRADE_SIZE,
  MAX_EXPOSURE_PCT,
} from "./engines/risk-management.js";
import { saveBankrollState, loadBankrollState } from "./engines/bankroll-persist.js";
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import readline from "node:readline";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import { executeTrade, fetchUsdcBalance, transferUsdc, WITHDRAWAL_ADDRESS } from "./trade/executor.js";
import { runAutoRedeem } from "./trade/redeemer.js";
import { recordMockEntry, checkMockOutcomes, mockPositionCount } from "./trade/mock-tracker.js";
import {
  createTradeId,
  recordTradeOpen,
  recordTradeClose,
  estimatePnlRealized
} from "./engines/trade-telemetry.js";

applyGlobalProxyFromEnv();

const is5m      = CONFIG.timeframe.endsWith("-5m");
const isMockMode = String(process.env.TRADE_MOCK_MODE ?? "true").toLowerCase() === "true";

const tradedTokens = new Set();
const tradedMarketSlugs = new Set();
let isPlacingOrder = false;

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m"
};

const BALANCE_TTL_MS = 30_000;
const REDEEM_INTERVAL_MS = 2 * 60 * 1000;
const LABEL_W = 18;
const MODEL_VERSION = "v1-edge-calibrated";

function marketTypeFromTimeframe(timeframe) {
  const [asset, window] = String(timeframe ?? "").split("-");
  if (!asset || !window) return String(timeframe ?? "UNKNOWN");
  return `${asset.toUpperCase()}${window}`;
}

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

function fmtTimeLeft(mins) {
  const totalSeconds = Math.max(0, Math.floor(mins * 60));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function screenWidth() {
  const w = Number(process.stdout?.columns);
  return Number.isFinite(w) && w >= 40 ? w : 80;
}

function sepLine(ch = "-") {
  return `${ANSI.white}${ch.repeat(screenWidth())}${ANSI.reset}`;
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

function kv(label, value) {
  return `${padLabel(String(label), LABEL_W)}${value}`;
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

function formatProbPct(p, digits = 1) {
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

function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
  if (price === null || price === undefined) {
    return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  }

  const p = Number(price);
  const prev = prevPrice === null || prevPrice === undefined ? null : Number(prevPrice);
  let color = ANSI.reset;
  let marker = "";
  if (prev !== null && Number.isFinite(prev) && Number.isFinite(p) && p !== prev) {
    color = p > prev ? ANSI.green : ANSI.red;
    marker = p > prev ? " UP" : " DOWN";
  }
  return `${label}: ${color}${prefix}${formatNumber(p, decimals)}${marker}${ANSI.reset}`;
}

function toDecisionSignal(decision) {
  if (!decision?.canEnter) return "NO TRADE";
  return decision.side === "UP" ? "BUY UP" : "BUY DOWN";
}

const marketCache = {
  market: null,
  fetchedAtMs: 0
};

async function resolveCurrentMarket() {
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
  const market = await resolveCurrentMarket();
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
    if (label === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());
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
}

async function main() {
  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({
    symbolIncludes: CONFIG.polymarket.wsSymbolFilter
  });
  const chainlinkStream = startChainlinkPriceStream({
    aggregator: CONFIG.chainlink.assetUsdAggregator
  });

  const bankrollState = loadBankrollState(CONFIG.bankrollStatePath, 20);

  const pred5mState  = is5m ? createPrediction5mState()  : null;
  const pred5mConfig = is5m ? createPrediction5mConfig() : null;

  let cachedBalance = null;
  let lastBalanceCheckMs = 0;
  let lastRedeemCheckMs = 0;
  let lastPersistMs = 0;
  let prevSpotPrice = null;
  let prevCurrentPrice = null;
  let isWithdrawing = false;
  let wasCycleEnded = false;

  const PERSIST_INTERVAL_MS = 60_000;

  function persistIfDue() {
    const now = Date.now();
    if (now - lastPersistMs >= PERSIST_INTERVAL_MS) {
      lastPersistMs = now;
      saveBankrollState(bankrollState, CONFIG.bankrollStatePath);
    }
  }

  function persistNow() {
    lastPersistMs = Date.now();
    saveBankrollState(bankrollState, CONFIG.bankrollStatePath);
  }

  async function refreshBalance() {
    const now = Date.now();
    if (cachedBalance !== null && now - lastBalanceCheckMs < BALANCE_TTL_MS) {
      return cachedBalance;
    }
    const balance = await fetchUsdcBalance();
    if (balance !== null) {
      cachedBalance = balance;
      lastBalanceCheckMs = now;
    }
    return cachedBalance;
  }

  const header = [
    "timestamp",
    "entry_minute",
    "time_left_min",
    "signal",
    "decision_reason",
    "side",
    "prob_model_up",
    "prob_model_down",
    "prob_market_up",
    "prob_market_down",
    "edge_up",
    "edge_down",
    "stake_usd"
  ];

  while (true) {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    try {
      const nowMs = Date.now();
      if (nowMs - lastRedeemCheckMs >= REDEEM_INTERVAL_MS) {
        lastRedeemCheckMs = nowMs;

        if (isMockMode) {
          // In mock mode: no real positions to redeem — check paper outcomes instead
          await checkMockOutcomes({
            csvPath:   CONFIG.mockCalibrationCsv,
            upLabel:   CONFIG.polymarket.upOutcomeLabel,
            downLabel: CONFIG.polymarket.downOutcomeLabel,
          });
        } else {
          const report = await runAutoRedeem();
          const events = Array.isArray(report?.events) ? report.events : [];
          for (const event of events) {
            const outcome = recordOutcomeByToken(bankrollState, event.tokenId, event.won);
            if (outcome.updated) {
              const position = outcome.position ?? {};
              const tradeId = String(position.tradeId ?? "").trim();
              if (tradeId) {
                const pnlRealized = estimatePnlRealized({
                  stake: position.stakeUsed ?? outcome.stakeUsed,
                  entryPrice: position.entryPrice,
                  shareSize: position.shareSize,
                  won: event.won
                });
                recordTradeClose({
                  trade_id: tradeId,
                  timestamp_close: new Date().toISOString(),
                  result: event.won ? "WIN" : "LOSS",
                  won: event.won ? 1 : 0,
                  close_reason: event.closeReason ?? event.source ?? (event.won ? "settled_win" : "settled_loss"),
                  redeemed: event.redeemed === true,
                  market_settlement_price: event.marketSettlementPrice ?? null,
                  bankroll_after: bankrollState.bankroll,
                  open_positions_after: bankrollState.openPositions,
                  total_exposure_after: bankrollState.totalExposure,
                  losing_streak_after: bankrollState.losingStreak,
                  pnl_realized: pnlRealized
                });
              }

              if (is5m && pred5mState) {
                pred5mState.hasOpenPosition = bankrollState.openPositions > 0;
                if (event.won) { circuitReset(pred5mState.circuitBreaker); }
                else           { circuitRecordLoss(pred5mState.circuitBreaker); }
              }

              process.stderr.write(
                `\x1b[35m[OUTCOME] ${event.won ? "WIN" : "LOSS"} token ${event.tokenId} | ` +
                `stake $${outcome.stakeUsed.toFixed(2)} | losingStreak=${bankrollState.losingStreak}\x1b[0m\n`
              );
              persistNow();
            }
          }
        }
      }

      const currentBalance = await refreshBalance();
      syncBankroll(bankrollState, currentBalance);
      persistIfDue();

      const floorCheck = checkCycleFloor(bankrollState);
      if (floorCheck.cycleEnded && !wasCycleEnded) {
        process.stderr.write(
          `\x1b[31m[RISK] Ciclo ${bankrollState.cycleNumber} encerrado: ${floorCheck.reason}. Novas entradas bloqueadas.\x1b[0m\n`
        );
      }
      wasCycleEnded = floorCheck.cycleEnded;

      const withdrawalCheck = checkWithdrawal(bankrollState);
      if (withdrawalCheck.shouldWithdraw && !isWithdrawing) {
        isWithdrawing = true;
        const { withdrawAmount, resetTo } = withdrawalCheck;
        process.stderr.write(
          `\x1b[32m[SAQUE] bankroll $${bankrollState.bankroll.toFixed(2)} >= $150. ` +
          `Transferindo $${withdrawAmount} para ${WITHDRAWAL_ADDRESS} (reset operacional -> $${resetTo}).\x1b[0m\n`
        );
        try {
          const result = await transferUsdc(WITHDRAWAL_ADDRESS, withdrawAmount);
          recordWithdrawal(bankrollState);
          cachedBalance = resetTo;
          lastBalanceCheckMs = Date.now();
          persistNow();
          process.stderr.write(
            `\x1b[32m[SAQUE] Concluido. Tx: ${result.txHash ?? "(mock)"} | novo ciclo=${bankrollState.cycleNumber}\x1b[0m\n`
          );
        } catch (err) {
          process.stderr.write(`\x1b[31m[SAQUE] Falha: ${err?.message ?? String(err)}\x1b[0m\n`);
        } finally {
          isWithdrawing = false;
        }
      }

      const wsTick = binanceStream.getLast();
      const wsPrice = wsTick?.price ?? null;
      const polymarketWsTick = polymarketLiveStream.getLast();
      const polymarketWsPrice = polymarketWsTick?.price ?? null;
      const chainlinkWsTick = chainlinkStream.getLast();
      const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

      const chainlinkPromise = polymarketWsPrice !== null
        ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
        : chainlinkWsPrice !== null
          ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkBtcUsd();

      const [klines1m, lastPrice, chainlink, poly] = await Promise.all([
        fetchKlines({ interval: "1m", limit: 240 }),
        fetchLastPrice(),
        chainlinkPromise,
        fetchPolymarketSnapshot()
      ]);

      const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

      const marketSnapshot5m = is5m && poly.ok ? {
        marketSlug: poly.market?.slug ?? "",
        endDate:    settlementMs,
        upPrice:    poly.prices.up   ?? null,
        downPrice:  poly.prices.down ?? null,
        upAsk:      poly.orderbook?.up?.bestAsk   ?? poly.prices.up   ?? null,
        downAsk:    poly.orderbook?.down?.bestAsk ?? poly.prices.down ?? null,
        upBid:      poly.orderbook?.up?.bestBid   ?? null,
        downBid:    poly.orderbook?.down?.bestBid ?? null,
      } : null;

      const closes = klines1m.map((c) => c.close);
      const vwapSeries = computeVwapSeries(klines1m);
      const vwapNow = vwapSeries[vwapSeries.length - 1];
      const vwapLookback = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope = vwapSeries.length >= vwapLookback
        ? (vwapNow - vwapSeries[vwapSeries.length - vwapLookback]) / vwapLookback
        : null;
      const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

      const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      const rsiSeries = [];
      for (let i = 0; i < closes.length; i += 1) {
        const rsi = computeRsi(closes.slice(0, i + 1), CONFIG.rsiPeriod);
        if (rsi !== null) rsiSeries.push(rsi);
      }
      const rsiSlope = slopeLast(rsiSeries, 3);

      const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);
      const heiken = computeHeikenAshi(klines1m);
      const consec = countConsecutive(heiken);

      const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
      const volumeRecent = klines1m.slice(-20).reduce((a, c) => a + c.volume, 0);
      const volumeAvg = klines1m.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;
      const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
        ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
        : false;

      // ── 5m-specific indicators (only computed when needed) ──────────────
      let rsi5Now = null;
      let rsiSlope5 = null;
      let macd5 = null;
      let scored5m = null;
      if (is5m) {
        rsi5Now = computeRsi(closes, 5);
        const rsiSeries5 = [];
        for (let i = 0; i < closes.length; i += 1) {
          const r = computeRsi(closes.slice(0, i + 1), 5);
          if (r !== null) rsiSeries5.push(r);
        }
        rsiSlope5 = slopeLast(rsiSeries5, 3);
        macd5 = computeMacd(closes, 5, 13, 8);
        const volumes = klines1m.map((c) => c.volume);
        scored5m = scoreDirection5m({
          closes,
          volumes,
          rsi5: rsi5Now,
          rsiSlope5,
          macd: macd5,
          heikenColor: consec.color,
          heikenCount: consec.count,
        });
      }

      // ── 15m indicators (used by 15m bots and for display on 5m) ─────────
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
      const calibrated = calibrateModelProbabilities(timeAware.adjustedUp);

      const marketUpRaw = poly.ok ? poly.prices.up : null;
      const marketDownRaw = poly.ok ? poly.prices.down : null;
      const edge = computeEdge({
        modelUp: calibrated.probModelUp,
        modelDown: calibrated.probModelDown,
        marketYes: marketUpRaw,
        marketNo: marketDownRaw
      });

      const marketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";

      if (is5m && pred5mState && marketSnapshot5m && pred5mState.hasOpenPosition) {
        const openPos = [...bankrollState.positions.values()][0];
        if (openPos) {
          const posForExit = {
            side:          openPos.side,
            entryPrice:    openPos.entryPrice ?? 0,
            shares:        openPos.shareSize  ?? 0,
            contractSize:  (openPos.entryPrice ?? 0) * (openPos.shareSize ?? 0),
            marketSlug:    openPos.marketSlug,
            marketEndDate: openPos.marketEndDateMs ?? 0,
          };
          const exitDec = evaluateExit(pred5mState, posForExit, marketSnapshot5m, pred5mConfig, new Date());
          if (exitDec.type === "exit") {
            process.stderr.write(
              `\x1b[33m[5M-EXIT] Saída recomendada: ${exitDec.reason} | token=${openPos.tokenId}\x1b[0m\n`
            );
          }
        }
      }

      let decision;
      if (is5m && pred5mState && marketSnapshot5m && scored5m) {
        const entryDec = evaluateEntry(pred5mState, marketSnapshot5m, pred5mConfig, scored5m.rawUp, new Date());
        if (entryDec.type === "enter") {
          const stake      = sizeTrade(bankrollState.bankroll, entryDec.askPrice, pred5mConfig);
          const maxExposure = bankrollState.bankroll * MAX_EXPOSURE_PCT;
          const floorOk    = !floorCheck.cycleEnded;
          const pauseOk    = !bankrollState.paused;
          const exposureOk = (bankrollState.totalExposure + stake) <= maxExposure;
          const stakeOk    = Number.isFinite(stake) && stake >= MIN_TRADE_SIZE;
          if (floorOk && pauseOk && exposureOk && stakeOk) {
            decision = {
              canEnter:   true,
              reason:     "pred5m_ok",
              side:       entryDec.side,
              probModel:  entryDec.probModel,
              probMarket: entryDec.probMarket,
              edge:       entryDec.edge,
              edgeUp:     entryDec.edgeUp,
              edgeDown:   entryDec.edgeDown,
              stake,
            };
          } else {
            const reason = !floorOk     ? "cycle_ended"
              : !pauseOk    ? "paused_losing_streak_5"
              : !exposureOk ? `exposure_${(bankrollState.totalExposure + stake).toFixed(2)}_exceeds_${maxExposure.toFixed(2)}`
              :               `stake_${stake}_below_min_${MIN_TRADE_SIZE}`;
            decision = { canEnter: false, reason, side: entryDec.side, probModel: entryDec.probModel, probMarket: entryDec.probMarket, edge: entryDec.edge, edgeUp: entryDec.edgeUp, edgeDown: entryDec.edgeDown, stake: 0 };
          }
        } else {
          decision = { canEnter: false, reason: entryDec.reason, side: null, probModel: null, probMarket: null, edge: null, edgeUp: null, edgeDown: null, stake: 0 };
        }
      } else {
        decision = decideEntry(bankrollState, {
          probModelUp:   calibrated.probModelUp,
          probModelDown: calibrated.probModelDown,
          marketProbUp:  edge.marketUp,
          marketProbDown: edge.marketDown,
          marketSlug,
        });
      }

      const signal = toDecisionSignal(decision);
      process.stderr.write(`\x1b[36m[RISK] ${formatDiagnostics(bankrollState, decision)}\x1b[0m\n`);

      const spotPrice = wsPrice ?? lastPrice;
      const currentPrice = chainlink?.price ?? null;
      const decisionColor = decision.canEnter ? ANSI.green : ANSI.yellow;

      const lines = [
        poly.ok ? String(poly.market?.question ?? "-") : "-",
        kv("Market:", poly.ok ? (poly.market?.slug ?? "-") : "-"),
        kv("Time left:", fmtTimeLeft(timeLeftMin)),
        "",
        sepLine(),
        "",
        is5m
          ? kv("Model UP/DOWN:", `${formatProbPct(decision.probModel && decision.side === "UP" ? decision.probModel : null)} / ${formatProbPct(decision.probModel && decision.side === "DOWN" ? decision.probModel : null)}`)
          : kv("Model UP/DOWN:", `${formatProbPct(calibrated.probModelUp)} / ${formatProbPct(calibrated.probModelDown)}`),
        is5m
          ? kv("Market UP/DOWN:", `${formatProbPct(marketSnapshot5m?.upAsk)} / ${formatProbPct(marketSnapshot5m?.downAsk)}`)
          : kv("Market UP/DOWN:", `${formatProbPct(edge.marketUp)} / ${formatProbPct(edge.marketDown)}`),
        is5m
          ? kv("Edge UP/DOWN:", `${formatPct(decision.edgeUp, 2)} / ${formatPct(decision.edgeDown, 2)}`)
          : kv("Edge UP/DOWN:", `${formatPct(edge.edgeUp, 2)} / ${formatPct(edge.edgeDown, 2)}`),
        kv("Decision:", `${decisionColor}${signal}${ANSI.reset} (${decision.reason})`),
        kv("Stake:", decision.canEnter ? `$${decision.stake.toFixed(2)}` : "-"),
        "",
        sepLine(),
        "",
        kv("Heiken:", `${consec.color ?? "-"} x${consec.count}`),
        is5m
          ? kv("RSI(5):", `${formatNumber(rsi5Now, 1)} | slope ${formatNumber(rsiSlope5, 2)}`)
          : kv("RSI(14):", `${formatNumber(rsiNow, 1)} | slope ${formatNumber(rsiSlope, 2)}`),
        is5m
          ? kv("MACD(5/13/8):", macd5 ? `hist ${formatNumber(macd5.hist, 4)} | Δ ${formatNumber(macd5.histDelta, 4)}` : "-")
          : kv("MACD(12/26/9):", macd ? formatNumber(macd.hist, 4) : "-"),
        kv("VWAP:", `${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)})`),
        is5m
          ? kv("5m signal:", scored5m ? `rawUp=${formatNumber(scored5m.rawUp * 100, 1)}%` : "-")
          : kv("VWAP crosses:", vwapCrossCount ?? "-"),
        is5m
          ? kv("Circuit breaker:", (() => { const cb = pred5mState.circuitBreaker; return `losses=${cb.consecutiveLosses}${cb.cooldownUntil && Date.now() < cb.cooldownUntil ? ` TRIPPED ${Math.ceil((cb.cooldownUntil - Date.now()) / 1000)}s` : " ok"}`; })())
          : kv("Volume 20/120:", `${formatNumber(volumeRecent, 0)} / ${formatNumber(volumeAvg, 0)}`),
        "",
        sepLine(),
        "",
        colorPriceLine({ label: "Current (Chainlink)", price: currentPrice, prevPrice: prevCurrentPrice, decimals: 2, prefix: "$" }),
        colorPriceLine({ label: "Spot (Binance WS)", price: spotPrice, prevPrice: prevSpotPrice, decimals: 0, prefix: "$" }),
        "",
        kv("Bankroll:", `$${bankrollState.bankroll.toFixed(2)} | cycle ${bankrollState.cycleNumber}`),
        kv("Exposure:", `$${bankrollState.totalExposure.toFixed(2)} | open ${bankrollState.openPositions}`),
        kv("Losing streak:", `${bankrollState.losingStreak}${bankrollState.paused ? " (PAUSED)" : ""}`),
        "",
        sepLine(),
        kv("ET / Session:", `${fmtEtTime(new Date())} / ${getBtcSession(new Date())}`),
        isMockMode
          ? kv("Mode:", `${ANSI.yellow}MOCK CALIBRATION — paper=${mockPositionCount()} pending${ANSI.reset}`)
          : kv("Mode:", `${ANSI.green}LIVE${ANSI.reset}`),
        centerText(`${ANSI.dim}${ANSI.gray}Polymarket Assistant [${CONFIG.timeframe}]${ANSI.reset}`, screenWidth())
      ];

      renderScreen(lines.join("\n") + "\n");
      prevSpotPrice = spotPrice ?? prevSpotPrice;
      prevCurrentPrice = currentPrice ?? prevCurrentPrice;

      appendCsvRow(CONFIG.signalsCsv, header, [
        new Date().toISOString(),
        timing.elapsedMinutes.toFixed(3),
        timeLeftMin.toFixed(3),
        signal,
        decision.reason,
        decision.side ?? "",
        calibrated.probModelUp,
        calibrated.probModelDown,
        edge.marketUp,
        edge.marketDown,
        edge.edgeUp,
        edge.edgeDown,
        decision.stake
      ]);

      const canTradeThisMarket = poly.ok && marketSlug && !tradedMarketSlugs.has(marketSlug);
      if (!decision.canEnter) {
        process.stderr.write(
          `\x1b[90m[AUTO-TRADE] NO TRADE — ${decision.reason} | signal=${signal}\x1b[0m\n`
        );
      } else if (!canTradeThisMarket) {
        const reason = !poly.ok
          ? "mercado Polymarket indisponivel"
          : !marketSlug
            ? "slug do mercado vazio"
            : `mercado ja operado (${marketSlug})`;
        process.stderr.write(`\x1b[33m[AUTO-TRADE] Entrada aprovada, mas bloqueada: ${reason}.\x1b[0m\n`);
      } else {
        const isUp = decision.side === "UP";
        const targetTokenId = isUp ? poly.tokens.upTokenId : poly.tokens.downTokenId;
        const rawPrice = isUp
          ? (poly.orderbook.up.bestAsk ?? poly.prices.up)
          : (poly.orderbook.down.bestAsk ?? poly.prices.down);
        const slippage = Math.abs(Number(process.env.TRADE_SLIPPAGE ?? 0.01));
        const rawPriceNum = Number(rawPrice);
        const targetPrice = Number.isFinite(rawPriceNum)
          ? Math.min(Math.round((rawPriceNum + slippage) * 100) / 100, 0.97)
          : rawPriceNum;

        if (!targetTokenId) {
          process.stderr.write(`\x1b[31m[AUTO-TRADE] BLOQUEADO — tokenId ausente para ${decision.side}.\x1b[0m\n`);
        } else if (tradedTokens.has(targetTokenId)) {
          process.stderr.write(`\x1b[33m[AUTO-TRADE] BLOQUEADO — token ${targetTokenId} ja operado nesta sessao.\x1b[0m\n`);
        } else if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
          process.stderr.write(`\x1b[31m[AUTO-TRADE] BLOQUEADO — preco invalido (${rawPrice}).\x1b[0m\n`);
        } else if (!Number.isFinite(decision.stake) || decision.stake < MIN_TRADE_SIZE) {
          process.stderr.write(`\x1b[31m[AUTO-TRADE] BLOQUEADO — stake invalida $${decision.stake}.\x1b[0m\n`);
        } else if (isMockMode) {
          // ── MOCK / CALIBRATION MODE ────────────────────────────────────────
          // No real order, no bankroll state change.
          // Record paper position; outcome checked when market settles.
          tradedTokens.add(targetTokenId);
          tradedMarketSlugs.add(marketSlug);
          const sideLabel = isUp ? "LONG" : "SHORT";
          process.stderr.write(
            `\x1b[35m[AUTO-TRADE] MOCK ${sideLabel} | ` +
            `prob_model ${decision.probModel != null ? (decision.probModel * 100).toFixed(2) + "%" : "-"} | ` +
            `prob_market ${decision.probMarket != null ? (decision.probMarket * 100).toFixed(2) + "%" : "-"} | ` +
            `edge ${decision.edge != null ? (decision.edge * 100).toFixed(2) + "%" : "-"} | ` +
            `stake $${decision.stake.toFixed(2)} | price ${targetPrice.toFixed(4)} | slug=${marketSlug}\x1b[0m\n`
          );
          recordMockEntry({
            timeframe:   CONFIG.timeframe,
            marketSlug,
            side:        decision.side,
            entryPrice:  targetPrice,
            endDateMs:   settlementMs,
            stake:       decision.stake,
            probModel:   decision.probModel,
            probMarket:  decision.probMarket,
            edge:        decision.edge,
            rawUp:       is5m ? scored5m?.rawUp : scored.rawUp,
            timeLeftMin,
            signals: is5m
              ? { rsi5: rsi5Now, macdHist: macd5?.hist, macdDelta: macd5?.histDelta, heikenColor: consec.color, heikenCount: consec.count }
              : { rsi: rsiNow, macdHist: macd?.hist, macdDelta: macd?.histDelta, heikenColor: consec.color, heikenCount: consec.count, vwapDist },
          });
        } else if (isPlacingOrder) {
          process.stderr.write(`\x1b[33m[AUTO-TRADE] Ordem em andamento, aguardando confirmação.\x1b[0m\n`);
        } else {
          // ── REAL EXECUTION ────────────────────────────────────────────────
          const probabilityPct = decision.probModel != null ? decision.probModel * 100 : 0;
          const sideLabel = isUp ? "LONG" : "SHORT";
          const bankrollBefore      = bankrollState.bankroll;
          const openPositionsBefore = bankrollState.openPositions;
          const totalExposureBefore = bankrollState.totalExposure;
          const losingStreakBefore  = bankrollState.losingStreak;

          process.stderr.write(
            `\x1b[32m[AUTO-TRADE] DISPARANDO ${sideLabel} [REAL] | ` +
            `prob_model ${probabilityPct.toFixed(2)}% | prob_market ${decision.probMarket != null ? (decision.probMarket * 100).toFixed(2) + "%" : "-"} | ` +
            `edge ${decision.edge != null ? (decision.edge * 100).toFixed(2) + "%" : "-"} | stake $${decision.stake.toFixed(2)} | ` +
            `rawAsk ${rawPriceNum.toFixed(4)} + slippage ${slippage} = ${targetPrice.toFixed(2)} | token ${targetTokenId}\x1b[0m\n`
          );

          tradedTokens.add(targetTokenId);
          isPlacingOrder = true;
          try {
            await executeTrade(
              targetTokenId,
              "BUY",
              decision.stake,
              targetPrice,
              probabilityPct
            );

            const tradeId  = createTradeId();
            const shareSize = Math.ceil((decision.stake / targetPrice) * 100) / 100;
            tradedMarketSlugs.add(marketSlug);
            lastBalanceCheckMs = 0;
            recordOpenPosition(bankrollState, {
              tokenId: targetTokenId,
              marketSlug,
              side: decision.side,
              stakeUsed: decision.stake,
              tradeId,
              entryPrice: targetPrice,
              shareSize,
              probModel:  decision.probModel,
              probMarket: decision.probMarket,
              edge:       decision.edge,
              marketEndDateMs: settlementMs,
            });
            if (is5m && pred5mState) pred5mState.hasOpenPosition = true;
            persistNow();

            recordTradeOpen({
              trade_id:        tradeId,
              timestamp_open:  new Date().toISOString(),
              market_slug:     marketSlug,
              market_type:     marketTypeFromTimeframe(CONFIG.timeframe),
              side:            decision.side,
              token_id:        targetTokenId,
              prob_modelo:     decision.probModel,
              prob_mercado:    decision.probMarket,
              edge:            decision.edge,
              stake:           decision.stake,
              entry_price:     targetPrice,
              adjusted_up:     timeAware.adjustedUp,
              raw_up:          is5m ? scored5m?.rawUp : scored.rawUp,
              bankroll_before: bankrollBefore,
              open_positions_before: openPositionsBefore,
              total_exposure_before: totalExposureBefore,
              losing_streak_before:  losingStreakBefore,
              cycle_number:    bankrollState.cycleNumber,
              decision_reason: decision.reason,
              time_left_min:   timeLeftMin,
              model_version:   MODEL_VERSION
            });
            process.stderr.write(`\x1b[32m[AUTO-TRADE] Ordem confirmada pela API (${marketSlug}).\x1b[0m\n`);
          } catch (err) {
            tradedTokens.delete(targetTokenId);
            process.stderr.write(
              `\x1b[31m[AUTO-TRADE] FALHA na ordem ${sideLabel}: ${err?.message ?? String(err)}\x1b[0m\n`
            );
          } finally {
            isPlacingOrder = false;
          }
        }
      }
    } catch (err) {
      process.stderr.write(
        `\x1b[31m[LOOP] Erro no ciclo principal:\x1b[0m\n` +
        `\x1b[31m  ${err?.stack ?? err?.message ?? String(err)}\x1b[0m\n`
      );
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

main();
