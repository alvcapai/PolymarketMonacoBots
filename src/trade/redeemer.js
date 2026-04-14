/**
 * redeemer.js — Resgate automático de posições vencedoras no Polymarket.
 *
 * Exporta runAutoRedeem() para ser chamado periodicamente pelo loop principal.
 * Consulta data-api.polymarket.com, filtra winners (curPrice=1), confirma
 * saldo on-chain e chama redeemPositions() via Gnosis Safe (execTransaction).
 */

import { Contract, Interface, JsonRpcProvider, Wallet, ZeroHash } from "ethers";

const PROXY_ADDRESS = String(process.env.POLYMARKET_PROXY_ADDRESS ?? "").trim();
const RPC_URL       = process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com";
const TRADE_MOCK    = String(process.env.TRADE_MOCK_MODE ?? "true").toLowerCase() === "true";

const CTF_ADDRESS  = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const DATA_API     = "https://data-api.polymarket.com";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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

// conditionIds já resgatados nesta sessão — evita re-tentativas desnecessárias
const redeemedConditions = new Set();

let _wallet = null;

function getWallet() {
  if (_wallet) return _wallet;
  const pk = String(process.env.PK ?? "").trim();
  if (!pk) return null;
  const provider = new JsonRpcProvider(RPC_URL);
  _wallet = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
  return _wallet;
}

async function fetchWinningPositions() {
  try {
    const res = await fetch(
      `${DATA_API}/positions?user=${PROXY_ADDRESS}&sizeThreshold=.01&limit=500`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const all  = Array.isArray(data) ? data : (data?.results ?? data?.data ?? []);
    return all.filter(p =>
      (p.redeemable === true || p.redeemable === "true") &&
      Number(p.curPrice ?? 0) === 1 &&
      !redeemedConditions.has(p.conditionId)
    );
  } catch {
    return [];
  }
}

async function redeemViaSafe(w, conditionId, indexSets) {
  const ctfIface   = new Interface(CTF_ABI);
  const redeemData = ctfIface.encodeFunctionData("redeemPositions", [
    USDC_ADDRESS, ZeroHash, conditionId, indexSets,
  ]);

  const safe      = new Contract(PROXY_ADDRESS, SAFE_ABI, w.provider);
  const safeNonce = await safe.nonce();

  const safeTx = {
    to:             CTF_ADDRESS,
    value:          0n,
    data:           redeemData,
    operation:      0,
    safeTxGas:      0n,
    baseGas:        0n,
    gasPrice:       0n,
    gasToken:       ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce:          safeNonce,
  };

  const domain    = { chainId: 137, verifyingContract: PROXY_ADDRESS };
  const signature = await w.signTypedData(domain, SAFE_TX_TYPES, safeTx);

  return safe.connect(w).execTransaction(
    safeTx.to, safeTx.value, safeTx.data, safeTx.operation,
    safeTx.safeTxGas, safeTx.baseGas, safeTx.gasPrice,
    safeTx.gasToken, safeTx.refundReceiver, signature
  );
}

/**
 * Verifica posições vencedoras e resgata automaticamente via Gnosis Safe.
 * Deve ser chamado periodicamente (ex: a cada 2 minutos) pelo loop principal.
 */
export async function runAutoRedeem() {
  if (!PROXY_ADDRESS) return;

  const positions = await fetchWinningPositions();
  if (!positions.length) return;

  process.stderr.write(
    `\x1b[36m[REDEEM] ${positions.length} posição(ões) vencedora(s) encontrada(s) para resgate.\x1b[0m\n`
  );

  for (const pos of positions) {
    const conditionId  = pos.conditionId;
    const tokenId      = pos.asset;
    const outcomeIndex = Number(pos.outcomeIndex ?? 0);
    const indexSets    = [1 << outcomeIndex];
    const title        = pos.title ?? pos.slug ?? conditionId;
    const value        = Number(pos.currentValue ?? 0);

    if (TRADE_MOCK) {
      process.stderr.write(
        `\x1b[33m[REDEEM][MOCK] Seria resgatado: ${title} | ~$${value.toFixed(2)} | indexSets [${indexSets}]\x1b[0m\n`
      );
      redeemedConditions.add(conditionId);
      continue;
    }

    const w = getWallet();
    if (!w) {
      process.stderr.write(`\x1b[31m[REDEEM] PK não configurada — impossível resgatar.\x1b[0m\n`);
      return;
    }

    // Confirma saldo on-chain antes de enviar tx
    const ctf     = new Contract(CTF_ADDRESS, CTF_ABI, w.provider);
    const balance = await ctf.balanceOf(PROXY_ADDRESS, BigInt(tokenId)).catch(() => 0n);
    if (balance === 0n) {
      process.stderr.write(`\x1b[33m[REDEEM] ${title} — saldo on-chain zero, pulando.\x1b[0m\n`);
      redeemedConditions.add(conditionId);
      continue;
    }

    try {
      process.stderr.write(
        `\x1b[36m[REDEEM] Resgatando: ${title} (~$${value.toFixed(2)}) | indexSets [${indexSets}]\x1b[0m\n`
      );
      const tx      = await redeemViaSafe(w, conditionId, indexSets);
      process.stderr.write(`\x1b[32m[REDEEM] Tx enviada: ${tx.hash}\x1b[0m\n`);
      const receipt = await tx.wait(1);
      process.stderr.write(
        `\x1b[32m[REDEEM] ✔ Confirmada no bloco ${receipt.blockNumber}. USDC creditado na proxy.\x1b[0m\n`
      );
      redeemedConditions.add(conditionId);
    } catch (err) {
      process.stderr.write(`\x1b[31m[REDEEM] Erro ao resgatar "${title}": ${err.message}\x1b[0m\n`);
    }
  }
}
