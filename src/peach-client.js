// Peach quote source for the Swap page. Browser only. Arc mainnet only (chainId 5042).
//
// Rules:
//  - arc.swap() returns a quote plus a prepared transaction. The SDK never approves
//    or broadcasts; every transaction here is sent by the user's wallet after a click.
//  - One quote request per call. No automatic retry. Slippage is fixed and never widened.
//  - Only the transaction the user chose is sent to the wallet.
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  formatUnits,
  http,
  parseUnits,
} from "viem";
import { ArcClient } from "@masterpeach/arc-aggregator-sdk";

const CHAIN_ID = 5042;
const CHAIN_ID_HEX = "0x13b2";
const RPC_URL = "https://lensora.xyz/arc-rpc";

// Official Peach docs: Arc Mainnet configuration.
const PEACH_API_URL = "https://api.peach.ag/arc";
const PEACH_ROUTER = "0x2528F3190603B85A155D48C31946703d71f921ED";

const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";

// Only tokens with a known mainnet address are quoted. cirBTC is not listed here.
const TOKENS = {
  USDC: { address: USDC, decimals: 6 },
  EURC: { address: EURC, decimals: 6 },
};

const SLIPPAGE_BPS = 50; // fixed, shown in the UI, never widened
const DEADLINE_SECS = 120;

const arcMainnet = defineChain({
  id: CHAIN_ID,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
});

let _public = null;
let _arc = null;

function clients() {
  if (!_arc) {
    _public = createPublicClient({ chain: arcMainnet, transport: http(RPC_URL) });
    _arc = new ArcClient(
      {
        chainId: CHAIN_ID,
        rpcUrl: RPC_URL,
        executionRouterAddress: PEACH_ROUTER,
        // ArcConfig requires `weth`, but the SDK reads it only for nativeIn/nativeOut.
        // Both are forced to false below, so this value is never used in a swap.
        weth: USDC,
      },
      _public,
      { api: { baseUrl: PEACH_API_URL, timeout: 10000 } }
    );
  }
  return { arc: _arc, publicClient: _public };
}

function same(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

export function errorText(e) {
  if (!e) return "Unknown error";
  const base = e.shortMessage || e.message || String(e);
  const extra = [];
  if (typeof e.code === "number" && e.name === "ArcApiError") extra.push("code " + e.code);
  if (e.traceId) extra.push("trace " + e.traceId);
  return extra.length ? base + " (" + extra.join(", ") + ")" : base;
}

export function supports(symbol) {
  return Object.prototype.hasOwnProperty.call(TOKENS, symbol);
}

// Request ONE Peach quote + prepared tx. Nothing is approved or sent.
export async function quote({ symbolIn, symbolOut, amountIn, executor, signal }) {
  if (!supports(symbolIn) || !supports(symbolOut)) {
    throw new Error("Peach quote is not available for this pair.");
  }
  if (symbolIn === symbolOut) throw new Error("Select different tokens.");
  if (!executor) throw new Error("Connect your wallet to request a Peach quote.");

  const tin = TOKENS[symbolIn];
  const tout = TOKENS[symbolOut];

  const text = String(amountIn || "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("Enter a plain decimal amount.");
  const frac = text.split(".")[1] || "";
  if (frac.length > tin.decimals) {
    throw new Error("At most " + tin.decimals + " decimals for " + symbolIn + ".");
  }
  const amount = parseUnits(text, tin.decimals);
  if (amount <= 0n) throw new Error("Enter an amount greater than zero.");

  const { arc } = clients();
  const prepared = await arc.swap({
    from: tin.address,
    target: tout.address,
    amount,
    executor,
    slippageBps: SLIPPAGE_BPS,
    deadlineSecs: DEADLINE_SECS,
    nativeIn: false,
    nativeOut: false,
    signal,
  });

  // Defensive checks on top of the SDK's own validation.
  if (!same(prepared.approvalSpender, PEACH_ROUTER)) {
    throw new Error("Unexpected approval spender returned by the quote.");
  }
  if (!same(prepared.tx.to, PEACH_ROUTER)) {
    throw new Error("Unexpected transaction target returned by the quote.");
  }
  if (prepared.tx.value !== 0n) {
    throw new Error("Unexpected native value in a token swap.");
  }
  if (!same(prepared.recipient, executor)) {
    throw new Error("Quote recipient is not your wallet.");
  }

  return {
    prepared,
    view: {
      symbolIn,
      symbolOut,
      amountIn: text,
      expectedOut: formatUnits(prepared.expectAmountOut, tout.decimals),
      amountOutMin: formatUnits(prepared.tx.amountOutMin, tout.decimals),
      deadline: Number(prepared.execution.plan.deadline),
      recipient: prepared.recipient,
      spender: prepared.approvalSpender,
      slippageBps: SLIPPAGE_BPS,
    },
  };
}

async function ensureArcMainnet() {
  if (!window.ethereum) throw new Error("No browser wallet.");
  let id = await window.ethereum.request({ method: "eth_chainId" });
  if (String(id).toLowerCase() !== CHAIN_ID_HEX) {
    if (typeof window.ensureArcMainnet === "function") {
      try {
        await window.ensureArcMainnet();
      } catch (_) {
        /* checked below */
      }
    }
    id = await window.ethereum.request({ method: "eth_chainId" });
  }
  if (String(id).toLowerCase() !== CHAIN_ID_HEX) {
    throw new Error("Switch your wallet to Arc mainnet (chain ID 5042).");
  }
}

function walletClient() {
  return createWalletClient({ chain: arcMainnet, transport: custom(window.ethereum) });
}

function assertNotExpired(prepared) {
  const deadline = Number(prepared.execution.plan.deadline);
  if (deadline <= Math.floor(Date.now() / 1000)) {
    throw new Error("Peach quote expired. Request a new quote.");
  }
}

// Returns the exact-amount approval the user would sign, or null if allowance is enough.
export async function describeApproval(prepared, owner) {
  const { arc } = clients();
  const req = await arc.buildDirectApprovalRequest(prepared, owner); // exact amount, never "max"
  if (!req) return null;
  if (!same(req.spender, PEACH_ROUTER)) throw new Error("Unexpected approval spender.");
  return req;
}

export async function sendApproval(req, owner) {
  if (!same(req.spender, PEACH_ROUTER)) throw new Error("Unexpected approval spender.");
  await ensureArcMainnet();
  const { publicClient } = clients();
  const hash = await walletClient().sendTransaction({
    to: req.tx.to,
    data: req.tx.data,
    value: req.tx.value,
    account: owner,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Approval reverted.");
  return hash;
}

// Simulates, then sends the prepared swap transaction from the user's wallet.
export async function sendSwap(prepared, owner) {
  assertNotExpired(prepared);
  await ensureArcMainnet();
  const { publicClient } = clients();
  const tx = { to: prepared.tx.to, data: prepared.tx.data, value: prepared.tx.value };
  await publicClient.call({ ...tx, account: owner }); // throws if it would revert
  assertNotExpired(prepared);
  const hash = await walletClient().sendTransaction({ ...tx, account: owner });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Swap reverted.");
  return hash;
}

window.PeachSwap = {
  supports,
  quote,
  describeApproval,
  sendApproval,
  sendSwap,
  errorText,
  router: PEACH_ROUTER,
};
