import crypto from "node:crypto";

export function safeRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  const seconds = /^\d+$/.test(text) ? Number(text) : Math.ceil((Date.parse(text) - now) / 1000);
  return Number.isFinite(seconds) ? Math.min(86400, Math.max(1, seconds)) : null;
}

export function logRateLimit({ source, endpoint, category = "generation", operationId, retryAfter }) {
  const path = String(endpoint || "").split(":")[0].replace(/^api\//, '/api/');
  try { console.warn("[HTTP LIMIT]", {
    source, status: 429,
    code: source === "provider" ? "provider_rate_limited" : "rate_limited",
    endpoint: /^\/api\/[a-z/-]+$/.test(path) ? path : null,
    category: category === "protected" && ["/api/chat", "/api/chat/stream"].includes(path) ? "generation" : category,
    operation_id: operationId ? crypto.createHash("sha256").update(String(operationId)).digest("hex").slice(0, 24) : null,
    retry_after: safeRetryAfter(retryAfter)
  }); } catch (_) { /* Observability must not interfere with the response. */ }
}
