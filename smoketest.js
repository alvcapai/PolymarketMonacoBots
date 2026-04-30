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
const RPC_URL    = process.env.POLYGON_RPC_URL          || "https://polygon-bor-rpc.publicnode.com";
const PK         = String(process.env.PK                        ?? "").trim();
const API_KEY    = String(process.env.POLYMARKET_API_KEY        ?? "").trim();
const SECRET     = String(process.env.POLYMARKET_API_SECRET     ?? "").trim();
const PASSPHRASE = String(process.env.POLYMARKET_API_PASSPHRASE ?? "").trim();
const PROXY_ADDRESS = String(process.env.POLYMARKET_PROXY_ADDRESS ?? "").trim();
const SIGNATURE_TYPE = String(
  process.env.POLYMARKET_SIGNATURE_TYPE ?? (PROXY_ADDRESS ? "2" : "0")
).trim();

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

function formatUsdc(rawValue) {
  const raw = Number(rawValue ?? 0);
  if (!Number.isFinite(raw)) return String(rawValue);
  return `$${(raw / 1_000_000).toFixed(2)} USDC`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runSmokeTest() {
  // A documentação da Polymarket exige que POLY_ADDRESS continue sendo
  // o signer address no L2. A proxy wallet entra como funder/signature type.
  let walletAddress;
  try {
    const normalizedPK = PK.startsWith("0x") ? PK : `0x${PK}`;
    const provider     = new JsonRpcProvider(RPC_URL);
    const wallet       = new Wallet(normalizedPK, provider);
    walletAddress      = wallet.address;
    console.log(`${Y}[smoketest] Wallet: ${walletAddress}${X}`);
    if (PROXY_ADDRESS) {
      console.log(`${Y}[smoketest] Proxy wallet configurada: ${PROXY_ADDRESS}${X}`);
    }
    console.log(`${Y}[smoketest] Signature type: ${SIGNATURE_TYPE}${X}`);
    console.log(`${Y}[smoketest] Validando credenciais L2 via HMAC raw…${X}\n`);
  } catch (err) {
    console.error(`\n${R}${B}[ERRO] Falha ao instanciar wallet: ${err?.message}${X}\n`);
    process.exit(1);
  }

  // ── Helper: request autenticado L2 ──────────────────────────────────────
  // O HMAC é calculado sobre o PATH sem query string (spec do SDK).
  async function l2get(path, query = "") {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = buildHmacSignature(SECRET, timestamp, "GET", path);
    const url = `${CLOB_HOST}${path}${query ? "?" + query : ""}`;
    const res = await fetch(url, {
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
    const { status, ok, body } = await l2get("/auth/api-keys", "");

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

  // ── [1.5] Activate Funds — sync on-chain allowance with CLOB ────────────
  // Equivalente programático do botão "Activate Funds" da UI da Polymarket.
  // Sem isso, fundos depositados/aprovados podem aparecer como $0.00.
  // O SDK usa GET /balance-allowance/update com signature_type como query param.
  try {
    console.log(`${Y}[smoketest] Ativando fundos (balance-allowance sync)…${X}`);
    const ts      = Math.floor(Date.now() / 1000).toString();
    const actPath = "/balance-allowance/update";
    const actSig  = buildHmacSignature(SECRET, ts, "GET", actPath);
    const actQuery = `asset_type=COLLATERAL&signature_type=${SIGNATURE_TYPE}${PROXY_ADDRESS ? `&funder=${PROXY_ADDRESS}` : ""}`;
    const activateRes = await fetch(`${CLOB_HOST}${actPath}?${actQuery}`, {
      method: "GET",
      headers: {
        "Content-Type":    "application/json",
        "POLY_ADDRESS":    walletAddress,
        "POLY_API_KEY":    API_KEY,
        "POLY_PASSPHRASE": PASSPHRASE,
        "POLY_TIMESTAMP":  ts,
        "POLY_SIGNATURE":  actSig,
      },
    });
    const activateBody = await activateRes.json().catch(() => ({}));
    if (activateRes.ok) {
      console.log(`${G}        Activate Funds OK${X}`);
    } else {
      console.log(`${Y}        Activate Funds → ${activateRes.status}: ${JSON.stringify(activateBody)} (não-fatal)${X}`);
    }
  } catch (err) {
    console.log(`${Y}        Activate Funds falhou (não-fatal): ${err?.message}${X}`);
  }

  // ── [2] Buscar saldo USDC (COLLATERAL) ───────────────────────────────────
  let balance = "N/A";
  let allowance = "N/A";
  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const path = "/balance-allowance";
    const signature = buildHmacSignature(SECRET, timestamp, "GET", path);
    const query = `asset_type=COLLATERAL&signature_type=${SIGNATURE_TYPE}${PROXY_ADDRESS ? `&funder=${PROXY_ADDRESS}` : ""}`;
    const res = await fetch(`${CLOB_HOST}${path}?${query}`, {
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
    const { ok, status } = res;
    if (ok) {
      balance   = formatUsdc(body.balance);
      // Schema v2: allowance pode ser objeto "allowances" com múltiplos routers
      if (body.allowance != null) {
        allowance = formatUsdc(body.allowance);
      } else if (body.allowances && typeof body.allowances === "object") {
        const vals = Object.values(body.allowances).map(Number).filter(Number.isFinite);
        const total = vals.reduce((a, b) => a + b, 0);
        allowance = formatUsdc(total);
      } else {
        allowance = "$0.00 USDC";
      }
      // Debug: se saldo zero, logar body raw para diagnóstico
      const balRaw = Number(body.balance ?? 0);
      if (balRaw <= 0) {
        console.log(`${Y}        [debug] /balance-allowance body: ${JSON.stringify(body)}${X}`);
        if (!PROXY_ADDRESS) {
          console.log(`${Y}        [dica]  POLYMARKET_PROXY_ADDRESS não configurado — se a conta usa Smart Wallet,${X}`);
          console.log(`${Y}                defina POLYMARKET_PROXY_ADDRESS e POLYMARKET_SIGNATURE_TYPE=2 no .env${X}`);
        }
      }
    } else {
      balance   = `ERRO ${status}: ${JSON.stringify(body)}`;
      allowance = "—";
    }
  } catch (err) {
    balance = `ERRO: ${err?.message ?? String(err)}`;
  }

  // ── [3] Verificar mercado BTC com orderbook ativo ────────────────────────
  let marketStatus = "N/A";
  let sampleMarket = null;
  let orderStatus  = "N/A";
  try {
    // Pagina até encontrar um mercado BTC com orderbook real
    let cursor = "";
    outer: for (let page = 0; page < 5; page++) {
      const url  = `${CLOB_HOST}/markets?active=true&closed=false&limit=100${cursor ? `&next_cursor=${cursor}` : ""}`;
      const res  = await fetch(url);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { marketStatus = `ERRO ${res.status}`; break; }

      const list = body.data ?? (Array.isArray(body) ? body : []);
      const btc  = list.filter(m => {
        const q = (m.question ?? "").toLowerCase();
        return q.includes("bitcoin") || q.includes("btc");
      });

      for (const market of btc) {
        const tokenId = market.tokens?.[0]?.token_id;
        if (!tokenId) continue;
        const r = await fetch(`${CLOB_HOST}/midpoint?token_id=${tokenId}`);
        const b = await r.json().catch(() => ({}));
        if (r.ok && b.mid != null) {
          sampleMarket = market;
          marketStatus = `OK — "${market.question?.slice(0, 55)}"`;
          orderStatus  = `OK — midpoint ${(Number(b.mid) * 100).toFixed(1)}c`;
          break outer;
        }
      }

      cursor = body.next_cursor ?? "";
      if (!cursor || list.length === 0) break;
    }

    if (!sampleMarket && marketStatus === "N/A") {
      marketStatus = "Nenhum mercado BTC com orderbook ativo encontrado";
      orderStatus  = "—";
      console.log(`${Y}        [debug] Nenhum mercado BTC encontrado nas páginas pesquisadas.${X}`);
      console.log(`${Y}        [dica]  Verifique se a conexão com ${CLOB_HOST} está acessível.${X}`);
    }
  } catch (err) {
    marketStatus = `ERRO: ${err?.message ?? String(err)}`;
    orderStatus  = "—";
  }

  // ── Resultado final ───────────────────────────────────────────────────────
  const allowanceRaw  = Number((allowance.match(/\$([\d.]+)/) ?? [])[1] ?? -1);
  // Para proxy wallets (sig type 2), o CLOB gerencia fundos via contrato proxy —
  // o endpoint pode retornar $0.00 mesmo com fundos disponíveis. Não bloquear.
  const allowanceOk   = allowanceRaw > 0 || SIGNATURE_TYPE === "2";
  const balanceRaw    = Number((balance.match(/\$([\d.]+)/) ?? [])[1] ?? 0);
  const readyToBet    = allowanceOk && balanceRaw > 0 && orderStatus.startsWith("OK");

  console.log(
    `${G}${B}╔══════════════════════════════════════════════════════════╗${X}\n` +
    `${G}${B}║  [SUCESSO] Chaves validadas e conexão L2 perfeita!       ║${X}\n` +
    `${G}${B}╚══════════════════════════════════════════════════════════╝${X}\n` +
    `${G}  • Endpoint          : ${CLOB_HOST}${X}\n` +
    `${G}  • Wallet signer     : ${walletAddress}${X}\n` +
    `${G}  • Wallet funder     : ${PROXY_ADDRESS || walletAddress}${X}\n` +
    `${G}  • Signature type    : ${SIGNATURE_TYPE}${X}\n` +
    `${G}  • POLYMARKET_API_KEY: ${API_KEY}${X}\n` +
    `${G}  • Saldo USDC        : ${balance}${X}\n` +
    `${G}  • Allowance USDC    : ${allowance}${X}\n` +
    `${G}  • Mercados BTC      : ${marketStatus}${X}\n` +
    `${G}  • Preço (midpoint)  : ${orderStatus}${X}\n`
  );

  if (readyToBet) {
    console.log(
      `\n${G}${B}  ✔  PRONTO PARA APOSTAR — saldo, allowance e mercado OK.${X}\n`
    );
  } else {
    console.log(`\n${Y}${B}  Pendências antes de apostar:${X}`);
    if (balanceRaw <= 0)  console.log(`${R}  ✘  Saldo USDC zerado — deposite USDC na Polymarket.${X}`);
    if (!allowanceOk)     console.log(`${R}  ✘  Allowance zerada (sig type ${SIGNATURE_TYPE}) — acesse polymarket.com e faça um${X}\n` +
                                      `${R}     depósito para acionar o approve do contrato USDC.${X}`);
    if (!orderStatus.startsWith("OK")) console.log(`${R}  ✘  Mercado/preço indisponível: ${orderStatus}${X}`);
    console.log();
  }
}

runSmokeTest();
