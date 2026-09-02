const { AppKit } = require("@circle-fin/app-kit");

let kit = null;

function getKit() {
  if (kit) return kit;
  kit = new AppKit({ developerFee: null });
  return kit;
}

let circleAdapter = null;

function getCircleAdapter() {
  if (circleAdapter) return circleAdapter;

  if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) {
    throw new Error("CIRCLE_API_KEY veya CIRCLE_ENTITY_SECRET eksik");
  }

  const { createCircleWalletsAdapter } = require("@circle-fin/adapter-circle-wallets");

  circleAdapter = createCircleWalletsAdapter({
    apiKey: process.env.CIRCLE_API_KEY,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET,
  });

  return circleAdapter;
}

function assertExecuteEnabled(amount) {
  if (process.env.EXECUTE_ENABLED !== "true") {
    throw new Error("Execute kapalı. .env içinde EXECUTE_ENABLED=true yap.");
  }

  const max = Number(process.env.MAX_SWAP_AMOUNT || 10);
  const amt = Number(amount);
  if (!isFinite(amt) || amt <= 0) {
    throw new Error("Geçersiz miktar");
  }
  if (amt > max) {
    throw new Error(`Miktar limiti aşıldı (max ${max})`);
  }
}

async function executeSwapTokens({ chain, tokenIn, tokenOut, amountIn, recipientAddress }) {
  try {
    assertExecuteEnabled(amountIn);

    const source = process.env.CIRCLE_EVM_WALLET;
    if (!source) throw new Error("CIRCLE_EVM_WALLET eksik");
    if (!recipientAddress) throw new Error("Alıcı adresi gerekli");

    const k = getKit();
    const adapter = getCircleAdapter();

    const params = {
      from: {
        adapter,
        chain: chain || "Arc_Testnet",
        address: source,
      },
      tokenIn: tokenIn || "USDC",
      tokenOut: tokenOut || "EURC",
      amountIn: String(amountIn),
      to: {
        chain: chain || "Arc_Testnet",
        recipientAddress,
      },
      config: {
        kitKey: process.env.CIRCLE_KIT_KEY,
        allowanceStrategy: "approve",
      },
    };

    const result = await k.swap(params);
    return { success: true, result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function executeBridgeTransfer({ fromChain, toChain, amount, token, recipientAddress }) {
  try {
    assertExecuteEnabled(amount);

    const source = process.env.CIRCLE_EVM_WALLET;
    if (!source) throw new Error("CIRCLE_EVM_WALLET eksik");
    if (!recipientAddress) throw new Error("Alıcı adresi gerekli");

    const k = getKit();
    const adapter = getCircleAdapter();

    const result = await k.bridge({
      from: {
        adapter,
        chain: fromChain || "Ethereum_Sepolia",
        address: source,
      },
      to: {
        adapter,
        chain: toChain || "Arc_Testnet",
        address: recipientAddress,
        useForwarder: true
      },
      amount: String(amount),
      token: token || "USDC",
      config: {
        feePayment: "source"
      }
    });

    return { success: true, result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function estimateBridgeTransfer({ fromChain, toChain, amount, token = "USDC" }) {
  try {
    const k = getKit();
    const estimate = await k.estimateBridge({
      from: { chain: fromChain },
      to: { chain: toChain },
      token,
      amount
    });
    return {
      success: true,
      amount,
      token,
      fromChain,
      toChain,
      fee: estimate.fee?.amount || "0",
      estimatedTime: estimate.estimatedTime || null,
      transferSpeed: estimate.transferSpeed || "STANDARD"
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function estimateSwapTokens({ adapter, chain, tokenIn, tokenOut, amountIn }) {
  try {
    const k = getKit();
    const adapter = getCircleAdapter();
    const source = process.env.CIRCLE_EVM_WALLET;

    const estimate = await k.estimateSwap({
      from: {
        adapter,
        chain: chain || "Arc_Testnet",
        address: source
      },
      tokenIn: tokenIn || "USDC",
      tokenOut: tokenOut || "EURC",
      amountIn: amountIn || "1.00",
      config: {
        kitKey: process.env.CIRCLE_KIT_KEY,
        allowanceStrategy: "approve"
      }
    });

    const outAmt =
      estimate?.estimatedOutput?.amount ??
      estimate?.estimatedOutput ??
      null;

    const minAmt =
      estimate?.stopLimit?.amount ??
      estimate?.stopLimit ??
      null;

    return {
      success: true,
      ...estimate,
      estimatedOutput: outAmt,
      stopLimit: minAmt
    };
    return {
      success: true,
      tokenIn,
      tokenOut,
      amountIn,
      estimatedOutput: estimate.estimatedOutput?.amount || "0",
      stopLimit: estimate.stopLimit?.amount || "0",
      fees: estimate.fees || null
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function getSupportedChains(capability = "bridge") {
  try {
    const k = getKit();
    const chains = await k.getSupportedChains(capability);
    return { success: true, chains };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  getKit,
  estimateBridgeTransfer,
  estimateSwapTokens,
  getSupportedChains,
  executeSwapTokens,
  executeBridgeTransfer
};
