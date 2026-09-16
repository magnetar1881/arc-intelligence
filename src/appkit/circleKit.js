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

const ARC_CHAINS = new Set(["arc", "arc", "arc"]);

const OUT_CHAINS = {
  ethereum:         "Ethereum",
  ethereum_sepolia: "Ethereum_Sepolia",
  base:             "Base",
  base_sepolia:     "Base_Sepolia",
  arbitrum:         "Arbitrum",
  arbitrum_sepolia: "Arbitrum_Sepolia"
};

function norm(chain) {
  return String(chain || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function isArc(chain) {
  return ARC_CHAINS.has(norm(chain));
}

function resolveOutChain(chain) {
  const key = norm(chain);
  if (!OUT_CHAINS[key]) {
    throw new Error("Çıkış yalnızca Ethereum, Base veya Arbitrum.");
  }
  return OUT_CHAINS[key];
}

function assertBridgeRoute(fromChain, toChain) {
  const fromArc = isArc(fromChain);
  const toArc = isArc(toChain);

  if (fromArc && toArc) {
    throw new Error("Aynı ağ içinde köprü yok.");
  }

  // Çıkış: Arc → ETH / Base / Arb
  if (fromArc && !toArc) {
    resolveOutChain(toChain);
    return;
  }

  // Giriş: ETH / Base / Arb → Arc (eski davranış)
  if (!fromArc && toArc) {
    resolveOutChain(fromChain);
    return;
  }

  throw new Error("Köprü yalnızca Arc ile Ethereum / Base / Arbitrum arasında.");
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
        chain: chain || "Arc",
        address: source,
      },
      tokenIn: tokenIn || "USDC",
      tokenOut: tokenOut || "EURC",
      amountIn: String(amountIn),
      to: {
        chain: chain || "Arc",
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
    assertBridgeRoute(fromChain, toChain);

    const source = process.env.CIRCLE_EVM_WALLET;
    if (!source) throw new Error("CIRCLE_EVM_WALLET eksik");
    if (!recipientAddress) throw new Error("Alıcı adresi gerekli");

    const k = getKit();
    const adapter = getCircleAdapter();

    const result = await k.bridge({
      from: {
        adapter,
        chain: fromChain || "Ethereum",
        address: source,
      },
      to: {
        adapter,
        chain: toChain || "Arc",
        address: recipientAddress,
        useForwarder: true
      },
      amount: String(amount),
      token: token || "USDC",
      config: {
        feePayment: "source"
      }
    });

    return {
      success: true,
      result: JSON.parse(
        JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v))
      )
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function estimateBridgeTransfer({ fromChain, toChain, amount, token = "USDC" }) {
  try {
    assertBridgeRoute(fromChain, toChain);

    const k = getKit();
    const from = { chain: fromChain };
    const to = { chain: toChain };

    const estimate = await k.estimateBridge({
      from,
      to,
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
    const estimate = await k.estimateSwap({
      from: {
        chain: chain || "Arc"
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
  getSupportedChains
};
