const express = require("express");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

// DB bağlantısı (read-only, scanner ile çakışmasın)
const DB_PATH = path.join(__dirname, "../../data/whale.db");
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
  if (err) console.log("DB bağlantı hatası:", err.message);
});

// Static dosyalar
app.use(express.static(path.join(__dirname, "../../public")));

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
    `SELECT wallet, total_volume, transfer_count, whale_score, last_seen
     FROM wallets ORDER BY total_volume DESC LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ========================
// API: token aktivitesi
// ========================
app.get("/api/tokens", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  db.all(
    `SELECT token, symbol, transfer_count, mint_count, unique_wallets
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

// Ana sayfa
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../../public/index.html"));
});

app.listen(PORT, () => {
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
});

module.exports = app;
