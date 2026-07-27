import { SwapKit } from "@circle-fin/swap-kit";
import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";

const kit = new SwapKit();

export async function estimateSwap({ tokenIn, tokenOut, amountIn }) {
  const adapter = await createViemAdapterFromProvider({
    provider: window.ethereum,
  });

  return await kit.estimate({
    from: {
      adapter,
      chain: "Arc_Testnet",
    },
    tokenIn,
    tokenOut,
    amountIn,
    config: {
      kitKey: window.CIRCLE_KIT_KEY,
    },
  });
}

export async function executeCircleSwap({ tokenIn, tokenOut, amountIn }) {
  const adapter = await createViemAdapterFromProvider({
    provider: window.ethereum,
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
  console.log("CHAIN:", "Arc_Testnet");
  console.log("ADAPTER:", adapter);

  const payload = {
    from: {
      adapter,
      chain: "Arc_Testnet",
    },
    tokenIn,
    tokenOut,
    amountIn,
    config: {
      kitKey: window.CIRCLE_KIT_KEY,
    },
  };

  console.log("PAYLOAD");
  console.dir(payload);

  console.log("TOKEN IN FULL", tokenIn);
  console.log("TOKEN OUT FULL", tokenOut);
  console.log("ADAPTER FULL", adapter);

  try {
    const result = await kit.swap(payload);

    console.log("SWAP RESULT:", result);
    return result;
  } catch (e) {
    console.error("SWAP ERROR:", e);
    console.error("STACK:", e?.stack);

    console.log("CAUSE:");
    console.dir(e?.cause);

    if (e?.cause?.trace) {
      console.log("TRACE:");
      console.dir(e.cause.trace);
    }

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

  console.log("KIT METHODS");
  console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(kit)));

  const adapter = await createViemAdapterFromProvider({
    provider: window.ethereum,
  });

  console.log("===== BRIDGE =====");
  console.log({
    fromChain,
    toChain,
    token,
    amount,
  });

  const payload = {
    from: {
      adapter,
      chain: fromChain,
    },

    to: {
      adapter,
      chain: toChain,
    },

    amount,

    token,

    config: {
      kitKey: window.CIRCLE_KIT_KEY,
    },
  };

  console.log("BRIDGE PAYLOAD");
  console.dir(payload);

  const result = await kit.bridge(payload);

  console.log(result);

  return result;
}

window.executeCircleBridge = executeCircleBridge;
