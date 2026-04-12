import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { JsonRpcProvider, Wallet } from "ethers";
import { Chain, ClobClient } from "@polymarket/clob-client";

// ─── ANSI colours ────────────────────────────────────────────────────────────

const R = "\x1b[31m"; // red
const G = "\x1b[32m"; // green
const Y = "\x1b[33m"; // yellow
const C = "\x1b[36m"; // cyan
const B = "\x1b[1m";  // bold
const X = "\x1b[0m";  // reset

// ─── Load & validate env vars ────────────────────────────────────────────────

const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST || "https://clob.polymarket.com";
const RPC_URL   = process.env.POLYGON_RPC_URL       || "https://polygon-rpc.com";
const ENV_PATH  = resolve(process.cwd(), ".env");

const PK = String(process.env.PK ?? "").trim();

if (!PK) {
  console.error(
    `\n${R}${B}[ERRO] Variável PK ausente no .env.${X}\n` +
    `${R}  A chave privada da carteira é obrigatória para derivar as API keys.${X}\n`
  );
  process.exit(1);
}

if (!existsSync(ENV_PATH)) {
  console.error(
    `\n${R}${B}[ERRO] Arquivo .env não encontrado em:${X}\n` +
    `${R}  ${ENV_PATH}${X}\n`
  );
  process.exit(1);
}

// ─── .env patcher ────────────────────────────────────────────────────────────

/**
 * Substitui ou insere uma variável no conteúdo do .env.
 * Preserva todas as outras linhas intactas.
 */
function patchEnv(content, key, value) {
  const line = `${key}=${value}`;
  const regex = new RegExp(`^${key}=.*$`, "m");
  return regex.test(content)
    ? content.replace(regex, line)
    : content.trimEnd() + "\n" + line + "\n";
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${Y}${B}[keygen] Iniciando derivação de API keys Polymarket L2…${X}\n`);
  console.log(`${C}  • Wallet  : derivando da PK fornecida${X}`);
  console.log(`${C}  • Endpoint: ${CLOB_HOST}${X}`);
  console.log(`${C}  • .env    : ${ENV_PATH}${X}\n`);

  // ── Instanciar wallet ──────────────────────────────────────────────────────
  let wallet;
  try {
    const normalizedPK = PK.startsWith("0x") ? PK : `0x${PK}`;
    const provider     = new JsonRpcProvider(RPC_URL);
    wallet             = new Wallet(normalizedPK, provider);

    // Shim ethers v5 → v6: o SDK usa _signTypedData (API antiga)
    wallet._signTypedData = wallet.signTypedData.bind(wallet);

    console.log(`${Y}  [1/3] Wallet instanciada: ${wallet.address}${X}`);
  } catch (err) {
    console.error(
      `\n${R}${B}╔══════════════════════════════════════════════════════════╗${X}\n` +
      `${R}${B}║  [FALHA FATAL] Não foi possível instanciar a wallet.      ║${X}\n` +
      `${R}${B}╚══════════════════════════════════════════════════════════╝${X}\n` +
      `${R}  • Verifique se o valor de PK no .env é uma chave privada válida.${X}\n` +
      `${R}  • Detalhe: ${err?.message ?? String(err)}${X}\n`
    );
    process.exit(1);
  }

  // ── Derivar / criar API keys ───────────────────────────────────────────────
  let creds;
  try {
    const client = new ClobClient(CLOB_HOST, Chain.POLYGON, wallet);

    console.log(`${Y}  [2/3] Solicitando API keys ao servidor…${X}`);
    creds = await client.createOrDeriveApiKey();

    if (!creds?.key || !creds?.secret || !creds?.passphrase) {
      throw new Error("Resposta incompleta do servidor — campos key/secret/passphrase ausentes.");
    }
  } catch (err) {
    const message = err?.message ?? String(err);
    console.error(
      `\n${R}${B}╔══════════════════════════════════════════════════════════════════╗${X}\n` +
      `${R}${B}║  [FALHA FATAL] Não foi possível obter as API keys da Polymarket.  ║${X}\n` +
      `${R}${B}╚══════════════════════════════════════════════════════════════════╝${X}\n` +
      `${R}  • Verifique conectividade com ${CLOB_HOST}${X}\n` +
      `${R}  • Certifique-se que a carteira tem USDC na Polygon para ser elegível.${X}\n` +
      `${R}  • Detalhe: ${message}${X}\n`
    );
    process.exit(1);
  }

  // ── Gravar no .env ─────────────────────────────────────────────────────────
  try {
    console.log(`${Y}  [3/3] Gravando credenciais no .env…${X}`);

    let content = readFileSync(ENV_PATH, "utf8");
    content = patchEnv(content, "POLYMARKET_API_KEY",        creds.key);
    content = patchEnv(content, "POLYMARKET_API_SECRET",     creds.secret);
    content = patchEnv(content, "POLYMARKET_API_PASSPHRASE", creds.passphrase);
    writeFileSync(ENV_PATH, content, "utf8");
  } catch (err) {
    console.error(
      `\n${R}${B}[FALHA FATAL] Não foi possível gravar no .env.${X}\n` +
      `${R}  • Detalhe: ${err?.message ?? String(err)}${X}\n\n` +
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
    `${G}${B}║  [SUCESSO] API keys derivadas e gravadas no .env com sucesso!    ║${X}\n` +
    `${G}${B}╚══════════════════════════════════════════════════════════════════╝${X}\n` +
    `${G}  • POLYMARKET_API_KEY        : ${creds.key}${X}\n` +
    `${G}  • POLYMARKET_API_SECRET     : ${creds.secret.slice(0, 10)}…${X}\n` +
    `${G}  • POLYMARKET_API_PASSPHRASE : ${creds.passphrase.slice(0, 10)}…${X}\n\n` +
    `${C}  Execute agora: node smoketest.js${X}\n`
  );
}

run();
