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
  getDigestByToken,
  getDigestByWallet,
  getDigestTotalCount
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
async function sendAlert(message, tokenAddress) {
  try {
    const subscriberIds = new Set();

    // .env'deki CHAT_ID varsa, her zaman alarm alan "sabit" alıcı olarak kalır
    if (process.env.CHAT_ID) {
      subscriberIds.add(String(process.env.CHAT_ID));
    }

    if (tokenAddress) {
      const subs = await getSubscribersForToken(tokenAddress);
      subs.forEach((id) => subscriberIds.add(id));
    }

    for (const chatId of subscriberIds) {
      try {
        await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
      } catch (err) {
        console.log(`Telegram send error (chat ${chatId}):`, err.message);
      }
    }
  } catch (err) {
    console.log("sendAlert error:", err.message);
  }
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
/digest [saat] - son N saatlik özet (varsayılan 24)
/help - bu mesajı göster`
  );
});

module.exports = { sendAlert };
