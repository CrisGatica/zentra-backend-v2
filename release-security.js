import crypto from "node:crypto";

const protectedPaths = new Set([
  "/api/user", "/api/subscription/usage", "/api/subscription/capacity/offers",
  "/api/subscription/consume", "/api/audit/consume", "/api/audit/competitive-search", "/api/audio/transcribe",
  "/api/audit/reserve", "/api/audit/release",
  "/api/chat", "/api/chat/stream", "/api/lemon/checkout"
]);

export function allowedOrigins(origins = "", environment = process.env.NODE_ENV || "production") {
  const allowed = new Set();
  for (const entry of String(origins).split(",").map(value => value.trim()).filter(Boolean)) {
    let url;
    try { url = new URL(entry); } catch (_) { throw new Error("Invalid ZENTRA_ALLOWED_ORIGINS configuration"); }
    const extension = url.protocol === "chrome-extension:" && /^[a-p]{32}$/.test(url.hostname);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (entry.includes("*") || url.username || url.password || url.search || url.hash
      || (url.pathname && url.pathname !== "/") || (extension && url.port)
      || (!extension && url.protocol !== "https:" && !(local && url.protocol === "http:"))
      || (environment === "production" && local)) {
      throw new Error("Invalid ZENTRA_ALLOWED_ORIGINS configuration");
    }
    allowed.add(extension ? `chrome-extension://${url.hostname}` : url.origin);
  }
  return allowed;
}

export function createCorsOptions(origins = "", environment = process.env.NODE_ENV) {
  const allowed = allowedOrigins(origins, environment);
  return {
    origin(origin, callback) {
      // No Origin is normal for server-to-server calls, but never bypasses authentication.
      callback(null, Boolean(origin && allowed.has(origin)));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    maxAge: 600
  };
}

export function createApiSecurity({ client, origins = "", now = Date.now, env = process.env }) {
  const allowed = allowedOrigins(origins, env.NODE_ENV);
  const maximumIp = positiveLimit(env.ZENTRA_RATE_AUTH_IP, 240);
  const maximumUser = positiveLimit(env.ZENTRA_RATE_USER_LOCAL, 120);
  const buckets = new Map();
  function limited(key, maximum, windowMs = 60000) {
    const time = now();
    if (buckets.size > 10000) {
      for (const [id, bucket] of buckets) if (bucket.until <= time) buckets.delete(id);
      if (buckets.size > 10000) return true;
    }
    const bucket = buckets.get(key);
    if (!bucket || bucket.until <= time) {
      buckets.set(key, { count: 1, until: time + windowMs });
      return false;
    }
    return ++bucket.count > maximum;
  }
  return async function apiSecurity(req, res, next) {
    if (!protectedPaths.has(req.path.replace(/\/+$/, "").toLowerCase())) return next();
    const origin = req.get("Origin");
    if (origin && !allowed.has(origin)) return res.status(403).json({ error: "Origen no autorizado." });
    if (limited("ip:" + req.ip, maximumIp)) {
      return res.set("Retry-After", "60").status(429).json({ error: "Demasiadas solicitudes. Intentá nuevamente en un minuto." });
    }
    const match = /^Bearer ([^\s]+)$/i.exec(req.get("Authorization") || "");
    if (!match) return res.status(401).json({ error: "Iniciá sesión para continuar." });
    if (!client) return res.status(503).json({ error: "Servicio temporalmente no disponible." });
    try {
      const { data, error } = await client.auth.getUser(match[1]);
      const user = data?.user;
      if (error || !user?.id || !user.email || !(user.email_confirmed_at || user.confirmed_at)) {
        return res.status(401).json({ error: "Tu sesión no es válida. Iniciá sesión nuevamente." });
      }
      if (limited("user:" + user.id, maximumUser)) {
        return res.set("Retry-After", "60").status(429).json({ error: "Demasiadas solicitudes. Intentá nuevamente en un minuto." });
      }
      req.auth = { userId: user.id, email: user.email.trim().toLowerCase(), identitySource: "verified_session" };
      return next();
    } catch (_) {
      return res.status(503).json({ error: "No se pudo verificar la sesión. Intentá nuevamente." });
    }
  };
}

export function positiveLimit(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 100000) throw new Error("Invalid HTTP rate limit configuration");
  return number;
}

export function publicStreamEvent(payload = {}) {
  if (payload.type === "error") return { type: "error", message: "No se pudo completar la respuesta. Intentá nuevamente." };
  if (payload.type === "final") return { type: "final", text: String(payload.text || "") };
  if (payload.type === "layer") return {
    type: "layer", phase: payload.phase, text: String(payload.text || ""), summary: String(payload.summary || "")
  };
  if (payload.type === "status") return {
    type: "status", phase: payload.phase, message: "Preparando tu respuesta", label: "Zentra AI"
  };
  return null;
}

export function requestFingerprint(body = {}) {
  return crypto.createHash("sha256").update(JSON.stringify({
    messages: body.messages, task: body.zentra_routing?.taskType || body.task_type || "chat_basic",
    response_format: body.response_format, max_tokens: body.max_tokens, temperature: body.temperature,
    contract: body.responseContract || body.response_contract || body.zentra_response_contract || body.zentra_contract
  })).digest("hex");
}
