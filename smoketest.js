import "dotenv/config";
import { JsonRpcProvider, Wallet } from "ethers";
import { Chain, ClobClient } from "@polymarket/clob-client";

// ─── ANSI colours ────────────────────────────────────────────────────────────

const R = "\x1b[31m"; // red
const G = "\x1b[32m"; // green
const Y = "\x1b[33m"; // yellow
const B = "\x1b[1m";  // bold
const X = "\x1b[0m";  // reset

// ─── Load & validate env vars ────────────────────────────────────────────────

const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST || "https://clob.polymarket.com";
const RPC_URL   = process.env.POLYGON_RPC_URL       || "https://polygon-rpc.com";

const PK          = String(process.env.PK                      ?? "").trim();
const API_KEY     = String(process.env.POLYMARKET_API_KEY      ?? "").trim();
const API_SECRET  = String(process.env.POLYMARKET_API_SECRET   ?? "").trim();
const PASSPHRASE  = String(process.env.POLYMARKET_API_PASSPHRASE ?? "").trim();

const missing = [
  !PK         && "PK",
  !API_KEY    && "POLYMARKET_API_KEY",
  !API_SECRET && "POLYMARKET_API_SECRET",
  !PASSPHRASE && "POLYMARKET_API_PASSPHRASE",
].filter(Boolean);

if (missing.length) {
  console.error(
    `\n${R}${B}[ERRO] Variáveis de ambiente ausentes no .env:${X}\n` +
    missing.map(v => `  ${R}• ${v}${X}`).join("\n") + "\n"
  );
  process.exit(1);
}

// ─── Build ClobClient ────────────────────────────────────────────────────────

const normalizedPK = PK.startsWith("0x") ? PK : `0x${PK}`;

let clobClient;
try {
  const provider = new JsonRpcProvider(RPC_URL);
  const wallet   = new Wallet(normalizedPK, provider);

  clobClient = new ClobClient(
    CLOB_HOST,
    Chain.POLYGON,
    wallet,
    { key: API_KEY, secret: API_SECRET, passphrase: PASSPHRASE }
  );

  console.log(`${Y}[smoketest] ClobClient construído. Iniciando validação L2…${X}\n`);
} catch (initErr) {
  console.error(
    `\n${R}${B}[FALHA FATAL] Erro ao instanciar ClobClient.${X}\n` +
    `${R}Detalhe: ${initErr?.message ?? String(initErr)}${X}\n`
  );
  process.exit(1);
}

// ─── Authenticated probe ──────────────────────────────────────────────────────
// getApiKeys() → GET /auth/api-keys: o probe de auth mais direto do SDK.
// Retorna as API keys da conta se autenticado → 401 se as credenciais forem inválidas.

async function runSmokeTest() {
  try {
    const result = await clobClient.getApiKeys();

    // O SDK v2.x NÃO lança exceção em 401 — loga internamente e retorna
    // undefined/null ou { error: '...' }. Checamos ambos os casos.
    const errorMsg = result?.error ?? null;
    if (!result || errorMsg) {
      const fake = new Error(errorMsg ?? "Unauthorized/Invalid api key");
      fake.status = 401;
      throw fake;
    }

    // Chegou aqui: autenticação L2 aceita pelo servidor.
    const keyCount = Array.isArray(result) ? result.length : "?";
    console.log(
      `${G}${B}╔══════════════════════════════════════════════════════════╗${X}\n` +
      `${G}${B}║  [SUCESSO] Chaves validadas e conexão L2 perfeita!       ║${X}\n` +
      `${G}${B}╚══════════════════════════════════════════════════════════╝${X}\n` +
      `${G}  • Endpoint  : ${CLOB_HOST}${X}\n` +
      `${G}  • API Key   : ${API_KEY.slice(0, 8)}…${X}\n` +
      `${G}  • API keys na conta: ${keyCount}${X}\n`
    );
  } catch (err) {
    // O SDK v2.x pode lançar um TypeError interno ao parsear respostas vazias.
    // Inspecionamos tanto err.status quanto err.cause?.status para cobrir ambos os casos.
    const message    = err?.message ?? String(err);
    const statusCode = err?.status
      ?? err?.statusCode
      ?? err?.cause?.status
      ?? err?.response?.status
      ?? null;

    const rawStr  = JSON.stringify(err) ?? "";
    const is401   = statusCode === 401
      || message.includes("401")
      || rawStr.includes("401")
      || message.toLowerCase().includes("unauthorized")
      || message.toLowerCase().includes("not authorized");

    if (is401) {
      console.error(
        `\n${R}${B}╔══════════════════════════════════════════════════════════════════╗${X}\n` +
        `${R}${B}║  [FALHA FATAL] A API da Polymarket rejeitou as chaves fornecidas. ║${X}\n` +
        `${R}${B}║               Chave Inválida.                                     ║${X}\n` +
        `${R}${B}╚══════════════════════════════════════════════════════════════════╝${X}\n` +
        `${R}  • HTTP Status : 401 Unauthorized${X}\n` +
        `${R}  • Verifique POLYMARKET_API_KEY, POLYMARKET_API_SECRET e${X}\n` +
        `${R}    POLYMARKET_API_PASSPHRASE no seu arquivo .env.${X}\n` +
        `${R}  • Certifique-se que as chaves pertencem à carteira PK correta.${X}\n` +
        `${R}  • Detalhe do erro: ${message}${X}\n`
      );
    } else {
      console.error(
        `\n${R}${B}[ERRO INESPERADO] Falha na requisição autenticada.${X}\n` +
        `${R}  • Status : ${statusCode ?? "N/A"}${X}\n` +
        `${R}  • Detalhe: ${message}${X}\n` +
        `${R}  • Raw   : ${rawStr}${X}\n` +
        `${R}  Isso pode indicar problema de rede, RPC ou endpoint fora do ar.${X}\n`
      );
    }

    process.exit(1);
  }
}

runSmokeTest();
