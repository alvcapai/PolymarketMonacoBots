import "dotenv/config";
import { initConfigLoader } from "./config-loader.js";
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
import { computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge } from "./engines/edge.js";
import { calibrateModelProbabilities } from "./engines/signal-validation.js";
import {
  initStateManager,
  loadBankrollState,
  saveBankrollState,
  syncBankroll,
  checkWithdrawal,
  recordWithdrawal,
  checkCycleFloor,
  decideEntry,
  recordOpenPosition,
  recordOutcomeByToken,
  getMinTradeSize
} from "./engines/risk-management.js";
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import {
  ANSI, fmtTimeLeft, screenWidth, sepLine, kv, renderScreen,
  formatProbPct, fmtEtTime, getBtcSession, colorPriceLine, centerText
} from "./logging/ui.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import { logger } from "./logging/logger.js";
import { executeTrade, fetchUsdcBalance, transferUsdc, WITHDRAWAL_ADDRESS, ensureBalanceAllowance } from "./trade/executor.js";
import { runAutoRedeem, reconcileStalePositions } from "./trade/redeemer.js";
import { checkTakeProfit } from "./trade/take-profit.js";
import {
  createTradeId,
  recordTradeOpen,
  recordTradeClose,
  estimatePnlRealized,
  recordBlockReason
} from "./engines/trade-telemetry.js";
import { logCounterfactual } from "./logging/counterfactual-log.js";
import { logTradeEntry, logTradeExit } from "./logging/trade-log.js";

applyGlobalProxyFromEnv();

const tradedTokens = new Set();
const tradedMarketSlugs = new Set();
let isPlacingOrder = false;

const MODEL_VERSION = "risk-params-v1";
const BALANCE_TTL_MS = 30_000;
const REDEEM_INTERVAL_MS = 2 * 60_000;
const TAKE_PROFIT_INTERVAL_MS = 10_000;

// Rolling 30-candle history of (binanceClose − chainlinkPrice) for basis monitoring.
const basisHistory = [];

function countVwapCrosses(closes, vwapSeries, lookback = 20) {
  const end = Math.min(closes.length, vwapSeries.length);
  const start = Math.max(1, end - lookback);
  let crosses = 0;
  let prevSide = null;

  for (let i = start; i < end; i += 1) {
    const close = Number(closes[i]);
    const vwap = Number(vwapSeries[i]);
    if (!Number.isFinite(close) || !Number.isFinite(vwap)) continue;

    const side = close > vwap ? 1 : close < vwap ? -1 : 0;
    if (side === 0) continue;
    if (prevSide !== null && side !== prevSide) crosses += 1;
    prevSide = side;
  }

  return crosses;
}

function marketTypeFromTimeframe(timeframe) {
  const [asset, window] = String(timeframe ?? "").split("-");
  return `${asset || "unknown"}_${window || "unknown"}`;
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

function processOutcomeEvents(bankrollState, events) {
  for (const event of events) {
    const outcome = recordOutcomeByToken(bankrollState, event.tokenId, event.won);
    if (!outcome.updated) continue;

    // Unlock token and market slug so the bot can trade new markets freely
    tradedTokens.delete(event.tokenId);
    const closedSlug = outcome.position?.marketSlug;
    if (closedSlug) tradedMarketSlugs.delete(closedSlug);

    const position = outcome.position ?? {};
    const tradeId = String(position.tradeId ?? "").trim();
    if (tradeId) {
      const pnlRealized = estimatePnlRealized({
        stake: position.stakeUsed ?? outcome.stakeUsed,
        entryPrice: position.entryPrice,
        shareSize: position.shareSize,
        won: event.won,
        proceeds: event.proceeds
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

      logTradeExit({
        market: closedSlug || "unknown",
        side: position.side || "unknown",
        entryPrice: position.entryPrice,
        exitPrice: event.marketSettlementPrice,
        pnlUsdc: pnlRealized,
        roi: pnlRealized / (position.stakeUsed || outcome.stakeUsed || 1),
        reason: event.closeReason ?? event.source ?? (event.won ? "settled_win" : "settled_loss"),
        holdSec: (Date.now() - (position.openedAtMs || Date.now())) / 1000,
        remainingMinutesAtExit: null // Not easily available here, could fetch if needed
      });
    }

    logger.info({
      component: "outcome", result: event.won ? "WIN" : "LOSS",
      tokenId: event.tokenId, stake: outcome.stakeUsed, losingStreak: bankrollState.losingStreak,
    }, `Outcome: ${event.won ? "WIN" : "LOSS"}`);
  }
}

async function main() {
  // Initialize configuration and state management
  try {
    initConfigLoader();
    initStateManager(CONFIG.bankrollStatePath);
    logger.info("[init] Bot initialization completed successfully");
  } catch (error) {
    logger.error("[init] Bot initialization failed:", error);
    process.exit(1);
  }

  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({
    symbolIncludes: CONFIG.polymarket.wsSymbolFilter
  });
  const chainlinkStream = startChainlinkPriceStream({
    aggregator: CONFIG.chainlink.assetUsdAggregator
  });

  const bankrollState = loadBankrollState(20);
  await ensureBalanceAllowance();

  let cachedBalance = null;
  let lastBalanceCheckMs = 0;
  let lastRedeemCheckMs = 0;
  let lastTakeProfitCheckMs = 0;
  let prevSpotPrice = null;
  let prevCurrentPrice = null;
  let isWithdrawing = false;
  let wasCycleEnded = false;
  let lastPersistMs = 0;
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
        const report = await runAutoRedeem();
        processOutcomeEvents(bankrollState, Array.isArray(report?.events) ? report.events : []);
        const staleReport = await reconcileStalePositions(bankrollState);
        processOutcomeEvents(bankrollState, Array.isArray(staleReport?.events) ? staleReport.events : []);
        if ((report?.events?.length ?? 0) + (staleReport?.events?.length ?? 0) > 0) persistNow();
      }

      const currentBalance = await refreshBalance();
      syncBankroll(bankrollState, currentBalance);
      persistIfDue();

      const floorCheck = checkCycleFloor(bankrollState);
      if (floorCheck.cycleEnded && !wasCycleEnded) {
        logger.warn({ component: "risk", cycle: bankrollState.cycleNumber, reason: floorCheck.reason }, "Cycle ended — new entries blocked");
      }
      wasCycleEnded = floorCheck.cycleEnded;

      const withdrawalCheck = checkWithdrawal(bankrollState);
      if (withdrawalCheck.shouldWithdraw && !isWithdrawing) {
        isWithdrawing = true;
        const { withdrawAmount, resetTo } = withdrawalCheck;
        logger.info({ component: "withdrawal", bankroll: bankrollState.bankroll, withdrawAmount, to: WITHDRAWAL_ADDRESS, resetTo }, "Withdrawal triggered");
        try {
          const result = await transferUsdc(WITHDRAWAL_ADDRESS, withdrawAmount);
          await ensureBalanceAllowance();
          recordWithdrawal(bankrollState);
          cachedBalance = resetTo;
          lastBalanceCheckMs = Date.now();
          persistNow();
          logger.info({ component: "withdrawal", txHash: result.txHash ?? "(mock)", newCycle: bankrollState.cycleNumber }, "Withdrawal completed");
        } catch (err) {
          logger.error({ component: "withdrawal", err: err?.message ?? String(err) }, "Withdrawal failed");
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

      if (Date.now() - lastTakeProfitCheckMs >= TAKE_PROFIT_INTERVAL_MS) {
        lastTakeProfitCheckMs = Date.now();
        const tpReport = await checkTakeProfit(bankrollState, { settlementLeftMin });
        processOutcomeEvents(bankrollState, Array.isArray(tpReport?.events) ? tpReport.events : []);
        if ((tpReport?.events?.length ?? 0) > 0) persistNow();
      }

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

      // Basis tracking: Chainlink is the settlement source, Binance is the history source.
      // Log the spread each cycle; widen VWAP margin when basis is noisy (stddev > $25).
      const chainlinkPrice = chainlink?.price ?? null;
      const binanceClose = closes[closes.length - 1];
      const basisNow = chainlinkPrice !== null ? binanceClose - chainlinkPrice : null;
      if (basisNow !== null) {
        basisHistory.push(basisNow);
        if (basisHistory.length > 30) basisHistory.shift();
      }
      let basisStddev = 0;
      if (basisHistory.length >= 2) {
        const mean = basisHistory.reduce((a, b) => a + b, 0) / basisHistory.length;
        const variance = basisHistory.reduce((s, b) => s + (b - mean) ** 2, 0) / basisHistory.length;
        basisStddev = Math.sqrt(variance);
      }
      const vwapMargin = basisStddev > 25 ? 0.5 * basisStddev : 0;
      logger.info({ component: "basis", binance: binanceClose, chainlink: chainlinkPrice, basis: basisNow, stddev: basisStddev, vwapMargin }, "Basis check");

      const scored = scoreDirection({
        price: chainlinkPrice ?? lastPrice, // Chainlink as primary anchor; fallback to Binance
        vwap: vwapNow,
        vwapMargin,
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
      const rawPriceUp = poly.ok ? (poly.orderbook.up.bestAsk ?? poly.prices.up) : null;
      const rawPriceDown = poly.ok ? (poly.orderbook.down.bestAsk ?? poly.prices.down) : null;
      const tradeSlippage = Math.abs(Number(process.env.TRADE_SLIPPAGE ?? 0.01));

      const decision = decideEntry(bankrollState, {
        probModelUp: calibrated.probModelUp,
        probModelDown: calibrated.probModelDown,
        marketProbUp: edge.marketUp,
        marketProbDown: edge.marketDown,
        marketSlug,
        priceUp: rawPriceUp,
        priceDown: rawPriceDown,
        slippage: tradeSlippage,
        basisStdDev: basisStddev
      });

      const signal = toDecisionSignal(decision);
      logger.info({
        component: "risk", bankroll: bankrollState.bankroll, cycle: bankrollState.cycleNumber,
        openPositions: bankrollState.openPositions, exposure: bankrollState.totalExposure,
        losingStreak: bankrollState.losingStreak, side: decision.side,
        probModel: decision.probModel, probMarket: decision.probMarket,
        rawEdge: decision.rawEdge, netEdge: decision.edge, stake: decision.stake,
        canEnter: decision.canEnter, reason: decision.reason,
      }, "Risk diagnostics");

      logCounterfactual({
        logDir: "./logs",
        marketSlug,
        sideConsidered: decision.side,
        probModel: decision.probModel,
        probMarket: decision.probMarket,
        rawEdge: decision.rawEdge,
        netEdge: decision.edge,
        gateThatBlocked: decision.canEnter ? null : decision.reason,
        wouldHaveStake: decision.stake > 0 ? decision.stake : null
      });

      const spotPrice = wsPrice ?? lastPrice;
      const decisionColor = decision.canEnter ? ANSI.green : ANSI.yellow;

      const lines = [
        poly.ok ? String(poly.market?.question ?? "-") : "-",
        kv("Market:", poly.ok ? (poly.market?.slug ?? "-") : "-"),
        kv("Time left:", fmtTimeLeft(timeLeftMin)),
        "",
        sepLine(),
        "",
        kv("Model UP/DOWN:", `${formatProbPct(calibrated.probModelUp)} / ${formatProbPct(calibrated.probModelDown)}`),
        kv("Market UP/DOWN:", `${formatProbPct(edge.marketUp)} / ${formatProbPct(edge.marketDown)}`),
        kv("Edge UP/DOWN:", `${formatPct(edge.edgeUp, 2)} / ${formatPct(edge.edgeDown, 2)}`),
        kv("Decision:", `${decisionColor}${signal}${ANSI.reset} (${decision.reason})`),
        kv("Stake:", decision.canEnter ? `$${decision.stake.toFixed(2)}` : "-"),
        "",
        sepLine(),
        "",
        kv("Heiken:", `${consec.color ?? "-"} x${consec.count}`),
        kv("RSI:", `${formatNumber(rsiNow, 1)} | slope ${formatNumber(rsiSlope, 2)}`),
        kv("MACD hist:", macd ? formatNumber(macd.hist, 4) : "-"),
        kv("VWAP:", `${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)})`),
        kv("VWAP crosses:", vwapCrossCount ?? "-"),
        kv("Volume 20/120:", `${formatNumber(volumeRecent, 0)} / ${formatNumber(volumeAvg, 0)}`),
        "",
        sepLine(),
        "",
        colorPriceLine({ label: "Current (Chainlink)", price: chainlinkPrice, prevPrice: prevCurrentPrice, decimals: 2, prefix: "$" }),
        colorPriceLine({ label: "Spot (Binance WS)", price: spotPrice, prevPrice: prevSpotPrice, decimals: 0, prefix: "$" }),
        "",
        kv("Bankroll:", `$${bankrollState.bankroll.toFixed(2)} | cycle ${bankrollState.cycleNumber}`),
        kv("Exposure:", `$${bankrollState.totalExposure.toFixed(2)} | open ${bankrollState.openPositions}`),
        kv("Losing streak:", `${bankrollState.losingStreak}`),
        "",
        sepLine(),
        kv("ET / Session:", `${fmtEtTime(new Date())} / ${getBtcSession(new Date())}`),
        centerText(`${ANSI.dim}${ANSI.gray}Polymarket Assistant [${CONFIG.timeframe}]${ANSI.reset}`, screenWidth())
      ];

      renderScreen(lines.join("\n") + "\n");
      prevSpotPrice = spotPrice ?? prevSpotPrice;
      prevCurrentPrice = chainlinkPrice ?? prevCurrentPrice;

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
        logger.info({ component: "auto-trade", action: "NO_TRADE", reason: decision.reason, signal }, "No trade");
        const blockReport = recordBlockReason(decision.reason);
        if (blockReport) {
          logger.info({ component: "telemetry" }, blockReport);
        }
      } else if (!canTradeThisMarket) {
        const reason = !poly.ok
          ? "mercado Polymarket indisponivel"
          : !marketSlug
            ? "slug do mercado vazio"
            : `mercado ja operado (${marketSlug})`;
        logger.warn({ component: "auto-trade", reason }, "Entry approved but blocked");
      } else {
        const isUp = decision.side === "UP";
        const targetTokenId = isUp ? poly.tokens.upTokenId : poly.tokens.downTokenId;
        const rawPriceValue = isUp ? rawPriceUp : rawPriceDown;
        const rawPriceNum = Number(rawPriceValue);
        const targetPrice = Number.isFinite(rawPriceNum)
          ? Math.min(Math.round((rawPriceNum + tradeSlippage) * 100) / 100, 0.97)
          : rawPriceValue;

        if (!targetTokenId) {
          logger.error({ component: "auto-trade", side: decision.side }, "Blocked — missing tokenId");
        } else if (tradedTokens.has(targetTokenId)) {
          logger.warn({ component: "auto-trade", targetTokenId }, "Blocked — token already traded this session");
        } else if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
          logger.error({ component: "auto-trade", rawPriceValue }, "Blocked — invalid price");
        } else if (!Number.isFinite(decision.stake) || decision.stake < getMinTradeSize()) {
          logger.error({ component: "auto-trade", stake: decision.stake }, "Blocked — invalid stake");
        } else if (isPlacingOrder) {
          logger.warn({ component: "auto-trade" }, "Order already in progress");
        } else {
          const probabilityPct = decision.probModel * 100;
          const sideLabel = isUp ? "LONG" : "SHORT";
          const isMockMode = String(process.env.TRADE_MOCK_MODE ?? "true").toLowerCase() === "true";
          const bankrollBefore = bankrollState.bankroll;
          const openPositionsBefore = bankrollState.openPositions;
          const totalExposureBefore = bankrollState.totalExposure;
          const losingStreakBefore = bankrollState.losingStreak;

          logger.info({
            component: "auto-trade", action: "FIRE", side: sideLabel, mock: isMockMode,
            probModel: probabilityPct, probMarket: decision.probMarket * 100,
            rawEdge: decision.rawEdge * 100, netEdge: decision.edge * 100,
            stake: decision.stake, rawAsk: rawPriceNum, slippage: tradeSlippage,
            targetPrice, targetTokenId,
          }, `Firing ${sideLabel} order`);

          tradedTokens.add(targetTokenId);
          isPlacingOrder = true;
          try {
            const effectiveStake = decision.stake;

            await executeTrade(
              targetTokenId,
              "BUY",
              effectiveStake,
              targetPrice,
              probabilityPct
            );

            const tradeId = createTradeId();
            const shareSize = Math.ceil((effectiveStake / targetPrice) * 100) / 100;
            tradedMarketSlugs.add(marketSlug);
            lastBalanceCheckMs = 0;
            recordOpenPosition(bankrollState, {
              tokenId: targetTokenId,
              marketSlug,
              side: decision.side,
              stakeUsed: effectiveStake,
              tradeId,
              entryPrice: targetPrice,
              shareSize,
              probModel: decision.probModel,
              probMarket: decision.probMarket,
              edge: decision.edge
            });
            persistNow();

            recordTradeOpen({
              trade_id: tradeId,
              timestamp_open: new Date().toISOString(),
              market_slug: marketSlug,
              market_type: marketTypeFromTimeframe(CONFIG.timeframe),
              side: decision.side,
              token_id: targetTokenId,
              prob_modelo: decision.probModel,
              prob_mercado: decision.probMarket,
              edge: decision.edge,
              raw_edge: decision.rawEdge,
              stake: decision.stake,
              entry_price: targetPrice,
              adjusted_up: timeAware.adjustedUp,
              raw_up: scored.rawUp,
              bankroll_before: bankrollBefore,
              open_positions_before: openPositionsBefore,
              total_exposure_before: totalExposureBefore,
              losing_streak_before: losingStreakBefore,
              cycle_number: bankrollState.cycleNumber,
              decision_reason: decision.reason,
              time_left_min: timeLeftMin,
              model_version: MODEL_VERSION
            });

            logTradeEntry({
              market: marketSlug,
              side: decision.side,
              entryPrice: targetPrice,
              shares: shareSize,
              usdcSpent: effectiveStake,
              rawUp: scored.rawUp,
              adjustedUp: timeAware.adjustedUp,
              probModelUp: calibrated.probModelUp,
              marketUpProb: edge.marketUp,
              rawEdge: decision.rawEdge,
              netEdge: decision.edge,
              vwapMargin,
              basisStdDev: basisStddev,
              remainingMinutes: timeLeftMin,
              losingStreak: losingStreakBefore,
              bankroll: bankrollBefore
            });

            logger.info({ component: "auto-trade", marketSlug }, "Order confirmed by API");
          } catch (err) {
            tradedTokens.delete(targetTokenId);
            logger.error({ component: "auto-trade", side: sideLabel, err: err?.message ?? String(err) }, "Order failed");
          } finally {
            isPlacingOrder = false;
          }
        }
      }
    } catch (err) {
      logger.error({ component: "loop", err: err?.stack ?? err?.message ?? String(err) }, "Main loop error");
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

main();
