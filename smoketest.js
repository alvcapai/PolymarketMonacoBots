/**
 * smoketest.js — valida credenciais User API (CLOB L2) da Polymarket
 *
 * Usa HMAC raw com Node.js crypto (não o ClobClient/CryptoJS do SDK)
 * para evitar o bug de base64 URL-safe do CryptoJS presente no SDK v2.8.x.
 */

import "dotenv/config";
import crypto from "crypto";
import { JsonRpcProvider, Wallet } from "ethers";

// ─── ANSI colours ────────────────────────────────────────────────────────────

const R = "\x1b[31m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const B = "\x1b[1m";
const X = "\x1b[0m";

// ─── Config ───────────────────────────────────────────────────────────────────

const CLOB_HOST  = process.env.POLYMARKET_CLOB_HOST    || "https://clob.polymarket.com";
const RPC_URL    = process.env.POLYGON_RPC_URL          || "https://polygon-rpc.com";
const PK         = String(process.env.PK                        ?? "").trim();
const API_KEY    = String(process.env.POLYMARKET_API_KEY        ?? "").trim();
const SECRET     = String(process.env.POLYMARKET_API_SECRET     ?? "").trim();
const PASSPHRASE = String(process.env.POLYMARKET_API_PASSPHRASE ?? "").trim();

const missing = [
  !PK         && "PK",
  !API_KEY    && "POLYMARKET_API_KEY",
  !SECRET     && "POLYMARKET_API_SECRET",
  !PASSPHRASE && "POLYMARKET_API_PASSPHRASE",
].filter(Boolean);

if (missing.length) {
  console.error(
    `\n${R}${B}[ERRO] Variáveis ausentes no .env:${X}\n` +
    missing.map(v => `  ${R}• ${v}${X}`).join("\n") + "\n"
  );
  process.exit(1);
}

// ─── HMAC L2 ─────────────────────────────────────────────────────────────────

function buildHmacSignature(secret, timestamp, method, path, body = "") {
  const message     = `${timestamp}${method}${path}${body}`;
  // URL-safe base64 → standard base64 antes de decodificar
  const secretStd   = secret.replace(/-/g, "+").replace(/_/g, "/");
  const secretBytes = Buffer.from(secretStd, "base64");
  return crypto.createHmac("sha256", secretBytes).update(message).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runSmokeTest() {
  // Deriva endereço da wallet para o header POLY_ADDRESS
  let walletAddress;
  try {
    const normalizedPK = PK.startsWith("0x") ? PK : `0x${PK}`;
    const provider     = new JsonRpcProvider(RPC_URL);
    const wallet       = new Wallet(normalizedPK, provider);
    walletAddress      = wallet.address;
    console.log(`${Y}[smoketest] Wallet: ${walletAddress}${X}`);
    console.log(`${Y}[smoketest] Validando credenciais L2 via HMAC raw…${X}\n`);
  } catch (err) {
    console.error(`\n${R}${B}[ERRO] Falha ao instanciar wallet: ${err?.message}${X}\n`);
    process.exit(1);
  }

  // ── Helper: request autenticado L2 ──────────────────────────────────────
  async function l2get(endpoint) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = buildHmacSignature(SECRET, timestamp, "GET", endpoint);
    const res = await fetch(`${CLOB_HOST}${endpoint}`, {
      method: "GET",
      headers: {
        "Content-Type":    "application/json",
        "POLY_ADDRESS":    walletAddress,
        "POLY_API_KEY":    API_KEY,
        "POLY_PASSPHRASE": PASSPHRASE,
        "POLY_TIMESTAMP":  timestamp,
        "POLY_SIGNATURE":  signature,
      },
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body };
  }

  // ── [1] Validar auth ──────────────────────────────────────────────────────
  try {
    const { status, ok, body } = await l2get("/auth/api-keys");

    if (!ok) {
      if (status === 401) {
        console.error(
          `\n${R}${B}╔══════════════════════════════════════════════════════════════════╗${X}\n` +
          `${R}${B}║  [FALHA FATAL] A API da Polymarket rejeitou as chaves fornecidas. ║${X}\n` +
          `${R}${B}║               Chave Inválida.                                     ║${X}\n` +
          `${R}${B}╚══════════════════════════════════════════════════════════════════╝${X}\n` +
          `${R}  • HTTP Status          : 401 Unauthorized${X}\n` +
          `${R}  • POLYMARKET_API_KEY   : ${API_KEY}${X}\n` +
          `${R}  • Wallet               : ${walletAddress}${X}\n` +
          `${R}  • Resposta do servidor : ${JSON.stringify(body)}${X}\n\n` +
          `${Y}  Execute node keygen.js para gerar novas User API keys.${X}\n`
        );
      } else {
        console.error(`\n${R}${B}[ERRO ${status}] ${JSON.stringify(body)}${X}\n`);
      }
      process.exit(1);
    }
  } catch (err) {
    console.error(`\n${R}${B}[ERRO DE REDE] ${err?.message ?? String(err)}${X}\n`);
    process.exit(1);
  }

  // ── [2] Buscar saldo USDC (COLLATERAL) ───────────────────────────────────
  let balance = "N/A";
  let allowance = "N/A";
  try {
    const { ok, status, body } = await l2get("/balance-allowance?asset_type=COLLATERAL");
    if (ok) {
      // O servidor retorna o saldo como float string (ex: "17.5"), não em wei
      const raw = parseFloat(body.balance ?? "0");
      balance   = isNaN(raw) ? String(body.balance) : `$${raw.toFixed(2)} USDC`;
      const alw = parseFloat(body.allowance ?? "0");
      allowance = isNaN(alw) ? String(body.allowance) : `$${alw.toFixed(2)} USDC`;
    } else {
      balance   = `ERRO ${status}: ${JSON.stringify(body)}`;
      allowance = "—";
    }
  } catch (err) {
    balance = `ERRO: ${err?.message ?? String(err)}`;
  }

  // ── Resultado ────────────────────────────────────────────────────────────
  console.log(
    `${G}${B}╔══════════════════════════════════════════════════════════╗${X}\n` +
    `${G}${B}║  [SUCESSO] Chaves validadas e conexão L2 perfeita!       ║${X}\n` +
    `${G}${B}╚══════════════════════════════════════════════════════════╝${X}\n` +
    `${G}  • Endpoint          : ${CLOB_HOST}${X}\n` +
    `${G}  • Wallet            : ${walletAddress}${X}\n` +
    `${G}  • POLYMARKET_API_KEY: ${API_KEY}${X}\n` +
    `${G}  • Saldo USDC        : ${balance}${X}\n` +
    `${G}  • Allowance USDC    : ${allowance}${X}\n`
  );
}

runSmokeTest();
