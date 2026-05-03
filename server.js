import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const app = express();
const PORT = process.env.PORT || 3000;
const LEMON_WEBHOOK_SECRET = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    })
  : null;

app.use(cors());
app.use(express.json({
  limit: "50mb",
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const SUPPORTED_LEMON_EVENTS = new Set([
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "order_created"
]);

const LEMON_PRODUCT_MAP = {
  // Zentra AI SaaS - suscripciones mensuales y anuales
  "990970": { plan: "starter", plan_type: "subscription" },
  "1023400": { plan: "starter", plan_type: "subscription" },
  "990993": { plan: "pro", plan_type: "subscription" },
  "1023398": { plan: "pro", plan_type: "subscription" },
  "990997": { plan: "agency", plan_type: "subscription" },
  "1023395": { plan: "agency", plan_type: "subscription" },

  // Zentra Audit - pago unico
  "1023407": { plan: "starter", plan_type: "audit" },
  "1023412": { plan: "pro", plan_type: "audit" },
  "1023419": { plan: "agency", plan_type: "audit" }
};

const LEMON_VARIANT_MAP = {
  // Zentra AI SaaS - suscripciones mensuales y anuales
  "1554910": { plan: "starter", plan_type: "subscription" },
  "1605313": { plan: "starter", plan_type: "subscription" },
  "1554947": { plan: "pro", plan_type: "subscription" },
  "1605311": { plan: "pro", plan_type: "subscription" },
  "1554951": { plan: "agency", plan_type: "subscription" },
  "1605308": { plan: "agency", plan_type: "subscription" },

  // Zentra Audit - pago unico
  "1605323": { plan: "starter", plan_type: "audit" },
  "1605330": { plan: "pro", plan_type: "audit" },
  "1605342": { plan: "agency", plan_type: "audit" }
};

function getSupabaseClient() {
  if (!supabase) {
    throw new Error("Supabase no esta configurado. Define SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.");
  }

  return supabase;
}

function normalizeEmail(email = "") {
  return String(email || "").trim().toLowerCase();
}

function normalizePlanFromProductName(productName = "") {
  const value = String(productName || "").toLowerCase();

  if (value.includes("agency")) return "agency";
  if (value.includes("pro")) return "pro";
  if (value.includes("starter")) return "starter";

  return "free";
}

function normalizeLemonId(value = "") {
  return String(value || "").trim();
}

function getLemonMapping({ productId = "", variantId = "" } = {}) {
  const normalizedVariantId = normalizeLemonId(variantId);
  const normalizedProductId = normalizeLemonId(productId);

  return LEMON_VARIANT_MAP[normalizedVariantId]
    || LEMON_PRODUCT_MAP[normalizedProductId]
    || null;
}

function getProductFamily(productName = "", eventName = "") {
  const value = String(productName || "").toLowerCase();

  if (value.includes("audit")) return "audit";
  if (eventName.startsWith("subscription_")) return "subscription";

  return "subscription";
}

function getEventName(req, payload = {}) {
  return String(
    payload?.meta?.event_name ||
    req.get("X-Event-Name") ||
    req.get("x-event-name") ||
    ""
  ).trim();
}

function getFirstOrderItem(attributes = {}) {
  if (attributes.first_order_item) return attributes.first_order_item;
  if (attributes.order_item) return attributes.order_item;
  if (Array.isArray(attributes.order_items) && attributes.order_items[0]) {
    return attributes.order_items[0];
  }

  return {};
}

function extractLemonPaymentInfo(payload = {}, eventName = "") {
  const data = payload.data || {};
  const attributes = data.attributes || {};
  const firstOrderItem = getFirstOrderItem(attributes);
  const productName = String(
    attributes.product_name ||
    firstOrderItem.product_name ||
    attributes.name ||
    ""
  ).trim();
  const variantName = String(
    attributes.variant_name ||
    firstOrderItem.variant_name ||
    ""
  ).trim();
  const productId = normalizeLemonId(
    attributes.product_id ||
    firstOrderItem.product_id ||
    attributes.product?.id ||
    ""
  );
  const variantId = normalizeLemonId(
    attributes.variant_id ||
    firstOrderItem.variant_id ||
    attributes.variant?.id ||
    ""
  );
  const productLabel = `${productName} ${variantName}`.trim();
  const idMapping = getLemonMapping({ productId, variantId });
  const email = normalizeEmail(
    attributes.user_email ||
    attributes.customer_email ||
    attributes.email ||
    attributes.user?.email ||
    attributes.customer?.email ||
    ""
  );
  const family = idMapping?.plan_type || getProductFamily(productLabel || productName, eventName);
  const plan = idMapping?.plan || normalizePlanFromProductName(productLabel || productName);
  const status = eventName === "subscription_cancelled"
    ? "cancelled"
    : normalizeLemonStatus(attributes.status, eventName);

  return {
    email,
    plan,
    plan_type: family,
    status,
    product_name: productName,
    variant_name: variantName,
    product_label: productLabel,
    product_id: productId,
    variant_id: variantId,
    lemon_id: data.id || "",
    lemon_type: data.type || "",
    lemon_status: attributes.status || ""
  };
}

function normalizeLemonStatus(status = "", eventName = "") {
  const value = String(status || "").toLowerCase();

  if (eventName === "subscription_cancelled" || value === "cancelled" || value === "expired") {
    return "cancelled";
  }

  if (["active", "on_trial", "paid"].includes(value)) {
    return "active";
  }

  if (eventName === "subscription_created" || eventName === "subscription_updated") {
    return "active";
  }

  return value || "active";
}

function verifyLemonSignature(req) {
  if (!LEMON_WEBHOOK_SECRET) {
    throw new Error("LEMON_SQUEEZY_WEBHOOK_SECRET no esta configurado.");
  }

  const signature = req.get("X-Signature") || req.get("x-signature") || "";
  if (!signature || !req.rawBody) return false;

  const digest = crypto
    .createHmac("sha256", LEMON_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("hex");

  const signatureBuffer = Buffer.from(signature, "hex");
  const digestBuffer = Buffer.from(digest, "hex");

  if (signatureBuffer.length !== digestBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(signatureBuffer, digestBuffer);
}

async function upsertUserAccess(userData = {}) {
  const client = getSupabaseClient();
  const payload = {
    email: userData.email,
    plan: userData.plan,
    plan_type: userData.plan_type,
    status: userData.status,
    audit_credits: Number.isFinite(Number(userData.audit_credits)) ? Number(userData.audit_credits) : 0,
    audit_credits_used: Number.isFinite(Number(userData.audit_credits_used)) ? Number(userData.audit_credits_used) : 0,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await client
    .from("users")
    .upsert(payload, {
      onConflict: "email,plan_type"
    })
    .select("email, plan, plan_type, status, audit_credits, audit_credits_used, updated_at")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function getUserByEmail(email, planType = "subscription") {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("users")
    .select("email, plan, plan_type, status, audit_credits, audit_credits_used, updated_at")
    .eq("email", email)
    .eq("plan_type", planType)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function grantAuditAccess(paymentInfo = {}) {
  const existingUser = await getUserByEmail(paymentInfo.email, "audit");
  const nextCredits = Number(existingUser?.audit_credits || 0) + 1;
  const usedCredits = Number(existingUser?.audit_credits_used || 0);

  return upsertUserAccess({
    email: paymentInfo.email,
    plan: paymentInfo.plan,
    plan_type: "audit",
    status: "active",
    audit_credits: nextCredits,
    audit_credits_used: usedCredits
  });
}

async function consumeAuditCredit(email) {
  const user = await getUserByEmail(email, "audit");

  if (!user || user.status !== "active") {
    return {
      allowed: false,
      reason: "no_active_audit_access",
      user
    };
  }

  const credits = Number(user.audit_credits || 0);
  const used = Number(user.audit_credits_used || 0);

  if (used >= credits) {
    return {
      allowed: false,
      reason: "audit_credit_limit_reached",
      user
    };
  }

  const savedUser = await upsertUserAccess({
    ...user,
    audit_credits_used: used + 1,
    status: "active"
  });

  return {
    allowed: true,
    user: savedUser
  };
}

function parseJsonSafely(content) {
  if (!content) return {};

  const attempts = [];
  const raw = String(content).trim();
  attempts.push(raw);

  const withoutFences = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  attempts.push(withoutFences);

  const objectMatch = withoutFences.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    attempts.push(objectMatch[0]);
    attempts.push(
      objectMatch[0]
        .replace(/,\s*}/g, "}")
        .replace(/,\s*]/g, "]")
    );
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }

  return {};
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "zentra-backend",
    supabase_configured: Boolean(supabase),
    lemon_webhook_configured: Boolean(LEMON_WEBHOOK_SECRET)
  });
});

app.post("/api/lemon/webhook", async (req, res) => {
  try {
    if (!verifyLemonSignature(req)) {
      console.warn("[lemon:webhook] Firma invalida");
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    const payload = req.body || {};
    const eventName = getEventName(req, payload);

    if (!SUPPORTED_LEMON_EVENTS.has(eventName)) {
      console.log(`[lemon:webhook] Evento ignorado: ${eventName || "sin_evento"}`);
      return res.status(200).json({
        success: true,
        ignored: true,
        event: eventName
      });
    }

    const paymentInfo = extractLemonPaymentInfo(payload, eventName);

    if (!paymentInfo.email) {
      console.warn(`[lemon:webhook] Evento ${eventName} sin email`, {
        lemon_id: paymentInfo.lemon_id,
        product: paymentInfo.product_label
      });
      return res.status(400).json({ error: "Webhook sin email de usuario" });
    }

    if (paymentInfo.plan === "free") {
      console.warn(`[lemon:webhook] Producto sin plan reconocible: ${paymentInfo.product_label}`);
      return res.status(400).json({ error: "Producto sin plan reconocible" });
    }

    if (eventName === "order_created" && paymentInfo.plan_type === "audit") {
      const savedUser = await grantAuditAccess(paymentInfo);

      console.log("[lemon:webhook] Compra Audit sincronizada", {
        email: savedUser.email,
        plan: savedUser.plan,
        credits: savedUser.audit_credits,
        used: savedUser.audit_credits_used,
        product: paymentInfo.product_label
      });

      return res.status(200).json({
        success: true,
        event: eventName,
        user: savedUser
      });
    }

    if (!eventName.startsWith("subscription_")) {
      console.log(`[lemon:webhook] Evento ${eventName} no aplica a SaaS. Ignorado.`);
      return res.status(200).json({
        success: true,
        ignored: true,
        event: eventName
      });
    }

    const existingUser = await getUserByEmail(paymentInfo.email, "subscription");
    const savedUser = await upsertUserAccess({
      email: paymentInfo.email,
      plan: paymentInfo.plan,
      plan_type: "subscription",
      status: paymentInfo.status,
      audit_credits: Number(existingUser?.audit_credits || 0),
      audit_credits_used: Number(existingUser?.audit_credits_used || 0)
    });

    console.log("[lemon:webhook] Suscripcion SaaS sincronizada", {
      event: eventName,
      email: savedUser.email,
      plan: savedUser.plan,
      status: savedUser.status,
      product: paymentInfo.product_label
    });

    return res.status(200).json({
      success: true,
      event: eventName,
      user: savedUser
    });
  } catch (error) {
    console.error("[lemon:webhook] Error procesando webhook:", error);
    return res.status(500).json({
      error: "Error procesando webhook"
    });
  }
});

app.get("/api/user", async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email);
    const requestedPlanType = String(req.query.plan_type || "subscription").toLowerCase();
    const planType = requestedPlanType === "audit" ? "audit" : "subscription";

    if (!email) {
      return res.status(400).json({ error: "email es requerido" });
    }

    const user = await getUserByEmail(email, planType);

    if (!user || user.status === "cancelled") {
      return res.json({
        plan: "free",
        plan_type: planType,
        status: user?.status || "active",
        audit_credits: 0,
        audit_credits_used: 0,
        audit_credits_remaining: 0,
        found: Boolean(user)
      });
    }

    const auditCredits = Number(user.audit_credits || 0);
    const auditCreditsUsed = Number(user.audit_credits_used || 0);

    return res.json({
      plan: user.plan || "free",
      plan_type: user.plan_type || planType,
      status: user.status || "active",
      audit_credits: auditCredits,
      audit_credits_used: auditCreditsUsed,
      audit_credits_remaining: Math.max(auditCredits - auditCreditsUsed, 0),
      found: true
    });
  } catch (error) {
    console.error("[api:user] Error consultando usuario:", error);
    return res.status(500).json({ error: "Error consultando usuario" });
  }
});

app.post("/api/audit/consume", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({ error: "email es requerido" });
    }

    const result = await consumeAuditCredit(email);

    if (!result.allowed) {
      return res.status(403).json({
        allowed: false,
        reason: result.reason,
        plan: result.user?.plan || "free",
        plan_type: "audit",
        status: result.user?.status || "inactive",
        audit_credits: Number(result.user?.audit_credits || 0),
        audit_credits_used: Number(result.user?.audit_credits_used || 0),
        audit_credits_remaining: Math.max(
          Number(result.user?.audit_credits || 0) - Number(result.user?.audit_credits_used || 0),
          0
        )
      });
    }

    const user = result.user;
    const auditCredits = Number(user.audit_credits || 0);
    const auditCreditsUsed = Number(user.audit_credits_used || 0);

    return res.json({
      allowed: true,
      plan: user.plan || "free",
      plan_type: "audit",
      status: user.status || "active",
      audit_credits: auditCredits,
      audit_credits_used: auditCreditsUsed,
      audit_credits_remaining: Math.max(auditCredits - auditCreditsUsed, 0)
    });
  } catch (error) {
    console.error("[api:audit:consume] Error consumiendo credito Audit:", error);
    return res.status(500).json({ error: "Error consumiendo credito Audit" });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const {
      messages = [],
      model = "gpt-4o-mini",
      max_tokens = 500,
      temperature = 0.7,
      response_format
    } = req.body;

    // Conservar solo la imagen del ultimo mensaje; las anteriores se reemplazan.
    const cleanMessages = messages.map((msg, index) => {
      const isLastMessage = index === messages.length - 1;

      if (Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((item) => {
            if (item.type === "image_url") {
              if (isLastMessage) {
                return item;
              }

              return {
                type: "text",
                text: "[imagen omitida del historial]"
              };
            }
            return item;
          })
        };
      }
      return msg;
    });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        response_format: response_format || { type: "json_object" },
        temperature,
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: "Respondé SOLO en JSON válido. Sin texto extra."
              }
            ]
          },
          ...cleanMessages
        ],
        max_tokens
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || "Error en OpenAI",
        raw: data
      });
    }

    const content = data.choices?.[0]?.message?.content ?? "{}";
    const parsed = parseJsonSafely(content);

    res.json({
      success: true,
      analysis: parsed,
      raw_content: content,
      usage: data.usage,
      model: data.model,
      id: data.id
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
