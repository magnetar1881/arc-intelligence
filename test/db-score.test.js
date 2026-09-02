const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();

// Test için geçici DB
const TEST_DB = path.join(__dirname, "test-whale.db");
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

const db = new sqlite3.Database(TEST_DB);

db.serialize(() => {
  db.run(`CREATE TABLE wallets (
    wallet TEXT PRIMARY KEY,
    total_volume REAL DEFAULT 0,
    transfer_count INTEGER DEFAULT 0,
    last_seen DATETIME,
    whale_score REAL DEFAULT 0,
    behavior TEXT DEFAULT 'unknown',
    incoming_volume REAL DEFAULT 0,
    outgoing_volume REAL DEFAULT 0
  )`);
});

function updateWalletScore(wallet) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE wallets
       SET whale_score = ROUND(
         MIN(1.0,
           (
             CASE
               WHEN total_volume >= 1000000 THEN 0.45
               WHEN total_volume >= 250000  THEN 0.35
               WHEN total_volume >= 100000  THEN 0.25
               WHEN total_volume >= 50000   THEN 0.15
               WHEN total_volume >= 10000   THEN 0.08
               ELSE 0.03
             END
             +
             CASE
               WHEN transfer_count >= 50 THEN 0.25
               WHEN transfer_count >= 20 THEN 0.18
               WHEN transfer_count >= 10 THEN 0.12
               WHEN transfer_count >= 5  THEN 0.08
               WHEN transfer_count >= 2  THEN 0.04
               ELSE 0.02
             END
             +
             CASE behavior
               WHEN 'trader' THEN 0.20
               WHEN 'holder' THEN 0.12
               WHEN 'exited' THEN 0.05
               ELSE 0.08
             END
             +
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
      (err) => (err ? reject(err) : resolve())
    );
  });
}

describe("Whale Score", () => {
  it("should calculate high score for big volume + trader", async () => {
    await new Promise((res, rej) => {
      db.run(
        `INSERT INTO wallets (wallet, total_volume, transfer_count, behavior, incoming_volume, outgoing_volume)
         VALUES ('0xtest1', 500000, 25, 'trader', 300000, 200000)`,
        (err) => (err ? rej(err) : res())
      );
    });

    await updateWalletScore("0xtest1");

    const row = await new Promise((res, rej) => {
      db.get(`SELECT whale_score FROM wallets WHERE wallet = '0xtest1'`, (err, r) =>
        err ? rej(err) : res(r)
      );
    });

    // 0.35 (vol) + 0.18 (act) + 0.20 (trader) + 0.10 (balance) ≈ 0.83
    assert.ok(row.whale_score >= 0.80 && row.whale_score <= 0.85);
  });

  it("should give low score for small holder", async () => {
    await new Promise((res, rej) => {
      db.run(
        `INSERT INTO wallets (wallet, total_volume, transfer_count, behavior, incoming_volume, outgoing_volume)
         VALUES ('0xtest2', 5000, 1, 'holder', 5000, 0)`,
        (err) => (err ? rej(err) : res())
      );
    });

    await updateWalletScore("0xtest2");

    const row = await new Promise((res, rej) => {
      db.get(`SELECT whale_score FROM wallets WHERE wallet = '0xtest2'`, (err, r) =>
        err ? rej(err) : res(r)
      );
    });

    // 0.03 + 0.02 + 0.12 + 0.06 ≈ 0.23
    assert.ok(row.whale_score < 0.30);
  });
});

// Temizlik
process.on("exit", () => {
  try { fs.unlinkSync(TEST_DB); } catch {}
});
