const {
  insertWhale,
  updateWallet,
  updateWalletScore,
  updateTokenStats
} = require("../database/db");

const { ethers } = require("ethers");
const { sendAlert } = require("../telegram/bot");

// ========================
// CONFIG
// ========================
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Whale eşiği — decimal'e göre düzeltilmiş (insan-okunabilir) birim
// Ham value ile ASLA karşılaştırılmaz, sadece formatUnits sonrası amount ile kullanılır
const WHALE_THRESHOLD = Number(process.env.WHALE_THRESHOLD || 100000);

// Sadece etiketleme amaçlı boyut eşiği
// NOT: gerçek DEX likidite/TVL/slippage analizi değil — size-based heuristic
const LARGE_TRANSFER_THRESHOLD = Number(process.env.LARGE_TRANSFER_THRESHOLD || 250000);

// Aynı cüzdandan ardışık işlemler arası bekleme (ms)
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 5000);

// seenTx / walletCooldown bellek temizlik aralığı (ms)
const MEMORY_TTL_MS = Number(process.env.MEMORY_TTL_MS || 10 * 60 * 1000);

// Opsiyonel token whitelist — boş bırakılırsa tüm ERC20 transferleri dinlenir
const TOKEN_WHITELIST = (process.env.TOKEN_WHITELIST || "")
  .split(",")
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean);

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

// ERC20 Transfer(address,address,uint256)
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// ========================
// BELLEKTE TUTULAN STATE (TTL ile temizleniyor — memory leak yok)
// ========================
const seenTx = new Map();         // txHash -> timestamp
const walletCooldown = new Map(); // wallet -> timestamp
const tokenInfoCache = new Map(); // tokenAddress -> { symbol, decimals }

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of seenTx) {
    if (now - ts > MEMORY_TTL_MS) seenTx.delete(key);
  }
  for (const [key, ts] of walletCooldown) {
    if (now - ts > MEMORY_TTL_MS) walletCooldown.delete(key);
  }
}, MEMORY_TTL_MS);

// ========================
// TOKEN BİLGİSİ — cache'li
// Her transfer'de RPC'ye gitmez, aynı token için bir kez çekilip saklanır
// ========================
async function getTokenInfo(tokenAddress) {
  const key = tokenAddress.toLowerCase();
  if (tokenInfoCache.has(key)) return tokenInfoCache.get(key);

  let symbol = "UNKNOWN";
  let decimals = 18;

  try {
    const contract = new ethers.Contract(
      tokenAddress,
      [
        "function symbol() view returns (string)",
        "function decimals() view returns (uint8)"
      ],
      provider
    );
    symbol = await contract.symbol();
    decimals = await contract.decimals();
  } catch {
    // symbol()/decimals() implement etmeyen kontratlar için varsayılanlar kalır
  }

  const info = { symbol, decimals };
  tokenInfoCache.set(key, info);
  return info;
}

// ========================
// MAIN SCANNER
// ========================
async function startScanner() {
  console.log("🚀 Whale Engine V6 (size-based heuristic filter) started");

  let lastBlockTime = Date.now();
  let currentProvider = provider;

  // ========================
  // HEARTBEAT — sessiz donmayı önler
  // Her 30 saniyede son blok zamanını kontrol eder.
  // 2 dakikadır yeni blok gelmediyse provider'ı yeniden başlatır.
  // ========================
  setInterval(async () => {
    const elapsed = Date.now() - lastBlockTime;
    if (elapsed > 2 * 60 * 1000) {
      console.log("⚠️ 2 dakikadır blok gelmedi — provider yeniden başlatılıyor...");
      try {
        currentProvider.removeAllListeners();
        currentProvider = new ethers.JsonRpcProvider(process.env.RPC_URL);
        attachBlockListener(currentProvider);
        lastBlockTime = Date.now();
        console.log("✅ Provider yeniden bağlandı.");
      } catch (e) {
        console.log("❌ Reconnect hatası:", e.message);
      }
    }
  }, 30 * 1000);

  attachBlockListener(currentProvider);

  function attachBlockListener(p) {
    p.on("block", async (blockNumber) => {
      lastBlockTime = Date.now();

      try {
        const logs = await p.getLogs({
          fromBlock: blockNumber,
          toBlock: blockNumber,
          topics: [TRANSFER_TOPIC]
        });

        for (const log of logs) {
          try {
            if (!log?.data || log.data === "0x") continue;

            if (
              TOKEN_WHITELIST.length &&
              !TOKEN_WHITELIST.includes(log.address.toLowerCase())
            ) continue;

            const txHash = log.transactionHash;

            if (seenTx.has(txHash)) continue;
            seenTx.set(txHash, Date.now());

            const from = "0x" + log.topics[1].slice(26);
            const to   = "0x" + log.topics[2].slice(26);

            const lastSeen = walletCooldown.get(from);
            const now = Date.now();
            if (lastSeen && now - lastSeen < COOLDOWN_MS) continue;
            walletCooldown.set(from, now);

            const value = ethers.AbiCoder.defaultAbiCoder().decode(
              ["uint256"],
              log.data
            )[0];

            const isMint = from.toLowerCase() === ZERO_ADDRESS;
            const isBurn = to.toLowerCase()   === ZERO_ADDRESS;

            const token = log.address;
            const { symbol, decimals } = await getTokenInfo(token);

            const amount = Number(ethers.formatUnits(value, decimals));

            await updateWallet(from, amount);
            await updateWalletScore(from);
            await updateTokenStats(
              token,
              symbol,
              isMint ? "MINT" : isBurn ? "BURN" : "TRANSFER"
            );

            if (isMint || isBurn) continue;
            if (amount < WHALE_THRESHOLD) continue;

            const sizeTier = amount >= LARGE_TRANSFER_THRESHOLD ? "LARGE" : "STANDARD";

            await insertWhale({
              txHash,
              wallet: from,
              token: symbol,
              amount,
              type: "WHALE"
            });

            const message = `
🐋 <b>WHALE ALERT</b> (${sizeTier})

Token: ${symbol}
Amount: ${amount.toLocaleString()}

From:
${from}

To:
${to}

Tx:
${txHash}
            `;

            console.log("🐋 WHALE:", symbol, amount);
            await sendAlert(message, token);

          } catch (e) {
            console.log("log skip:", e.message);
          }
        }
      } catch (e) {
        console.log("block error:", e.message);
      }
    });

    p.on("error", (err) => {
      console.log("⚠️ Provider error:", err.message);
    });
  }
}

module.exports = { startScanner };
