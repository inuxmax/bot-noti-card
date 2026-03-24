const http = require("node:http");
const crypto = require("node:crypto");

function readRequestBody(req, { limitBytes = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(Object.assign(new Error("Payload too large"), { code: "PAYLOAD_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifyWebhookSignature(payloadBuffer, signatureHeader, secret) {
  if (!secret) return true;
  if (!signatureHeader) return false;
  const expectedSignature = `sha256=${crypto.createHmac("sha256", secret).update(payloadBuffer).digest("hex")}`;
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function safeJsonParse(buffer) {
  try {
    return { ok: true, value: JSON.parse(buffer.toString("utf8")) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(body.length));
  res.end(body);
}

function startWebhookServer({
  port,
  path,
  secret,
  onEvent
}) {
  if (!port) throw new Error("Missing webhook port");
  if (!path) throw new Error("Missing webhook path");

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method !== "POST" || url.pathname !== path) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const payload = await readRequestBody(req);
      const signatureHeader = req.headers["x-megaone-signature"];
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

      if (!verifyWebhookSignature(payload, signature, secret)) {
        sendJson(res, 401, { ok: false, error: "Invalid signature" });
        return;
      }

      const parsed = safeJsonParse(payload);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: "Invalid JSON" });
        return;
      }

      await onEvent(parsed.value, { signature, headers: req.headers });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      const code = err && err.code ? err.code : "SERVER_ERROR";
      const status = code === "PAYLOAD_TOO_LARGE" ? 413 : 500;
      sendJson(res, status, { ok: false, error: code });
    }
  });

  server.on("error", (err) => {
    const msg = err && err.message ? err.message : String(err);
    console.error(`[webhook] ${msg}`);
  });

  server.listen(port);
  return server;
}

module.exports = {
  startWebhookServer,
  verifyWebhookSignature
};
