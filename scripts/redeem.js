#!/usr/bin/env node
/**
 * redeem.js — Resgate manual de posições vencedoras no CTF (Conditional Tokens Framework).
 *
 * Uso:
 *   node scripts/redeem.js                       # lista posições e resgata todas as vencedoras
 *   node scripts/redeem.js --list                 # apenas lista sem resgatar
 *   node scripts/redeem.js <conditionId>          # resgata um conditionId específico
 *
 * Requer no .env: PK, POLYMARKET_PROXY_ADDRESS, POLYGON_RPC_URL
 * Opcionais:      ALL_PROXY / HTTPS_PROXY
 *
 * Ver docs/BOT-LOGIC.md para contexto da migração.
 */
import "dotenv/config";
import { Contract, FetchRequest, Interface, JsonRpcProvider, Wallet, ZeroHash } from "ethers";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

// ─── Endereços ──────────────────────────────────────────────────────────────

const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const NATIVE_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const DATA_API = "https://data-api.polymarket.com";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ─── ABIs ───────────────────────────────────────────────────────────────────

const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
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

// ─── Proxy provider ─────────────────────────────────────────────────────────

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

// ─── Helpers ────────────────────────────────────────────────────────────────

function toFinite(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function fetchPositions(userAddress) {
  const res = await fetch(
    `${DATA_API}/positions?user=${userAddress}&sizeThreshold=.01&limit=500`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`Data API ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data?.results ?? data?.data ?? []);
}

function findRedeemable(positions) {
  return positions.filter((p) => {
    const price = toFinite(p?.curPrice ?? p?.currentPrice);
    return price === 1 && (p?.redeemable === true || p?.redeemable === "true");
  });
}

// ─── Redeem via Gnosis Safe ─────────────────────────────────────────────────

async function redeemViaSafe(wallet, provider, conditionId, indexSets) {
  const ctfIface = new Interface(CTF_ABI);
  const redeemData = ctfIface.encodeFunctionData("redeemPositions", [
    NATIVE_USDC, ZeroHash, conditionId, indexSets,
  ]);

  const safe = new Contract(PROXY_ADDRESS, SAFE_ABI, provider);
  const safeNonce = await safe.nonce();

  const safeTx = {
    to: CTF_ADDRESS, value: 0n, data: redeemData, operation: 0,
    safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
    gasToken: ZERO_ADDRESS, refundReceiver: ZERO_ADDRESS, nonce: safeNonce,
  };

  const domain = { chainId: 137, verifyingContract: PROXY_ADDRESS };
  const signature = await wallet.signTypedData(domain, SAFE_TX_TYPES, safeTx);

  return safe.connect(wallet).execTransaction(
    safeTx.to, safeTx.value, safeTx.data, safeTx.operation,
    safeTx.safeTxGas, safeTx.baseGas, safeTx.gasPrice,
    safeTx.gasToken, safeTx.refundReceiver, safeTx.signature ?? signature,
  );
}

// ─── Main ───────────────────────────────────────────────────────────────────

const LIST_ONLY = process.argv.includes("--list");
const SPECIFIC_CONDITION = process.argv.find((a) => /^0x[0-9a-fA-F]{64}$/.test(a));

async function main() {
  const pk = (process.env.PK ?? "").trim();
  if (!pk) { console.error("[redeem] PK ausente no .env"); process.exit(1); }
  if (!PROXY_ADDRESS) { console.error("[redeem] POLYMARKET_PROXY_ADDRESS ausente no .env"); process.exit(1); }

  const provider = createProxiedProvider(RPC_URL);
  const wallet = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
  const ctf = new Contract(CTF_ADDRESS, CTF_ABI, provider);

  console.log(`[redeem] Owner: ${PROXY_ADDRESS} (Gnosis Safe)`);
  console.log(`[redeem] CTF:   ${CTF_ADDRESS}`);
  console.log(`[redeem] USDC:  ${NATIVE_USDC}\n`);

  const positions = await fetchPositions(PROXY_ADDRESS);
  const redeemable = findRedeemable(positions);

  if (redeemable.length === 0) {
    console.log("[redeem] Nenhuma posição resgatável encontrada.");
    return;
  }

  console.log(`[redeem] ${redeemable.length} posição(ões) resgatável(is):\n`);

  for (const pos of redeemable) {
    const tokenId = String(pos?.asset ?? "");
    const conditionId = String(pos?.conditionId ?? "");
    const title = pos?.title ?? pos?.slug ?? conditionId.slice(0, 20);
    const value = toFinite(pos?.currentValue) ?? 0;
    const outcomeIndex = Number(pos?.outcomeIndex ?? 0);

    console.log(`  ${title}`);
    console.log(`    conditionId: ${conditionId}`);
    console.log(`    tokenId:     ${tokenId.slice(0, 20)}...`);
    console.log(`    valor:       ~$${value.toFixed(2)}`);

    if (LIST_ONLY) { console.log(); continue; }
    if (SPECIFIC_CONDITION && conditionId !== SPECIFIC_CONDITION) { console.log("    (pulando — não é o conditionId alvo)\n"); continue; }

    const balance = await ctf.balanceOf(PROXY_ADDRESS, BigInt(tokenId)).catch(() => 0n);
    if (balance === 0n) {
      console.log("    \x1b[33m✗ Saldo on-chain zero — já resgatado?\x1b[0m\n");
      continue;
    }

    const indexSets = [1 << outcomeIndex];
    console.log(`    Resgatando (indexSets: [${indexSets}])...`);

    const tx = await redeemViaSafe(wallet, provider, conditionId, indexSets);
    console.log(`    Tx: ${tx.hash}`);
    const receipt = await tx.wait(1);
    console.log(`    \x1b[32m✓ Confirmada no bloco ${receipt.blockNumber}\x1b[0m\n`);
  }

  console.log("[redeem] Concluído.");
}

main().catch((err) => {
  console.error(`[redeem] Falha fatal: ${err.message}`);
  process.exit(1);
});
