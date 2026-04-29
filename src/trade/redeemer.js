import { Contract, Interface, JsonRpcProvider, Wallet, ZeroHash } from "ethers";

const PROXY_ADDRESS = String(process.env.POLYMARKET_PROXY_ADDRESS ?? "").trim();
const RPC_URL = process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com";
const TRADE_MOCK = String(process.env.TRADE_MOCK_MODE ?? "true").toLowerCase() === "true";

const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
// Bridged USDC.e — colateral usado pelo SDK Polymarket (clob-client) ao criar posições.
// redeemPositions() exige o mesmo collateralToken usado na criação da posição.
// Se a Polymarket migrar o colateral on-chain para Native USDC, atualizar aqui.
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const DATA_API = "https://data-api.polymarket.com";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external",
  "function balanceOf(address account, uint256 id) view returns (uint256)"
];

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)"
];

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" }
  ]
};

const settledTokenIds = new Set();
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

function getUserAddress() {
  if (PROXY_ADDRESS) return PROXY_ADDRESS;
  const wallet = getWallet();
  return wallet?.address ?? "";
}

function isTrue(x) {
  return x === true || x === "true" || x === 1 || x === "1";
}

function toFinite(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function fetchUserPositions(userAddress) {
  if (!userAddress) return [];
  try {
    const res = await fetch(
      `${DATA_API}/positions?user=${userAddress}&sizeThreshold=.01&limit=500`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : (data?.results ?? data?.data ?? []);
  } catch {
    return [];
  }
}

function classifySettledOutcomes(positions) {
  const events = [];
  for (const pos of positions) {
    const tokenId = String(pos?.asset ?? "").trim();
    if (!tokenId || settledTokenIds.has(tokenId)) continue;

    const curPrice = toFinite(pos?.curPrice ?? pos?.currentPrice);
    if (curPrice !== 0 && curPrice !== 1) continue;

    settledTokenIds.add(tokenId);
    events.push({
      tokenId,
      conditionId: String(pos?.conditionId ?? ""),
      won: curPrice === 1,
      closeReason: curPrice === 1 ? "settled_win" : "settled_loss",
      redeemed: false,
      marketSettlementPrice: curPrice,
      source: "positions_settlement"
    });
  }
  return events;
}

function listRedeemCandidates(positions) {
  return positions.filter((p) => {
    const tokenId = String(p?.asset ?? "").trim();
    if (!tokenId) return false;
    if (toFinite(p?.curPrice ?? p?.currentPrice) !== 1) return false;
    if (!isTrue(p?.redeemable)) return false;
    if (redeemedConditions.has(String(p?.conditionId ?? ""))) return false;
    return true;
  });
}

async function redeemViaSafe(wallet, conditionId, indexSets) {
  const ctfIface = new Interface(CTF_ABI);
  const redeemData = ctfIface.encodeFunctionData("redeemPositions", [
    USDC_ADDRESS, ZeroHash, conditionId, indexSets
  ]);

  const safe = new Contract(PROXY_ADDRESS, SAFE_ABI, wallet.provider);
  const safeNonce = await safe.nonce();

  const safeTx = {
    to: CTF_ADDRESS,
    value: 0n,
    data: redeemData,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce: safeNonce
  };

  const domain = { chainId: 137, verifyingContract: PROXY_ADDRESS };
  const signature = await wallet.signTypedData(domain, SAFE_TX_TYPES, safeTx);

  return safe.connect(wallet).execTransaction(
    safeTx.to, safeTx.value, safeTx.data, safeTx.operation,
    safeTx.safeTxGas, safeTx.baseGas, safeTx.gasPrice,
    safeTx.gasToken, safeTx.refundReceiver, signature
  );
}

export async function runAutoRedeem() {
  const userAddress = getUserAddress();
  if (!userAddress) return { events: [] };

  const positions = await fetchUserPositions(userAddress);
  if (!positions.length) return { events: [] };

  const events = classifySettledOutcomes(positions);
  const eventsByTokenId = new Map(events.map((e) => [e.tokenId, e]));

  const winners = listRedeemCandidates(positions);
  if (!winners.length) return { events };

  process.stderr.write(
    `\x1b[36m[REDEEM] ${winners.length} posição(ões) vencedora(s) candidata(s) a resgate.\x1b[0m\n`
  );

  for (const pos of winners) {
    const conditionId = String(pos?.conditionId ?? "").trim();
    const tokenId = String(pos?.asset ?? "").trim();
    const title = pos?.title ?? pos?.slug ?? conditionId;
    const outcomeIndex = Number(pos?.outcomeIndex ?? 0);
    const indexSets = [1 << outcomeIndex];
    const value = Number(pos?.currentValue ?? 0);

    if (!conditionId || !PROXY_ADDRESS) continue;

    if (TRADE_MOCK) {
      process.stderr.write(
        `\x1b[33m[REDEEM][MOCK] Resgate simulado: ${title} | ~$${value.toFixed(2)} | indexSets [${indexSets}]\x1b[0m\n`
      );
      redeemedConditions.add(conditionId);
      settledTokenIds.add(tokenId);
      const evt = eventsByTokenId.get(tokenId);
      if (evt) {
        evt.redeemed = true;
        evt.closeReason = "redeemed";
      }
      continue;
    }

    const wallet = getWallet();
    if (!wallet) {
      process.stderr.write(`\x1b[31m[REDEEM] PK não configurada — impossível resgatar.\x1b[0m\n`);
      break;
    }

    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, wallet.provider);
    const balance = await ctf.balanceOf(PROXY_ADDRESS, BigInt(tokenId)).catch(() => 0n);
    if (balance === 0n) {
      process.stderr.write(`\x1b[33m[REDEEM] ${title} — saldo on-chain zero, pulando.\x1b[0m\n`);
      redeemedConditions.add(conditionId);
      settledTokenIds.add(tokenId);
      continue;
    }

    try {
      process.stderr.write(
        `\x1b[36m[REDEEM] Resgatando: ${title} (~$${value.toFixed(2)}) | indexSets [${indexSets}]\x1b[0m\n`
      );
      const tx = await redeemViaSafe(wallet, conditionId, indexSets);
      process.stderr.write(`\x1b[32m[REDEEM] Tx enviada: ${tx.hash}\x1b[0m\n`);
      const WAIT_TIMEOUT_MS = 2 * 60 * 1000;
      const receipt = await Promise.race([
        tx.wait(1),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`tx.wait timeout após ${WAIT_TIMEOUT_MS / 1000}s`)), WAIT_TIMEOUT_MS)
        ),
      ]);
      process.stderr.write(
        `\x1b[32m[REDEEM] ✔ Confirmada no bloco ${receipt.blockNumber}. USDC creditado na proxy.\x1b[0m\n`
      );
      redeemedConditions.add(conditionId);
      settledTokenIds.add(tokenId);
      const evt = eventsByTokenId.get(tokenId);
      if (evt) {
        evt.redeemed = true;
        evt.closeReason = "redeemed";
      }
    } catch (err) {
      process.stderr.write(`\x1b[31m[REDEEM] Erro ao resgatar "${title}": ${err.message}\x1b[0m\n`);
    }
  }

  return { events };
}
