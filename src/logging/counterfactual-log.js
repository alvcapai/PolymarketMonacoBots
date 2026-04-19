import path from "node:path";
import { appendCsvRow } from "../utils.js";

const HEADER = [
  "timestamp",
  "market_slug",
  "side_considered",
  "prob_model",
  "prob_market",
  "raw_edge",
  "net_edge",
  "gate_that_blocked",
  "would_have_stake",
  "actual_settled_outcome"  // filled post-settlement via external script
];

// Appends one row per poll cycle (whether or not a trade fired).
// actual_settled_outcome is left blank; fill it from trade-telemetry data
// after the market settles to build the calibration dataset.
export function logCounterfactual({
  logDir,
  marketSlug,
  sideConsidered,
  probModel,
  probMarket,
  rawEdge,
  netEdge,
  gateThatBlocked,
  wouldHaveStake
}) {
  const filePath = path.join(logDir, "counterfactual.csv");
  appendCsvRow(filePath, HEADER, [
    new Date().toISOString(),
    marketSlug ?? "",
    sideConsidered ?? "",
    probModel != null ? Number(probModel).toFixed(4) : "",
    probMarket != null ? Number(probMarket).toFixed(4) : "",
    rawEdge != null ? Number(rawEdge).toFixed(4) : "",
    netEdge != null ? Number(netEdge).toFixed(4) : "",
    gateThatBlocked ?? "none",
    wouldHaveStake != null ? Number(wouldHaveStake).toFixed(4) : "",
    ""
  ]);
}
