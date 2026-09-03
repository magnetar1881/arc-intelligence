const {
  insertSignal,
  getRecentWhaleCluster,
  getSignalsSinceMinutes,
  getWalletStats
} = require("../database/db");

const WINDOW_MIN = Number(process.env.SIGNAL_WINDOW_MIN || 30);
const CLUSTER_MIN_WALLETS = Number(process.env.SIGNAL_CLUSTER_WALLETS || 2);
const CLUSTER_MIN_SCORE = Number(process.env.SIGNAL_MIN_SCORE || 0.25);
const ROTATION_ASSETS = new Set(["USDC", "EURC"]);
const SIGNAL_MIN_AMOUNT = Number(process.env.SIGNAL_MIN_AMOUNT || process.env.WHALE_THRESHOLD || 100000);

function confidenceOf({ walletCount, totalAmount, highScoreCount }) {
  if (walletCount >= 3 || totalAmount >= 1000000 || highScoreCount >= 2) return "high";
  if (walletCount >= 2 || totalAmount >= 250000) return "medium";
  return "low";
}

function short(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

async function alreadyEmitted(type, asset, minutes = WINDOW_MIN) {
  const recent = await getSignalsSinceMinutes(minutes, asset);
  return recent.some((s) => s.type === type);
}

async function emit(signal) {
  const id = await insertSignal(signal);
  return { id, ...signal };
}

async function evaluateSignals({ txHash, from, to, symbol, amount, fromStats, toStats }) {
  const asset = String(symbol || "UNKNOWN").toUpperCase();
  const created = [];

  try {
    const toCount = Number(toStats?.transfer_count || 0);
    if (toCount <= 1) {
      const sig = {
        type: "fresh_receiver",
        asset,
        windowMin: 1,
        totalAmount: amount,
        walletCount: 1,
        confidence: amount >= 250000 ? "high" : "medium",
        explanation:
          `${short(from)} → yeni görülen cüzdan ${short(to)}: ${Number(amount).toLocaleString()} ${asset}.`,
        evidence: [
          { txHash, from, to, amount, token: asset, role: "first_seen_receiver" }
        ]
      };
      if (!(await alreadyEmitted("fresh_receiver", asset, 10))) {
        created.push(await emit(sig));
      }
    }
  } catch (e) {
    console.log("signal fresh_receiver skip:", e.message);
  }

  try {
    const cluster = await getRecentWhaleCluster(asset, WINDOW_MIN);
    const incoming = cluster.filter((r) => r.type === "WHALE_IN");
    const unique = new Map();
    for (const row of incoming) {
      const w = String(row.wallet || "").toLowerCase();
      if (!w) continue;
      if (!unique.has(w)) unique.set(w, row);
    }
    const wallets = [...unique.values()];
    const highScoreCount = wallets.filter((w) => Number(w.whale_score || 0) >= CLUSTER_MIN_SCORE).length;
    const totalAmount = incoming.reduce((s, r) => s + Number(r.amount || 0), 0);

    if (wallets.length >= CLUSTER_MIN_WALLETS && highScoreCount >= 1) {
      const sig = {
        type: "smart_cluster",
        asset,
        windowMin: WINDOW_MIN,
        totalAmount,
        walletCount: wallets.length,
        confidence: confidenceOf({ walletCount: wallets.length, totalAmount, highScoreCount }),
        explanation:
          `Son ${WINDOW_MIN} dk içinde ${wallets.length} cüzdan ${asset} aldı. ` +
          `Yüksek skorlu: ${highScoreCount}. Toplam: ${totalAmount.toLocaleString()} ${asset}.`,
        evidence: incoming.slice(0, 8).map((r) => ({
          txHash: r.txHash,
          wallet: r.wallet,
          amount: r.amount,
          score: r.whale_score,
          type: r.type
        }))
      };
      if (!(await alreadyEmitted("smart_cluster", asset, WINDOW_MIN))) {
        created.push(await emit(sig));
      }
    }
  } catch (e) {
    console.log("signal smart_cluster skip:", e.message);
  }

  try {
    if (ROTATION_ASSETS.has(asset)) {
      const other = asset === "USDC" ? "EURC" : "USDC";
      const a = await getRecentWhaleCluster(asset, 60);
      const b = await getRecentWhaleCluster(other, 60);
      const outA = a.filter((r) => r.type === "WHALE_OUT").reduce((s, r) => s + Number(r.amount || 0), 0);
      const inB = b.filter((r) => r.type === "WHALE_IN").reduce((s, r) => s + Number(r.amount || 0), 0);
      const rotated = Math.min(outA, inB);

      if (rotated >= SIGNAL_MIN_AMOUNT) {
        const sig = {
          type: "stable_rotation",
          asset: `${asset}->${other}`,
          windowMin: 60,
          totalAmount: rotated,
          walletCount: 0,
          confidence: rotated >= 500000 ? "high" : "medium",
          explanation:
            `Son 60 dk: ${asset} çıkışı ${outA.toLocaleString()}, ${other} girişi ${inB.toLocaleString()}. ` +
            `Net rotasyon ≈ ${rotated.toLocaleString()}.`,
          evidence: [
            { token: asset, outflow: outA },
            { token: other, inflow: inB }
          ]
        };
        if (!(await alreadyEmitted("stable_rotation", sig.asset, 60))) {
          created.push(await emit(sig));
        }
      }
    }
  } catch (e) {
    console.log("signal stable_rotation skip:", e.message);
  }

  try {
    if (amount >= SIGNAL_MIN_AMOUNT) {
      const fromScore = Number(fromStats?.whale_score || 0);
      const sig = {
        type: fromScore >= 0.25 ? "accumulation" : "large_transfer",
        asset,
        windowMin: 1,
        totalAmount: amount,
        walletCount: 2,
        confidence: amount >= 250000 ? "high" : "medium",
        explanation:
          `${short(from)} (${fromStats?.behavior || "unknown"}, skor ${fromScore.toFixed(2)}) ` +
          `${Number(amount).toLocaleString()} ${asset} gönderdi → ${short(to)}.`,
        evidence: [{ txHash, from, to, amount, token: asset }]
      };
      if (!(await alreadyEmitted(sig.type, asset, 5))) {
        created.push(await emit(sig));
      }
    }
  } catch (e) {
    console.log("signal large_transfer skip:", e.message);
  }

  return created;
}

module.exports = { evaluateSignals };
