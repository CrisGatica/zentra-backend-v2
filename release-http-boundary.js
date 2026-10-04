import { isIP } from "node:net";
import { positiveLimit } from "./release-security.js";
import { logRateLimit } from "./release-rate-observability.js";

export function configureHttpProxy(app, env = process.env) {
  const proxies = String(env.ZENTRA_TRUSTED_PROXY_CIDRS || "").split(",").map(value => value.trim()).filter(Boolean);
  for (const proxy of proxies) {
    const [address, mask, extra] = proxy.split("/");
    const version = isIP(address);
    if (!version || extra !== undefined || (mask !== undefined
      && (!/^\d+$/.test(mask) || Number(mask) < 1 || Number(mask) > (version === 4 ? 32 : 128)))) {
      throw new Error("Invalid ZENTRA_TRUSTED_PROXY_CIDRS configuration");
    }
  }
  // Never trust a caller-controlled forwarding header without a known proxy address.
  app.set("trust proxy", proxies.length ? proxies : false);
}

export function createHttpBoundary({ env = process.env, now = Date.now } = {}) {
  const limits = {
    health: positiveLimit(env.ZENTRA_RATE_HEALTH_IP, 600),
    webhook: positiveLimit(env.ZENTRA_RATE_WEBHOOK_IP, 600),
    public: positiveLimit(env.ZENTRA_RATE_PUBLIC_IP, 120)
  };
  const buckets = new Map();
  return function httpBoundary(req, res, next) {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Cache-Control", "no-store");
    const path = req.path.replace(/\/+$/, "").toLowerCase();
    const category = ["/health", "/api/health"].includes(path) ? "health"
      : path === "/api/lemon/webhook" ? "webhook" : "public";
    // Sensitive routes have their own pre-auth IP guard, then a durable user guard.
    if (category === "public" && rateCategory(path, req.method)) return next();
    const time = now();
    if (buckets.size >= 10000) {
      for (const [key, value] of buckets) if (value.until <= time) buckets.delete(key);
    }
    const key = category + ":" + req.ip;
    let bucket = buckets.get(key);
    if (!bucket && buckets.size >= 10000) return res.set("Retry-After", "60").status(429).json({ error: "Demasiadas solicitudes." });
    if (!bucket || bucket.until <= time) {
      bucket = { count: 0, until: time + 60000 };
      buckets.set(key, bucket);
    }
    if (++bucket.count > limits[category]) return res.set("Retry-After", String(Math.max(1, Math.ceil((bucket.until - time) / 1000))))
      .status(429).json({ error: "Demasiadas solicitudes. Intentá nuevamente más tarde." });
    return next();
  };
}

export function rateCategory(path, method) {
  path = path.replace(/\/+$/, "").toLowerCase();
  if (method === "OPTIONS") return null;
  if (["/api/chat", "/api/chat/stream"].includes(path)) return "generation";
  if (path === "/api/audio/transcribe") return "audio";
  if (path === "/api/audit/competitive-search") return "search";
  if (["/api/audit/reserve", "/api/audit/release"].includes(path)) return "audit";
  if (["/api/subscription/consume", "/api/audit/consume"].includes(path)) return "consume";
  if (path === "/api/subscription/free/notify") return "consume";
  if (["/api/user", "/api/subscription/usage", "/api/subscription/capacity/offers"].includes(path)) return "read";
  return null;
}

export function createDistributedRateLimit({ client, env = process.env }) {
  const limits = Object.fromEntries(Object.entries({ generation: 60, audio: 12, search: 30, audit: 120, consume: 60, read: 180 })
    .map(([category, fallback]) => [category, positiveLimit(env["ZENTRA_RATE_" + category.toUpperCase() + "_USER"], fallback)]));
  return async function distributedRateLimit(req, res, next) {
    const category = rateCategory(req.path, req.method);
    if (!category || !req.auth) return next();
    try {
      const { data, error } = await client.rpc("zentra_http_rate_limit", {
        p_subject: req.auth.userId, p_category: category, p_maximum: limits[category]
      });
      if (error || typeof data?.allowed !== "boolean") throw new Error("HTTP rate store unavailable");
      if (!data.allowed) {
        const retryAfter = Math.max(1, Math.min(60, Number(data.retry_after) || 60));
        logRateLimit({ source: "zentra_distributed", endpoint: req.path, category, retryAfter });
        return res.set("Retry-After", String(retryAfter))
          .status(429).json({ error: "Demasiadas solicitudes. Intentá nuevamente más tarde.", code: "rate_limited" });
      }
      return next();
    } catch (_) {
      // Fail before reservation/provider work, without returning database diagnostics.
      return res.status(503).json({ error: "Servicio temporalmente no disponible.", code: "rate_limit_unavailable" });
    }
  };
}

export function minimalHealth(_req, res) { res.json({ ok: true }); }

export function publicHttpError(error, _req, res, _next) {
  if (res.headersSent) return res.end();
  const status = error?.type === "entity.too.large" ? 413 : error?.type === "entity.parse.failed" ? 400 : 500;
  res.status(status).json({ error: status === 413 ? "El archivo supera el tamaño permitido."
    : status === 400 ? "La solicitud no tiene un formato válido." : "Error en el servidor." });
}
