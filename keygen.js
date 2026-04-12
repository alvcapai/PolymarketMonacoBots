/**
 * keygen.js — cria User API keys (CLOB L2) para Polymarket
 *
 * Bypassa o SDK completamente para a assinatura L1 (EIP-712) usando
 * ethers v6 diretamente, evitando o bug de compatibilidade v5/_signTypedData.
 *
 * ATENÇÃO: Cria "User API keys" — diferentes das "Builder API keys" do site.
 * As User API keys são as credenciais L2 necessárias para negociar via CLOB.
 */

import "dotenv/config";
import crypto          from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve }     from "path";
import { JsonRpcProvider, Wallet } from "ethers";

// ─── ANSI colours ────────────────────────────────────────────────────────────

const R = "\x1b[31m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const B = "\x1b[1m";
const X = "\x1b[0m";

// ─── Config ───────────────────────────────────────────────────────────────────

const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST || "https://clob.polymarket.com";
const RPC_URL   = process.env.POLYGON_RPC_URL       || "https://polygon-rpc.com";
const CHAIN_ID  = 137; // Polygon mainnet
const ENV_PATH  = resolve(process.cwd(), ".env");

const PK = String(process.env.PK ?? "").trim();
const PROXY_ADDRESS = String(process.env.POLYMARKET_PROXY_ADDRESS ?? "").trim();
const SIGNATURE_TYPE = String(
  process.env.POLYMARKET_SIGNATURE_TYPE ?? (PROXY_ADDRESS ? "2" : "0")
).trim();

if (!PK) {
  console.error(`\n${R}${B}[ERRO] PK ausente no .env.${X}\n`);
  process.exit(1);
}
if (!existsSync(ENV_PATH)) {
  console.error(`\n${R}${B}[ERRO] .env não encontrado em: ${ENV_PATH}${X}\n`);
  process.exit(1);
}

// ─── EIP-712 — estrutura ClobAuth ─────────────────────────────────────────────

const EIP712_DOMAIN = {
  name:    "ClobAuthDomain",
  version: "1",
  chainId: CHAIN_ID,
};

const EIP712_TYPES = {
  ClobAuth: [
    { name: "address",   type: "address" },
    { name: "timestamp", type: "string"  },
    { name: "nonce",     type: "uint256" },
    { name: "message",   type: "string"  },
  ],
};

const MSG_TO_SIGN = "This message attests that I control the given wallet";

// ─── HMAC L2 (para validação pós-criação) ────────────────────────────────────

function buildHmacSignature(secret, timestamp, method, path, body = "") {
  const message     = `${timestamp}${method}${path}${body}`;
  const secretStd   = secret.replace(/-/g, "+").replace(/_/g, "/");
  const secretBytes = Buffer.from(secretStd, "base64");
  return crypto.createHmac("sha256", secretBytes).update(message).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_");
}

// ─── .env patcher ────────────────────────────────────────────────────────────

function patchEnv(content, key, value) {
  const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex   = new RegExp(`^${safeKey}=.*$`, "m");
  const line    = `${key}=${value}`;
  return regex.test(content)
    ? content.replace(regex, line)
    : content.trimEnd() + "\n" + line + "\n";
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${Y}${B}[keygen] Criando User API keys Polymarket CLOB L2…${X}\n`);
  console.log(`${C}  • Endpoint : ${CLOB_HOST}${X}`);
  console.log(`${C}  • Chain    : Polygon (${CHAIN_ID})${X}`);
  console.log(`${C}  • .env     : ${ENV_PATH}${X}\n`);
  if (PROXY_ADDRESS) {
    console.log(`${C}  • Funder   : ${PROXY_ADDRESS}${X}`);
    console.log(`${C}  • Sig type : ${SIGNATURE_TYPE}${X}\n`);
  }

  // ── [1] Instanciar wallet ──────────────────────────────────────────────────
  let wallet;
  try {
    const normalizedPK = PK.startsWith("0x") ? PK : `0x${PK}`;
    const provider     = new JsonRpcProvider(RPC_URL);
    wallet             = new Wallet(normalizedPK, provider);
    console.log(`${Y}  [1/4] Wallet: ${wallet.address}${X}`);
  } catch (err) {
    console.error(
      `\n${R}${B}╔═══════════════════════════════════════════════╗${X}\n` +
      `${R}${B}║  [FALHA] Não foi possível instanciar wallet.  ║${X}\n` +
      `${R}${B}╚═══════════════════════════════════════════════╝${X}\n` +
      `${R}  Detalhe: ${err?.message ?? String(err)}${X}\n`
    );
    process.exit(1);
  }

  // ── Helper: assina EIP-712 e monta headers L1 ─────────────────────────────
  async function buildL1Headers(nonce = 0) {
    const ts        = Math.floor(Date.now() / 1000).toString();
    const value     = {
      address:   wallet.address,
      timestamp: ts,
      nonce,
      message:   MSG_TO_SIGN,
    };
    const signature = await wallet.signTypedData(EIP712_DOMAIN, EIP712_TYPES, value);
    return {
      "Content-Type":   "application/json",
      "POLY_ADDRESS":   wallet.address,
      "POLY_SIGNATURE": signature,
      "POLY_TIMESTAMP": ts,
      "POLY_NONCE":     String(nonce),
    };
  }

  // ── Helper: tenta criar, deletar (L1) e recriar a key ────────────────────
  async function tryCreate(nonce = 0) {
    const headers = await buildL1Headers(nonce);
    const params  = new URLSearchParams();
    if (PROXY_ADDRESS) {
      params.set("signature_type", SIGNATURE_TYPE);
      params.set("funder", PROXY_ADDRESS);
    }
    const url = `${CLOB_HOST}/auth/api-key${params.size ? `?${params.toString()}` : ""}`;
    const res = await fetch(url, { method: "POST", headers });
    const body    = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body };
  }

  async function tryDelete(nonce = 0) {
    // O SDK usa L2 para delete, mas tentamos L1 — o servidor pode aceitar.
    const headers = await buildL1Headers(nonce);
    const res     = await fetch(`${CLOB_HOST}/auth/api-key`, { method: "DELETE", headers });
    const body    = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body };
  }

  async function tryDerive(nonce = 0) {
    const headers = await buildL1Headers(nonce);
    const params  = new URLSearchParams();
    if (PROXY_ADDRESS) {
      params.set("signature_type", SIGNATURE_TYPE);
      params.set("funder", PROXY_ADDRESS);
    }
    const url = `${CLOB_HOST}/auth/derive-api-key${params.size ? `?${params.toString()}` : ""}`;
    const res = await fetch(url, { method: "GET", headers });
    const body    = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body };
  }

  function extractCreds(body, label) {
    const key        = body.apiKey ?? body.key;
    const secret     = body.secret;
    const passphrase = body.passphrase;
    if (!key || !secret || !passphrase) {
      throw new Error(`Resposta incompleta (${label}): ${JSON.stringify(body)}`);
    }
    return { key, secret, passphrase };
  }

  // ── Helper: testa credenciais L2 em memória ──────────────────────────────
  async function testCreds(c) {
    const ts  = Math.floor(Date.now() / 1000).toString();
    const sig = buildHmacSignature(c.secret, ts, "GET", "/auth/api-keys");
    const res = await fetch(`${CLOB_HOST}/auth/api-keys`, {
      method: "GET",
      headers: {
        "POLY_ADDRESS":    wallet.address,
        "POLY_API_KEY":    c.key,
        "POLY_PASSPHRASE": c.passphrase,
        "POLY_TIMESTAMP":  ts,
        "POLY_SIGNATURE":  sig,
      },
    });
    return res.ok;
  }

  // ── [2] Criar ou derivar User API key (tenta nonces 0‥4) ─────────────────
  let creds;
  try {
    console.log(`${Y}  [2/4] Criando/derivando User API key…${X}`);

    // Passo A: tenta criar com nonces crescentes
    for (let nonce = 0; nonce <= 4; nonce++) {
      const r = await tryCreate(nonce);
      if (r.ok) {
        const c = extractCreds(r.body, `create nonce=${nonce}`);
        console.log(`${Y}        Criada (nonce=${nonce}): ${c.key}${X}`);
        creds = c;
        break;
      }
      console.log(`${Y}        POST nonce=${nonce} → ${r.status} (${r.body?.error ?? "sem detalhe"})${X}`);
    }

    // Passo B: se criação falhou, deriva e testa cada nonce
    if (!creds) {
      console.log(`${Y}        Criação bloqueada — derivando por nonce…${X}`);
      for (let nonce = 0; nonce <= 4; nonce++) {
        const r = await tryDerive(nonce);
        if (!r.ok) {
          console.log(`${Y}        DERIVE nonce=${nonce} → ${r.status}${X}`);
          continue;
        }
        const c = extractCreds(r.body, `derive nonce=${nonce}`);
        console.log(`${Y}        Derivada nonce=${nonce}: ${c.key} — testando…${X}`);
        if (await testCreds(c)) {
          creds = c;
          console.log(`${Y}        Válida! ✓${X}`);
          break;
        }
        console.log(`${Y}        Inválida para L2, tentando próximo nonce…${X}`);
      }
    }

    if (!creds) {
      throw new Error(
        "Nenhum nonce (0‥4) produziu credenciais válidas.\n" +
        "  Possíveis causas:\n" +
        "  1. A carteira não tem permissão para CLOB API (conta sem atividade)\n" +
        "  2. A assinatura EIP-712 está incorreta para este servidor\n" +
        "  3. Entre em contato com o suporte da Polymarket para resetar as API keys"
      );
    }
  } catch (err) {
    const msg = err?.message ?? String(err);
    console.error(
      `\n${R}${B}╔══════════════════════════════════════════════════════════╗${X}\n` +
      `${R}${B}║  [FALHA] Não foi possível criar/recuperar a User API key.  ║${X}\n` +
      `${R}${B}╚══════════════════════════════════════════════════════════╝${X}\n` +
      `${R}${msg}${X}\n`
    );
    process.exit(1);
  }

  // ── [3] Validar credenciais antes de gravar ────────────────────────────────
  console.log(`${Y}  [3/4] Validando credenciais contra a API…${X}`);
  try {
    const ts        = Math.floor(Date.now() / 1000).toString();
    const endpoint  = "/auth/api-keys";
    const signature = buildHmacSignature(creds.secret, ts, "GET", endpoint);

    const res  = await fetch(`${CLOB_HOST}${endpoint}`, {
      method:  "GET",
      headers: {
        "POLY_API_KEY":   creds.key,
        "POLY_PASSPHRASE": creds.passphrase,
        "POLY_TIMESTAMP": ts,
        "POLY_SIGNATURE": signature,
        "POLY_ADDRESS":   wallet.address,
      },
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw Object.assign(
        new Error(body?.error ?? `HTTP ${res.status}`),
        { status: res.status }
      );
    }
    const count = Array.isArray(body) ? body.length : "?";
    console.log(`${Y}        Validação OK — ${count} key(s) na conta.${X}`);
  } catch (err) {
    console.error(
      `\n${R}${B}[FALHA] Credenciais criadas mas rejeitadas na validação.${X}\n` +
      `${R}  Detalhe: ${err?.message ?? String(err)}${X}\n`
    );
    process.exit(1);
  }

  // ── [4] Gravar no .env ─────────────────────────────────────────────────────
  try {
    console.log(`${Y}  [4/4] Gravando credenciais validadas no .env…${X}`);
    let content = readFileSync(ENV_PATH, "utf8");
    content = patchEnv(content, "POLYMARKET_API_KEY",        creds.key);
    content = patchEnv(content, "POLYMARKET_API_SECRET",     creds.secret);
    content = patchEnv(content, "POLYMARKET_API_PASSPHRASE", creds.passphrase);
    writeFileSync(ENV_PATH, content, "utf8");
  } catch (err) {
    console.error(
      `\n${R}${B}[FALHA] Não foi possível gravar no .env.${X}\n` +
      `${R}  Detalhe: ${err?.message ?? String(err)}${X}\n\n` +
      `${Y}  Copie manualmente:${X}\n` +
      `  POLYMARKET_API_KEY=${creds.key}\n` +
      `  POLYMARKET_API_SECRET=${creds.secret}\n` +
      `  POLYMARKET_API_PASSPHRASE=${creds.passphrase}\n`
    );
    process.exit(1);
  }

  // ── Sucesso ────────────────────────────────────────────────────────────────
  console.log(
    `\n${G}${B}╔══════════════════════════════════════════════════════════════════╗${X}\n` +
    `${G}${B}║  [SUCESSO] User API key criada, validada e gravada no .env!      ║${X}\n` +
    `${G}${B}╚══════════════════════════════════════════════════════════════════╝${X}\n` +
    `${G}  • Wallet               : ${wallet.address}${X}\n` +
    `${G}  • POLYMARKET_API_KEY   : ${creds.key}${X}\n` +
    `${G}  • POLYMARKET_API_SECRET: ${creds.secret.slice(0, 12)}…${X}\n` +
    `${G}  • POLYMARKET_PASSPHRASE: ${creds.passphrase.slice(0, 12)}…${X}\n\n` +
    `${C}  Execute agora: node smoketest.js${X}\n`
  );
}

run();
