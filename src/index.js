require("dotenv").config();

const dns = require("node:dns");
const https = require("node:https");
const { Telegraf, Markup } = require("telegraf");

const { readState, writeState, resolveStatePath } = require("./stateStore");
const { getBalance, listCards, listTransactions } = require("./megaoneApi");
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

function telegramApiCall(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    const err = new Error("Missing TELEGRAM_BOT_TOKEN env var");
    err.code = "CONFIG";
    throw err;
  }

  const body = Buffer.from(JSON.stringify(payload || {}));
  const options = {
    method: "POST",
    hostname: "api.telegram.org",
    port: 443,
    path: `/bot${token}/${method}`,
    family: 4,
    headers: {
      "content-type": "application/json",
      "content-length": String(body.length)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          const e = new Error(`Telegram API non-JSON response (${res.statusCode}): ${raw.slice(0, 200)}`);
          e.code = "TELEGRAM_BAD_RESPONSE";
          e.status = res.statusCode;
          return reject(e);
        }

        if (!parsed?.ok) {
          const e = new Error(parsed?.description || `Telegram API error (${res.statusCode})`);
          e.code = "TELEGRAM_API";
          e.status = parsed?.error_code || res.statusCode;
          e.body = parsed;
          return reject(e);
        }

        resolve(parsed.result);
      });
    });

    req.on("error", reject);
    req.setTimeout(15_000, () => {
      const e = new Error("Telegram API request timeout");
      e.code = "ETIMEDOUT";
      req.destroy(e);
    });
    req.write(body);
    req.end();
  });
}

function sendHtml(_bot, chatId, html, extra = {}) {
  return telegramApiCall("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra
  });
}

function formatError(err) {
  const base = {
    name: err?.name,
    message: err?.message,
    code: err?.code,
    stack: err?.stack
  };
  const cause = err?.cause;
  if (cause && typeof cause === "object") {
    base.cause = {
      name: cause.name,
      message: cause.message,
      code: cause.code,
      errno: cause.errno,
      syscall: cause.syscall,
      address: cause.address,
      port: cause.port,
      stack: cause.stack
    };
  } else if (cause) {
    base.cause = String(cause);
  }

  try {
    return JSON.stringify(base);
  } catch {
    return String(err?.message || err);
  }
}

function configureDns() {
  const raw = (process.env.TELEGRAM_FORCE_IPV4 || "1").trim();
  if (raw === "0") return;
  try {
    dns.setDefaultResultOrder?.("ipv4first");
  } catch {}
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

function normalizeState(state) {
  const sentTransactionIds = Array.isArray(state.sentTransactionIds) ? state.sentTransactionIds : [];
  const transactionStatusById =
    state.transactionStatusById && typeof state.transactionStatusById === "object" && !Array.isArray(state.transactionStatusById)
      ? state.transactionStatusById
      : {};
  return { ...state, sentTransactionIds, transactionStatusById };
}

async function main() {
  configureDns();
  const token = getRequiredEnv("TELEGRAM_BOT_TOKEN");
  const bot = new Telegraf(token);

  let state = normalizeState(await readState());
  const envChatId = parseChatId(process.env.TELEGRAM_CHAT_ID?.trim());
  if (envChatId) {
    state.chatId = envChatId;
    await writeState(state);
  }

  const enablePolling = (() => {
    const raw = (process.env.TELEGRAM_ENABLE_POLLING || "").trim().toLowerCase();
    if (!raw) return true;
    if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
    if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
    return true;
  })();

  try {
    await telegramApiCall("setMyCommands", {
      commands: [
        { command: "status", description: "💼 Xem số dư" },
        { command: "cards", description: "💳 Xem danh sách thẻ" },
        { command: "transactions", description: "🧾 Xem 5 giao dịch gần nhất" },
        { command: "history", description: "📥 Xem lịch sử nạp tiền" },
        { command: "deposit_qr", description: "🔳 Hiện QR nạp tiền" },
        { command: "menu", description: "📋 Hiện menu" }
      ]
    });
  } catch (err) {
    console.error(`[telegram] setMyCommands failed: ${formatError(err)}`);
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
    const imageUrl = (process.env.DEPOSIT_QR_IMAGE_URL || "https://sf-static.upanhlaylink.com/img/image_20260325b1d37994c6ac8a3402c1c24233f1dfb7.jpg").trim();
    if (!imageUrl || !imageUrl.startsWith("http")) {
      await replyHtml(ctx, "⚠️ Thiếu DEPOSIT_QR_IMAGE_URL hoặc link không hợp lệ.", mainMenuMarkup());
      return;
    }

    const caption = "🔳 QR nạp tiền";
    await ctx.replyWithPhoto(imageUrl, { caption }).catch(async () => {
      await replyHtml(ctx, `🔳 QR nạp tiền\n${imageUrl}`, mainMenuMarkup());
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
        const isPollingConflict =
          String(err?.code || "") === "409" ||
          String(err?.message || "").toLowerCase().includes("terminated by other getupdates request") ||
          String(err?.message || "").toLowerCase().includes("409: conflict");
        if (isPollingConflict) {
          console.error(`[telegram] polling disabled due to conflict: ${formatError(err)}`);
          return false;
        }
        console.error(`[telegram] launch failed: ${formatError(err)}`);
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 60_000);
      }
    }
    return false;
  }

  if (enablePolling) {
    await launchWithRetry();
  }

  await pollOnce();
  const timer = setInterval(pollOnce, pollIntervalMs);
  timer.unref?.();
}

main().catch((err) => {
  console.error(formatError(err));
  process.exitCode = 1;
});
