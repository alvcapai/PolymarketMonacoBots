#!/usr/bin/env node
/**
 * approve_usdc.js — Aprova os roteadores da Polymarket a gastar Native USDC.
 *
 * Uso:
 *   node scripts/approve_usdc.js                # aprova todos os roteadores
 *   node scripts/approve_usdc.js --dry-run      # mostra o que faria sem enviar tx
 *
 * Requer no .env: PK, POLYGON_RPC_URL (ou usa default)
 * Opcionais:      POLYMARKET_PROXY_ADDRESS (se Gnosis Safe), ALL_PROXY / HTTPS_PROXY
 *
 * Ver docs/BOT-LOGIC.md para contexto da migração.
 */
import "dotenv/config";
import { Contract, FetchRequest, Interface, JsonRpcProvider, MaxUint256, Wallet } from "ethers";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

// ─── Endereços ──────────────────────────────────────────────────────────────

const NATIVE_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

const ROUTERS = [
  { name: "Router 1 (Primary)", address: "0xE111180000d2663C0091e4f400237545B87B996B" },
  { name: "Router 2 / NegRisk Adapter", address: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296" },
];

// ─── Proxy-aware provider (ver docs/AGENT-OPS.md §3) ───────────────────────

function getProxyUrl() {
  const v = (k) => (process.env[k] ?? "").trim();
  return v("ALL_PROXY") || v("all_proxy") || v("HTTPS_PROXY") || v("https_proxy") || "";
}

function createProxiedProvider(rpcUrl) {
  const proxyUrl = getProxyUrl();
  const fetchReq = new FetchRequest(rpcUrl);

  if (proxyUrl) {
    const lower = proxyUrl.toLowerCase();
    const agent = (lower.startsWith("socks") ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl));
    fetchReq.getUrlFunc = FetchRequest.createGetUrlFunc({ agent });
  }

  return new JsonRpcProvider(fetchReq);
}

// ─── ABIs ───────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function symbol() view returns (string)",
];

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
];

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

// ─── Main ───────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const PROXY_ADDRESS = (process.env.POLYMARKET_PROXY_ADDRESS ?? "").trim();
const RPC_URL = process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com";

async function main() {
  const pk = (process.env.PK ?? "").trim();
  if (!pk) { console.error("[approve_usdc] PK ausente no .env"); process.exit(1); }

  const provider = createProxiedProvider(RPC_URL);
  const wallet = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
  const ownerAddress = PROXY_ADDRESS || wallet.address;

  const usdc = new Contract(NATIVE_USDC, ERC20_ABI, wallet);
  const symbol = await usdc.symbol().catch(() => "USDC");

  console.log(`[approve_usdc] Wallet:  ${wallet.address}`);
  console.log(`[approve_usdc] Owner:   ${ownerAddress}${PROXY_ADDRESS ? " (Gnosis Safe)" : " (EOA)"}`);
  console.log(`[approve_usdc] Token:   ${symbol} (${NATIVE_USDC})`);
  console.log(`[approve_usdc] Routers: ${ROUTERS.length}`);
  if (DRY_RUN) console.log(`[approve_usdc] \x1b[33m-- DRY RUN --\x1b[0m`);
  console.log();

  for (const { name, address } of ROUTERS) {
    const current = await usdc.allowance(ownerAddress, address);
    console.log(`  ${name} (${address})`);
    console.log(`    Allowance atual: ${current.toString()}`);

    if (current === MaxUint256) {
      console.log(`    \x1b[32m✓ Já aprovado (MaxUint256)\x1b[0m\n`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`    \x1b[33m→ Faria approve(MaxUint256) [dry-run]\x1b[0m\n`);
      continue;
    }

    const tx = PROXY_ADDRESS
      ? await approveViaSafe(wallet, provider, address)
      : await usdc.approve(address, MaxUint256);

    console.log(`    Tx enviada: ${tx.hash}`);
    const receipt = await tx.wait(1);
    console.log(`    \x1b[32m✓ Confirmada no bloco ${receipt.blockNumber}\x1b[0m\n`);
  }

  console.log("[approve_usdc] Concluído.");
}

async function approveViaSafe(wallet, provider, spender) {
  const erc20Iface = new Interface(ERC20_ABI);
  const approveData = erc20Iface.encodeFunctionData("approve", [spender, MaxUint256]);

  const safe = new Contract(PROXY_ADDRESS, SAFE_ABI, provider);
  const safeNonce = await safe.nonce();

  const safeTx = {
    to: NATIVE_USDC, value: 0n, data: approveData, operation: 0,
    safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
    gasToken: ZERO_ADDRESS, refundReceiver: ZERO_ADDRESS, nonce: safeNonce,
  };

  const domain = { chainId: 137, verifyingContract: PROXY_ADDRESS };
  const signature = await wallet.signTypedData(domain, SAFE_TX_TYPES, safeTx);

  return safe.connect(wallet).execTransaction(
    safeTx.to, safeTx.value, safeTx.data, safeTx.operation,
    safeTx.safeTxGas, safeTx.baseGas, safeTx.gasPrice,
    safeTx.gasToken, safeTx.refundReceiver, signature,
  );
}

main().catch((err) => {
  console.error(`[approve_usdc] Falha fatal: ${err.message}`);
  process.exit(1);
});
