#!/usr/bin/env node
/**
 * deposit_usdc.js — Transfere Native USDC do EOA para a Gnosis Safe (proxy).
 *
 * Uso:
 *   node scripts/deposit_usdc.js <amount>        # transfere <amount> USDC para o proxy
 *   node scripts/deposit_usdc.js --balance        # mostra saldos sem transferir
 *
 * Se não houver POLYMARKET_PROXY_ADDRESS, exibe apenas o saldo do EOA.
 *
 * Requer no .env: PK, POLYGON_RPC_URL (ou usa default)
 * Opcionais:      POLYMARKET_PROXY_ADDRESS, ALL_PROXY / HTTPS_PROXY
 *
 * Ver docs/BOT-LOGIC.md para contexto da migração.
 */
import "dotenv/config";
import { Contract, FetchRequest, JsonRpcProvider, Wallet, parseUnits, formatUnits } from "ethers";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

const NATIVE_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDC_DECIMALS = 6;

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function symbol() view returns (string)",
];

const RPC_URL = process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com";
const PROXY_ADDRESS = (process.env.POLYMARKET_PROXY_ADDRESS ?? "").trim();

function getProxyUrl() {
  const v = (k) => (process.env[k] ?? "").trim();
  return v("ALL_PROXY") || v("all_proxy") || v("HTTPS_PROXY") || v("https_proxy") || "";
}

function createProxiedProvider(rpcUrl) {
  const proxyUrl = getProxyUrl();
  const fetchReq = new FetchRequest(rpcUrl);
  if (proxyUrl) {
    const lower = proxyUrl.toLowerCase();
    const agent = lower.startsWith("socks") ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
    fetchReq.getUrlFunc = FetchRequest.createGetUrlFunc({ agent });
  }
  return new JsonRpcProvider(fetchReq);
}

async function main() {
  const pk = (process.env.PK ?? "").trim();
  if (!pk) { console.error("[deposit_usdc] PK ausente no .env"); process.exit(1); }

  const provider = createProxiedProvider(RPC_URL);
  const wallet = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
  const usdc = new Contract(NATIVE_USDC, ERC20_ABI, wallet);
  const symbol = await usdc.symbol().catch(() => "USDC");

  const eoaBalance = await usdc.balanceOf(wallet.address);
  const eoaFormatted = formatUnits(eoaBalance, USDC_DECIMALS);

  console.log(`[deposit_usdc] Token: ${symbol} (${NATIVE_USDC})`);
  console.log(`[deposit_usdc] EOA (${wallet.address}): ${eoaFormatted} ${symbol}`);

  if (PROXY_ADDRESS) {
    const proxyBalance = await usdc.balanceOf(PROXY_ADDRESS);
    const proxyFormatted = formatUnits(proxyBalance, USDC_DECIMALS);
    console.log(`[deposit_usdc] Proxy (${PROXY_ADDRESS}): ${proxyFormatted} ${symbol}`);
  }

  // --balance: só mostrar saldos
  if (process.argv.includes("--balance")) return;

  // Parse amount argument
  const amountArg = process.argv.find((a) => /^\d+(\.\d+)?$/.test(a));
  if (!amountArg) {
    console.log("\n[deposit_usdc] Uso: node scripts/deposit_usdc.js <amount> | --balance");
    process.exit(0);
  }

  if (!PROXY_ADDRESS) {
    console.error("[deposit_usdc] POLYMARKET_PROXY_ADDRESS não definido — nada a depositar.");
    process.exit(1);
  }

  const amount = parseUnits(amountArg, USDC_DECIMALS);

  if (eoaBalance < amount) {
    console.error(
      `[deposit_usdc] Saldo insuficiente: ${eoaFormatted} < ${amountArg} ${symbol}`
    );
    process.exit(1);
  }

  console.log(`\n[deposit_usdc] Transferindo ${amountArg} ${symbol} → ${PROXY_ADDRESS}`);
  const tx = await usdc.transfer(PROXY_ADDRESS, amount);
  console.log(`[deposit_usdc] Tx enviada: ${tx.hash}`);
  const receipt = await tx.wait(1);
  console.log(`\x1b[32m[deposit_usdc] Confirmada no bloco ${receipt.blockNumber}\x1b[0m`);

  const newProxy = formatUnits(await usdc.balanceOf(PROXY_ADDRESS), USDC_DECIMALS);
  console.log(`[deposit_usdc] Novo saldo proxy: ${newProxy} ${symbol}`);
}

main().catch((err) => {
  console.error(`[deposit_usdc] Falha fatal: ${err.message}`);
  process.exit(1);
});
