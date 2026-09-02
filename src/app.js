require("dotenv").config();

const REQUIRED_ENV_VARS = [
  "RPC_URL",
  "BOT_TOKEN",
  "CHAT_ID",
  "GROQ_API_KEY"
];

const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);

if (missing.length) {
  console.error(`❌ Eksik environment değişkenleri: ${missing.join(", ")}`);
  console.error("Lütfen .env dosyasını kontrol et. Örnek için: .env.example");
  process.exit(1);
}

process.on("uncaughtException", (err) => console.error("Uncaught:", err));
process.on("unhandledRejection", (err) => console.error("Rejection:", err));

// Telegram botu her zaman çalışsın
require("./telegram/bot");
console.log("✅ Telegram bot aktif.");

// Scanner sadece SCANNER_ENABLED=true ise başlasın
if (process.env.SCANNER_ENABLED === "true") {
  require("./scanner/blockScanner").startScanner();
  console.log("✅ Scanner aktif.");
} else {
  console.log("⏸️  Scanner devre dışı (SCANNER_ENABLED=true ile aç).");
}

require("./dashboard/server");
console.log("✅ Dashboard çalışıyor.");
