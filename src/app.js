require("dotenv").config();

const REQUIRED_ENV_VARS = ["RPC_URL", "BOT_TOKEN", "CHAT_ID"];
const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);

if (missing.length) {
  console.error(`❌ Eksik environment değişkenleri: ${missing.join(", ")}`);
  process.exit(1);
}

process.on("uncaughtException", (err) => console.error("Uncaught:", err));
process.on("unhandledRejection", (err) => console.error("Rejection:", err));

require("./scanner/blockScanner").startScanner();
require("./dashboard/server");

console.log("✅ Arc Intelligence çalışıyor.");
