const express = require("express");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const circleKit = require("../appkit/circleKit");
const { askArc } = require("../appkit/askArc");
const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;
const {
  getWhaleByTxHash,
  getWalletStats,
  getTokenTrustScore,
  getStablecoinFlow,
  getAnomalies,
  getRecentSignals
} = require("../database/db");

// DB bağlantısı (read-only, scanner ile çakışmasın)
const DB_PATH = path.join(__dirname, "../../data/whale.db");
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.log("DB bağlantı hatası:", err.message);
});

// Static dosyalar
app.use(express.static(path.join(__dirname, "../../public")));
app.use(express.json());

// ========================
// API: son whale işlemleri
// ========================
app.get("/api/whales", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  db.all(
    `SELECT txHash, wallet, token, amount, type, timestamp
     FROM whales ORDER BY timestamp DESC LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ========================
// API: top cüzdanlar
// ========================
app.get("/api/top", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  db.all(
    `SELECT wallet, total_volume, transfer_count, whale_score, last_seen,
     behavior, incoming_volume, outgoing_volume
     FROM wallets
     WHERE wallet != '0x0000000000000000000000000000000000000000'
     AND total_volume < 1e15
     ORDER BY total_volume DESC LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ========================
// API: wallet arama
// ========================
app.get("/api/wallets/search", (req, res) => {
  const query = String(req.query.q || "").trim();

  if (!query) {
    return res.json([]);
  }

  const searchTerm = `%${query}%`;

  db.all(
    `SELECT wallet, total_volume, transfer_count, whale_score,
            last_seen, behavior, incoming_volume, outgoing_volume
     FROM wallets
     WHERE wallet != '0x0000000000000000000000000000000000000000'
     AND wallet LIKE ?
     ORDER BY total_volume DESC
     LIMIT 20`,
    [searchTerm],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ========================
// API: tek cüzdan detayı
// ========================
app.get("/api/wallets/:address", (req, res) => {
  const address = String(req.params.address || "").trim().toLowerCase();

  if (!address || address.length < 10) {
    return res.status(400).json({ error: "Geçersiz cüzdan adresi" });
  }

  db.get(
    `SELECT wallet, total_volume, transfer_count, whale_score, last_seen,
            behavior, incoming_volume, outgoing_volume
     FROM wallets
     WHERE lower(wallet) = ?`,
    [address],
    (err, wallet) => {
      if (err) return res.status(500).json({ error: err.message });

      if (!wallet) {
        return res.status(404).json({ error: "Cüzdan bulunamadı" });
      }

      db.all(
        `SELECT txHash, token, amount, type, timestamp
         FROM whales
         WHERE lower(wallet) = ?
         ORDER BY timestamp DESC
         LIMIT 50`,
        [address],
        (err2, txs) => {
          if (err2) return res.status(500).json({ error: err2.message });

          db.all(
            `SELECT token,
                    COUNT(*) as transfer_count,
                    SUM(amount) as volume,
                    MIN(timestamp) as first_seen,
                    MAX(timestamp) as last_seen
             FROM whales
             WHERE lower(wallet) = ?
             GROUP BY token
             ORDER BY transfer_count DESC
             LIMIT 20`,
            [address],
            (err3, tokens) => {
              if (err3) return res.status(500).json({ error: err3.message });

              res.json({
                wallet,
                transactions: txs || [],
                tokenActivity: tokens || []
              });
            }
          );
        }
      );
    }
  );
});

// ========================
// API: token aktivitesi
// ========================
app.get("/api/tokens", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  db.all(
    `SELECT token, symbol, transfer_count, mint_count, unique_wallets, trust_score
     FROM tokens ORDER BY transfer_count DESC LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ========================
// API: özet istatistikler
// ========================
app.get("/api/stats", (req, res) => {
  const queries = [
    new Promise((resolve, reject) => {
      db.get(`SELECT COUNT(*) as total FROM whales`, (err, row) => {
        if (err) reject(err);
        else resolve({ total_whales: row.total });
      });
    }),
    new Promise((resolve, reject) => {
      db.get(`SELECT COUNT(*) as total FROM wallets`, (err, row) => {
        if (err) reject(err);
        else resolve({ total_wallets: row.total });
      });
    }),
    new Promise((resolve, reject) => {
      db.get(`SELECT COUNT(*) as total FROM tokens`, (err, row) => {
        if (err) reject(err);
        else resolve({ total_tokens: row.total });
      });
    }),
    new Promise((resolve, reject) => {
      db.get(
        `SELECT COUNT(*) as total FROM whales
         WHERE timestamp >= datetime('now', '-24 hours')`,
        (err, row) => {
          if (err) reject(err);
          else resolve({ whales_24h: row.total });
        }
      );
    }),
    new Promise((resolve, reject) => {
      db.get(
        `SELECT SUM(amount) as total FROM whales
         WHERE timestamp >= datetime('now', '-24 hours')`,
        (err, row) => {
          if (err) reject(err);
          else resolve({ volume_24h: row.total || 0 });
        }
      );
    })
  ];

  Promise.all(queries)
    .then((results) => res.json(Object.assign({}, ...results)))
    .catch((err) => res.status(500).json({ error: err.message }));
});

app.get("/api/stable-hero", (req, res) => {
  db.get(`SELECT MAX(timestamp) as last_seen FROM whales`, [], (e1, last) => {
    db.all(
      `SELECT upper(token) as token,
              COUNT(*) as txs,
              SUM(amount) as volume
       FROM whales
       WHERE upper(token) IN ('USDC','EURC','CIRBTC')
         AND timestamp >= datetime('now','-24 hours')
       GROUP BY upper(token)`,
      [],
      (e2, rows) => {
        if (e1 || e2) return res.status(500).json({ error: (e1||e2).message });
        const map = {};
        (rows || []).forEach(r => { map[r.token] = r; });
        res.json({
          last_seen: last?.last_seen || null,
          usdc_txs: map.USDC?.txs || 0,
          usdc_vol: map.USDC?.volume || 0,
          eurc_txs: map.EURC?.txs || 0,
          eurc_vol: map.EURC?.volume || 0,
          cirbtc_txs: map.CIRBTC?.txs || 0,
          cirbtc_vol: map.CIRBTC?.volume || 0
        });
      }
    );
  });
});

// ========================
// API: digest (son N saat)
// ========================
app.get("/api/digest", (req, res) => {
  const hours = Math.min(parseInt(req.query.hours) || 24, 168);
  db.all(
    `SELECT token, COUNT(*) as count, SUM(amount) as volume
     FROM whales
     WHERE timestamp >= datetime('now', ?)
     GROUP BY token ORDER BY volume DESC LIMIT 10`,
    [`-${hours} hours`],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ========================
// API: ekosistem verisi
// ========================
app.get("/api/ecosystem", (req, res) => {
  const ecosystemPath = path.join(__dirname, "../../data/ecosystem.json");
  try {
    const data = JSON.parse(fs.readFileSync(ecosystemPath, "utf8"));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "ecosystem.json okunamadı" });
  }
});

// ========================
// API: anomalies
// ========================
app.get("/api/anomalies", async (req, res) => {
  const hours = Math.min(parseInt(req.query.hours) || 24, 168);
  try {
    const rows = await getAnomalies(hours);
    res.json({ hours, count: rows.length, anomalies: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================
// API: Smart Money
// ========================
app.get("/api/smart-money", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  db.all(
    `SELECT wallet, total_volume, transfer_count, incoming_volume, outgoing_volume,
            whale_score, behavior, last_seen
     FROM wallets
     WHERE whale_score IS NOT NULL
     ORDER BY whale_score DESC, total_volume DESC
     LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

app.get("/smart-money", (req, res) => {
  res.sendFile(path.join(__dirname, "../../public/smart-money.html"));
});

app.get("/anomalies", (req, res) => {
  res.sendFile(path.join(__dirname, "../../public/anomalies.html"));
});

// ========================
// API: Portfolio
// ========================
app.get("/api/portfolio/:address", (req, res) => {
  const address = String(req.params.address || "").toLowerCase();
  if (!address.startsWith("0x") || address.length < 10) {
    return res.status(400).json({ error: "Invalid address" });
  }

  db.get(
    `SELECT * FROM wallets WHERE lower(wallet) = ?`,
    [address],
    (err, wallet) => {
      if (err) return res.status(500).json({ error: err.message });

      db.all(
        `SELECT token, COUNT(*) as txs, SUM(amount) as volume, MAX(timestamp) as last_seen
         FROM whales WHERE lower(wallet) = ?
         GROUP BY token ORDER BY volume DESC LIMIT 20`,
        [address],
        (err2, tokens) => {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({
            address,
            wallet: wallet || null,
            tokens: tokens || []
          });
        }
      );
    }
  );
});

app.get("/portfolio", (req, res) => {
  res.sendFile(path.join(__dirname, "../../public/portfolio.html"));
});

// ========================
// API: DEX Liquidity Proxy
// ========================
app.get("/api/dex-liquidity", (req, res) => {
  db.all(
    `SELECT token, symbol, transfer_count, mint_count, unique_wallets, trust_score
     FROM tokens
     ORDER BY transfer_count DESC
     LIMIT 30`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        note: "Proxy: token transfer activity until pool addresses are known on mainnet",
        tokens: rows || []
      });
    }
  );
});

app.get("/dex", (req, res) => {
  res.sendFile(path.join(__dirname, "../../public/dex.html"));
});

// Ana sayfa
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../../public/index.html"));
});

// ========================
// BRIDGE ESTIMATE
// ========================
app.get("/api/bridge/estimate", async (req, res) => {
  const { from, to, amount, token } = req.query;

  if (!from || !to || !amount) {
    return res.status(400).json({ error: "from, to, amount zorunlu" });
  }

  const result = await circleKit.estimateBridgeTransfer({
    fromChain: from,
    toChain: to,
    amount,
    token: token || "USDC"
  });

  res.json(result);
});

// ========================
// SWAP ESTIMATE (adapter gerektirmez — sadece fiyat tahmini)
// ========================
app.get("/api/swap/estimate", async (req, res) => {
  const { chain, tokenIn, tokenOut, amountIn } = req.query;

  if (!chain || !tokenIn || !tokenOut || !amountIn) {
    return res.status(400).json({ error: "chain, tokenIn, tokenOut, amountIn zorunlu" });
  }

  const result = await circleKit.estimateSwapTokens({
    adapter: null,
    chain,
    tokenIn,
    tokenOut,
    amountIn
  });

  res.json(result);
});

// ========================
// SUPPORTED CHAINS
// ========================
app.get("/api/supported-chains", async (req, res) => {
  const { capability } = req.query;
  const result = await circleKit.getSupportedChains(capability || "bridge");
  res.json(result);
});

// ========================
// ASK ARC
// ========================
app.post("/api/ask", async (req, res) => {
  const { question } = req.body;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const result = await askArc(question, ip);
  res.json(result);
});

// ========================
// AI TRANSACTION EXPLANATION
// ========================
app.post("/api/explain-tx", async (req, res) => {
  const txHash = String(req.body?.txHash || "").trim();
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  if (!txHash || txHash.length < 10) {
    return res.status(400).json({ success: false, error: "Geçersiz tx hash" });
  }

  try {
    const rows = await getWhaleByTxHash(txHash);
    if (!rows.length) {
      return res.status(404).json({ success: false, error: "Bu işlem kaydı bulunamadı" });
    }

    const outRow = rows.find((r) => r.type === "WHALE_OUT") || rows[0];
    const inRow = rows.find((r) => r.type === "WHALE_IN") || null;

    const fromWallet = outRow.wallet;
    const toWallet = inRow ? inRow.wallet : null;

    const [fromStats, toStats] = await Promise.all([
      getWalletStats(fromWallet),
      toWallet ? getWalletStats(toWallet) : Promise.resolve(null)
    ]);

    const tokenMeta = await getTokenTrustScore(outRow.token);

    const question =
      `Explain this Arc on-chain whale transaction in 4-6 short bullet points. ` +
      `Tx: ${txHash}. ` +
      `Token: ${outRow.token}. Amount: ${outRow.amount}. Type: ${outRow.type}. Time: ${outRow.timestamp}. ` +
      `From wallet: ${fromWallet} (score ${fromStats?.whale_score ?? "n/a"}, behavior ${fromStats?.behavior || "unknown"}). ` +
      (toWallet
        ? `To wallet: ${toWallet} (score ${toStats?.whale_score ?? "n/a"}, behavior ${toStats?.behavior || "unknown"}). `
        : "") +
      `Token trust_score: ${tokenMeta?.trust_score ?? "n/a"}. ` +
      `Do not invent data. Explain what this transfer likely means and any risk notes.`;

    const result = await askArc(question, ip);
    res.json(result);
  } catch (err) {
    console.log("explain-tx error:", err.message);
    res.status(500).json({ success: false, error: "Açıklama üretilemedi" });
  }
});

// ========================
// STABLECOIN FLOW (USDC / EURC)
// ========================
app.get("/api/stablecoin-flow", async (req, res) => {
  const hours = Math.min(parseInt(req.query.hours) || 24, 168);
  try {
    const rows = await getStablecoinFlow(hours);
    const totals = rows.reduce(
      (acc, r) => {
        acc.tx_count += Number(r.tx_count || 0);
        acc.volume += Number(r.volume || 0);
        acc.inflow += Number(r.inflow || 0);
        acc.outflow += Number(r.outflow || 0);
        return acc;
      },
      { tx_count: 0, volume: 0, inflow: 0, outflow: 0 }
    );

    res.json({ hours, tokens: rows, totals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/stablecoins", (req, res) => {
  res.sendFile(path.join(__dirname, "../../public/stablecoins.html"));
});

// ========================
// SAYFA ROUTE'LARI
// ========================
app.get("/whales", (req, res) => {
  res.sendFile(path.join(__dirname, "../../public/whales.html"));
});

app.get("/wallets", (req, res) => {
  res.sendFile(path.join(__dirname, "../../public/wallets.html"));
});

app.get("/ecosystem", (req, res) => {
  res.sendFile(path.join(__dirname, "../../public/ecosystem.html"));
});

// Yeni sayfa route'ları
app.get("/swap", (req, res) => {
  res.sendFile(path.join(__dirname, "../../public/swap.html"));
});

app.get("/bridge", (req, res) => {
  res.sendFile(path.join(__dirname, "../../public/bridge.html"));
});

app.get("/wallets/:address", (req, res) => {
  res.sendFile(path.join(__dirname, "../../public/wallet.html"));
});

// wallet.js static olarak zaten /public'ten servis ediliyor

// Swap execute — App Kit browser wallet desteği gelince aktif olacak
app.post("/api/swap/execute", async (req, res) => {
  const { chain, tokenIn, tokenOut, amountIn, recipientAddress } = req.body || {};

  if (!amountIn || !recipientAddress) {
    return res.status(400).json({
      success: false,
      error: "amountIn ve recipientAddress zorunlu"
    });
  }

  const result = await circleKit.executeSwapTokens({
    chain: chain || "Arc_Testnet",
    tokenIn: tokenIn || "USDC",
    tokenOut: tokenOut || "EURC",
    amountIn,
    recipientAddress
  });

  res.json(result);
});

// Bridge execute
app.post("/api/bridge/execute", async (req, res) => {
  const { from, to, amount, token, recipientAddress } = req.body || {};

  if (!from || !to || !amount || !recipientAddress) {
    return res.status(400).json({
      success: false,
      error: "from, to, amount ve recipientAddress zorunlu"
    });
  }

  const result = await circleKit.executeBridgeTransfer({
    fromChain: from,
    toChain: to,
    amount,
    token: token || "USDC",
    recipientAddress
  });

  res.json(result);
});

// ========================
// TRENDING — zaman bazlı token aktivitesi
// ========================
app.get("/api/trending", (req, res) => {
  const hours = Math.min(parseInt(req.query.hours) || 1, 168);
  db.all(
    `SELECT
      w.token,
      t.symbol,
      COUNT(*) as tx_count,
      SUM(w.amount) as volume,
      MIN(w.timestamp) as first_seen,
      MAX(w.timestamp) as last_seen
     FROM whales w
     LEFT JOIN tokens t ON w.token = t.token
     WHERE w.timestamp >= datetime('now', ?)
     GROUP BY w.token
     ORDER BY tx_count DESC
     LIMIT 10`,
    [`-${hours} hours`],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ hours, rows });
    }
  );
});

// ========================
// TOKEN TREND
// ========================
app.get("/api/token-trend", (req, res) => {
  db.all(
    `SELECT
      t.token,
      t.symbol,
      t.transfer_count,
      t.unique_wallets,
      COALESCE(curr.count, 0) as count_1h,
      COALESCE(prev.count, 0) as count_prev_1h
     FROM tokens t
     LEFT JOIN (
       SELECT token, COUNT(*) as count
       FROM whales
       WHERE timestamp >= datetime('now', '-1 hours')
       GROUP BY token
     ) curr ON t.token = curr.token
     LEFT JOIN (
       SELECT token, COUNT(*) as count
       FROM whales
       WHERE timestamp >= datetime('now', '-2 hours')
       AND timestamp < datetime('now', '-1 hours')
       GROUP BY token
     ) prev ON t.token = prev.token
     ORDER BY t.transfer_count DESC
     LIMIT 10`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

const signalHits = new Map();
const SIGNAL_FREE_LIMIT = Number(process.env.SIGNAL_FREE_LIMIT || 30);
const SIGNALS_API_KEY = process.env.SIGNALS_API_KEY || "";

function signalClientId(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown");
}

function allowSignalRequest(req) {
  const key = String(req.headers["x-api-key"] || req.query.api_key || "");
  if (SIGNALS_API_KEY && key === SIGNALS_API_KEY) {
    return { ok: true, plan: "key" };
  }

  const id = signalClientId(req);
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const prev = (signalHits.get(id) || []).filter((t) => t > hourAgo);
  if (prev.length >= SIGNAL_FREE_LIMIT) {
    return { ok: false, plan: "free" };
  }
  prev.push(now);
  signalHits.set(id, prev);
  return { ok: true, plan: "free" };
}

function stripSignal(row, plan) {
  const evidence = plan === "key" ? (row.evidence || []) : (row.evidence || []).slice(0, 2);
  return {
    id: row.id,
    type: row.type,
    asset: row.asset,
    window_min: row.window_min,
    confidence: row.confidence,
    total_amount: row.total_amount,
    wallet_count: row.wallet_count,
    explanation: row.explanation,
    created_at: row.created_at,
    evidence
  };
}

app.get("/api/v1/signals", async (req, res) => {
  const gate = allowSignalRequest(req);
  if (!gate.ok) {
    return res.status(429).json({
      error: "rate_limited",
      message: "Ücretsiz limit doldu. Destek sonrası X-Api-Key ile açılacak.",
      limit: SIGNAL_FREE_LIMIT,
      paid: false
    });
  }

  const limit = Math.min(parseInt(req.query.limit) || 10, gate.plan === "key" ? 100 : 10);
  const type = req.query.type || null;

  try {
    const rows = await getRecentSignals(limit, type);
    res.json({
      paid: gate.plan === "key",
      count: rows.length,
      signals: rows.map((r) => stripSignal(r, gate.plan))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/v1/signals/:id", async (req, res) => {
  const gate = allowSignalRequest(req);
  if (!gate.ok) {
    return res.status(429).json({ error: "rate_limited", paid: false });
  }

  try {
    const rows = await getRecentSignals(100);
    const found = rows.find((r) => String(r.id) === String(req.params.id));
    if (!found) return res.status(404).json({ error: "not_found" });
    res.json({ paid: gate.plan === "key", signal: stripSignal(found, gate.plan) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
});

module.exports = app;
