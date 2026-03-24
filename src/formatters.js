function formatMoney(amount, currency) {
  if (amount === undefined || amount === null) return "N/A";
  const num = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(num)) return "N/A";
  if (!currency) return `${num}`;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(num);
  } catch {
    return `${num} ${currency}`;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusIcon(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("pending")) return "⏳";
  if (s.includes("settled")) return "✅";
  if (s.includes("declined")) return "❌";
  if (s.includes("failed")) return "⚠️";
  return "ℹ️";
}

function amountIcon(amount) {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return "💳";
  if (n < 0) return "💸";
  if (n > 0) return "💰";
  return "💳";
}

function isPendingStatus(status) {
  return String(status || "").toLowerCase().includes("pending");
}

function pickTransactionTime(tx) {
  return tx?.createdAt || tx?.transactionAt || tx?.authorizedAt || null;
}

function formatTransactionLine(tx, { currency } = {}) {
  const amount = tx?.amount ?? (typeof tx?.amountCents === "number" ? tx.amountCents / 100 : undefined);
  const txCurrency = tx?.currency || currency;
  const status = tx?.detailedStatus || tx?.status || "unknown";
  const merchant = tx?.merchant || "Unknown merchant";
  const cardName = tx?.cardNickname || "Card";
  const cardLast4 = tx?.cardLast4 ? `•••• ${tx.cardLast4}` : "";
  const when = pickTransactionTime(tx);
  const whenText = when ? new Date(when).toISOString().replace("T", " ").replace("Z", " UTC") : "unknown time";

  const left = `🗓️ ${whenText} | 💳 ${cardName}${cardLast4 ? ` ${cardLast4}` : ""}`;
  const rightParts = [`${amountIcon(amount)} ${formatMoney(amount, txCurrency)}`, `🏪 ${merchant}`];
  if (isPendingStatus(status)) rightParts.push(`${statusIcon(status)} ${status}`);
  const right = rightParts.join(" | ");
  return escapeHtml(`${left} | ${right}`);
}

function formatTransaction(tx, { balance, currency } = {}) {
  const amount = tx?.amount ?? (typeof tx?.amountCents === "number" ? tx.amountCents / 100 : undefined);
  const txCurrency = tx?.currency || currency;
  const status = tx?.detailedStatus || tx?.status || "unknown";
  const merchant = tx?.merchant || "Unknown merchant";
  const description = tx?.description || tx?.merchantDescription || "";
  const cardName = tx?.cardNickname || "Card";
  const cardLast4 = tx?.cardLast4 ? `•••• ${tx.cardLast4}` : "";
  const when = pickTransactionTime(tx);
  const whenText = when ? new Date(when).toISOString().replace("T", " ").replace("Z", " UTC") : "unknown time";

  const pending = isPendingStatus(status);
  const lines = [
    `<b>🧾 Giao dịch mới</b> ${amountIcon(amount)} <code>${escapeHtml(formatMoney(amount, txCurrency))}</code>${pending ? ` <i>(${statusIcon(status)} ${escapeHtml(status)})</i>` : ""}`,
    `<b>💳 Thẻ:</b> ${escapeHtml(cardName)}${cardLast4 ? ` ${escapeHtml(cardLast4)}` : ""}`,
    `<b>🏪 Merchant:</b> ${escapeHtml(merchant)}`,
    description ? `<b>📝 Mô tả:</b> ${escapeHtml(description)}` : null,
    `<b>🗓️ Thời gian:</b> ${escapeHtml(whenText)}`,
    balance !== undefined && balance !== null ? `<b>💼 Số dư:</b> <code>${escapeHtml(formatMoney(balance, currency || txCurrency))}</code>` : null
  ].filter(Boolean);

  return lines.join("\n");
}

function formatBalance(balanceResp) {
  if (!balanceResp || typeof balanceResp !== "object") return "Không lấy được số dư.";
  const balance = balanceResp.balance;
  const currency = balanceResp.currency;
  const accountName = balanceResp.accountName;
  const updatedAt = balanceResp.lastUpdatedAt;
  const updatedText = updatedAt ? new Date(updatedAt).toISOString().replace("T", " ").replace("Z", " UTC") : "";
  return [
    "<b>💼 Số dư tài khoản</b>",
    accountName ? `<b>🏷️ Tài khoản:</b> ${escapeHtml(accountName)}` : null,
    `<b>💰 Số dư:</b> <code>${escapeHtml(formatMoney(balance, currency))}</code>`,
    updatedText ? `<b>🕒 Cập nhật:</b> ${escapeHtml(updatedText)}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function formatCards(cardsResp) {
  const cards = cardsResp?.data;
  if (!Array.isArray(cards) || cards.length === 0) return "Không có thẻ.";
  const lines = [];
  for (const c of cards) {
    const name = c.nickname || "Card";
    const last4 = c.last4 ? `•••• ${c.last4}` : "";
    const status = c.status || "unknown";
    const groupName = c.cardGroup?.name ? ` (${c.cardGroup.name})` : "";
    const availableCents = c.availableBalanceCents ?? c.utilization?.availableBalanceCents;
    const spentCents = c.spentAmountCents ?? c.utilization?.spentAmountCents;
    const available = typeof availableCents === "number" ? availableCents / 100 : null;
    const spent = typeof spentCents === "number" ? spentCents / 100 : null;
    const title = `${name}${last4 ? ` ${last4}` : ""}${groupName}`;
    const parts = [`💳 <b>${escapeHtml(title)}</b> <i>(${statusIcon(status)} ${escapeHtml(status)})</i>`];
    if (available !== null) parts.push(`<b>✅ Còn:</b> <code>${escapeHtml(available)}</code>`);
    if (spent !== null) parts.push(`<b>📤 Đã chi:</b> <code>${escapeHtml(spent)}</code>`);
    lines.push(parts.join(" | "));
  }
  return ["<b>💳 Danh sách thẻ</b>", "", ...lines].join("\n");
}

module.exports = {
  formatTransaction,
  formatTransactionLine,
  formatBalance,
  formatCards,
  pickTransactionTime
};
