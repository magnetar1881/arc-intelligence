const TelegramBot = require("node-telegram-bot-api");
const {
  getTopWhales,
  addSubscription,
  removeSubscription,
  removeAllSubscriptionsForChat,
  getSubscribersForToken,
  getSubscriptionsForChat,
  getWalletStats,
  getRecentWhalesForWallet,
  addWatch,
  removeWatch,
  getWatchlistForChat,
  getWatchers,
  getDigestByToken,
  getDigestByWallet,
  getDigestTotalCount,
  getStrategyWatchers,
  getRecentSignals
} = require("../database/db");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

bot.on("polling_error", (err) => {
  console.log("Telegram polling error:", err.message);
});

bot.on("message", (msg) => {
  console.log("MSG from chat:", msg.chat.id, msg.chat.type, msg.text);
});

// ========================
// ALARM GÖNDERME (artık tek CHAT_ID değil, abonelere göre)
// ========================
async function sendAlert(message, tokenAddress, wallets = []) {
  try {
    const subscriberIds = new Set();

    // .env'deki CHAT_ID varsa, her zaman alarm alan "sabit" alıcı olarak kalır
    if (process.env.CHAT_ID) {
      subscriberIds.add(String(process.env.CHAT_ID));
    }

    if (tokenAddress) {
      const subs = await getSubscribersForToken(tokenAddress);
      subs.forEach((id) => subscriberIds.add(id));

      // Token'ı watchlist'e ekleyen kullanıcıları da ekle
      const tokenWatchers = await getWatchers("token", tokenAddress);
      tokenWatchers.forEach((id) => subscriberIds.add(id));
    }

    // Watchlist'e eklenmiş wallet'ları takip eden kullanıcıları ekle
    for (const w of wallets) {
      if (!w) continue;

      const walletWatchers = await getWatchers("wallet", w);
      walletWatchers.forEach((id) => subscriberIds.add(id));
    }

    for (const chatId of subscriberIds) {
      try {
        await bot.sendMessage(chatId, message, {
          parse_mode: "HTML"
        });
      } catch (err) {
        console.log(
          `Telegram send error (chat ${chatId}):`,
          err.message
        );
      }
    }
  } catch (err) {
    console.log("sendAlert error:", err.message);
  }
}

function formatSignalCard(signal) {
  const ev = (signal.evidence || []).slice(0, 3);
  const evLines = ev
    .map((e) => {
      if (e.txHash) return `• <code>${e.txHash.slice(0, 10)}…</code> ${e.amount ? Number(e.amount).toLocaleString() : ""}`;
      if (e.token) return `• ${e.token} out:${e.outflow || 0} in:${e.inflow || 0}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");

  return `<b>SIGNAL · ${String(signal.type).toUpperCase()}</b>
Asset: <b>${signal.asset}</b>
Confidence: ${signal.confidence}
Amount: ${Number(signal.totalAmount || 0).toLocaleString()}
Wallets: ${signal.walletCount}

${signal.explanation || ""}
${evLines ? "\n" + evLines : ""}`;
}

async function notifyStrategyWatchers(signal) {
  try {
    const chatIds = new Set();

    if (process.env.CHAT_ID) chatIds.add(String(process.env.CHAT_ID));

    const keys = [signal.type];
    if (signal.type === "accumulation" || signal.type === "large_transfer") {
      keys.push("smart_cluster");
    }
    if (signal.type === "stable_rotation") keys.push("stable_rotation");
    if (signal.type === "fresh_receiver") keys.push("fresh_receiver");
    if (signal.type === "smart_cluster") keys.push("smart_cluster");

    for (const key of keys) {
      const ids = await getStrategyWatchers(key);
      ids.forEach((id) => chatIds.add(String(id)));
    }

    const text = formatSignalCard(signal);
    for (const chatId of chatIds) {
      try {
        await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
      } catch (err) {
        console.log(`strategy notify error (chat ${chatId}):`, err.message);
      }
    }
  } catch (err) {
    console.log("notifyStrategyWatchers error:", err.message);
  }
}

const STRATEGY_LABELS = {
  stable_rotation: "USDC ↔ EURC rotasyonu",
  smart_cluster: "Smart money kümesi",
  fresh_receiver: "Yeni alıcı + büyük transfer"
};

function strategyKeyboard() {
  return {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "USDC ↔ EURC rotasyonu", callback_data: "strat:stable_rotation" }],
        [{ text: "Smart money kümesi", callback_data: "strat:smart_cluster" }],
        [{ text: "Yeni alıcı (fresh receiver)", callback_data: "strat:fresh_receiver" }],
        [{ text: "Watchlistim", callback_data: "strat:list" }]
      ]
    }
  };
}

// ========================
// /subscribe  veya  /subscribe <token_adresi>
// ========================
bot.onText(/\/subscribe(?:\s+(\S+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match[1] || null;

  try {
    await addSubscription(chatId, token);
    if (token) {
      bot.sendMessage(chatId, `✅ Abone oldun: ${token}`);
    } else {
      bot.sendMessage(chatId, "✅ Tüm whale alarmlarına abone oldun.");
    }
  } catch (err) {
    console.log("subscribe error:", err.message);
    bot.sendMessage(chatId, "Abonelik sırasında bir hata oluştu.");
  }
});

// ========================
// /unsubscribe  veya  /unsubscribe <token_adresi>
// ========================
bot.onText(/\/unsubscribe(?:\s+(\S+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match[1] || null;

  try {
    if (token) {
      await removeSubscription(chatId, token);
      bot.sendMessage(chatId, `🚫 Abonelik kaldırıldı: ${token}`);
    } else {
      await removeAllSubscriptionsForChat(chatId);
      bot.sendMessage(chatId, "🚫 Tüm abonelikler kaldırıldı.");
    }
  } catch (err) {
    console.log("unsubscribe error:", err.message);
    bot.sendMessage(chatId, "Abonelik kaldırılırken bir hata oluştu.");
  }
});

// ========================
// /mysubs - bu chat'in mevcut abonelikleri
// ========================
bot.onText(/\/mysubs/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const subs = await getSubscriptionsForChat(chatId);

    if (!subs.length) {
      bot.sendMessage(chatId, "Henüz hiçbir aboneliğin yok. /subscribe yazarak başlayabilirsin.");
      return;
    }

    const lines = subs.map((t) => (t ? t : "Tüm tokenler (genel alarm)"));
    bot.sendMessage(chatId, `📋 Aboneliklerin:\n\n${lines.join("\n")}`);
  } catch (err) {
    console.log("mysubs error:", err.message);
    bot.sendMessage(chatId, "Abonelikler alınırken bir hata oluştu.");
  }
});

// ========================
// /top - en yüksek hacimli cüzdanlar
// ========================
bot.onText(/\/top/, async (msg) => {
  try {
    const data = await getTopWhales(10);

    let text = "🐋 <b>TOP WHALES</b>\n\n";

    if (!data.length) {
      text += "No data yet...";
    } else {
      data.forEach((w, i) => {
        text +=
`#${i + 1}
Wallet: <code>${w.wallet}</code>
Volume: <b>${Number(w.total_volume).toFixed(2)}</b>
Transfers: ${w.transfer_count}
Score: ${w.whale_score}

`;
      });
    }

    bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
  } catch (err) {
    console.log("top error:", err.message);
    bot.sendMessage(msg.chat.id, "Liderlik tablosu alınırken bir hata oluştu.");
  }
});

// ========================
// /wallet <address> - gerçek veriyle
// ========================
bot.onText(/\/wallet (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const wallet = match[1].trim();

  try {
    const stats = await getWalletStats(wallet);

    if (!stats) {
      bot.sendMessage(chatId, `🔍 ${wallet}\n\nBu cüzdan için henüz veri yok.`);
      return;
    }

    const recent = await getRecentWhalesForWallet(wallet, 5);

    let text = `🔍 <b>Wallet Tracker</b>

<code>${wallet}</code>

Total Volume: <b>${Number(stats.total_volume).toFixed(2)}</b>
Transfer Count: ${stats.transfer_count}
Whale Score: ${stats.whale_score}
Last Seen: ${stats.last_seen}
`;

    if (recent.length) {
      text += `\n<b>Son whale işlemleri:</b>\n`;
      recent.forEach((r) => {
        text += `\n${r.token} — ${Number(r.amount).toFixed(2)} (${r.timestamp})`;
      });
    }

    bot.sendMessage(chatId, text, { parse_mode: "HTML" });
  } catch (err) {
    console.log("wallet error:", err.message);
    bot.sendMessage(chatId, "Cüzdan bilgisi alınırken bir hata oluştu.");
  }
});

// ========================
// /digest [saat] - varsayılan son 24 saat özeti
// ========================
bot.onText(/\/digest(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const hours = match[1] ? Number(match[1]) : 24;

  try {
    const totalCount = await getDigestTotalCount(hours);
    const byToken = await getDigestByToken(hours, 5);
    const byWallet = await getDigestByWallet(hours, 5);

    let text = `📊 <b>${hours} Saatlik Özet</b>\n\nToplam whale işlemi: ${totalCount}\n`;

    if (byToken.length) {
      text += `\n<b>En aktif tokenler:</b>\n`;
      byToken.forEach((t, i) => {
        text += `${i + 1}. ${t.token} — ${Number(t.volume).toFixed(2)} (${t.count} işlem)\n`;
      });
    }

    if (byWallet.length) {
      text += `\n<b>En aktif cüzdanlar:</b>\n`;
      byWallet.forEach((w, i) => {
        text += `${i + 1}. <code>${w.wallet}</code> — ${Number(w.volume).toFixed(2)} (${w.count} işlem)\n`;
      });
    }

    if (!totalCount) {
      text += `\nBu zaman aralığında kayıtlı whale işlemi yok.`;
    }

    bot.sendMessage(chatId, text, { parse_mode: "HTML" });
  } catch (err) {
    console.log("digest error:", err.message);
    bot.sendMessage(chatId, "Özet alınırken bir hata oluştu.");
  }
});

bot.onText(/\/watch\s+(wallet|token)\s+(\S+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const kind = match[1].toLowerCase();
  const value = match[2];

  try {
    await addWatch(chatId, kind, value);
    bot.sendMessage(chatId, `✅ Watchlist: ${kind} → <code>${value}</code>`, { parse_mode: "HTML" });
  } catch (err) {
    console.log("watch error:", err.message);
    bot.sendMessage(chatId, "Watchlist eklenirken hata oluştu.");
  }
});

bot.onText(/\/unwatch\s+(wallet|token)\s+(\S+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const kind = match[1].toLowerCase();
  const value = match[2];

  try {
    await removeWatch(chatId, kind, value);
    bot.sendMessage(chatId, `🚫 Kaldırıldı: ${kind} → <code>${value}</code>`, { parse_mode: "HTML" });
  } catch (err) {
    console.log("unwatch error:", err.message);
    bot.sendMessage(chatId, "Watchlist silinirken hata oluştu.");
  }
});

bot.onText(/\/watchlist/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const rows = await getWatchlistForChat(chatId);
    if (!rows.length) {
      bot.sendMessage(chatId, "Watchlist boş. /watch wallet <adres> veya /watch token USDC");
      return;
    }
    const lines = rows.map((r) => `• ${r.kind}: <code>${r.value}</code>`);
    bot.sendMessage(chatId, `👀 Watchlist:\n\n${lines.join("\n")}`, { parse_mode: "HTML" });
  } catch (err) {
    console.log("watchlist error:", err.message);
    bot.sendMessage(chatId, "Watchlist alınamadı.");
  }
});

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(
    chatId,
    `<b>Lensora</b>

Arc üstündeki büyük stablecoin hareketlerini izler.
Adres yazmana gerek yok — bir strateji seç.

Mevcut whale alarmları için /subscribe
Son sinyaller: /signals`,
    strategyKeyboard()
  );
});

bot.onText(/\/signals/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const rows = await getRecentSignals(5);
    if (!rows.length) {
      bot.sendMessage(chatId, "Henüz sinyal yok. Eşik yüksekse (WHALE_THRESHOLD) beklenen bu.");
      return;
    }
    for (const s of rows) {
      await bot.sendMessage(chatId, formatSignalCard(s), { parse_mode: "HTML" });
    }
  } catch (err) {
    console.log("signals cmd error:", err.message);
    bot.sendMessage(chatId, "Sinyaller alınamadı.");
  }
});

bot.onText(/\/strategy(?:\s+(\S+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const key = (match[1] || "").toLowerCase();
  const allowed = ["stable_rotation", "smart_cluster", "fresh_receiver"];

  if (!allowed.includes(key)) {
    bot.sendMessage(
      chatId,
      `Kullanım:
/strategy stable_rotation
/strategy smart_cluster
/strategy fresh_receiver
/unstrategy <aynı_ad>`,
      strategyKeyboard()
    );
    return;
  }

  try {
    await addWatch(chatId, "strategy", key);
    bot.sendMessage(chatId, `Strateji açıldı: <b>${STRATEGY_LABELS[key]}</b>`, {
      parse_mode: "HTML"
    });
  } catch (err) {
    console.log("strategy error:", err.message);
    bot.sendMessage(chatId, "Strateji eklenemedi.");
  }
});

bot.onText(/\/unstrategy(?:\s+(\S+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const key = (match[1] || "").toLowerCase();
  try {
    await removeWatch(chatId, "strategy", key);
    bot.sendMessage(chatId, `Strateji kapatıldı: ${key}`);
  } catch (err) {
    console.log("unstrategy error:", err.message);
    bot.sendMessage(chatId, "Strateji silinemedi.");
  }
});

bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data || "";
  try {
    if (data === "strat:list") {
      const rows = await getWatchlistForChat(chatId);
      const lines = rows.length
        ? rows.map((r) => `• ${r.kind}: <code>${r.value}</code>`).join("\n")
        : "Liste boş.";
      await bot.sendMessage(chatId, `Watchlist:\n\n${lines}`, { parse_mode: "HTML" });
    } else if (data.startsWith("strat:")) {
      const key = data.slice(6);
      await addWatch(chatId, "strategy", key);
      await bot.sendMessage(
        chatId,
        `Strateji açıldı: <b>${STRATEGY_LABELS[key] || key}</b>\nKapatmak: /unstrategy ${key}`,
        { parse_mode: "HTML" }
      );
    }
    await bot.answerCallbackQuery(q.id);
  } catch (err) {
    console.log("callback error:", err.message);
    try { await bot.answerCallbackQuery(q.id, { text: "Hata" }); } catch (_) {}
  }
});

// ========================
// /help
// ========================
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Kullanılabilir komutlar:

/subscribe - tüm whale alarmlarına abone ol
/subscribe <token_adresi> - sadece belirli bir tokene abone ol
/unsubscribe - tüm aboneliklerini kaldır
/unsubscribe <token_adresi> - belirli bir aboneliği kaldır
/mysubs - mevcut aboneliklerini listele

/top - en yüksek hacimli whale cüzdanları
/wallet <adres> - belirli bir cüzdanı sorgula
/watch wallet <adres>
/watch token <adres_veya_sembol>
/unwatch wallet <adres>
/unwatch token <adres_veya_sembol>
/watchlist - takip listen
/start - strateji seç
/strategy stable_rotation|smart_cluster|fresh_receiver
/unstrategy <ad>
/signals - son sinyaller
/digest [saat] - son N saatlik özet (varsayılan 24)
/help - bu mesajı göster`
  );
});

module.exports = { sendAlert, notifyStrategyWatchers, formatSignalCard };
