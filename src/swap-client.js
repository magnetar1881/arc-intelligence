import { SwapKit } from "@circle-fin/swap-kit";
import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";

const kit = new SwapKit();
const appKit = new AppKit({ developerFee: null });

export async function estimateSwap({ tokenIn, tokenOut, amountIn }) {
  const adapter = await createViemAdapterFromProvider({
    provider: window.ethereum,
    rpcUrl: "https://lensora.xyz/arc-rpc",
  });

  const payload = {
    from: {
      adapter,
      chain: "Arc",
    },
    tokenIn,
    tokenOut,
    amountIn,
    config: {
      kitKey: window.CIRCLE_KIT_KEY,
      allowanceStrategy: "approve",
    },
  };

  return await kit.estimate(payload);
}

export async function executeCircleSwap({ tokenIn, tokenOut, amountIn }) {
  const adapter = await createViemAdapterFromProvider({
    provider: window.ethereum,
    rpcUrl: "https://lensora.xyz/arc-rpc",
  });

  console.log("=== BEFORE SWAP ===");
  console.log(
    "chainId:",
    await window.ethereum.request({ method: "eth_chainId" })
  );
  console.log(
    "accounts:",
    await window.ethereum.request({ method: "eth_accounts" })
  );

  console.log("provider:", window.ethereum);
  console.log("KIT KEY:", window.CIRCLE_KIT_KEY);
  console.log("TOKEN IN:", tokenIn);
  console.log("TOKEN OUT:", tokenOut);
  console.log("AMOUNT:", amountIn);
  console.log("CHAIN:", "Arc");
  console.log("ADAPTER:", adapter);

  const payload = {
    from: {
      adapter,
      chain: "Arc",
    },
    tokenIn,
    tokenOut,
    amountIn,
    config: {
      kitKey: window.CIRCLE_KIT_KEY,
      allowanceStrategy: "approve",
    },
  };

  try {
    const result = await kit.swap(payload);
    console.log("SWAP RESULT:", result);
    return result;
  } catch (e) {
    console.error("SWAP ERROR:", e);
    console.error("STACK:", e?.stack);
    console.log("CAUSE:");
    console.dir(e?.cause);
    throw e;
  }
}

window.executeCircleSwap = executeCircleSwap;
window.estimateCircleSwap = estimateSwap;

export async function executeCircleBridge({
  fromChain,
  toChain,
  token,
  amount,
}) {
  if (!window.ethereum) throw new Error("No browser wallet");

  const adapter = await createViemAdapterFromProvider({
    provider: window.ethereum,
    rpcUrl: "https://lensora.xyz/arc-rpc",
  });

  const result = await appKit.bridge({
    from: { adapter, chain: fromChain },
    to: { adapter, chain: toChain },
    amount: String(amount),
    token: token || "USDC",
  });

  return result;
}

window.executeCircleBridge = executeCircleBridge;
