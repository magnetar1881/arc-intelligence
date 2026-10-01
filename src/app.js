require("dotenv").config();

const REQUIRED_ENV_VARS = ["RPC_URL"];

const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);

if (missing.length) {
  console.error(`❌ Eksik environment değişkenleri: ${missing.join(", ")}`);
  console.error("Lütfen .env dosyasını kontrol et. Örnek için: .env.example");
  process.exit(1);
}

process.on("uncaughtException", (err) => console.error("Uncaught:", err));
process.on("unhandledRejection", (err) => console.error("Rejection:", err));

// ========================
// BOOT: intel.json repair
// If intel.json is missing or predates the latest whale row with amount >= 500000,
// rewrite it from that row using a template (no LLM at boot).
// Does NOT write for 100k-499k rows. Does NOT delete server file.
// ========================
(function repairIntelJson() {
  const fs   = require("fs");
  const path = require("path");
  const sqlite3 = require("sqlite3").verbose();

  const INTEL_PATH = path.join(__dirname, "../data/intel.json");
  const DB_PATH    = path.join(__dirname, "../data/whale.db");

  // Read current intel.json timestamp (null if missing/unreadable)
  let intelAt = null;
  try {
    const raw = JSON.parse(fs.readFileSync(INTEL_PATH, "utf8"));
    if (raw && raw.at) intelAt = new Date(raw.at).getTime();
  } catch (_) {}

  const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
    if (err) { console.log("intel repair: db open error", err.message); return; }

    // One row per txHash — pick the WHALE_OUT leg, latest first, amount >= 500000
    db.get(
      `SELECT w.txHash, w.wallet AS fromAddr,
              (SELECT wallet FROM whales w2 WHERE w2.txHash=w.txHash AND w2.type='WHALE_IN' LIMIT 1) AS toAddr,
              w.token, w.amount, w.timestamp, w.source, w.direction
       FROM whales w
       WHERE w.type = 'WHALE_OUT' AND w.amount >= 500000
       ORDER BY w.timestamp DESC
       LIMIT 1`,
      [],
      (err, row) => {
        db.close();
        if (err || !row) return; // no qualifying row yet — leave intel.json as-is

        const rowAt = new Date(row.timestamp + " UTC").getTime();

        // Only rewrite if intel.json is missing or older than the latest 500k row
        if (intelAt && intelAt >= rowAt) return;

        const fmtAmt = row.amount >= 1e6
          ? (row.amount / 1e6).toFixed(2) + "M"
          : row.amount >= 1e3
            ? (row.amount / 1e3).toFixed(1) + "K"
            : String(row.amount);

        const cctpLine = row.source === "CCTP"
          ? ` Transfer crossed chains via CCTP (${row.direction === "OUT" ? "burn on Arc" : "mint on Arc"}).`
          : "";

        const intel = {
          at:        new Date(row.timestamp + " UTC").toISOString(),
          txHash:    row.txHash,
          from:      String(row.fromAddr || "").toLowerCase(),
          to:        String(row.toAddr   || "").toLowerCase(),
          token:     row.token,
          amount:    row.amount,
          tier:      row.amount >= 250000 ? "LARGE" : "STANDARD",
          source:    row.source    || null,
          direction: row.direction || null,
          text:      `${fmtAmt} ${row.token} transfer recorded.${cctpLine} Model note unavailable.`
        };

        try {
          fs.writeFileSync(INTEL_PATH, JSON.stringify(intel), "utf8");
          console.log("intel write (boot repair)", row.txHash, row.amount);
        } catch (e) {
          console.error("intel repair write failed:", e.message);
        }
      }
    );
  });
})();

// Scanner sadece SCANNER_ENABLED=true ise başlasın
if (process.env.SCANNER_ENABLED === "true") {
  require("./scanner/blockScanner").startScanner();
  console.log("✅ Scanner aktif.");
} else {
  console.log("⏸️  Scanner devre dışı (SCANNER_ENABLED=true ile aç).");
}

require("./dashboard/server");
console.log("✅ Dashboard çalışıyor.");
