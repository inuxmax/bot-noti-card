require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const QRCode = require("qrcode");

const { readState, writeState, resolveStatePath } = require("./stateStore");
const { getBalance, listCards, listTransactions, listCryptoDeposits } = require("./megaoneApi");
const { formatBalance, formatCards, formatTransaction, formatTransactionLine, pickTransactionTime } = require("./formatters");
const { startWebhookServer } = require("./webhookServer");

const MENU = {
  status: "💼 Số dư",
  cards: "💳 Thẻ",
  transactions: "🧾 Giao dịch",
  history: "📥 Lịch sử nạp",
  depositQr: "🔳 QR nạp tiền",
  menu: "📋 Menu"
};

function getRequiredEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    const err = new Error(`Missing ${name} env var`);
    err.code = "CONFIG";
    throw err;
  }
  return v;
}

function parseChatId(raw) {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

function parseIntervalMs() {
  const raw = process.env.POLL_INTERVAL_SECONDS?.trim();
  const n = raw ? Number(raw) : 30;
  if (!Number.isFinite(n) || n <= 5) return 30_000;
  return Math.floor(n * 1000);
}

function toEpochMs(isoString) {
  if (!isoString) return null;
  const t = Date.parse(isoString);
  return Number.isFinite(t) ? t : null;
}

function replyHtml(ctx, html, extra = {}) {
  return ctx.reply(html, { parse_mode: "HTML", disable_web_page_preview: true, ...extra });
}

function sendHtml(bot, chatId, html, extra = {}) {
  return bot.telegram.sendMessage(chatId, html, { parse_mode: "HTML", disable_web_page_preview: true, ...extra });
}

function getTransactionId(tx) {
  if (!tx || typeof tx !== "object") return null;
  if (typeof tx.id === "string" && tx.id) return tx.id;
  if (typeof tx.bankTransactionId === "string" && tx.bankTransactionId) return tx.bankTransactionId;
  return null;
}

function getTransactionStatus(tx) {
  if (!tx || typeof tx !== "object") return null;
  return tx.detailedStatus || tx.status || null;
}

function isPendingStatus(status) {
  return String(status || "").toLowerCase().includes("pending");
}

function getTransactionSearchText(tx) {
  const parts = [
    tx?.merchant,
    tx?.merchantDescription,
    tx?.description,
    tx?.memo,
    tx?.cardNickname,
    tx?.cardLast4
  ].filter(Boolean);
  return parts.join(" ").toLowerCase();
}

function parseKeywordsCsv(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function isTopupTransaction(tx, keywords) {
  const text = getTransactionSearchText(tx);
  if (!text) return false;
  for (const kw of keywords) {
    if (text.includes(kw)) return true;
  }
  return false;
}

function pickFirstArray(value) {
  if (Array.isArray(value)) return value;
  return null;
}

function pickDepositsArray(resp) {
  if (!resp || typeof resp !== "object") return [];
  return (
    pickFirstArray(resp.data) ||
    pickFirstArray(resp.items) ||
    pickFirstArray(resp.deposits) ||
    pickFirstArray(resp.result) ||
    []
  );
}

function pickQrImageUrl(obj) {
  const candidates = [
    obj?.qrUrl,
    obj?.qrURL,
    obj?.qrCodeUrl,
    obj?.qrCodeURL,
    obj?.qr_image_url,
    obj?.qrImageUrl,
    obj?.qrImage
  ].filter((x) => typeof x === "string" && x.startsWith("http"));
  return candidates[0] || null;
}

function pickQrPayload(obj) {
  const candidates = [
    obj?.qr,
    obj?.qrCode,
    obj?.qrPayload,
    obj?.qrData,
    obj?.address,
    obj?.depositAddress,
    obj?.walletAddress,
    obj?.toAddress,
    obj?.paymentAddress,
    obj?.paymentUri,
    obj?.paymentURI,
    obj?.uri
  ].filter((x) => typeof x === "string" && x.trim().length > 0);
  return candidates[0] || null;
}

function pickDepositMeta(obj) {
  if (!obj || typeof obj !== "object") return {};
  return {
    currency: obj.currency || obj.coin || obj.asset || obj.symbol || "",
    network: obj.network || obj.chain || obj.blockchain || "",
    amount: obj.amount || obj.amountValue || obj.value || "",
    status: obj.status || "",
    createdAt: obj.createdAt || obj.created_at || obj.time || obj.timestamp || ""
  };
}

function normalizeState(state) {
  const sentTransactionIds = Array.isArray(state.sentTransactionIds) ? state.sentTransactionIds : [];
  const transactionStatusById =
    state.transactionStatusById && typeof state.transactionStatusById === "object" && !Array.isArray(state.transactionStatusById)
      ? state.transactionStatusById
      : {};
  return { ...state, sentTransactionIds, transactionStatusById };
}

async function main() {
  const token = getRequiredEnv("TELEGRAM_BOT_TOKEN");
  const bot = new Telegraf(token);

  let state = normalizeState(await readState());
  const envChatId = parseChatId(process.env.TELEGRAM_CHAT_ID?.trim());
  if (envChatId) {
    state.chatId = envChatId;
    await writeState(state);
  }

  try {
    await bot.telegram.setMyCommands([
      { command: "status", description: "💼 Xem số dư" },
      { command: "cards", description: "💳 Xem danh sách thẻ" },
      { command: "transactions", description: "🧾 Xem 5 giao dịch gần nhất" },
      { command: "history", description: "📥 Xem lịch sử nạp tiền" },
      { command: "deposit_qr", description: "🔳 Hiện QR nạp tiền" },
      { command: "menu", description: "📋 Hiện menu" }
    ]);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`[telegram] setMyCommands failed: ${msg}`);
  }

  async function ensureChat(ctx) {
    if (ctx?.chat?.id) {
      const chatId = ctx.chat.id;
      if (state.chatId !== chatId) {
        state = normalizeState({ ...state, chatId });
        await writeState(state);
      }
      return chatId;
    }
    return state.chatId;
  }

  function hasSentTransactionId(txId) {
    if (!txId) return false;
    return state.sentTransactionIds.includes(txId);
  }

  async function markTransactionSeen({ txId, txStatus, lastTransactionIso }) {
    if (!txId) return;
    const nextSent = [txId, ...state.sentTransactionIds.filter((x) => x !== txId)].slice(0, 200);
    const nextStatusById = { ...state.transactionStatusById };
    if (txStatus) nextStatusById[txId] = txStatus;
    const next = normalizeState({
      ...state,
      sentTransactionIds: nextSent,
      transactionStatusById: nextStatusById,
      lastTransactionCreatedAt: lastTransactionIso ?? state.lastTransactionCreatedAt
    });
    state = next;
    await writeState(state);
  }

  async function sendTransactionNotification(tx, { sourceEventType } = {}) {
    if (!state.chatId) return;
    const txId = getTransactionId(tx);
    const txStatus = getTransactionStatus(tx);
    const txTime = pickTransactionTime(tx);
    if (!isPendingStatus(txStatus)) return;

    if (txId && sourceEventType === "transaction.updated") {
      const prev = state.transactionStatusById?.[txId] || null;
      if (prev && txStatus && prev === txStatus) return;
    } else if (txId && hasSentTransactionId(txId)) {
      return;
    }

    const balance = await getBalance().catch(() => null);
    const msg = formatTransaction(tx, { balance: balance?.balance, currency: balance?.currency });
    await sendHtml(bot, state.chatId, msg);

    await markTransactionSeen({
      txId: txId || `no-id:${Date.now()}`,
      txStatus,
      lastTransactionIso: txTime ? new Date(txTime).toISOString() : undefined
    });
  }

  function mainMenuMarkup() {
    return Markup.keyboard([[MENU.status, MENU.cards], [MENU.transactions, MENU.history], [MENU.depositQr, MENU.menu]]).resize();
  }

  async function sendMenu(ctx) {
    await ensureChat(ctx);
    await replyHtml(ctx, "<b>📋 Chọn chức năng:</b>", mainMenuMarkup());
  }

  async function runStatus(ctx) {
    await ensureChat(ctx);
    const balance = await getBalance();
    await replyHtml(ctx, formatBalance(balance), mainMenuMarkup());
  }

  async function runCards(ctx) {
    await ensureChat(ctx);
    const cards = await listCards({ status: process.env.CARDS_STATUS || "active" });
    await replyHtml(ctx, formatCards(cards), mainMenuMarkup());
  }

  async function runTransactions(ctx) {
    await ensureChat(ctx);
    const txResp = await listTransactions({ limit: 5, status: "all" });
    const rows = Array.isArray(txResp?.data) ? txResp.data : [];
    if (rows.length === 0) {
      await replyHtml(ctx, "Không có giao dịch.", mainMenuMarkup());
      return;
    }
    const balance = await getBalance().catch(() => null);
    const bal = balance?.balance;
    const cur = balance?.currency;
    const text = rows
      .slice()
      .sort((a, b) => (toEpochMs(pickTransactionTime(b)) || 0) - (toEpochMs(pickTransactionTime(a)) || 0))
      .map((tx) => formatTransaction(tx, { balance: bal, currency: cur }))
      .join("\n\n────────────\n\n");
    await replyHtml(ctx, text, mainMenuMarkup());
  }

  async function runDepositQr(ctx) {
    await ensureChat(ctx);
    const timezone = (process.env.CUSTOMER_TIMEZONE || "Asia/Saigon").trim();
    const limit = 10;
    const page = 1;

    let resp;
    try {
      resp = await listCryptoDeposits({ page, limit, timezone });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      await replyHtml(ctx, `⚠️ Không gọi được API nạp tiền: ${msg}`, mainMenuMarkup());
      return;
    }

    const deposits = pickDepositsArray(resp);
    if (!Array.isArray(deposits) || deposits.length === 0) {
      await replyHtml(ctx, "ℹ️ Không có lịch sử nạp tiền.", mainMenuMarkup());
      return;
    }

    const first = deposits[0];
    const qrUrl = pickQrImageUrl(first);
    const qrPayload = pickQrPayload(first);
    const meta = pickDepositMeta(first);

    const captionParts = [
      "🔳 QR nạp tiền",
      meta.currency ? `🪙 Coin: ${meta.currency}` : null,
      meta.network ? `🌐 Network: ${meta.network}` : null,
      meta.amount ? `💰 Amount: ${meta.amount}` : null,
      meta.status ? `📌 Status: ${meta.status}` : null,
      meta.createdAt ? `🕒 Time: ${meta.createdAt}` : null,
      qrPayload && !qrUrl ? `Data: ${qrPayload}` : null
    ].filter(Boolean);
    const caption = captionParts.join("\n");

    if (qrUrl) {
      await ctx.replyWithPhoto(qrUrl, { caption }).catch(async () => {
        await ctx.reply(caption, mainMenuMarkup());
      });
      return;
    }

    if (!qrPayload) {
      await replyHtml(ctx, "⚠️ Không tìm thấy QR/address trong dữ liệu nạp tiền trả về.", mainMenuMarkup());
      return;
    }

    const png = await QRCode.toBuffer(qrPayload, { type: "png", errorCorrectionLevel: "M", margin: 1, scale: 6 });
    await ctx.replyWithPhoto({ source: png }, { caption }).catch(async () => {
      await ctx.reply(caption, mainMenuMarkup());
    });
  }

  const topupKeywords = (() => {
    const raw = process.env.TOPUP_KEYWORDS?.trim();
    const parsed = parseKeywordsCsv(raw);
    if (parsed.length > 0) return parsed;
    return ["top up", "topup", "deposit", "funding", "add funds", "recharge", "nạp", "nap"];
  })();

  function historyInlineMarkup({ page, totalPages, limit }) {
    const buttons = [];
    if (page > 1) buttons.push(Markup.button.callback("⬅️ Trước", `tophist:${page - 1}:${limit}`));
    if (page < totalPages) buttons.push(Markup.button.callback("➡️ Sau", `tophist:${page + 1}:${limit}`));
    if (buttons.length === 0) return undefined;
    return Markup.inlineKeyboard(buttons);
  }

  async function renderHistory(ctx, { page = 1, limit = 20, editMessage = false } = {}) {
    await ensureChat(ctx);
    const desired = limit;
    const maxPagesToScan = 5;
    let currentPage = page;
    let totalPages = page;
    const collected = [];

    for (let i = 0; i < maxPagesToScan && collected.length < desired; i += 1) {
      const txResp = await listTransactions({ page: currentPage, limit, status: "all" });
      const rows = Array.isArray(txResp?.data) ? txResp.data : [];
      const pagination = txResp?.pagination || {};
      totalPages = typeof pagination.totalPages === "number" ? pagination.totalPages : totalPages;

      for (const tx of rows) {
        if (isTopupTransaction(tx, topupKeywords)) collected.push(tx);
        if (collected.length >= desired) break;
      }

      if (currentPage >= totalPages) break;
      currentPage += 1;
    }

    if (collected.length === 0) {
      const text = "Không có giao dịch.";
      if (editMessage) {
        await ctx.editMessageText(text).catch(() => {});
      } else {
        await replyHtml(ctx, text, mainMenuMarkup());
      }
      return;
    }

    const header = `<b>📥 Lịch sử nạp tiền</b> <i>(Trang ${page}/${totalPages || page})</i>`;
    const startIndex = (page - 1) * limit;
    const body = collected.map((tx, i) => `${startIndex + i + 1}. ${formatTransactionLine(tx)}`).join("\n");
    const text = `${header}\n\n${body}`;
    const inline = historyInlineMarkup({ page, totalPages: totalPages || page, limit });

    if (editMessage) {
      await ctx
        .editMessageText(text, { parse_mode: "HTML", disable_web_page_preview: true, ...(inline ? inline : {}) })
        .catch(() => {});
    } else {
      await replyHtml(ctx, text, inline ? inline : undefined);
    }
  }

  const webhookEnabled = (process.env.WEBHOOK_ENABLED || "1").trim() !== "0";
  const webhookPath = process.env.WEBHOOK_PATH?.trim() || "/webhook/megaone";
  const webhookPortRaw = process.env.WEBHOOK_PORT?.trim();
  const webhookPort = webhookPortRaw ? Number(webhookPortRaw) : 3000;
  const webhookSecret = process.env.WEBHOOK_SECRET?.trim() || "";

  const webhookServer = webhookEnabled
    ? startWebhookServer({
        port: webhookPort,
        path: webhookPath,
        secret: webhookSecret,
        onEvent: async (payload) => {
          const eventType = payload?.type || payload?.eventType || payload?.event || payload?.name || null;
          const normalizedType = typeof eventType === "string" ? eventType : null;
          if (!normalizedType) return;

          if (normalizedType === "transaction.created" || normalizedType === "transaction.updated") {
            const tx = payload?.data?.transaction || payload?.transaction || payload?.data;
            if (tx && typeof tx === "object") {
              await sendTransactionNotification(tx, { sourceEventType: normalizedType });
            }
          }
        }
      })
    : null;

  bot.start(async (ctx) => {
    await ensureChat(ctx);
    const balance = await getBalance().catch(() => null);
    const lines = [
      "<b>Đã kết nối bot.</b>",
      `<b>State file:</b> <code>${resolveStatePath()}</code>`,
      webhookEnabled ? `Webhook: http://localhost:${webhookPort}${webhookPath}` : "Webhook: disabled",
      "",
      "<b>Lệnh:</b>",
      "<code>/status</code> - xem số dư",
      "<code>/cards</code> - xem danh sách thẻ",
      "<code>/transactions</code> - xem 5 giao dịch gần nhất",
      "<code>/history</code> - xem lịch sử nạp tiền",
      "<code>/deposit_qr</code> - hiện QR nạp tiền",
      "<code>/menu</code> - hiện menu",
      "",
      balance ? formatBalance(balance) : "Chưa lấy được số dư (kiểm tra API_KEY)."
    ];
    await replyHtml(ctx, lines.join("\n"), mainMenuMarkup());
  });

  bot.command("help", async (ctx) => {
    await sendMenu(ctx);
  });

  bot.command("status", async (ctx) => {
    await runStatus(ctx);
  });

  bot.command("cards", async (ctx) => {
    await runCards(ctx);
  });

  bot.command("transactions", async (ctx) => {
    await runTransactions(ctx);
  });

  bot.command("history", async (ctx) => {
    await renderHistory(ctx, { page: 1, limit: 20 });
  });

  bot.command("deposit_qr", async (ctx) => {
    await runDepositQr(ctx);
  });

  bot.command("menu", async (ctx) => {
    await sendMenu(ctx);
  });

  bot.hears(MENU.status, async (ctx) => {
    await runStatus(ctx);
  });

  bot.hears(MENU.cards, async (ctx) => {
    await runCards(ctx);
  });

  bot.hears(MENU.transactions, async (ctx) => {
    await runTransactions(ctx);
  });

  bot.hears(MENU.history, async (ctx) => {
    await renderHistory(ctx, { page: 1, limit: 20 });
  });

  bot.hears(MENU.depositQr, async (ctx) => {
    await runDepositQr(ctx);
  });

  bot.hears(MENU.menu, async (ctx) => {
    await sendMenu(ctx);
  });

  bot.action(/^tophist:(\d+):(\d+)$/, async (ctx) => {
    const page = Number(ctx.match[1]);
    const limit = Number(ctx.match[2]);
    await ctx.answerCbQuery().catch(() => {});
    if (!Number.isFinite(page) || page < 1) return;
    if (!Number.isFinite(limit) || limit < 1 || limit > 100) return;
    await renderHistory(ctx, { page, limit, editMessage: true });
  });

  bot.action(/^txhist:(\d+):(\d+)$/, async (ctx) => {
    const page = Number(ctx.match[1]);
    const limit = Number(ctx.match[2]);
    await ctx.answerCbQuery().catch(() => {});
    if (!Number.isFinite(page) || page < 1) return;
    if (!Number.isFinite(limit) || limit < 1 || limit > 100) return;
    await renderHistory(ctx, { page, limit, editMessage: true });
  });

  const pollIntervalMs = parseIntervalMs();
  let pollInFlight = false;

  async function pollOnce() {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      if (!state.chatId) return;

      const [balance, txResp] = await Promise.all([getBalance(), listTransactions({ limit: 20, status: "all" })]);
      const bal = balance?.balance;
      const cur = balance?.currency;

      const rows = Array.isArray(txResp?.data) ? txResp.data : [];
      const lastSentMs = toEpochMs(state.lastTransactionCreatedAt);

      const candidates = rows
        .map((tx) => ({ tx, t: toEpochMs(pickTransactionTime(tx)), id: getTransactionId(tx) }))
        .filter((x) => x.t !== null)
        .sort((a, b) => a.t - b.t);

      const newOnes =
        lastSentMs === null ? [] : candidates.filter((x) => x.t > lastSentMs && (!x.id || !hasSentTransactionId(x.id)));

      let maxSeen = lastSentMs;
      for (const { tx, t, id } of newOnes) {
        const msg = formatTransaction(tx, { balance: bal, currency: cur });
        maxSeen = maxSeen === null ? t : Math.max(maxSeen, t);
        const txStatus = getTransactionStatus(tx);
        if (!isPendingStatus(txStatus)) continue;
        await sendHtml(bot, state.chatId, msg);
        await markTransactionSeen({ txId: id || `no-id:${t}`, txStatus, lastTransactionIso: new Date(t).toISOString() });
      }

      if (maxSeen !== null && (lastSentMs === null || maxSeen > lastSentMs)) {
        state = normalizeState({ ...state, lastTransactionCreatedAt: new Date(maxSeen).toISOString() });
        await writeState(state);
      }

      if (lastSentMs === null && candidates.length > 0) {
        const latest = candidates[candidates.length - 1].t;
        const baselineIds = candidates
          .slice(-200)
          .map((x) => x.id)
          .filter(Boolean);
        state = normalizeState({
          ...state,
          lastTransactionCreatedAt: new Date(latest).toISOString(),
          sentTransactionIds: [...baselineIds, ...state.sentTransactionIds].slice(0, 200)
        });
        await writeState(state);
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error(`[poll] ${msg}`);
    } finally {
      pollInFlight = false;
    }
  }

  let stopping = false;
  const stopAll = (signal) => {
    stopping = true;
    try {
      bot.stop(signal);
    } catch {}
    try {
      webhookServer?.close();
    } catch {}
  };

  process.once("SIGINT", () => stopAll("SIGINT"));
  process.once("SIGTERM", () => stopAll("SIGTERM"));

  async function sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
  }

  async function launchWithRetry() {
    let delayMs = 2_000;
    while (!stopping) {
      try {
        await bot.launch();
        return true;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        const causeMsg = err && err.cause && err.cause.message ? err.cause.message : err && err.cause ? String(err.cause) : "";
        console.error(`[telegram] launch failed: ${msg}${causeMsg ? ` | cause: ${causeMsg}` : ""}`);
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 60_000);
      }
    }
    return false;
  }

  const launched = await launchWithRetry();
  if (!launched) return;

  await pollOnce();
  const timer = setInterval(pollOnce, pollIntervalMs);
  timer.unref?.();
}

main().catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  console.error(msg);
  process.exitCode = 1;
});
