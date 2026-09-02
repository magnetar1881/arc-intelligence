const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const DB_DIR = path.join(__dirname, "../../data");
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new sqlite3.Database(path.join(DB_DIR, "whale.db"));

db.serialize(() => {
  db.run("PRAGMA journal_mode = WAL");

  db.run(`
    CREATE TABLE IF NOT EXISTS whales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      txHash TEXT,
      wallet TEXT,
      token TEXT,
      amount REAL,
      type TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(txHash, wallet)
    )
  `);

db.run(`
    CREATE TABLE IF NOT EXISTS wallets (
      wallet TEXT PRIMARY KEY,
      total_volume REAL DEFAULT 0,
      transfer_count INTEGER DEFAULT 0,
      last_seen DATETIME,
      whale_score REAL DEFAULT 0,
      behavior TEXT DEFAULT 'unknown',
      incoming_volume REAL DEFAULT 0,
      outgoing_volume REAL DEFAULT 0
    )
  `);


  db.run(`
    CREATE TABLE IF NOT EXISTS tokens (
      token TEXT PRIMARY KEY,
      symbol TEXT,
      transfer_count INTEGER DEFAULT 0,
      mint_count INTEGER DEFAULT 0,
      unique_wallets INTEGER DEFAULT 0,
      trust_score REAL DEFAULT 0
    )
  `);

  // token = NULL  -> bu chat tüm whale alarmlarına abone
  // token = '0x..' -> bu chat sadece o tokene abone
  db.run(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      token TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chat_id, token)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chat_id, kind, value)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS token_wallets (
      token TEXT NOT NULL,
      wallet TEXT NOT NULL,
      first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (token, wallet)
    )
  `);
});

function insertWhale(data) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO whales
       (txHash, wallet, token, amount, type)
       VALUES (?, ?, ?, ?, ?)`,
      [data.txHash, data.wallet, data.token, data.amount, data.type],
      function (err) {
        if (err) reject(err);
        else resolve(this?.changes);
      }
    );
  });
}

function updateWallet(wallet, amount, direction = 'in') {
  return new Promise((resolve, reject) => {
    const inAmount = direction === 'in' ? amount : 0;
    const outAmount = direction === 'out' ? amount : 0;
    db.run(
      `INSERT INTO wallets (wallet, total_volume, transfer_count, last_seen, incoming_volume, outgoing_volume)
       VALUES (?, ?, 1, datetime('now'), ?, ?)
       ON CONFLICT(wallet) DO UPDATE SET
         total_volume = total_volume + ?,
         transfer_count = transfer_count + 1,
         last_seen = datetime('now'),
         incoming_volume = incoming_volume + ?,
         outgoing_volume = outgoing_volume + ?`,
      [wallet, amount, inAmount, outAmount, amount, inAmount, outAmount],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}


function updateWalletScore(wallet) {
  return new Promise((resolve, reject) => {
    // Smart Money Score (0.00 – 1.00)
    // volume + aktivite + behavior + in/out dengesi
    db.run(
      `UPDATE wallets
       SET whale_score = ROUND(
         MIN(1.0,
           (
             /* Volume component (max 0.45) */
             CASE
               WHEN total_volume >= 1000000 THEN 0.45
               WHEN total_volume >= 250000  THEN 0.35
               WHEN total_volume >= 100000  THEN 0.25
               WHEN total_volume >= 50000   THEN 0.15
               WHEN total_volume >= 10000   THEN 0.08
               ELSE 0.03
             END
             +
             /* Activity component (max 0.25) */
             CASE
               WHEN transfer_count >= 50 THEN 0.25
               WHEN transfer_count >= 20 THEN 0.18
               WHEN transfer_count >= 10 THEN 0.12
               WHEN transfer_count >= 5  THEN 0.08
               WHEN transfer_count >= 2  THEN 0.04
               ELSE 0.02
             END
             +
             /* Behavior component (max 0.20) */
             CASE behavior
               WHEN 'trader' THEN 0.20
               WHEN 'holder' THEN 0.12
               WHEN 'exited' THEN 0.05
               ELSE 0.08
             END
             +
             /* Flow balance component (max 0.10) */
             CASE
               WHEN incoming_volume > 0 AND outgoing_volume > 0
                    AND outgoing_volume <= incoming_volume * 1.5
                    AND outgoing_volume >= incoming_volume * 0.2
                 THEN 0.10
               WHEN incoming_volume > 0 AND outgoing_volume = 0
                 THEN 0.06
               WHEN outgoing_volume > incoming_volume * 2
                 THEN 0.02
               ELSE 0.04
             END
           )
         ),
         2
       )
       WHERE wallet = ?`,
      [wallet],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

function updateWalletBehavior(wallet) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE wallets SET behavior =
       CASE
         WHEN outgoing_volume = 0 AND incoming_volume > 0 THEN 'holder'
         WHEN outgoing_volume > 0 AND incoming_volume = 0 THEN 'exited'
         WHEN outgoing_volume > incoming_volume * 0.8 THEN 'exited'
         WHEN incoming_volume > 0 AND outgoing_volume > 0 THEN 'trader'
         ELSE 'unknown'
       END
       WHERE wallet = ?`,
      [wallet],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}


function updateTokenStats(token, symbol, type, fromWallet = null, toWallet = null) {
  return new Promise((resolve, reject) => {
    const mintInc = type === "MINT" ? 1 : 0;

    // Önce token satırını oluştur / güncelle
    db.run(
      `INSERT INTO tokens (token, symbol, transfer_count, mint_count, unique_wallets)
       VALUES (?, ?, 1, ?, 0)
       ON CONFLICT(token) DO UPDATE SET
         transfer_count = transfer_count + 1,
         mint_count = mint_count + ?`,
      [token, symbol, mintInc, mintInc],
      (err) => {
        if (err) return reject(err);

        // Gerçek unique wallet’ları kaydet
        const walletsToAdd = [fromWallet, toWallet].filter(Boolean);
        if (walletsToAdd.length === 0) return resolve();

        let pending = walletsToAdd.length;
        let errorOccurred = false;

        walletsToAdd.forEach((w) => {
          db.run(
            `INSERT OR IGNORE INTO token_wallets (token, wallet) VALUES (?, ?)`,
            [token, w.toLowerCase()],
            function (err2) {
              if (errorOccurred) return;
              if (err2) {
                errorOccurred = true;
                return reject(err2);
              }

              // Yeni eklendiyse unique_wallets sayısını artır
              if (this.changes > 0) {
                db.run(
                  `UPDATE tokens SET unique_wallets = unique_wallets + 1 WHERE token = ?`,
                  [token],
                  (err3) => {
                    pending--;
                    if (err3 && !errorOccurred) {
                      errorOccurred = true;
                      return reject(err3);
                    }
                    if (pending === 0 && !errorOccurred) resolve();
                  }
                );
              } else {
                pending--;
                if (pending === 0 && !errorOccurred) resolve();
              }
            }
          );
        });
      }
    );
  });
}

function updateTokenRiskScore(token) {
  return new Promise((resolve, reject) => {
    // trust_score: 0.00 (riskli) → 1.00 (daha güvenilir)
    db.run(
      `UPDATE tokens
       SET trust_score = ROUND(
         MIN(1.0,
           MAX(0.0,
             (
               /* Activity (max 0.35) */
               CASE
                 WHEN transfer_count >= 100 THEN 0.35
                 WHEN transfer_count >= 50  THEN 0.28
                 WHEN transfer_count >= 20  THEN 0.20
                 WHEN transfer_count >= 10  THEN 0.12
                 WHEN transfer_count >= 3   THEN 0.06
                 ELSE 0.02
               END
               +
               /* Unique wallets (max 0.30) */
               CASE
                 WHEN unique_wallets >= 50 THEN 0.30
                 WHEN unique_wallets >= 20 THEN 0.22
                 WHEN unique_wallets >= 10 THEN 0.15
                 WHEN unique_wallets >= 5  THEN 0.10
                 WHEN unique_wallets >= 2  THEN 0.05
                 ELSE 0.02
               END
               +
               /* Mint pressure — yüksek mint oranı risk (max 0.25, ceza) */
               CASE
                 WHEN transfer_count = 0 THEN 0.05
                 WHEN (CAST(mint_count AS REAL) / transfer_count) >= 0.8 THEN 0.02
                 WHEN (CAST(mint_count AS REAL) / transfer_count) >= 0.5 THEN 0.08
                 WHEN (CAST(mint_count AS REAL) / transfer_count) >= 0.2 THEN 0.15
                 ELSE 0.25
               END
               +
               /* Concentration penalty offset (max 0.10) */
               CASE
                 WHEN unique_wallets <= 1 AND transfer_count >= 5 THEN 0.01
                 WHEN unique_wallets <= 3 AND transfer_count >= 15 THEN 0.03
                 ELSE 0.10
               END
             )
           )
         ),
         2
       )
       WHERE token = ?`,
      [token],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

function getTopWhales(limit = 10) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT wallet, total_volume, transfer_count, whale_score
       FROM wallets
       ORDER BY total_volume DESC
       LIMIT ?`,
      [limit],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

// ========================
// SUBSCRIPTIONS
// ========================
function addSubscription(chatId, token) {
  const normalizedToken = token ? token.toLowerCase() : null;
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO subscriptions (chat_id, token) VALUES (?, ?)`,
      [String(chatId), normalizedToken],
      function (err) {
        if (err) reject(err);
        else resolve(this?.changes);
      }
    );
  });
}

function removeSubscription(chatId, token) {
  const normalizedToken = token ? token.toLowerCase() : null;
  return new Promise((resolve, reject) => {
    const sql = normalizedToken === null
      ? `DELETE FROM subscriptions WHERE chat_id = ? AND token IS NULL`
      : `DELETE FROM subscriptions WHERE chat_id = ? AND token = ?`;
    const params = normalizedToken === null ? [String(chatId)] : [String(chatId), normalizedToken];

    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this?.changes);
    });
  });
}

function removeAllSubscriptionsForChat(chatId) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM subscriptions WHERE chat_id = ?`,
      [String(chatId)],
      function (err) {
        if (err) reject(err);
        else resolve(this?.changes);
      }
    );
  });
}

// Bir token için alarm gönderilecek chat_id listesi.
// token IS NULL olanlar (her şeye abone) + o tokene özel abone olanlar.
function getSubscribersForToken(tokenAddress) {
  const normalizedToken = tokenAddress.toLowerCase();
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT DISTINCT chat_id FROM subscriptions WHERE token IS NULL OR token = ?`,
      [normalizedToken],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map((r) => r.chat_id));
      }
    );
  });
}

function getSubscriptionsForChat(chatId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT token FROM subscriptions WHERE chat_id = ?`,
      [String(chatId)],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map((r) => r.token));
      }
    );
  });
}

// ========================
// WALLET LOOKUP
// ========================
function getWalletStats(wallet) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT wallet, total_volume, transfer_count, last_seen, whale_score
       FROM wallets WHERE wallet = ?`,
      [wallet],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
}

function getTokenTrustScore(token) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT token, symbol, trust_score, transfer_count, mint_count, unique_wallets
       FROM tokens WHERE token = ? OR symbol = ?`,
      [token, token],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

function getWhaleByTxHash(txHash) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT txHash, wallet, token, amount, type, timestamp
       FROM whales
       WHERE txHash = ?
       ORDER BY type DESC`,
      [txHash],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

function getRecentWhalesForWallet(wallet, limit = 5) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT txHash, token, amount, timestamp
       FROM whales WHERE wallet = ?
       ORDER BY timestamp DESC LIMIT ?`,
      [wallet, limit],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

// ========================
// DIGEST (son N saat özeti)
// ========================
function getDigestByToken(hours = 24, limit = 10) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT token, COUNT(*) as count, SUM(amount) as volume
       FROM whales
       WHERE timestamp >= datetime('now', ?)
       GROUP BY token
       ORDER BY volume DESC
       LIMIT ?`,
      [`-${hours} hours`, limit],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

function getDigestByWallet(hours = 24, limit = 5) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT wallet, COUNT(*) as count, SUM(amount) as volume
       FROM whales
       WHERE timestamp >= datetime('now', ?)
       GROUP BY wallet
       ORDER BY volume DESC
       LIMIT ?`,
      [`-${hours} hours`, limit],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

function getDigestTotalCount(hours = 24) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) as count FROM whales WHERE timestamp >= datetime('now', ?)`,
      [`-${hours} hours`],
      (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.count : 0);
      }
    );
  });
}

function addWatch(chatId, kind, value) {
  const k = String(kind || "").toLowerCase();
  const v = String(value || "").toLowerCase();
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO watchlist (chat_id, kind, value) VALUES (?, ?, ?)`,
      [String(chatId), k, v],
      function (err) {
        if (err) reject(err);
        else resolve(this?.changes);
      }
    );
  });
}

function removeWatch(chatId, kind, value) {
  const k = String(kind || "").toLowerCase();
  const v = String(value || "").toLowerCase();
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM watchlist WHERE chat_id = ? AND kind = ? AND value = ?`,
      [String(chatId), k, v],
      function (err) {
        if (err) reject(err);
        else resolve(this?.changes);
      }
    );
  });
}

function getWatchlistForChat(chatId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT kind, value, created_at FROM watchlist WHERE chat_id = ? ORDER BY created_at DESC`,
      [String(chatId)],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

function getWatchers(kind, value) {
  const k = String(kind || "").toLowerCase();
  const v = String(value || "").toLowerCase();
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT DISTINCT chat_id FROM watchlist WHERE kind = ? AND value = ?`,
      [k, v],
      (err, rows) => {
        if (err) reject(err);
        else resolve((rows || []).map((r) => r.chat_id));
      }
    );
  });
}

function getStablecoinFlow(hours = 24) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT
         upper(token) as token,
         COUNT(*) as tx_count,
         SUM(amount) as volume,
         SUM(CASE WHEN type = 'WHALE_IN' THEN amount ELSE 0 END) as inflow,
         SUM(CASE WHEN type = 'WHALE_OUT' THEN amount ELSE 0 END) as outflow,
         MIN(timestamp) as first_seen,
         MAX(timestamp) as last_seen
       FROM whales
       WHERE timestamp >= datetime('now', ?)
         AND upper(token) IN ('USDC', 'EURC')
       GROUP BY upper(token)
       ORDER BY volume DESC`,
      [`-${hours} hours`],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

function getAnomalies(hours = 24) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT
         w.txHash,
         w.wallet,
         w.token,
         w.amount,
         w.type,
         w.timestamp,
         wa.whale_score,
         wa.behavior,
         wa.total_volume,
         CASE
           WHEN wa.transfer_count > 1
                AND w.amount > (wa.total_volume / wa.transfer_count) * 5
             THEN 'SPIKE'
           WHEN w.amount >= 100000 THEN 'WHALE_SIZE'
           ELSE 'UNUSUAL'
         END as anomaly_type
       FROM whales w
       LEFT JOIN wallets wa ON lower(wa.wallet) = lower(w.wallet)
       WHERE w.timestamp >= datetime('now', ?)
         AND (
           w.amount >= 100000
           OR (
             wa.transfer_count > 1
             AND w.amount > (wa.total_volume / wa.transfer_count) * 5
           )
         )
       ORDER BY w.amount DESC
       LIMIT 50`,
      [`-${hours} hours`],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

module.exports = {
  insertWhale,
  updateWallet,
  updateWalletScore,
  updateWalletBehavior,
  updateTokenStats,
  updateTokenRiskScore,
  getTopWhales,
  addSubscription,
  removeSubscription,
  removeAllSubscriptionsForChat,
  getSubscribersForToken,
  getSubscriptionsForChat,
  getAnomalies,
  getWalletStats,
  getTokenTrustScore,
  getRecentWhalesForWallet,
  getWhaleByTxHash,
  addWatch,
  removeWatch,
  getWatchlistForChat,
  getWatchers,
  getStablecoinFlow,
  getDigestByToken,
  getDigestByWallet,
  getDigestTotalCount
};
