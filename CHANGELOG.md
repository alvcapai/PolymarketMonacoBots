# Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased] – 2026-04-30

### fix(redeemer): reconcile ghost positions from unfilled GTC orders

**Problem:** The bot recorded a position in `bankrollState` immediately after
posting a GTC order to the CLOB, regardless of whether the order was filled.
If the order was never matched (e.g. price moved before fill), the user held
no actual shares on Polymarket. `runAutoRedeem` queries
`data-api.polymarket.com/positions` and only processes positions the user
actually holds on-chain — unfilled orders never appear there, so the ghost
position persisted indefinitely and blocked all future trades
(`max_positions_1_reached`).

**Fix — `src/trade/redeemer.js`:**
- Added `reconcileStalePositions(bankrollState)` (exported): called alongside
  `runAutoRedeem` every 2 minutes.
- For each position in `bankrollState.positions` older than 25 minutes, it
  checks the outcome via two steps:
  1. CLOB midpoint (`/midpoint?token_id=…`) — returns 0 or 1 for resolved
     tokens.
  2. Gamma API fallback (`/markets?slug=…&closed=true`) — parses `clobTokenIds`
     and `outcomePrices` (both stored as JSON strings) to identify the winning
     token.
- If the outcome is determined, fires a standard outcome event that removes the
  position from state and updates the bankroll/streak counters.

**Fix — `src/index.js`:**
- Imports and calls `reconcileStalePositions(bankrollState)` in the redeem
  cycle block, after `runAutoRedeem`.

---

## [Unreleased] – 2026-04-12

### refactor(executor): rewrite `src/trade/executor.js` for stability and security

#### Breaking / Behavioral changes
- **Ethers import fixed** — removed `createRequire` + path hack into
  `@polymarket/clob-client/node_modules/ethers`; now uses a clean ESM import:
  `import { Wallet } from "ethers"`.
- **Fail-fast credential validation** — `ClobClient`, `Wallet`, and all three
  L2 API credentials (`POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`,
  `POLYMARKET_API_PASSPHRASE`) are now validated **at module load time**, not
  lazily on the first `executeTrade` call. The error message lists every missing
  variable by name.
- **Mock mode is credential-free** — when `TRADE_MOCK_MODE=true`, none of the
  above validations run; the module boots even with an empty `.env`.
- **Mock log format corrected** — output now matches the specified format:
  `[MOCK EXECUCAO] Apostando $X em BUY no Token Z a Wc (Probabilidade: P%)`.

#### Internal cleanup
- Removed exported `getClobClient()` — `clobClient` is now a private module-
  level singleton initialized once at startup.
- Renamed helpers: `normalizePrivateKey` → `normalizePk`,
  `getApiCreds` → `loadApiCreds`, `toFiniteNumber` → `assertFinite`.
- Replaced `||` with `??` for env-var reads to avoid falsy-empty-string edge cases.
- Error messages prefixed with `[executor]` for easier log filtering.

#### `src/index.js` — no changes required
The anti-spam guard (`tradedTokens` Set, `!tradedTokens.has(targetTokenId)`
check, and `tradedTokens.add()` before `await executeTrade`) was already
correctly implemented.

---

## [dd9a4ae] – fix: anti-spam 1 order per market

## [d697aa8] – fix: lower probability threshold to 75%

## [820aa56] – chore: add Dockerfile for Render/cloud deployment

## [66a0cd9] – Codex adding shit

## [5955967] – README: proxy auth guide
