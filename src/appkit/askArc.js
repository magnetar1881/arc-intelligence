const Groq = require("groq-sdk");
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const { estimateBridgeTransfer, estimateSwapTokens } = require("./circleKit");

const DB_PATH = path.join(__dirname, "../../data/whale.db");
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
let groq = null;

function getGroq() {
  if (!groq) {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groq;
}

async function getContextData() {
  const [topWallets, recentWhales, topTokens, stats, trending1h, trending24h] = await Promise.all([
    new Promise((resolve, reject) => {
      db.all(
        `SELECT wallet, total_volume, transfer_count, whale_score
         FROM wallets
         WHERE wallet != '0x0000000000000000000000000000000000000000'
         AND total_volume < 1e15
         ORDER BY total_volume DESC LIMIT 10`,
        (err, rows) => err ? reject(err) : resolve(rows)
      );
    }),
    new Promise((resolve, reject) => {
      db.all(
        `SELECT wallet, token, amount, type, timestamp
         FROM whales ORDER BY timestamp DESC LIMIT 10`,
        (err, rows) => err ? reject(err) : resolve(rows)
      );
    }),
    new Promise((resolve, reject) => {
      db.all(
        `SELECT token, symbol, transfer_count, unique_wallets
         FROM tokens ORDER BY transfer_count DESC LIMIT 5`,
        (err, rows) => err ? reject(err) : resolve(rows)
      );
    }),
    new Promise((resolve, reject) => {
      db.get(
        `SELECT
          (SELECT COUNT(*) FROM whales) as total_whales,
          (SELECT COUNT(*) FROM wallets) as total_wallets,
          (SELECT COUNT(*) FROM tokens) as total_tokens,
          (SELECT COUNT(*) FROM whales WHERE timestamp >= datetime('now', '-24 hours')) as whales_24h,
          (SELECT SUM(amount) FROM whales WHERE timestamp >= datetime('now', '-24 hours')) as volume_24h`,
        (err, row) => err ? reject(err) : resolve(row)
      );
    }),
    new Promise((resolve, reject) => {
      db.all(
        `SELECT w.token, t.symbol, COUNT(*) as tx_count, SUM(w.amount) as volume
         FROM whales w
         LEFT JOIN tokens t ON w.token = t.token
         WHERE w.timestamp >= datetime('now', '-1 hours')
         GROUP BY w.token ORDER BY tx_count DESC LIMIT 5`,
        (err, rows) => err ? reject(err) : resolve(rows)
      );
    }),
    new Promise((resolve, reject) => {
      db.all(
        `SELECT w.token, t.symbol, COUNT(*) as tx_count, SUM(w.amount) as volume
         FROM whales w
         LEFT JOIN tokens t ON w.token = t.token
         WHERE w.timestamp >= datetime('now', '-24 hours')
         GROUP BY w.token ORDER BY tx_count DESC LIMIT 5`,
        (err, rows) => err ? reject(err) : resolve(rows)
      );
    })
  ]);

  return { topWallets, recentWhales, topTokens, stats, trending1h, trending24h };
}

function getEcosystemData() {
  try {
    const p = path.join(__dirname, "../../data/ecosystem.json");
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function detectBridgeIntent(question) {
  const q = question.toLowerCase();
  const keywords = ["bridge", "köprü", "transfer to", "send to", "move to", "from ethereum", "from base", "from arbitrum", "to arc"];
  return keywords.some(k => q.includes(k));
}

function detectSwapIntent(question) {
  const q = question.toLowerCase();
  const keywords = ["swap", "exchange", "convert", "trade", "değiştir", "çevir"];
  return keywords.some(k => q.includes(k));
}

function extractChainAndAmount(question) {
  const q = question.toLowerCase();
  const chainMap = {
    "ethereum": "Ethereum", "base": "Base", "arbitrum": "Arbitrum",
    "polygon": "Polygon", "optimism": "Optimism", "solana": "Solana", "avalanche": "Avalanche"
  };
  let fromChain = "Ethereum";
  for (const [key, value] of Object.entries(chainMap)) {
    if (q.includes(`from ${key}`) || q.includes(key)) { fromChain = value; break; }
  }
  const amountMatch = q.match(/(\d+(?:\.\d+)?)\s*usdc/);
  return { fromChain, toChain: "Arc_Testnet", amount: amountMatch ? amountMatch[1] : "10" };
}

function extractSwapTokens(question) {
  const q = question.toLowerCase();
  const tokens = ["usdc", "eurc", "cirbtc", "usdt", "eth", "weth"];
  const found = tokens.filter(t => q.includes(t));
  return {
    tokenIn: found[0]?.toUpperCase() || "USDC",
    tokenOut: found[1]?.toUpperCase() || "EURC",
    amountIn: (q.match(/(\d+(?:\.\d+)?)/) || ["", "10"])[1]
  };
}

function buildSystemPrompt(contextData, ecosystemData, bridgeEstimate, swapEstimate) {
  const { topWallets, recentWhales, topTokens, stats, trending1h, trending24h } = contextData;

  const ecosystemSummary = Object.entries(ecosystemData)
    .filter(([k]) => !["last_updated", "source", "note"].includes(k))
    .map(([category, items]) => {
      if (!Array.isArray(items)) return "";
      const active = items.filter(i => i.status === "active");
      return `${category}: ${active.map(i => `${i.name} (${i.url})`).join(", ")}`;
    })
    .filter(Boolean)
    .join("\n");

  const bridgeSection = bridgeEstimate?.success
    ? `\nBRIDGE ESTIMATE (live data):
- From: ${bridgeEstimate.fromChain} → To: ${bridgeEstimate.toChain}
- Amount: ${bridgeEstimate.amount} ${bridgeEstimate.token}
- Fee: ${bridgeEstimate.fee} ${bridgeEstimate.feeToken || "USDC"}
- Speed: ${bridgeEstimate.transferSpeed}
Use this data when answering bridge-related questions.`
    : "";

  const swapSection = swapEstimate?.success
    ? `\nSWAP ESTIMATE (live data):
- Token In: ${swapEstimate.tokenIn} (${swapEstimate.amountIn})
- Token Out: ${swapEstimate.tokenOut}
- Estimated Output: ${swapEstimate.estimatedOutput}
- Minimum Output: ${swapEstimate.stopLimit}
Use this data when answering swap-related questions.`
    : "";

  const arcWhitepaperContext = `
ARC TOKEN WHITEPAPER SUMMARY (Source: arc.io/arc-token-whitepaper, May 2026):

SUPPLY & ALLOCATION:
- Initial supply: 10 billion ARC tokens
- 60% Ecosystem: token sales, developer grants, network growth programs
- 25% Circle: protocol development, staking, governance, ecosystem administration
- 15% Long-Term Reserve: resilience, strategic flexibility, economic stabilization
- Unlock/release schedules to be announced

TOKENOMICS:
- Inflation starts at ~2-3% annually, decays over time
- Goal: inflation neutrality (burns from activity offset new issuance)
- All fees (USDC or other) converted to ARC at protocol level
- Converted ARC split between: validator/staker rewards + permanent burn
- Burn ratio configurable by governance

ARC UTILITY (5 functions):
1. Economic alignment: stake ARC, earn rewards from fees + inflation
2. Platform utility: gas discounts, reduced fees across Arc stack for stakers
3. Fee capture: all fees convert to ARC → distributed to validators/stakers + burned
4. Governance: token holders vote on economic parameters (fees, inflation, burn)
5. Expanding utility: multichain coordination, specialized lanes (future)

NETWORK STATUS:
- Testnet launched October 2025
- 244.1M transactions processed as of May 5, 2026
- Mainnet expected summer 2026
- Currently Proof-of-Authority, will transition to Proof-of-Stake

GOVERNANCE:
- Token holders vote on economic parameters
- Validators enforce decisions
- Circle is initial steward, authority shifts to token holders over time
- Decisions: fees, inflation, burn logic → token holder governance
- Security/compliance/incidents → Circle decides (speed required)

CONSENSUS:
- PoA → PoS transition planned
- Permissioned validator set (identity layer)
- ARC staking provides economic security layer
- Private/encrypted mempools to prevent frontrunning/MEV attacks

RULES FOR WHITEPAPER QUESTIONS:
- If asked about ARC token, supply, allocation, tokenomics, governance, or staking: answer from this data
- Always add: "Source: Arc Token Whitepaper (May 2026) — verify at arc.io/arc-token-whitepaper"
- Never speculate beyond what's written above
`;

  return `You are Ask Arc, an AI assistant for the Arc blockchain network.
You answer questions about Arc on-chain activity and help users navigate the Arc ecosystem.
Always be concise, accurate, and helpful. Never make up data — only use what is provided below.

CURRENT NETWORK STATS:
- Total whale transactions: ${stats?.total_whales || 0}
- Tracked wallets: ${stats?.total_wallets || 0}
- Tokens seen: ${stats?.total_tokens || 0}
- Whale transactions (last 24h): ${stats?.whales_24h || 0}
- Volume (last 24h): ${Number(stats?.volume_24h || 0).toFixed(2)}

TOP 20 WALLETS BY VOLUME:
${(topWallets || []).map((w, i) =>
  `${i + 1}. ${w.wallet} | volume: ${Number(w.total_volume).toFixed(2)} | txs: ${w.transfer_count} | score: ${w.whale_score}`
).join("\n")}

RECENT WHALE TRANSACTIONS:
${(recentWhales || []).map(w =>
  `${w.wallet} | ${w.token} | ${Number(w.amount).toFixed(2)} | ${w.timestamp}`
).join("\n")}

TOP TOKENS BY ACTIVITY:
${(topTokens || []).map((t, i) =>
  `${i + 1}. ${t.symbol || t.token} | transfers: ${t.transfer_count} | wallets: ${t.unique_wallets}`
).join("\n")}

TRENDING (last 1 hour):
${(trending1h||[]).length ? trending1h.map((t,i) =>
  `${i+1}. ${t.symbol||t.token} | txs: ${t.tx_count} | volume: ${Number(t.volume||0).toFixed(2)}`
).join("\n") : "No activity in the last hour"}

TRENDING (last 24 hours):
${(trending24h||[]).length ? trending24h.map((t,i) =>
  `${i+1}. ${t.symbol||t.token} | txs: ${t.tx_count} | volume: ${Number(t.volume||0).toFixed(2)}`
).join("\n") : "No activity in the last 24 hours"}

ARC ECOSYSTEM (official sources only):
${ecosystemSummary}
${bridgeSection}
${swapSection}
${arcWhitepaperContext}

RULES:
CRITICAL RULE - CHART FORMAT:
When the user asks about top wallets, whale wallets, or top tokens, you MUST respond with ONLY this JSON, no other text before or after:
{"type":"chart","chartType":"bar","title":"Top Wallets by Volume","labels":["wallet1","wallet2","wallet3","wallet4","wallet5"],"values":[1000,900,800,700,600],"valueLabel":"Volume"}
- If asked about a SPECIFIC wallet address (e.g. "tell me about wallet 0x..."), respond in plain text with that wallet's stats. Do NOT use chart format for single wallet queries.
Use the actual wallet addresses and volumes from the TOP 20 WALLETS data above.
For top tokens use "title":"Top Tokens by Activity" and transfer_count as values.
DO NOT add any explanation text. ONLY output the raw JSON.
- If asked about top wallets, list them with volume and tx count from the data above.
- If asked about bridging, swapping, or ecosystem tools, refer to the ecosystem data and provide the URL.
- If a bridge or swap estimate is available above, include the fee and speed in your answer.
- If asked something you have no data for, say so honestly.
- Keep responses short and clear. Use bullet points when listing multiple items.
- For top tokens chart use "title":"Top Tokens by Activity" and values as transfer counts.
- If asked about recent activity, trending tokens, or what happened in the last hour/day: use the TRENDING data above.
- For all other questions, respond normally in text.
- All on-chain data is from Arc Testnet.`;
}

const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.resetAt > 24 * 60 * 60 * 1000) {
    rateLimitMap.set(ip, { count: 1, resetAt: now });
    return true;
  }
  if (entry.count >= 20) return false;
  entry.count++;
  return true;
}

async function askArc(question, ip = "unknown") {
  if (!process.env.GROQ_API_KEY) {
    return { success: false, error: "GROQ_API_KEY tanımlı değil." };
  }
  if (!checkRateLimit(ip)) {
    return { success: false, error: "Günlük sorgu limitine ulaştınız (20 sorgu/gün). Yarın tekrar deneyin." };
  }
  if (!question || question.trim().length < 3) {
    return { success: false, error: "Lütfen geçerli bir soru girin." };
  }

  try {
    const [contextData, ecosystemData] = await Promise.all([
      getContextData(),
      Promise.resolve(getEcosystemData())
    ]);

    let bridgeEstimate = null;
    let swapEstimate = null;

    if (detectBridgeIntent(question)) {
      const { fromChain, toChain, amount } = extractChainAndAmount(question);
      bridgeEstimate = await estimateBridgeTransfer({ fromChain, toChain, amount });
    }

    if (detectSwapIntent(question)) {
      const { tokenIn, tokenOut, amountIn } = extractSwapTokens(question);
      swapEstimate = await estimateSwapTokens({ chain: "Arc_Testnet", tokenIn, tokenOut, amountIn });
    }

    const systemPrompt = buildSystemPrompt(contextData, ecosystemData, bridgeEstimate, swapEstimate);

    const completion = await getGroq().chat.completions.create({
      model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: question }
      ],
      max_tokens: 1024,
      temperature: 0.3
    });

    const answer = completion.choices[0]?.message?.content || "Yanıt alınamadı.";
    return { success: true, answer };

  } catch (e) {
    console.log("askArc error:", e.message);
    return { success: false, error: "Yanıt alınamadı: " + e.message };
  }
}

module.exports = { askArc };
