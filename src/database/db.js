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
    db.run(
      `UPDATE wallets
       SET whale_score =
       CASE
         WHEN total_volume > 100000 THEN 1.0
         WHEN total_volume > 50000 THEN 0.7
         WHEN total_volume > 10000 THEN 0.4
         ELSE 0.1
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


function updateTokenStats(token, symbol, type) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO tokens (token, symbol, transfer_count, mint_count, unique_wallets)
       VALUES (?, ?, 1, ?, 1)
       ON CONFLICT(token) DO UPDATE SET
         transfer_count = transfer_count + 1,
         mint_count = mint_count + ?,
         unique_wallets = unique_wallets + 1`,
      [
        token,
        symbol,
        type === "MINT" ? 1 : 0,
        type === "MINT" ? 1 : 0
      ],
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

module.exports = {
  insertWhale,
  updateWallet,
  updateWalletScore,
  updateWalletBehavior,
  updateTokenStats,
  getTopWhales,
  addSubscription,
  removeSubscription,
  removeAllSubscriptionsForChat,
  getSubscribersForToken,
  getSubscriptionsForChat,
  getWalletStats,
  getRecentWhalesForWallet,
  getDigestByToken,
  getDigestByWallet,
  getDigestTotalCount
};
