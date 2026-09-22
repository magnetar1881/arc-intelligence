require("dotenv").config();

const TELEGRAM_ON = process.env.TELEGRAM_ENABLED !== "false";

const REQUIRED_ENV_VARS = [
  "RPC_URL",
  ...(TELEGRAM_ON ? ["BOT_TOKEN", "CHAT_ID"] : []),
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

require("./telegram/bot");
if (process.env.TELEGRAM_ENABLED !== "false") {
  console.log("✅ Telegram bot aktif.");
} else {
  console.log("Telegram kapalı");
}

// Scanner sadece SCANNER_ENABLED=true ise başlasın
if (process.env.SCANNER_ENABLED === "true") {
  require("./scanner/blockScanner").startScanner();
  console.log("✅ Scanner aktif.");
} else {
  console.log("⏸️  Scanner devre dışı (SCANNER_ENABLED=true ile aç).");
}

require("./dashboard/server");
console.log("✅ Dashboard çalışıyor.");
