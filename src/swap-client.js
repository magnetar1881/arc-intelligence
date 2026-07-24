import { SwapKit } from "@circle-fin/swap-kit";
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

  const result = await kit.swap(payload);

  try {
    const result = await kit.swap({
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

    console.log("SWAP RESULT:", result);
    return result;

  } catch (e) {

    console.error("ERROR", e);
    console.dir(e.cause);

    if (e.cause?.trace) {
        console.log("TRACE");
        console.dir(e.cause.trace);
    }

    throw e;
  }

}

// HTML'den erişebilmek için
window.executeCircleSwap = executeCircleSwap;
window.estimateCircleSwap = estimateSwap;
