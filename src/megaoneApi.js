const { fetch } = require("undici");

function getConfig() {
  const baseUrl = (process.env.API_BASE_URL || "https://api.megaone.us/public/api/v1").replace(/\/+$/, "");
  const apiKey = process.env.API_KEY?.trim();
  if (!apiKey) {
    const err = new Error("Missing API_KEY env var (example: mk_xxx)");
    err.code = "CONFIG";
    throw err;
  }
  return { baseUrl, apiKey };
}

function getCustomerConfig() {
  const baseUrl = (process.env.CUSTOMER_API_BASE_URL || "https://api.megaone.us").replace(/\/+$/, "");
  const token = (process.env.CUSTOMER_BEARER_TOKEN || process.env.CUSTOMER_AUTH_TOKEN || "").trim();
  if (!token) {
    const err = new Error("Missing CUSTOMER_BEARER_TOKEN env var");
    err.code = "CONFIG";
    throw err;
  }
  return { baseUrl, token };
}

async function requestJson(path, { method = "GET", query } = {}) {
  const { baseUrl, apiKey } = getConfig();
  const url = new URL(`${baseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json"
    }
  });

  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const body = isJson ? await res.json().catch(() => null) : await res.text().catch(() => "");

  if (!res.ok) {
    const messageFromBody =
      typeof body === "string"
        ? body
        : body && typeof body === "object"
          ? body.message || body.error || JSON.stringify(body)
          : "";
    const err = new Error(`MegaOne API error ${res.status} ${res.statusText}${messageFromBody ? `: ${messageFromBody}` : ""}`);
    err.code = "API";
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return body;
}

async function requestCustomerJson(path, { method = "GET", query } = {}) {
  const { baseUrl, token } = getCustomerConfig();
  const url = new URL(`${baseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const body = isJson ? await res.json().catch(() => null) : await res.text().catch(() => "");

  if (!res.ok) {
    const messageFromBody =
      typeof body === "string"
        ? body
        : body && typeof body === "object"
          ? body.message || body.error || JSON.stringify(body)
          : "";
    const err = new Error(`MegaOne Customer API error ${res.status} ${res.statusText}${messageFromBody ? `: ${messageFromBody}` : ""}`);
    err.code = "API";
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return body;
}

async function getBalance() {
  return requestJson("/balance");
}

async function listCards({ status = "active" } = {}) {
  return requestJson("/cards", { query: { status } });
}

async function listTransactions({ page = 1, limit = 20, status = "all", dateFrom, dateTo, cardId, search } = {}) {
  return requestJson("/transactions", {
    query: { page, limit, status, dateFrom, dateTo, cardId, search }
  });
}

async function listCryptoDeposits({ page = 1, limit = 10, timezone = "Asia/Saigon" } = {}) {
  return requestCustomerJson("/api/customer/crypto/deposits", {
    query: { page, limit, timezone }
  });
}

module.exports = {
  getBalance,
  listCards,
  listTransactions,
  listCryptoDeposits
};
