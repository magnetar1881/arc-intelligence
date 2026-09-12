const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "../../data/labels.json");
let map = {};
try {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const [addr, meta] of Object.entries(raw)) {
    map[String(addr).toLowerCase()] = meta;
  }
} catch (e) {
  console.log("labels.json yok veya bozuk:", e.message);
}

function lookupLabel(address) {
  if (!address) return null;
  return map[String(address).toLowerCase()] || null;
}

function describeWallet(address, stats = {}) {
  const known = lookupLabel(address);
  const fresh = Number(stats.transfer_count || 0) <= 1;
  return {
    address,
    label: known ? known.label : null,
    kind: known ? known.kind : (fresh ? "fresh" : "unknown"),
    fresh,
    behavior: stats.behavior || "unknown",
    score: stats.whale_score == null ? null : Number(stats.whale_score)
  };
}

module.exports = { lookupLabel, describeWallet };
