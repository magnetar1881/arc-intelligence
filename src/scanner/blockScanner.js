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
const { evaluateSignals } = require("./signalEngine");
const { lookupLabel } = require("../database/labels");

// ========================
// CONFIG
// ========================
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// Arc dual-USDC (resmi adresler)
// Native / EIP-7708: 18 decimal — her USDC hareketi
// ERC-20 USDC: 6 decimal — aynı hareketin ikinci log'u, ATLANIR
const ARC_USDC_SYSTEM = "0xfffffffffffffffffffffffffffffffffffffffe";
const ARC_USDC_ERC20  = "0x3600000000000000000000000000000000000000";
const ARC_EURC_MAINNET = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";

const ALERT_ASSETS = new Set(["USDC", "EURC"]);

const WHALE_THRESHOLD = Number(process.env.WHALE_THRESHOLD || 100000);
const LARGE_TRANSFER_THRESHOLD = Number(process.env.LARGE_TRANSFER_THRESHOLD || 250000);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 5000);
const SCAN_EVERY_N_BLOCKS = Number(process.env.SCAN_EVERY_N_BLOCKS || 15);
let rpcBackoffUntil = 0;
const MEMORY_TTL_MS = Number(process.env.MEMORY_TTL_MS || 10 * 60 * 1000);

const DEFAULT_WHITELIST = [
  ARC_USDC_SYSTEM,
  ARC_EURC_MAINNET
];

const TOKEN_WHITELIST = (process.env.TOKEN_WHITELIST || DEFAULT_WHITELIST.join(","))
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

tokenInfoCache.set(ARC_USDC_SYSTEM.toLowerCase(), { symbol: "USDC", decimals: 18 });
tokenInfoCache.set(ARC_USDC_ERC20.toLowerCase(), { symbol: "USDC", decimals: 6 });
tokenInfoCache.set(ARC_EURC_MAINNET.toLowerCase(), { symbol: "EURC", decimals: 6 });

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
          address: TOKEN_WHITELIST,
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
            const logId = `${txHash}:${log.index ?? log.logIndex ?? 0}`;

            if (seenTx.has(logId)) continue;
            seenTx.set(logId, Date.now());

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

            const emitter = String(log.address || "").toLowerCase();

            // ERC-20 USDC log'u = sistem log'unun kopyası. Sayma.
            if (emitter === ARC_USDC_ERC20.toLowerCase()) continue;

            let token = log.address;
            let symbol;
            let decimals;

            if (emitter === ARC_USDC_SYSTEM.toLowerCase()) {
              token = ARC_USDC_ERC20;
              symbol = "USDC";
              decimals = 18;
            } else if (emitter === ARC_EURC_MAINNET.toLowerCase()) {
              token = ARC_EURC_MAINNET;
              symbol = "EURC";
              decimals = 6;
            } else {
              const info = await getTokenInfo(token);
              symbol = info.symbol;
              decimals = info.decimals;
            }

            if (!ALERT_ASSETS.has(String(symbol).toUpperCase())) continue;

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

            try {
              const newSignals = await evaluateSignals({
                txHash,
                from,
                to,
                symbol,
                amount,
                fromStats,
                toStats
              });
              if (newSignals.length) {
                console.log(
                  "signals emitted:",
                  newSignals.map((s) => `${s.type}:${s.asset}`).join(", ")
                );
                const { notifyStrategyWatchers } = require("../telegram/bot");
                for (const s of newSignals) {
                  await notifyStrategyWatchers(s);
                }
              }
            } catch (e) {
              console.log("evaluateSignals skip:", e.message);
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
              const fromBehav = fmtBehavior(fromStats?.behavior);
              const toBehav   = fmtBehavior(toStats?.behavior);
              const fromScoreVal = fromStats?.whale_score ?? null;
              const toScoreVal   = toStats?.whale_score   ?? null;

              const agentQuestion =
                `Write intel commentary for a whale transfer on Arc mainnet (chainId 5042). ` +
                `Rules you must follow exactly:\n` +
                `- Plain sentences only. No markdown: no asterisks, no hashes, no bullet points, no backticks, no bold or italic markers.\n` +
                `- 2 to 4 short sentences.\n` +
                `- Do NOT repeat the token address, wallet addresses, tx hash, or raw score numbers — those are already shown in the UI.\n` +
                `- Do NOT mention testnet. This is Arc mainnet.\n` +
                `- Cover: size in human terms (e.g. "a mid-sized transfer", "a very large move"), which side looks stronger and briefly why, one caution.\n` +
                `- If a wallet behavior is UNKNOWN, say that once. Do not invent intent or label.\n` +
                `\n` +
                `Transfer data:\n` +
                `Token: ${symbol}\n` +
                `Amount: ${amount.toLocaleString()} ${symbol} (tier: ${sizeTier})\n` +
                `Sender behavior: ${fromBehav}${fromScoreVal !== null ? `, whale score ${fmtScore(fromScoreVal)}` : ""}\n` +
                `Receiver behavior: ${toBehav}${toScoreVal !== null ? `, whale score ${fmtScore(toScoreVal)}` : ""}\n` +
                `Token risk: ${riskLabel}\n` +
                `\n` +
                `Write the commentary now:`;


              const analysis = await askArc(agentQuestion, "whale-agent");

              if (analysis.success && analysis.answer) {
                const agentMessage = `🤖 <b>AI Analysis</b>\n\n${analysis.answer}`;
                try {
                  const fs = require("fs");
                  const path = require("path");
                  const fromLbl = lookupLabel(from);
                  const toLbl   = lookupLabel(to);
                  fs.writeFileSync(
                    path.join(__dirname, "../../data/intel.json"),
                    JSON.stringify({
                      text: analysis.answer,
  		      at: new Date().toISOString(),
  		      txHash: txHash,
  		      from: String(from).toLowerCase(),
  		      to: String(to).toLowerCase(),
  		      token: symbol,
  		      amount: amount,
  		      tier: sizeTier,
  		      fromScore: fromStats && fromStats.whale_score != null ? fromStats.whale_score : null,
  		      toScore: toStats && toStats.whale_score != null ? toStats.whale_score : null,
  		      fromBehavior: fromStats && fromStats.behavior ? fromStats.behavior : null,
  		      toBehavior: toStats && toStats.behavior ? toStats.behavior : null
		    }),
                    "utf8"
                  );
                } catch (e) {
                  console.log("intel.json yazılamadı", e.message);
                }
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
