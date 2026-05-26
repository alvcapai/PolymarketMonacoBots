import { appendFile, mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { logger } from "../logging/logger.js";

const OPEN_LOG_PATH = path.resolve(process.cwd(), "data", "trades_opened.jsonl");
const CLOSE_LOG_PATH = path.resolve(process.cwd(), "data", "trades_closed.jsonl");

function ensureDir(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendJsonl(filePath, payload) {
  ensureDir(filePath);
  appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8", (err) => {
    if (err) logger.error({ component: "telemetry", filePath, err: err.message }, "Failed to write JSONL");
  });
}

export function createTradeId() {
  return `tr_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

export function recordTradeOpen(data) {
  const record = {
    event_type: "OPEN",
    ...data
  };
  appendJsonl(OPEN_LOG_PATH, record);
  return record;
}

export function recordTradeClose(data) {
  const record = {
    event_type: "CLOSE",
    ...data
  };
  appendJsonl(CLOSE_LOG_PATH, record);
  return record;
}

export function estimatePnlRealized({ stake, entryPrice, shareSize, won, proceeds = undefined }) {
  const s = Number(stake);
  const received = (proceeds !== undefined && proceeds !== null) ? Number(proceeds) : NaN;
  const p = Number(entryPrice);
  const sh = Number(shareSize);
  if (!Number.isFinite(s) || s <= 0) return 0;
  if (Number.isFinite(received)) return received - s;
  if (!won) return -s;
  if (Number.isFinite(sh) && sh > 0) return sh - s;
  if (Number.isFinite(p) && p > 0 && p < 1) return s * ((1 / p) - 1);
  return 0;
}

// ---------------------------------------------------------------------------
// Block-reason telemetry
// Call recordBlockReason() each time decideEntry returns canEnter=false.
// Returns a formatted report string every BLOCK_REPORT_EVERY ticks, null otherwise.
// ---------------------------------------------------------------------------

const _blockCounts = new Map();
let _blockTicks = 0;
const BLOCK_REPORT_EVERY = 100;

/**
 * Normalize a raw decision reason to a stable bucket key.
 * Strips per-tick numeric values while preserving structural labels.
 * e.g. "prob_model_0.4502_below_0.54" → "prob_model_below_0.54"
 * e.g. "min_ticket_3.03_exceeds_risk_cap_3.05_bankroll_20.34" → "min_ticket_exceeds_risk_cap"
 */
function _normalizeBlockReason(reason) {
  return reason
    .replace(/_(-?[\d.]+)(?=_[a-z])/g, "")  // strip _<number> before a word segment
    .replace(/_bankroll_[\d.]+$/, "")         // strip trailing _bankroll_X.XX
    .replace(/__+/g, "_")
    .replace(/_+$/, "");
}

export function recordBlockReason(reason) {
  const key = _normalizeBlockReason(String(reason));
  _blockCounts.set(key, (_blockCounts.get(key) ?? 0) + 1);
  _blockTicks++;

  if (_blockTicks >= BLOCK_REPORT_EVERY) {
    return _flushBlockReport();
  }
  return null;
}

function _flushBlockReport() {
  const entries = [..._blockCounts.entries()].sort((a, b) => b[1] - a[1]);
  const lines = [`Block distribution (last ${_blockTicks} ticks):`];
  for (const [k, v] of entries) {
    lines.push(`  ${k.padEnd(48)} ${String(v).padStart(4)}`);
  }
  _blockTicks = 0;
  _blockCounts.clear();
  return lines.join("\n");
}
