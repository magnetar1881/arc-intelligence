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
// Telegram removed — no sendAlert
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

// ========================
// CCTP V2 — Arc mainnet (source: data/ecosystem.json / docs.arc.io)
// TokenMessengerV2 emits DepositForBurn (OUT) and MintAndWithdraw (IN)
// MessageTransmitterV2 relays attestations
// ========================
const CCTP_TOKEN_MESSENGER   = "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d"; // lowercase
const CCTP_MSG_TRANSMITTER   = "0x81d40f21f12a8f0e3252bccb954d722d4c464b64"; // lowercase
// DepositForBurn(uint64,address,uint256,address,bytes32,uint256,bytes32,bytes32)
const CCTP_DEPOSIT_FOR_BURN  = "0x2fa9ca894982930190727e75500a97d8dc500233";
// MintAndWithdraw(address,uint256,address)
const CCTP_MINT_AND_WITHDRAW = "0x1b2a7ff080b8cb6ff19c7c6f9b8a4c3c3bc6e4e5";
// DepositForBurnWithCaller — same prefix as DepositForBurn, shares topic[0]
// We detect by: from/to === CCTP_TOKEN_MESSENGER in the same tx receipt

/**
 * detectCctp — inspect full tx receipt for CCTP log signatures.
 * Returns { source: "CCTP", direction: "IN"|"OUT" } or null.
 * "OUT" = DepositForBurn present (burn on Arc, mint elsewhere)
 * "IN"  = MintAndWithdraw present (mint on Arc, burn elsewhere)
 * We do ONE eth_getTransactionReceipt call per whale tx, cached by txHash.
 */
const cctpReceiptCache = new Map(); // txHash -> { source, direction } | null

async function detectCctp(provider, txHash) {
  if (cctpReceiptCache.has(txHash)) return cctpReceiptCache.get(txHash);

  let result = null;
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt && Array.isArray(receipt.logs)) {
      let hasDeposit = false;
      let hasMint    = false;
      for (const log of receipt.logs) {
        const addr = String(log.address || "").toLowerCase();
        const t0   = (log.topics && log.topics[0]) ? log.topics[0].toLowerCase() : "";
        // keccak256("DepositForBurn(uint64,address,uint256,address,bytes32,uint256,bytes32,bytes32)")
        if (addr === CCTP_TOKEN_MESSENGER && t0 === CCTP_DEPOSIT_FOR_BURN) hasDeposit = true;
        // keccak256("MintAndWithdraw(address,uint256,address)")
        if (addr === CCTP_TOKEN_MESSENGER && t0 === CCTP_MINT_AND_WITHDRAW) hasMint    = true;
      }
      if (hasDeposit) result = { source: "CCTP", direction: "OUT" };
      else if (hasMint) result = { source: "CCTP", direction: "IN" };
    }
  } catch (_) {
    // receipt fetch failed — leave null, do not tag
  }

  cctpReceiptCache.set(txHash, result);
  // Evict old entries to avoid unbounded growth
  if (cctpReceiptCache.size > 500) {
    const oldest = cctpReceiptCache.keys().next().value;
    cctpReceiptCache.delete(oldest);
  }
  return result;
}

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

// Prefer RPC_URL=https://lensora.xyz/arc-rpc if public rpc.mainnet.arc.io ECONNRESETs.
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

            // CCTP detection — one receipt lookup per txHash (cached)
            let cctpTag = null;
            try {
              cctpTag = await detectCctp(p, txHash);
            } catch (_) {}

            await insertWhale({
              txHash,
              wallet: from,
              token: symbol,
              amount,
              type: "WHALE_OUT",
              source: cctpTag ? cctpTag.source : null,
              direction: cctpTag ? cctpTag.direction : null
            });

            await insertWhale({
              txHash,
              wallet: to,
              token: symbol,
              amount,
              type: "WHALE_IN",
              source: cctpTag ? cctpTag.source : null,
              direction: cctpTag ? cctpTag.direction : null
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
                // Telegram removed — signals logged only
                for (const s of newSignals) {
                  console.log("signal:", s.type, s.asset);
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

            // ========================
            // WHALE AGENT — AI + intel.json only for LARGE (>=500k)
            // 100k–499k: whale DB insert runs above, no intel.json overwrite
            // ========================
            if (amount >= 500000) {
              const fs   = require("fs");
              const path = require("path");
              const fromLbl = lookupLabel(from);
              const toLbl   = lookupLabel(to);

              // Base payload — always populated regardless of AI outcome
              const intelBase = {
                at:           new Date().toISOString(),
                txHash:       txHash,
                from:         String(from).toLowerCase(),
                to:           String(to).toLowerCase(),
                token:        symbol,
                amount:       amount,
                tier:         sizeTier,
                source:       cctpTag ? cctpTag.source    : null,
                direction:    cctpTag ? cctpTag.direction : null,
                fromScore:    fromStats && fromStats.whale_score != null ? fromStats.whale_score : null,
                toScore:      toStats  && toStats.whale_score  != null ? toStats.whale_score   : null,
                fromBehavior: fromStats && fromStats.behavior ? fromStats.behavior : null,
                toBehavior:   toStats   && toStats.behavior   ? toStats.behavior   : null,
                fromLabel:    fromLbl ? fromLbl.label : null,
                toLabel:      toLbl   ? toLbl.label   : null,
                text:         null  // filled below
              };

              const fromBehav    = fmtBehavior(fromStats?.behavior);
              const toBehav      = fmtBehavior(toStats?.behavior);
              const fromScoreVal = fromStats?.whale_score ?? null;
              const toScoreVal   = toStats?.whale_score   ?? null;

              const cctpLine = cctpTag
                ? `Transfer type: CCTP cross-chain (${cctpTag.direction === "OUT" ? "burn on Arc, mint elsewhere" : cctpTag.direction === "IN" ? "mint on Arc, burn elsewhere" : "CCTP detected, direction unclear"})\n`
                : `Transfer type: same-chain (no CCTP detected)\n`;

              const agentQuestion =
                `Write intel commentary for a whale transfer on Arc mainnet (chainId 5042). ` +
                `Output ONLY 2 to 4 plain English sentences. Nothing else.\n` +
                `\n` +
                `ABSOLUTE RULES — violating any of these makes the output wrong:\n` +
                `1. FORBIDDEN: any 0x address, any tx hash, any hex string. Say "the sender", "the receiver", "the counterparty" instead.\n` +
                `2. FORBIDDEN: raw numeric scores. Say "high-scoring wallet" or "low-scoring wallet" instead.\n` +
                `3. FORBIDDEN: markdown of any kind — no asterisks, no hashes, no bullets, no backticks, no bold, no italic, no lists.\n` +
                `4. FORBIDDEN: the word "testnet". This is Arc mainnet only.\n` +
                `5. FORBIDDEN: more than 4 sentences or any header/title line.\n` +
                `\n` +
                `STABLECOINS (USDC, EURC on Arc):\n` +
                `- Do not say the transfer will move price, peg, or market sentiment.\n` +
                `- Do not say it will drain or add protocol liquidity unless the to/from address was given to you as a pool or vault label.\n` +
                `- A 100k–few million USDC/EURC move is routine treasury or rebalancing.\n` +
                `- One clause max on size. No "caution: price impact".\n` +
                `- If you have no pool, bridge, or CCTP label for either address, say it is a transfer between wallets.\n` +
                `\n` +
                `REQUIRED content (all in plain prose, addresses already shown above UI):\n` +
                `- Size in human terms (e.g. "a very large move", "a mid-sized transfer").\n` +
                `- Which side looks stronger and why in one clause.\n` +
                `- One caution.\n` +
                `- If behavior is UNKNOWN, say it once. Do not invent labels.\n` +
                `- If transfer type is CCTP: mention it crossed chains via CCTP in one clause. No source chain unless destinationChain is present.\n` +
                `- If transfer type is same-chain: do NOT say bridge, CCTP, Gateway, or "from Ethereum".\n` +
                `\n` +
                `Transfer data (DO NOT repeat these values in your output):\n` +
                `Token: ${symbol}\n` +
                `Amount: ${amount.toLocaleString()} ${symbol} (tier: ${sizeTier})\n` +
                cctpLine +
                `Sender behavior: ${fromBehav}${fromScoreVal !== null ? `, whale score ${fmtScore(fromScoreVal)}` : ""}\n` +
                `Receiver behavior: ${toBehav}${toScoreVal !== null ? `, whale score ${fmtScore(toScoreVal)}` : ""}\n` +
                `Token risk: ${riskLabel}\n` +
                `\n` +
                `Write the 2-4 sentence commentary now. No addresses. No scores. No markdown:`;

              // ── 1. askArc (isolated — Telegram failure must not erase good text) ──
              let analysisText = null;
              try {
                const analysis = await askArc(agentQuestion, "whale-agent");
                if (analysis && analysis.success && analysis.answer && analysis.answer.trim()) {
                  analysisText = analysis.answer.trim();
                }
              } catch (err) {
                console.error("intel skip", txHash, err && err.message);
              }

              // ── 2. Fallback when AI unavailable or returned empty ──
              if (!analysisText) {
                const fmtAmt = amount >= 1e6
                  ? (amount / 1e6).toFixed(2) + "M"
                  : amount >= 1e3
                    ? (amount / 1e3).toFixed(1) + "K"
                    : String(amount);
                analysisText = `${fmtAmt} ${symbol} transfer recorded. Model note unavailable.`;
              }

              intelBase.text = analysisText;

              // Write intel.json for LARGE (>=500k) whale events only
              try {
                fs.writeFileSync(
                  path.join(__dirname, "../../data/intel.json"),
                  JSON.stringify(intelBase),
                  "utf8"
                );
              } catch (e) {
                console.log("intel.json yazılamadı", e.message);
              }
            } // end if (amount >= 500000)

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
