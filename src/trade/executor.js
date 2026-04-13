import "dotenv/config";
import crypto from "node:crypto";
import { JsonRpcProvider, Wallet } from "ethers";
import { Chain, ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { CONFIG } from "../config.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const ANSI = {
  reset:   "\x1b[0m",
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
};

const CLOB_HOST      = process.env.POLYMARKET_CLOB_HOST || "https://clob.polymarket.com";
const CHAIN_ID       = Chain.POLYGON;
const TRADE_MOCK     = String(process.env.TRADE_MOCK_MODE ?? "true").toLowerCase() === "true";
const PROXY_ADDRESS  = String(process.env.POLYMARKET_PROXY_ADDRESS ?? "").trim();
// Polymarket SignatureType: 0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE
const SIGNATURE_TYPE = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? (PROXY_ADDRESS ? 2 : 0));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizePrivateKey(raw) {
  const pk = String(raw ?? "").trim();
  if (!pk) throw new Error("[executor] Variável de ambiente PK não encontrada.");
  return pk.startsWith("0x") ? pk : `0x${pk}`;
}

function loadApiCreds() {
  const key        = String(process.env.POLYMARKET_API_KEY        ?? "").trim();
  const secret     = String(process.env.POLYMARKET_API_SECRET     ?? "").trim();
  const passphrase = String(process.env.POLYMARKET_API_PASSPHRASE ?? "").trim();

  const missing = [
    !key        && "POLYMARKET_API_KEY",
    !secret     && "POLYMARKET_API_SECRET",
    !passphrase && "POLYMARKET_API_PASSPHRASE",
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(
      `[executor] Credenciais L2 ausentes no .env: ${missing.join(", ")}. ` +
      "Defina essas variáveis ou ative TRADE_MOCK_MODE=true."
    );
  }

  return { key, secret, passphrase };
}

function assertFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`[executor] Parâmetro inválido — ${name}: ${value}`);
  return n;
}

function formatCents(price) {
  return `${(Number(price) * 100).toFixed(1).replace(/\.0$/, "")}c`;
}

// ─── HMAC helper (para consulta de saldo via API raw) ─────────────────────────
function buildHmacSignature(secret, timestamp, method, path) {
  const message   = `${timestamp}${method}${path}`;
  const secretStd = secret.replace(/-/g, "+").replace(/_/g, "/");
  return crypto
    .createHmac("sha256", Buffer.from(secretStd, "base64"))
    .update(message)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// ─── Initialization ───────────────────────────────────────────────────────────
// Credenciais e wallet são validadas AGORA (fail-fast), não na primeira ordem.

let clobClient = null;
let walletAddress = null;
let apiSecret = null;
let apiKey = null;
let apiPassphrase = null;

if (!TRADE_MOCK) {
  const pk = process.env.PK;
  const key = process.env.POLYMARKET_API_KEY;
  const secret = process.env.POLYMARKET_API_SECRET;
  const passphrase = process.env.POLYMARKET_API_PASSPHRASE;

  const missingVars = [
    !pk          && "PK",
    !key         && "POLYMARKET_API_KEY",
    !secret      && "POLYMARKET_API_SECRET",
    !passphrase  && "POLYMARKET_API_PASSPHRASE",
  ].filter(Boolean);

  if (missingVars.length) {
    throw new Error(
      `[executor] Configuração incompleta para modo real. Variáveis ausentes: ${missingVars.join(", ")}. ` +
      "Defina essas variáveis no .env ou ative TRADE_MOCK_MODE=true."
    );
  }

  const provider = new JsonRpcProvider(CONFIG.chainlink.polygonRpcUrl);
  const wallet   = new Wallet(normalizePrivateKey(pk), provider);
  const creds    = loadApiCreds();

  walletAddress  = wallet.address;
  apiSecret      = creds.secret;
  apiKey         = creds.key;
  apiPassphrase  = creds.passphrase;

  // ── ClobClient com signature type e funder address (hack para proxy wallets)
  // SignatureType 2 = POLY_GNOSIS_SAFE — sem isso, ordens de proxy falham.
  clobClient = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    wallet,
    creds,
    SIGNATURE_TYPE,
    PROXY_ADDRESS || undefined,
  );

  console.log(
    `${ANSI.green}[executor] ClobClient inicializado (modo real, sig type ${SIGNATURE_TYPE}` +
    `${PROXY_ADDRESS ? `, funder ${PROXY_ADDRESS}` : ""}).${ANSI.reset}`
  );
} else {
  console.log(`${ANSI.yellow}[executor] TRADE_MOCK_MODE ativo — nenhuma ordem real será enviada.${ANSI.reset}`);
}

// ─── fetchUsdcBalance ─────────────────────────────────────────────────────────
/**
 * Consulta o saldo USDC collateral via API CLOB com HMAC raw.
 * Retorna o valor em dólares (ex: 16.21) ou null se não disponível.
 */
export async function fetchUsdcBalance() {
  if (!apiKey || !apiSecret || !apiPassphrase || !walletAddress) return null;

  try {
    const path = "/balance-allowance";
    const ts   = Math.floor(Date.now() / 1000).toString();
    const sig  = buildHmacSignature(apiSecret, ts, "GET", path);
    const query = `asset_type=COLLATERAL&signature_type=${SIGNATURE_TYPE}${PROXY_ADDRESS ? `&funder=${PROXY_ADDRESS}` : ""}`;

    const res = await fetch(`${CLOB_HOST}${path}?${query}`, {
      method: "GET",
      headers: {
        "Content-Type":    "application/json",
        "POLY_ADDRESS":    walletAddress,
        "POLY_API_KEY":    apiKey,
        "POLY_PASSPHRASE": apiPassphrase,
        "POLY_TIMESTAMP":  ts,
        "POLY_SIGNATURE":  sig,
      },
    });

    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    const raw  = Number(body.balance ?? 0);
    return Number.isFinite(raw) ? raw / 1_000_000 : null;
  } catch {
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Executa (ou simula) uma ordem de compra no Polymarket CLOB.
 *
 * @param {string} marketTokenId  Token ID do outcome alvo
 * @param {string} side           Lado da ordem (apenas "BUY" suportado)
 * @param {number} sizeUsdc       Tamanho em USDC a arriscar
 * @param {number} limitPrice     Preço-limite (0–1), ex: 0.82 → 82c
 * @param {number} probability    Probabilidade estimada em % (apenas para log)
 */
export async function executeTrade(marketTokenId, side, sizeUsdc, limitPrice, probability) {
  // ── Validações de entrada ────────────────────────────────────────────────
  const tokenId      = String(marketTokenId ?? "").trim();
  if (!tokenId) throw new Error("[executor] marketTokenId ausente ou vazio.");

  if (String(side).toUpperCase() !== Side.BUY) {
    throw new Error(`[executor] Lado "${side}" não suportado. Apenas BUY é permitido.`);
  }

  const usdcSize     = assertFinite(sizeUsdc,    "sizeUsdc");
  const price        = assertFinite(limitPrice,  "limitPrice");
  const probabilityN = assertFinite(probability, "probability");

  if (usdcSize <= 0)            throw new Error("[executor] sizeUsdc deve ser > 0.");
  if (price <= 0 || price >= 1) throw new Error("[executor] limitPrice deve estar entre 0 e 1 (exclusive).");

  const shareSize = usdcSize / price;

  // ── Mock Mode ────────────────────────────────────────────────────────────
  if (TRADE_MOCK) {
    console.log(
      `${ANSI.yellow}[MOCK EXECUCAO] Apostando $${usdcSize.toFixed(2)} em ${Side.BUY}` +
      ` no Token ${tokenId} a ${formatCents(price)}` +
      ` (Probabilidade: ${probabilityN.toFixed(2)}%)${ANSI.reset}`
    );
    return { success: true, mock: true, tokenId, side: Side.BUY, usdcSize, shareSize, price, probability: probabilityN };
  }

  // ── Modo Real ────────────────────────────────────────────────────────────
  console.log(
    `${ANSI.green}[EXECUCAO] Apostando $${usdcSize.toFixed(2)} em ${Side.BUY}` +
    ` no Token ${tokenId} a ${formatCents(price)}` +
    ` (Probabilidade: ${probabilityN.toFixed(2)}%)${ANSI.reset}`
  );

  const order = await clobClient.createOrder({
    tokenID:    tokenId,
    side:       Side.BUY,
    price,
    size:       shareSize,
    feeRateBps: 0,
  });

  try {
    const response = await clobClient.postOrder(order, OrderType.GTC);
    console.log(`${ANSI.green}[EXECUCAO] Ordem enviada com sucesso.${ANSI.reset}`);
    return response;
  } catch (err) {
    console.error(`${ANSI.red}[EXECUCAO] Falha ao enviar ordem: ${err?.message ?? String(err)}${ANSI.reset}`);
    throw err;
  }
}
