const {
  insertWhale,
  updateWallet,
  updateWalletScore,
  updateWalletBehavior,
  updateTokenStats,
  updateTokenRiskScore,
  getWalletStats,
  getTokenTrustScore
} = require("../database/db");

const { ethers } = require("ethers");
const { askArc } = require("../appkit/askArc");
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

const SCAN_EVERY_N_BLOCKS = Number(process.env.SCAN_EVERY_N_BLOCKS || 15);
let rpcBackoffUntil = 0;

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
      if (blockNumber % SCAN_EVERY_N_BLOCKS !== 0) return;
      if (Date.now() < rpcBackoffUntil) return;

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

            await updateWallet(from, amount, 'out');
            await updateWallet(to, amount, 'in');
            await updateWalletBehavior(from);
            await updateWalletBehavior(to);
            await updateWalletScore(from);
            await updateWalletScore(to);
            await updateTokenStats(
              token,
              symbol,
              isMint ? "MINT" : isBurn ? "BURN" : "TRANSFER",
              from,
              to
            );
            await updateTokenRiskScore(token);

            if (isMint || isBurn) continue;
            if (amount < WHALE_THRESHOLD) continue;

            const sizeTier = amount >= LARGE_TRANSFER_THRESHOLD ? "LARGE" : "STANDARD";

            await insertWhale({
              txHash,
              wallet: from,
              token: symbol,
              amount,
              type: "WHALE_OUT"
            });

            await insertWhale({
              txHash,
              wallet: to,
              token: symbol,
              amount,
              type: "WHALE_IN"
            });

            // --- Whale signal context ---
            let fromStats = null;
            let toStats = null;
            let tokenMeta = null;
            try {
              fromStats = await getWalletStats(from);
              toStats = await getWalletStats(to);
              tokenMeta = await getTokenTrustScore(token);
            } catch (e) {
              console.log("context fetch skip:", e.message);
            }

            const fmtScore = (v) =>
              v === null || v === undefined ? "n/a" : Number(v).toFixed(2);
            const fmtBehavior = (b) => (b || "unknown").toUpperCase();
            const trust = tokenMeta ? Number(tokenMeta.trust_score || 0) : null;
            const riskLabel =
              trust === null
                ? "n/a"
                : trust >= 0.7
                  ? "LOW"
                  : trust >= 0.4
                    ? "MEDIUM"
                    : "HIGH";

            const message = `
🐋 <b>WHALE ALERT</b> (${sizeTier})

Token: ${symbol}
Amount: ${amount.toLocaleString()}
Token trust: <b>${fmtScore(trust)}</b> (risk: ${riskLabel})

From:
<code>${from}</code>
Score: ${fmtScore(fromStats?.whale_score)} · ${fmtBehavior(fromStats?.behavior)}

To:
<code>${to}</code>
Score: ${fmtScore(toStats?.whale_score)} · ${fmtBehavior(toStats?.behavior)}

Tx:
<code>${txHash}</code>
            `;

            console.log("🐋 WHALE:", symbol, amount);
            await sendAlert(message, token, [from, to]);

            // ========================
            // WHALE AGENT — AI analizi (context'li)
            // ========================
            try {
              const agentQuestion =
                `A large transfer just happened on Arc. ` +
                `Wallet ${from} (score ${fmtScore(fromStats?.whale_score)}, behavior ${fmtBehavior(fromStats?.behavior)}) ` +
                `sent ${amount.toLocaleString()} ${symbol} ` +
                `to ${to} (score ${fmtScore(toStats?.whale_score)}, behavior ${fmtBehavior(toStats?.behavior)}). ` +
                `Token trust_score=${fmtScore(trust)} (risk ${riskLabel}). ` +
                `Give a short whale signal context: what this likely means, who looks like smart money vs noise, and any caution.`;

              const analysis = await askArc(agentQuestion, "whale-agent");

              if (analysis.success && analysis.answer) {
                const agentMessage = `🤖 <b>AI Analysis</b>\n\n${analysis.answer}`;
                await sendAlert(agentMessage, token, [from, to]);
              }
            } catch (e) {
              console.log("agent analysis skip:", e.message);
            }

          } catch (e) {
            console.log("log skip:", e.message);
          }
        }
      } catch (e) {
        const msg = String(e.message || e);
        console.log("block error:", msg);
        if (msg.toLowerCase().includes("rate limit") || msg.includes("-32005")) {
          rpcBackoffUntil = Date.now() + 30 * 1000;
          console.log("⏳ RPC backoff 30s");
        }
      }
    });

    p.on("error", (err) => {
      console.log("⚠️ Provider error:", err.message);
    });
  }
}

module.exports = { startScanner };
