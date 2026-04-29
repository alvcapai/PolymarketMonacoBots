import "dotenv/config";
import crypto from "node:crypto";
import { Contract, Interface, JsonRpcProvider, Wallet } from "ethers";
import { ClobClient, OrderType, Side } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CONFIG } from "../config.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const ANSI = {
  reset:   "\x1b[0m",
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  bold:    "\x1b[1m",
};

const CLOB_HOST      = process.env.POLYMARKET_CLOB_HOST || "https://clob.polymarket.com";
const CHAIN_ID       = 137; // Polygon mainnet (number for v2 SDK)
const TRADE_MOCK     = String(process.env.TRADE_MOCK_MODE ?? "true").toLowerCase() === "true";
const PROXY_ADDRESS  = String(process.env.POLYMARKET_PROXY_ADDRESS ?? "").trim();
// Polymarket SignatureType: 0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE
const SIGNATURE_TYPE = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? (PROXY_ADDRESS ? 2 : 0));

// Default tickSize and negRisk for BTC/ETH up-or-down markets
const TICK_SIZE = "0.01";
const NEG_RISK  = false;

// Destination wallet for automatic profit withdrawals
const WITHDRAWAL_ADDRESS = String(
  process.env.WITHDRAWAL_ADDRESS ?? "0xCbaDe218c50692C94001159A406c6Fd9A65dDF417"
).trim();

// USDC on Polygon mainnet
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// ─── ABIs ────────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];

// Gnosis Safe — only the functions needed
const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
];

// EIP-712 SafeTx type (Gnosis Safe v1.3.0+)
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to",             type: "address" },
    { name: "value",          type: "uint256" },
    { name: "data",           type: "bytes"   },
    { name: "operation",      type: "uint8"   },
    { name: "safeTxGas",      type: "uint256" },
    { name: "baseGas",        type: "uint256" },
    { name: "gasPrice",       type: "uint256" },
    { name: "gasToken",       type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce",          type: "uint256" },
  ],
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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

// ─── Balance-allowance sync (the "Activate Funds" step) ─────────────────────

/**
 * Calls POST /balance-allowance/update on the CLOB so the exchange recognises
 * the on-chain USDC allowance.  This is the programmatic equivalent of the
 * "Activate Funds" button shown in the Polymarket UI after a deposit/approve.
 * Safe to call repeatedly — it's a no-op when already synced.
 */
async function ensureBalanceAllowance() {
  if (!clobClient) return;
  try {
    await clobClient.updateBalanceAllowance({ asset_type: "COLLATERAL" });
  } catch (err) {
    // Non-fatal: the order may still succeed if already activated
    process.stderr.write(
      `${ANSI.yellow}[executor] updateBalanceAllowance falhou (não-fatal): ${err?.message}${ANSI.reset}\n`
    );
  }
}

// ─── Initialization ───────────────────────────────────────────────────────────

let clobClient    = null;
let signerWallet  = null;   // ethers wallet (for on-chain txs: USDC transfer, Safe)
let viemAccount   = null;   // viem account (for CLOB V2 signing)
let walletAddress = null;
let apiSecret     = null;
let apiKey        = null;
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

  const pkNormalized = normalizePrivateKey(pk);
  const creds        = loadApiCreds();

  // Ethers wallet for on-chain operations (USDC transfer, Gnosis Safe)
  const provider = new JsonRpcProvider(CONFIG.chainlink.polygonRpcUrl);
  const wallet   = new Wallet(pkNormalized, provider);

  // Viem account for CLOB V2 EIP-712 signing
  const account = privateKeyToAccount(pkNormalized);
  const viemSigner = createWalletClient({
    account,
    chain: { id: CHAIN_ID, rpcUrls: { default: { http: [CONFIG.chainlink.polygonRpcUrl] } } },
    transport: http(),
  });

  signerWallet   = wallet;
  viemAccount    = account;
  walletAddress  = wallet.address;
  apiSecret      = creds.secret;
  apiKey         = creds.key;
  apiPassphrase  = creds.passphrase;

  // ── ClobClient V2 with options-object constructor ───────────────────────
  clobClient = new ClobClient({
    host:          CLOB_HOST,
    chain:         CHAIN_ID,
    signer:        viemSigner,
    creds:         creds,
    signatureType: SIGNATURE_TYPE,
    funderAddress: PROXY_ADDRESS || undefined,
  });

  console.log(
    `${ANSI.green}[executor] ClobClient V2 inicializado (modo real, sig type ${SIGNATURE_TYPE}` +
    `${PROXY_ADDRESS ? `, funder ${PROXY_ADDRESS}` : ""}).${ANSI.reset}`
  );
} else {
  console.log(`${ANSI.yellow}[executor] TRADE_MOCK_MODE ativo — nenhuma ordem real será enviada.${ANSI.reset}`);
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

// ─── transferUsdc ─────────────────────────────────────────────────────────────
/**
 * Transfere USDC para uma carteira externa (Monaco Rule / saque de lucros).
 *
 * Sig type 0/1 (EOA): assina e envia transfer() diretamente.
 * Sig type 2 (Gnosis Safe): executa via execTransaction() no contrato safe,
 *   assinado com EIP-712 pelo EOA owner — o mesmo padrão do approve_usdc.js.
 *
 * @param {string} toAddress     Carteira destino
 * @param {number} amountUsdc    Valor em dólares a transferir (ex: 100)
 * @returns {{ success: boolean, txHash?: string, mock?: boolean }}
 */
export async function transferUsdc(toAddress, amountUsdc) {
  if (TRADE_MOCK) {
    console.log(
      `${ANSI.yellow}[MOCK SAQUE] $${amountUsdc.toFixed(2)} USDC → ${toAddress}${ANSI.reset}`
    );
    return { success: true, mock: true };
  }

  if (!signerWallet) {
    throw new Error("[executor] Wallet não inicializada — TRADE_MOCK_MODE deve ser false.");
  }

  const amount = BigInt(Math.floor(amountUsdc * 1_000_000)); // USDC = 6 decimais
  const usdcIface = new Interface(ERC20_ABI);
  const transferData = usdcIface.encodeFunctionData("transfer", [toAddress, amount]);

  // ── Modo EOA direto (sig type 0 ou 1) ───────────────────────────────────
  if (SIGNATURE_TYPE !== 2 || !PROXY_ADDRESS) {
    const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, signerWallet);
    const tx   = await usdc.transfer(toAddress, amount);
    console.log(`${ANSI.green}[SAQUE] Tx enviada: ${tx.hash}${ANSI.reset}`);
    const receipt = await tx.wait(1);
    return { success: true, txHash: receipt.hash };
  }

  // ── Modo Gnosis Safe (sig type 2) — execTransaction ──────────────────────
  const safe = new Contract(PROXY_ADDRESS, SAFE_ABI, signerWallet.provider);

  const safeNonce = await safe.nonce();

  const safeTx = {
    to:             USDC_ADDRESS,
    value:          0n,
    data:           transferData,
    operation:      0,          // CALL
    safeTxGas:      0n,
    baseGas:        0n,
    gasPrice:       0n,
    gasToken:       ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce:          safeNonce,
  };

  const domain = { chainId: 137, verifyingContract: PROXY_ADDRESS };
  const signature = await signerWallet.signTypedData(domain, SAFE_TX_TYPES, safeTx);

  const safeWithSigner = safe.connect(signerWallet);
  const tx = await safeWithSigner.execTransaction(
    safeTx.to,
    safeTx.value,
    safeTx.data,
    safeTx.operation,
    safeTx.safeTxGas,
    safeTx.baseGas,
    safeTx.gasPrice,
    safeTx.gasToken,
    safeTx.refundReceiver,
    signature,
  );

  console.log(`${ANSI.green}[SAQUE] execTransaction enviada: ${tx.hash}${ANSI.reset}`);
  const receipt = await tx.wait(1);
  return { success: true, txHash: receipt.hash };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Executa (ou simula) uma ordem de compra no Polymarket CLOB V2.
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

  // Arredondar para o tick mínimo do Polymarket (0.01 = 1 centavo)
  const roundedPrice = Math.round(price * 100) / 100;
  if (roundedPrice !== price) {
    process.stderr.write(
      `${ANSI.yellow}[executor] Preço ajustado para tick mínimo: ${price} → ${roundedPrice}${ANSI.reset}\n`
    );
  }
  // Arredondar shares para CIMA com 2 casas decimais.
  const shareSize = Math.ceil((usdcSize / roundedPrice) * 100) / 100;

  // ── Mock Mode ────────────────────────────────────────────────────────────
  if (TRADE_MOCK) {
    process.stderr.write(
      `${ANSI.yellow}[MOCK EXECUCAO] Apostando $${usdcSize.toFixed(2)} em ${Side.BUY}` +
      ` no Token ${tokenId} a ${formatCents(price)}` +
      ` (Probabilidade: ${probabilityN.toFixed(2)}%)${ANSI.reset}\n`
    );
    return { success: true, mock: true, tokenId, side: Side.BUY, usdcSize, shareSize, price, probability: probabilityN };
  }

  // ── Modo Real (CLOB V2) ─────────────────────────────────────────────────
  process.stderr.write(
    `${ANSI.green}[EXECUCAO] Apostando $${usdcSize.toFixed(2)} em ${Side.BUY}` +
    ` no Token ${tokenId} a ${formatCents(price)}` +
    ` (Probabilidade: ${probabilityN.toFixed(2)}%)${ANSI.reset}\n`
  );

  // Sync on-chain allowance with CLOB ("Activate Funds")
  await ensureBalanceAllowance();

  // CLOB V2: createAndPostOrder creates, signs, and posts in one call
  let response;
  try {
    response = await clobClient.createAndPostOrder(
      {
        tokenID: tokenId,
        side:    Side.BUY,
        price:   roundedPrice,
        size:    shareSize,
      },
      { tickSize: TICK_SIZE, negRisk: NEG_RISK },
      OrderType.GTC,
    );
  } catch (err) {
    const detail = err?.message ?? String(err);
    process.stderr.write(`${ANSI.red}[EXECUCAO] Exceção ao enviar ordem: ${detail}${ANSI.reset}\n`);
    throw err;
  }

  // Detectar rejeição silenciosa da API (retorno { error: ... } sem throw)
  if (response && typeof response === "object" && ("error" in response || "errorCode" in response)) {
    const apiError = response.error ?? response.errorCode ?? JSON.stringify(response);
    const detail = typeof apiError === "object" ? JSON.stringify(apiError) : String(apiError);
    process.stderr.write(
      `${ANSI.red}[EXECUCAO] API rejeitou a ordem — resposta completa: ${JSON.stringify(response)}${ANSI.reset}\n`
    );
    throw new Error(`[executor] API rejeitou a ordem: ${detail}`);
  }

  // Verificar se a resposta tem o shape esperado de uma ordem aceita
  if (!response || typeof response !== "object") {
    process.stderr.write(
      `${ANSI.red}[EXECUCAO] Resposta inesperada da API: ${JSON.stringify(response)}${ANSI.reset}\n`
    );
    throw new Error(`[executor] Resposta inesperada da API: ${JSON.stringify(response)}`);
  }

  process.stderr.write(
    `${ANSI.green}[EXECUCAO] Ordem aceita pela API. Resposta: ${JSON.stringify(response)}${ANSI.reset}\n`
  );
  return response;
}

/**
 * Executa (ou simula) uma ordem de VENDA no Polymarket CLOB V2.
 * Usada pelo take-profit para liquidar posições antes do settlement.
 *
 * @param {string} tokenId    Token ID do outcome a vender
 * @param {number} shareSize  Quantidade de shares a vender
 * @param {number} limitPrice Preço-limite (0–1), ex: 0.80 → 80c
 */
export async function executeSell(tokenId, shareSize, limitPrice) {
  const token = String(tokenId ?? "").trim();
  if (!token) throw new Error("[executor] tokenId ausente ou vazio para SELL.");

  const size  = assertFinite(shareSize, "shareSize");
  const price = assertFinite(limitPrice, "limitPrice");

  if (size <= 0)              throw new Error("[executor] shareSize deve ser > 0.");
  if (price <= 0 || price >= 1) throw new Error("[executor] limitPrice deve estar entre 0 e 1 (exclusive).");

  const roundedPrice = Math.round(price * 100) / 100;
  if (roundedPrice !== price) {
    process.stderr.write(
      `${ANSI.yellow}[executor] Preço SELL ajustado para tick mínimo: ${price} → ${roundedPrice}${ANSI.reset}\n`
    );
  }

  const roundedSize = Math.floor(size * 100) / 100;

  if (TRADE_MOCK) {
    process.stderr.write(
      `${ANSI.yellow}[MOCK SELL] ${roundedSize} shares do Token ${token.slice(0, 20)}... ` +
      `a ${formatCents(roundedPrice)} [MOCK]${ANSI.reset}\n`
    );
    return { success: true, mock: true, tokenId: token, side: "SELL", shareSize: roundedSize, price: roundedPrice };
  }

  process.stderr.write(
    `${ANSI.green}[EXECUCAO] Vendendo ${roundedSize} shares do Token ${token.slice(0, 20)}... ` +
    `a ${formatCents(roundedPrice)}${ANSI.reset}\n`
  );

  // Sync on-chain allowance with CLOB ("Activate Funds")
  await ensureBalanceAllowance();

  let response;
  try {
    response = await clobClient.createAndPostOrder(
      {
        tokenID: token,
        side:    Side.SELL,
        price:   roundedPrice,
        size:    roundedSize,
      },
      { tickSize: TICK_SIZE, negRisk: NEG_RISK },
      OrderType.GTC,
    );
  } catch (err) {
    const detail = err?.message ?? String(err);
    process.stderr.write(`${ANSI.red}[EXECUCAO] Exceção ao enviar ordem SELL: ${detail}${ANSI.reset}\n`);
    throw err;
  }

  if (response && typeof response === "object" && ("error" in response || "errorCode" in response)) {
    const apiError = response.error ?? response.errorCode ?? JSON.stringify(response);
    const detail = typeof apiError === "object" ? JSON.stringify(apiError) : String(apiError);
    process.stderr.write(
      `${ANSI.red}[EXECUCAO] API rejeitou a ordem SELL — resposta completa: ${JSON.stringify(response)}${ANSI.reset}\n`
    );
    throw new Error(`[executor] API rejeitou a ordem SELL: ${detail}`);
  }

  if (!response || typeof response !== "object") {
    process.stderr.write(
      `${ANSI.red}[EXECUCAO] Resposta inesperada da API (SELL): ${JSON.stringify(response)}${ANSI.reset}\n`
    );
    throw new Error(`[executor] Resposta inesperada da API (SELL): ${JSON.stringify(response)}`);
  }

  process.stderr.write(
    `${ANSI.green}[EXECUCAO] Ordem SELL aceita pela API. Resposta: ${JSON.stringify(response)}${ANSI.reset}\n`
  );
  return response;
}

// Exporta o endereço de saque padrão para o index.js poder usar
export { WITHDRAWAL_ADDRESS };
