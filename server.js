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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_API_VERSION = process.env.ANTHROPIC_API_VERSION || "2023-06-01";
const ZENTRA_BASE_PROVIDER = normalizeProvider(process.env.ZENTRA_BASE_PROVIDER || "openai");
const ZENTRA_PREMIUM_PROVIDER = normalizeProvider(process.env.ZENTRA_PREMIUM_PROVIDER || ZENTRA_BASE_PROVIDER);
const ZENTRA_PREMIUM_FINAL_PROVIDER = normalizeProvider(process.env.ZENTRA_PREMIUM_FINAL_PROVIDER || ZENTRA_PREMIUM_PROVIDER);
const ZENTRA_BASE_MODEL = process.env.ZENTRA_BASE_MODEL || "gpt-4o-mini";
const ZENTRA_PREMIUM_MODEL = process.env.ZENTRA_PREMIUM_MODEL || ZENTRA_BASE_MODEL;
const ZENTRA_PREMIUM_FINAL_MODEL = process.env.ZENTRA_PREMIUM_FINAL_MODEL || ZENTRA_PREMIUM_MODEL;
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

const PLAN_LIMITS = {
  free: { actions: 20, audits: 1 },
  starter: { actions: 200, audits: 3 },
  pro: { actions: 800, audits: 10 },
  agency: { actions: 2000, audits: 20 }
};

const PREMIUM_LIMITS = {
  free: { premium_chat_used: 20, premium_pdf_used: 0 },
  starter: { premium_chat_used: 20, premium_pdf_used: 0 },
  pro: { premium_chat_used: 150, premium_pdf_used: 30 },
  agency: { premium_chat_used: 400, premium_pdf_used: 80 }
};
const TEMP_UNLIMITED_LIMIT = 999999;
const TEMP_UNLIMITED_AGENCY_EMAILS = new Set([
  "cristiangaticanegocios@gmail.com"
]);

const AI_TASK_ROUTING = {
  chat_basic: {
    provider: ZENTRA_BASE_PROVIDER,
    model: ZENTRA_BASE_MODEL,
    premium: false,
    maxTokens: 4096
  },
  chat_image_ocr: {
    provider: ZENTRA_BASE_PROVIDER,
    model: ZENTRA_BASE_MODEL,
    premium: false,
    maxTokens: 4096
  },
  chat_premium: {
    provider: ZENTRA_PREMIUM_PROVIDER,
    model: ZENTRA_PREMIUM_MODEL,
    fallbackProvider: ZENTRA_BASE_PROVIDER,
    fallbackModel: ZENTRA_BASE_MODEL,
    premium: true,
    counterKey: "premium_chat_used",
    allowedPlans: ["free", "starter", "pro", "agency"],
    maxTokens: 4096
  },
  seo_analysis: {
    provider: ZENTRA_BASE_PROVIDER,
    model: ZENTRA_BASE_MODEL,
    premium: false,
    maxTokens: 2048
  },
  pdf_summary: {
    provider: ZENTRA_PREMIUM_PROVIDER,
    model: ZENTRA_PREMIUM_MODEL,
    fallbackProvider: ZENTRA_BASE_PROVIDER,
    fallbackModel: ZENTRA_BASE_MODEL,
    premium: true,
    counterKey: "premium_pdf_used",
    allowedPlans: ["pro", "agency"],
    maxTokens: 2200
  },
  pdf_polish: {
    provider: ZENTRA_PREMIUM_FINAL_PROVIDER,
    model: ZENTRA_PREMIUM_FINAL_MODEL,
    fallbackProvider: ZENTRA_BASE_PROVIDER,
    fallbackModel: ZENTRA_BASE_MODEL,
    premium: true,
    counterKey: "premium_pdf_used",
    allowedPlans: ["agency"],
    maxTokens: 3072
  },
  premium_reasoning_audit: {
    provider: ZENTRA_PREMIUM_FINAL_PROVIDER,
    model: ZENTRA_PREMIUM_FINAL_MODEL,
    fallbackProvider: ZENTRA_BASE_PROVIDER,
    fallbackModel: ZENTRA_BASE_MODEL,
    premium: true,
    counterKey: "premium_pdf_used",
    allowedPlans: ["pro", "agency"],
    maxTokens: 2200
  }
};
const PDF_FLOW_TASKS = new Set([
  "seo_analysis",
  "pdf_summary",
  "pdf_polish",
  "premium_reasoning_audit"
]);
let PREMIUM_AUDIT_ROUTE_HIT_COUNT = 0;

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

function normalizePlan(plan = "free") {
  const normalizedPlan = String(plan || "free").toLowerCase();
  return PLAN_LIMITS[normalizedPlan] ? normalizedPlan : "free";
}

function normalizeCounterValue(value = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.floor(numberValue) : 0;
}

function hasUnlimitedAgencyOverride(email = "") {
  return TEMP_UNLIMITED_AGENCY_EMAILS.has(normalizeEmail(email));
}

function applyUnlimitedAgencySubscriptionUser(email = "", user = {}) {
  const normalizedEmail = normalizeEmail(email || user.email || "");
  return {
    ...getDefaultSubscriptionUser(normalizedEmail),
    ...user,
    email: normalizedEmail,
    plan: "agency",
    plan_type: "subscription",
    status: "active",
    unlimited_agency: true
  };
}

function getUnlimitedAuditUsage(email = "", user = {}) {
  const normalizedEmail = normalizeEmail(email || user.email || "");
  const used = normalizeCounterValue(user.audit_credits_used || 0);
  const credits = Math.max(TEMP_UNLIMITED_LIMIT, used + 1000);

  return {
    email: normalizedEmail,
    plan: "agency",
    plan_type: "audit",
    status: "active",
    audit_credits: credits,
    audit_credits_used: used,
    audit_credits_remaining: Math.max(credits - used, 0),
    unlimited_agency: true
  };
}

function normalizeProvider(provider = "openai") {
  const normalizedProvider = String(provider || "openai").trim().toLowerCase();
  return normalizedProvider === "anthropic" || normalizedProvider === "claude"
    ? "anthropic"
    : "openai";
}

function isProviderConfigured(provider = "openai") {
  const normalizedProvider = normalizeProvider(provider);
  return normalizedProvider === "anthropic"
    ? Boolean(ANTHROPIC_API_KEY)
    : Boolean(OPENAI_API_KEY);
}

function getPlanLimits(plan = "free") {
  return PLAN_LIMITS[normalizePlan(plan)] || PLAN_LIMITS.free;
}

function getPremiumLimits(plan = "free") {
  return PREMIUM_LIMITS[normalizePlan(plan)] || PREMIUM_LIMITS.free;
}

function normalizeTaskType(taskType = "chat_basic") {
  const normalizedTaskType = String(taskType || "chat_basic").trim().toLowerCase();
  return AI_TASK_ROUTING[normalizedTaskType] ? normalizedTaskType : "chat_basic";
}

function isPdfFlowTask(taskType = "chat_basic") {
  const normalizedTaskType = String(taskType || "chat_basic").trim().toLowerCase();
  return PDF_FLOW_TASKS.has(normalizedTaskType);
}

function clampMaxTokens(requestedMaxTokens, taskType = "chat_basic") {
  const route = AI_TASK_ROUTING[normalizeTaskType(taskType)] || AI_TASK_ROUTING.chat_basic;
  const requested = normalizeCounterValue(requestedMaxTokens || route.maxTokens || 500);
  const routeLimit = normalizeCounterValue(route.maxTokens || 4096);
  const hardLimit = 4096;
  return Math.min(Math.max(requested || 500, 128), routeLimit, hardLimit);
}

function normalizeTemperature(value = 0.7) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0.7;
  return Math.min(Math.max(numberValue, 0), 1);
}

function getEmailFromChatRequest(req, routing = {}) {
  return normalizeEmail(
    req.body?.zentra_user_email ||
    req.body?.user_email ||
    routing.email ||
    routing.userEmail ||
    ""
  );
}

function getPlanTypeFromChatRequest(req, routing = {}) {
  const value = String(
    req.body?.zentra_plan_type ||
    routing.planType ||
    routing.plan_type ||
    ""
  ).trim().toLowerCase();

  return value === "audit" ? "audit" : "subscription";
}

async function resolveAiRoutingForRequest(req) {
  const routing = req.body?.zentra_routing || {};
  const incomingTaskType = routing.taskType || req.body?.task_type || "chat_basic";
  const taskType = normalizeTaskType(incomingTaskType);
  const route = AI_TASK_ROUTING[taskType] || AI_TASK_ROUTING.chat_basic;
  const maxTokens = clampMaxTokens(req.body?.max_tokens || routing.maxTokens, taskType);
  const email = getEmailFromChatRequest(req, routing);
  const planType = getPlanTypeFromChatRequest(req, routing);
  const requestedModel = req.body?.model || routing.selectedModel || "";
  const tracePdfFlow = isPdfFlowTask(incomingTaskType) || isPdfFlowTask(taskType);
  const premiumAuditRouteRequested = String(incomingTaskType || "").trim().toLowerCase() === "premium_reasoning_audit";
  const premiumAuditRouteResolved = taskType === "premium_reasoning_audit";

  const logPdfFlow = (stage, details = {}) => {
    if (!tracePdfFlow) return;
    console.log("[PDF FLOW]", {
      stage,
      taskType: incomingTaskType,
      requestedModel,
      resolvedTask: taskType,
      resolvedModel: details.resolvedModel || null,
      provider: details.provider || null,
      reason: details.reason || null,
      ...details
    });
  };

  if (premiumAuditRouteRequested || premiumAuditRouteResolved) {
    PREMIUM_AUDIT_ROUTE_HIT_COUNT += 1;
    console.log("[PDF FLOW] PREMIUM AUDIT ROUTE HIT", {
      hits: PREMIUM_AUDIT_ROUTE_HIT_COUNT,
      incomingTaskType,
      resolvedTask: taskType
    });
  }

  logPdfFlow("resolve:start", {
    provider: route.provider || ZENTRA_BASE_PROVIDER,
    resolvedModel: route.model || ZENTRA_BASE_MODEL,
    planType
  });

  const resolved = {
    taskType,
    email,
    requestedModel,
    provider: ZENTRA_BASE_PROVIDER,
    model: ZENTRA_BASE_MODEL,
    fallbackProvider: route.fallbackProvider || ZENTRA_BASE_PROVIDER,
    fallbackModel: route.fallbackModel || ZENTRA_BASE_MODEL,
    maxTokens,
    premiumRequested: Boolean(routing.premiumActive || routing.premiumAllowed || route.premium),
    premiumActive: false,
    premiumConsumed: false,
    counterKey: route.counterKey || null,
    planType,
    reason: "base_model"
  };

  if (!route.premium) {
    logPdfFlow("resolve:base", {
      provider: resolved.provider,
      resolvedModel: resolved.model,
      reason: resolved.reason
    });
    return resolved;
  }

  if (!email) {
    logPdfFlow("resolve:blocked_missing_email", {
      provider: resolved.provider,
      resolvedModel: resolved.model,
      reason: "missing_user_email"
    });
    return {
      ...resolved,
      reason: "missing_user_email"
    };
  }

  const premiumModel = route.model || ZENTRA_BASE_MODEL;
  const premiumProvider = normalizeProvider(route.provider || ZENTRA_BASE_PROVIDER);
  const isSameBaseLayer = premiumProvider === ZENTRA_BASE_PROVIDER && premiumModel === ZENTRA_BASE_MODEL;

  if (!premiumModel || isSameBaseLayer) {
    logPdfFlow("resolve:blocked_premium_model_not_configured", {
      provider: resolved.provider,
      resolvedModel: resolved.model,
      reason: "premium_model_not_configured"
    });
    return {
      ...resolved,
      reason: "premium_model_not_configured"
    };
  }

  if (!isProviderConfigured(premiumProvider)) {
    logPdfFlow("resolve:blocked_premium_provider_not_configured", {
      provider: resolved.provider,
      resolvedModel: resolved.model,
      reason: "premium_provider_not_configured"
    });
    return {
      ...resolved,
      reason: "premium_provider_not_configured"
    };
  }

  if (planType === "audit" && ["pdf_summary", "pdf_polish", "premium_reasoning_audit"].includes(taskType)) {
    if (hasUnlimitedAgencyOverride(email)) {
      const resolvedAuditPremium = {
        ...resolved,
        plan: "agency",
        provider: premiumProvider,
        model: premiumModel,
        premiumActive: true,
        premiumConsumed: false,
        counterKey: null,
        reason: "audit_premium_authorized_unlimited_override"
      };
      logPdfFlow("resolve:audit_premium_authorized_unlimited_override", {
        provider: resolvedAuditPremium.provider,
        resolvedModel: resolvedAuditPremium.model,
        reason: resolvedAuditPremium.reason,
        plan: "agency"
      });
      return resolvedAuditPremium;
    }

    const auditUser = await getUserByEmail(email, "audit");
    const plan = normalizePlan(auditUser?.plan);
    const credits = Number(auditUser?.audit_credits || 0);
    const used = Number(auditUser?.audit_credits_used || 0);

    if (!auditUser || auditUser.status !== "active" || used >= credits) {
      logPdfFlow("resolve:audit_premium_not_allowed", {
        provider: resolved.provider,
        resolvedModel: resolved.model,
        reason: "audit_premium_not_allowed",
        plan,
        credits,
        used
      });
      return {
        ...resolved,
        plan,
        reason: "audit_premium_not_allowed"
      };
    }

    const resolvedAuditPremium = {
      ...resolved,
      plan,
      provider: premiumProvider,
      model: premiumModel,
      premiumActive: true,
      premiumConsumed: false,
      counterKey: null,
      reason: "audit_premium_authorized"
    };
    logPdfFlow("resolve:audit_premium_authorized", {
      provider: resolvedAuditPremium.provider,
      resolvedModel: resolvedAuditPremium.model,
      reason: resolvedAuditPremium.reason,
      plan
    });
    return resolvedAuditPremium;
  }

  const user = await ensureFreshSubscriptionUsage(email);
  const plan = hasUnlimitedAgencyOverride(email) ? "agency" : normalizePlan(user?.plan);
  const allowedPlans = route.allowedPlans || [];

  if (!user || user.status !== "active" || !allowedPlans.includes(plan)) {
    logPdfFlow("resolve:premium_not_allowed_for_plan", {
      provider: resolved.provider,
      resolvedModel: resolved.model,
      reason: "premium_not_allowed_for_plan",
      plan
    });
    return {
      ...resolved,
      plan,
      reason: "premium_not_allowed_for_plan"
    };
  }

  const premiumUsage = await consumeSubscriptionUsage(email, route.counterKey);
  if (!premiumUsage.allowed) {
    logPdfFlow("resolve:premium_limit_reached", {
      provider: resolved.provider,
      resolvedModel: resolved.model,
      reason: premiumUsage.reason || "premium_limit_reached",
      plan
    });
    return {
      ...resolved,
      plan,
      reason: premiumUsage.reason || "premium_limit_reached"
    };
  }

  const resolvedPremium = {
    ...resolved,
    plan,
    provider: premiumProvider,
    model: premiumModel,
    premiumActive: true,
    premiumConsumed: true,
    reason: "premium_authorized"
  };
  logPdfFlow("resolve:premium_authorized", {
    provider: resolvedPremium.provider,
    resolvedModel: resolvedPremium.model,
    reason: resolvedPremium.reason,
    plan
  });
  return resolvedPremium;
}

function getNextBillingCycleStart(timestamp = Date.now()) {
  const date = new Date(Number(timestamp) || Date.now());
  const nextDate = new Date(date);
  nextDate.setMonth(nextDate.getMonth() + 1);
  return nextDate.getTime();
}

function shouldResetMonthlyUsage(user = {}) {
  const billingCycleStart = normalizeCounterValue(user.billing_cycle_start || Date.now());
  return Date.now() >= getNextBillingCycleStart(billingCycleStart);
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
    plan: normalizePlan(userData.plan),
    plan_type: userData.plan_type,
    status: userData.status,
    audit_credits: normalizeCounterValue(userData.audit_credits),
    audit_credits_used: normalizeCounterValue(userData.audit_credits_used),
    actions_used: normalizeCounterValue(userData.actions_used),
    audits_used: normalizeCounterValue(userData.audits_used),
    premium_chat_used: normalizeCounterValue(userData.premium_chat_used),
    premium_pdf_used: normalizeCounterValue(userData.premium_pdf_used),
    billing_cycle_start: normalizeCounterValue(userData.billing_cycle_start || Date.now()),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await client
    .from("users")
    .upsert(payload, {
      onConflict: "email,plan_type"
    })
    .select("email, plan, plan_type, status, audit_credits, audit_credits_used, actions_used, audits_used, premium_chat_used, premium_pdf_used, billing_cycle_start, updated_at")
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
    .select("email, plan, plan_type, status, audit_credits, audit_credits_used, actions_used, audits_used, premium_chat_used, premium_pdf_used, billing_cycle_start, updated_at")
    .eq("email", email)
    .eq("plan_type", planType)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

function getDefaultSubscriptionUser(email = "") {
  return {
    email,
    plan: "free",
    plan_type: "subscription",
    status: "active",
    audit_credits: 0,
    audit_credits_used: 0,
    actions_used: 0,
    audits_used: 0,
    premium_chat_used: 0,
    premium_pdf_used: 0,
    billing_cycle_start: Date.now()
  };
}

function formatSubscriptionUsage(user = {}) {
  if (user.unlimited_agency || hasUnlimitedAgencyOverride(user.email)) {
    const actionsUsed = normalizeCounterValue(user.actions_used);
    const auditsUsed = normalizeCounterValue(user.audits_used);
    const premiumChatUsed = normalizeCounterValue(user.premium_chat_used);
    const premiumPdfUsed = normalizeCounterValue(user.premium_pdf_used);
    const actionsLimit = Math.max(TEMP_UNLIMITED_LIMIT, actionsUsed + 1000);
    const auditsLimit = Math.max(TEMP_UNLIMITED_LIMIT, auditsUsed + 1000);
    const premiumChatLimit = Math.max(TEMP_UNLIMITED_LIMIT, premiumChatUsed + 1000);
    const premiumPdfLimit = Math.max(TEMP_UNLIMITED_LIMIT, premiumPdfUsed + 1000);

    return {
      plan: "agency",
      plan_type: "subscription",
      status: "active",
      actions_used: actionsUsed,
      actions_limit: actionsLimit,
      actions_remaining: Math.max(actionsLimit - actionsUsed, 0),
      audits_used: auditsUsed,
      audits_limit: auditsLimit,
      audits_remaining: Math.max(auditsLimit - auditsUsed, 0),
      premium_chat_used: premiumChatUsed,
      premium_chat_limit: premiumChatLimit,
      premium_chat_remaining: Math.max(premiumChatLimit - premiumChatUsed, 0),
      premium_pdf_used: premiumPdfUsed,
      premium_pdf_limit: premiumPdfLimit,
      premium_pdf_remaining: Math.max(premiumPdfLimit - premiumPdfUsed, 0),
      billing_cycle_start: normalizeCounterValue(user.billing_cycle_start || Date.now()),
      unlimited_agency: true
    };
  }

  const plan = normalizePlan(user.plan);
  const limits = getPlanLimits(plan);
  const premiumLimits = getPremiumLimits(plan);
  const actionsUsed = normalizeCounterValue(user.actions_used);
  const auditsUsed = normalizeCounterValue(user.audits_used);
  const premiumChatUsed = normalizeCounterValue(user.premium_chat_used);
  const premiumPdfUsed = normalizeCounterValue(user.premium_pdf_used);

  return {
    plan,
    plan_type: "subscription",
    status: user.status || "active",
    actions_used: actionsUsed,
    actions_limit: limits.actions,
    actions_remaining: Math.max(limits.actions - actionsUsed, 0),
    audits_used: auditsUsed,
    audits_limit: limits.audits,
    audits_remaining: Math.max(limits.audits - auditsUsed, 0),
    premium_chat_used: premiumChatUsed,
    premium_chat_limit: premiumLimits.premium_chat_used,
    premium_chat_remaining: Math.max(premiumLimits.premium_chat_used - premiumChatUsed, 0),
    premium_pdf_used: premiumPdfUsed,
    premium_pdf_limit: premiumLimits.premium_pdf_used,
    premium_pdf_remaining: Math.max(premiumLimits.premium_pdf_used - premiumPdfUsed, 0),
    billing_cycle_start: normalizeCounterValue(user.billing_cycle_start || Date.now())
  };
}

async function ensureFreshSubscriptionUsage(email) {
  if (hasUnlimitedAgencyOverride(email)) {
    const existingUser = await getUserByEmail(email, "subscription");
    return applyUnlimitedAgencySubscriptionUser(email, existingUser || {});
  }

  const existingUser = await getUserByEmail(email, "subscription");
  const user = existingUser || getDefaultSubscriptionUser(email);

  if (user.status === "cancelled") {
    return {
      ...getDefaultSubscriptionUser(email),
      status: "cancelled"
    };
  }

  if (!existingUser || shouldResetMonthlyUsage(user)) {
    return upsertUserAccess({
      ...user,
      plan: user.plan || "free",
      plan_type: "subscription",
      status: user.status || "active",
      actions_used: 0,
      audits_used: 0,
      premium_chat_used: 0,
      premium_pdf_used: 0,
      billing_cycle_start: Date.now()
    });
  }

  return user;
}

async function consumeSubscriptionUsage(email, counterKey = "actions_used") {
  if (hasUnlimitedAgencyOverride(email)) {
    const user = await ensureFreshSubscriptionUsage(email);
    return {
      allowed: true,
      reason: "unlimited_agency_override",
      user
    };
  }

  const allowedCounters = new Set(["actions_used", "audits_used", "premium_chat_used", "premium_pdf_used"]);
  if (!allowedCounters.has(counterKey)) {
    return {
      allowed: false,
      reason: "invalid_counter"
    };
  }

  const user = await ensureFreshSubscriptionUsage(email);
  if (!user || user.status !== "active") {
    return {
      allowed: false,
      reason: "no_active_subscription",
      user
    };
  }

  const usage = formatSubscriptionUsage(user);
  const limitMap = {
    actions_used: usage.actions_limit,
    audits_used: usage.audits_limit,
    premium_chat_used: usage.premium_chat_limit,
    premium_pdf_used: usage.premium_pdf_limit
  };
  const currentUsed = normalizeCounterValue(user[counterKey]);
  const limit = normalizeCounterValue(limitMap[counterKey]);

  if (currentUsed >= limit) {
    return {
      allowed: false,
      reason: "usage_limit_reached",
      user
    };
  }

  const savedUser = await upsertUserAccess({
    ...user,
    [counterKey]: currentUsed + 1,
    plan_type: "subscription",
    status: "active"
  });

  return {
    allowed: true,
    user: savedUser
  };
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
  if (hasUnlimitedAgencyOverride(email)) {
    const user = await getUserByEmail(email, "audit");
    return {
      allowed: true,
      reason: "unlimited_agency_override",
      user: getUnlimitedAuditUsage(email, user || {})
    };
  }

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

function extractTextFromContent(content = "") {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");

  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      if (item.type === "text") return item.text || "";
      if (item.type === "image_url") return "[imagen adjunta]";
      return item.text || "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeAnthropicMessages(messages = []) {
  return messages
    .filter((msg) => msg?.role !== "system")
    .map((msg) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: extractTextFromContent(msg.content)
    }))
    .filter((msg) => msg.content);
}

function buildOpenAIRequestBody({ model, messages, responseFormat, temperature, maxTokens }) {
  return {
    model,
    response_format: responseFormat || { type: "json_object" },
    temperature: normalizeTemperature(temperature),
    messages,
    max_tokens: maxTokens
  };
}

function shouldUseOpenAIResponsesApi(model = "") {
  return /^gpt-5/i.test(String(model || "").trim());
}

function normalizeOpenAIResponsesContent(content = "") {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ type: "input_text", text: String(content || "") }];
  }

  return content
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      if (item.type === "text") {
        return { type: "input_text", text: item.text || "" };
      }
      if (item.type === "image_url" && item.image_url?.url) {
        return { type: "input_image", image_url: item.image_url.url };
      }
      if (typeof item.text === "string") {
        return { type: "input_text", text: item.text };
      }
      return null;
    })
    .filter(Boolean);
}

function normalizeOpenAIResponsesInput(messages = []) {
  return messages.map((msg) => ({
    role: msg?.role === "assistant" ? "assistant" : (msg?.role === "system" ? "system" : "user"),
    content: normalizeOpenAIResponsesContent(msg?.content)
  }));
}

function buildOpenAIResponsesRequestBody({ model, messages, responseFormat, temperature, maxTokens }) {
  const body = {
    model,
    input: normalizeOpenAIResponsesInput(messages),
    max_output_tokens: maxTokens
  };

  if (responseFormat?.type === "json_object") {
    body.text = { format: { type: "json_object" } };
  }

  return body;
}

function buildAnthropicRequestBody({ model, messages, temperature, maxTokens }) {
  return {
    model,
    system: "Respondé SOLO en JSON válido. Sin texto extra.",
    temperature: normalizeTemperature(temperature),
    max_tokens: maxTokens,
    messages: normalizeAnthropicMessages(messages)
  };
}

async function callOpenAI({ model, messages, responseFormat, temperature, maxTokens }) {
  if (!OPENAI_API_KEY) {
    return {
      ok: false,
      status: 500,
      data: { error: { message: "OPENAI_API_KEY no esta configurada" } },
      provider: "openai",
      model
    };
  }

  const useResponsesApi = shouldUseOpenAIResponsesApi(model);
  const endpoint = useResponsesApi
    ? "https://api.openai.com/v1/responses"
    : "https://api.openai.com/v1/chat/completions";
  const body = useResponsesApi
    ? buildOpenAIResponsesRequestBody({ model, messages, responseFormat, temperature, maxTokens })
    : buildOpenAIRequestBody({ model, messages, responseFormat, temperature, maxTokens });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));

  return {
    ok: response.ok,
    status: response.status,
    data,
    provider: "openai",
    model: data.model || model,
    api: useResponsesApi ? "responses" : "chat_completions"
  };
}

async function callAnthropic({ model, messages, temperature, maxTokens }) {
  if (!ANTHROPIC_API_KEY) {
    return {
      ok: false,
      status: 500,
      data: { error: { message: "ANTHROPIC_API_KEY no esta configurada" } },
      provider: "anthropic",
      model
    };
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildAnthropicRequestBody({
      model,
      messages,
      temperature,
      maxTokens
    }))
  });
  const data = await response.json().catch(() => ({}));

  return {
    ok: response.ok,
    status: response.status,
    data,
    provider: "anthropic",
    model: data.model || model
  };
}

function getAiResponseText(result = {}) {
  if (result.provider === "anthropic") {
    return (result.data?.content || [])
      .map((item) => item?.text || "")
      .filter(Boolean)
      .join("\n")
      .trim() || "{}";
  }

  if (result.provider === "openai" && result.api === "responses") {
    if (typeof result.data?.output_text === "string" && result.data.output_text.trim()) {
      return result.data.output_text.trim();
    }

    const outputItems = Array.isArray(result.data?.output) ? result.data.output : [];
    const textChunks = [];
    outputItems.forEach((item) => {
      const contents = Array.isArray(item?.content) ? item.content : [];
      contents.forEach((contentItem) => {
        if (typeof contentItem?.text === "string" && contentItem.text.trim()) {
          textChunks.push(contentItem.text.trim());
        }
      });
    });

    return textChunks.join("\n").trim() || "{}";
  }

  return result.data?.choices?.[0]?.message?.content ?? "{}";
}

function getAiUsage(result = {}) {
  if (result.provider === "anthropic") {
    return result.data?.usage
      ? {
          prompt_tokens: result.data.usage.input_tokens,
          completion_tokens: result.data.usage.output_tokens,
          total_tokens: Number(result.data.usage.input_tokens || 0) + Number(result.data.usage.output_tokens || 0),
          raw: result.data.usage
        }
      : undefined;
  }

  if (result.provider === "openai" && result.api === "responses") {
    const usage = result.data?.usage || {};
    const inputTokens = Number(usage.input_tokens || 0);
    const outputTokens = Number(usage.output_tokens || 0);
    return {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      raw: usage
    };
  }

  return result.data?.usage;
}

function getAiErrorMessage(result = {}) {
  return result.data?.error?.message
    || result.data?.error
    || `Error en ${result.provider || "proveedor IA"}`;
}

async function callAiProvider({ provider, model, messages, responseFormat, temperature, maxTokens }) {
  const normalizedProvider = normalizeProvider(provider);

  if (normalizedProvider === "anthropic") {
    return callAnthropic({ model, messages, temperature, maxTokens });
  }

  return callOpenAI({ model, messages, responseFormat, temperature, maxTokens });
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "zentra-backend",
    supabase_configured: Boolean(supabase),
    lemon_webhook_configured: Boolean(LEMON_WEBHOOK_SECRET),
    ai: {
      openai_configured: Boolean(OPENAI_API_KEY),
      anthropic_configured: Boolean(ANTHROPIC_API_KEY),
      base_provider: ZENTRA_BASE_PROVIDER,
      base_model: ZENTRA_BASE_MODEL,
      premium_provider: ZENTRA_PREMIUM_PROVIDER,
      premium_model: ZENTRA_PREMIUM_MODEL,
      premium_final_provider: ZENTRA_PREMIUM_FINAL_PROVIDER,
      premium_final_model: ZENTRA_PREMIUM_FINAL_MODEL
    }
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
      audit_credits_used: Number(existingUser?.audit_credits_used || 0),
      actions_used: Number(existingUser?.actions_used || 0),
      audits_used: Number(existingUser?.audits_used || 0),
      premium_chat_used: Number(existingUser?.premium_chat_used || 0),
      premium_pdf_used: Number(existingUser?.premium_pdf_used || 0),
      billing_cycle_start: Number(existingUser?.billing_cycle_start || Date.now())
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

    const user = planType === "subscription"
      ? await ensureFreshSubscriptionUsage(email)
      : await getUserByEmail(email, planType);

    if (hasUnlimitedAgencyOverride(email)) {
      if (planType === "subscription") {
        const subscriptionUser = applyUnlimitedAgencySubscriptionUser(email, user || {});
        return res.json({
          ...formatSubscriptionUsage(subscriptionUser),
          audit_credits: 0,
          audit_credits_used: 0,
          audit_credits_remaining: 0,
          found: true,
          unlimited_agency: true
        });
      }

      const auditUsage = getUnlimitedAuditUsage(email, user || {});
      return res.json({
        ...auditUsage,
        found: true
      });
    }

    if (!user || user.status === "cancelled") {
      return res.json({
        plan: "free",
        plan_type: planType,
        status: user?.status || "active",
        actions_used: 0,
        actions_limit: PLAN_LIMITS.free.actions,
        actions_remaining: PLAN_LIMITS.free.actions,
        audits_used: 0,
        audits_limit: PLAN_LIMITS.free.audits,
        audits_remaining: PLAN_LIMITS.free.audits,
        premium_chat_used: 0,
        premium_chat_limit: 0,
        premium_chat_remaining: 0,
        premium_pdf_used: 0,
        premium_pdf_limit: 0,
        premium_pdf_remaining: 0,
        billing_cycle_start: Date.now(),
        audit_credits: 0,
        audit_credits_used: 0,
        audit_credits_remaining: 0,
        found: Boolean(user)
      });
    }

    if (planType === "subscription") {
      return res.json({
        ...formatSubscriptionUsage(user),
        audit_credits: 0,
        audit_credits_used: 0,
        audit_credits_remaining: 0,
        found: true
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

app.get("/api/subscription/usage", async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email);

    if (!email) {
      return res.status(400).json({ error: "email es requerido" });
    }

    if (hasUnlimitedAgencyOverride(email)) {
      const user = await ensureFreshSubscriptionUsage(email);
      return res.json({
        ...formatSubscriptionUsage(user),
        found: true,
        unlimited_agency: true
      });
    }

    const user = await ensureFreshSubscriptionUsage(email);

    if (!user || user.status === "cancelled") {
      return res.json({
        ...formatSubscriptionUsage(getDefaultSubscriptionUser(email)),
        status: user?.status || "active",
        found: Boolean(user)
      });
    }

    return res.json({
      ...formatSubscriptionUsage(user),
      found: true
    });
  } catch (error) {
    console.error("[api:subscription:usage] Error consultando consumo:", error);
    return res.status(500).json({ error: "Error consultando consumo de suscripcion" });
  }
});

app.post("/api/subscription/consume", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const counterKey = String(req.body?.counter || "actions_used").trim();

    if (!email) {
      return res.status(400).json({ error: "email es requerido" });
    }

    const result = await consumeSubscriptionUsage(email, counterKey);

    if (!result.allowed) {
      const fallbackUser = result.user || await ensureFreshSubscriptionUsage(email);
      return res.status(403).json({
        allowed: false,
        reason: result.reason,
        ...formatSubscriptionUsage(fallbackUser || getDefaultSubscriptionUser(email))
      });
    }

    return res.json({
      allowed: true,
      ...formatSubscriptionUsage(result.user)
    });
  } catch (error) {
    console.error("[api:subscription:consume] Error consumiendo uso:", error);
    return res.status(500).json({ error: "Error consumiendo uso de suscripcion" });
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
      temperature = 0.7,
      response_format
    } = req.body;
    const incomingRouting = req.body?.zentra_routing || {};
    const incomingTaskType = incomingRouting.taskType || req.body?.task_type || "chat_basic";
    const incomingRequestedModel = req.body?.model || incomingRouting.selectedModel || null;
    const incomingReqBodyTaskType = req.body?.taskType || null;
    const incomingReqBodyModel = req.body?.model || null;
    const tracePdfFlow = isPdfFlowTask(incomingTaskType);
    const logPdfTrace = (payload = {}) => {
      if (!tracePdfFlow) return;
      console.log("[PDF FLOW]", payload);
    };
    if (tracePdfFlow) {
      console.log("===== PDF FLOW START =====");
      logPdfTrace({
        stage: "chat:entry",
        "incoming taskType": incomingTaskType,
        "req.body.taskType": incomingReqBodyTaskType,
        "incoming requested model": incomingRequestedModel,
        "req.body.model": incomingReqBodyModel
      });
    }
    const aiRouting = await resolveAiRoutingForRequest(req);
    let premiumFallbackError = null;
    const traceResolvedPdfFlow = tracePdfFlow || isPdfFlowTask(aiRouting.taskType);
    if (traceResolvedPdfFlow) {
      logPdfTrace({
        stage: "chat:routing_resolved",
        "incoming taskType": incomingTaskType,
        "req.body.taskType": incomingReqBodyTaskType,
        "incoming requested model": incomingRequestedModel,
        "req.body.model": incomingReqBodyModel,
        "resolved task": aiRouting.taskType,
        "aiRouting object": JSON.stringify(aiRouting),
        "resolved model": aiRouting.model,
        provider: aiRouting.provider,
        reason: aiRouting.reason
      });
    }
    console.log("[ZENTRA MODEL] OPENAI REQUEST MODEL:", {
      taskType: aiRouting.taskType,
      requestedModel: req.body?.model || req.body?.zentra_routing?.selectedModel || null,
      selectedModel: aiRouting.model,
      provider: aiRouting.provider,
      reason: aiRouting.reason
    });

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

    const providerMessages = [
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
    ];

    if (traceResolvedPdfFlow) {
      logPdfTrace({
        stage: "before callAiProvider",
        "incoming taskType": incomingTaskType,
        "incoming requested model": incomingRequestedModel,
        "resolved task": aiRouting.taskType,
        "resolved model": aiRouting.model,
        provider: aiRouting.provider,
        model: aiRouting.model
      });
    }

    let result = await callAiProvider({
      provider: aiRouting.provider,
      model: aiRouting.model,
      messages: providerMessages,
      responseFormat: response_format,
      temperature,
      maxTokens: aiRouting.maxTokens
    });
    if (traceResolvedPdfFlow) {
      logPdfTrace({
        stage: "after callAiProvider",
        "incoming taskType": incomingTaskType,
        "incoming requested model": incomingRequestedModel,
        "resolved task": aiRouting.taskType,
        "resolved model": aiRouting.model,
        provider: result.provider || aiRouting.provider,
        "response.model": result.model || null,
        ok: Boolean(result.ok),
        status: Number(result.status || 0)
      });
    }

    if (!result.ok && aiRouting.premiumActive && aiRouting.fallbackModel) {
      premiumFallbackError = getAiErrorMessage(result);
      console.warn("[api:chat] Modelo premium fallo. Reintentando con fallback base.", {
        taskType: aiRouting.taskType,
        premiumProvider: aiRouting.provider,
        premiumModel: aiRouting.model,
        fallbackProvider: aiRouting.fallbackProvider,
        fallbackModel: aiRouting.fallbackModel,
        status: result.status,
        error: premiumFallbackError
      });

      if (traceResolvedPdfFlow) {
        logPdfTrace({
          stage: "before callAiProvider fallback",
          "incoming taskType": incomingTaskType,
          "incoming requested model": incomingRequestedModel,
          "resolved task": aiRouting.taskType,
          "resolved model": aiRouting.fallbackModel,
          provider: aiRouting.fallbackProvider,
          model: aiRouting.fallbackModel
        });
      }

      result = await callAiProvider({
        provider: aiRouting.fallbackProvider,
        model: aiRouting.fallbackModel,
        messages: providerMessages,
        responseFormat: response_format,
        temperature,
        maxTokens: aiRouting.maxTokens
      });
      if (traceResolvedPdfFlow) {
        logPdfTrace({
          stage: "after callAiProvider fallback",
          "incoming taskType": incomingTaskType,
          "incoming requested model": incomingRequestedModel,
          "resolved task": aiRouting.taskType,
          "resolved model": aiRouting.fallbackModel,
          provider: result.provider || aiRouting.fallbackProvider,
          "response.model": result.model || null,
          ok: Boolean(result.ok),
          status: Number(result.status || 0)
        });
      }
      aiRouting.provider = aiRouting.fallbackProvider;
      aiRouting.model = aiRouting.fallbackModel;
      aiRouting.premiumActive = false;
      aiRouting.reason = "premium_failed_fallback_used";
    }

    if (!result.ok) {
      if (traceResolvedPdfFlow) {
        logPdfTrace({
          stage: "chat:error_response",
          "incoming taskType": incomingTaskType,
          "incoming requested model": incomingRequestedModel,
          "resolved task": aiRouting.taskType,
          "resolved model": aiRouting.model,
          provider: result.provider || aiRouting.provider,
          "response.model": result.model || null,
          ok: Boolean(result.ok),
          status: Number(result.status || 0)
        });
        console.log("===== PDF FLOW END =====");
      }
      return res.status(result.status).json({
        error: getAiErrorMessage(result),
        provider: result.provider,
        raw: result.data
      });
    }

    const content = getAiResponseText(result);
    const parsed = parseJsonSafely(content);
    console.log("[ZENTRA MODEL] OPENAI RESPONSE MODEL:", {
      taskType: aiRouting.taskType,
      requestedModel: req.body?.model || req.body?.zentra_routing?.selectedModel || null,
      selectedModel: aiRouting.model,
      actualModel: result.model,
      provider: result.provider
    });
    if (traceResolvedPdfFlow) {
      logPdfTrace({
        stage: "chat:success_response",
        "incoming taskType": incomingTaskType,
        "incoming requested model": incomingRequestedModel,
        "resolved task": aiRouting.taskType,
        "resolved model": aiRouting.model,
        provider: result.provider,
        "response.model": result.model || null,
        ok: true,
        status: Number(result.status || 200)
      });
      console.log("===== PDF FLOW END =====");
    }

    res.json({
      success: true,
      analysis: parsed,
      raw_content: content,
      usage: getAiUsage(result),
      provider: result.provider,
      model: result.model,
      id: result.data?.id,
      zentra_routing: {
        taskType: aiRouting.taskType,
        provider: aiRouting.provider,
        model: aiRouting.model,
        premiumActive: aiRouting.premiumActive,
        premiumConsumed: aiRouting.premiumConsumed,
        counterKey: aiRouting.counterKey,
        reason: aiRouting.reason,
        premiumFallbackError
      }
    });

  } catch (error) {
    try {
      const incomingRouting = req.body?.zentra_routing || {};
      const incomingTaskType = incomingRouting.taskType || req.body?.task_type || "chat_basic";
      if (isPdfFlowTask(incomingTaskType)) {
        console.log("[PDF FLOW]", {
          stage: "chat:exception",
          "incoming taskType": incomingTaskType,
          "req.body.taskType": req.body?.taskType || null,
          "incoming requested model": req.body?.model || incomingRouting.selectedModel || null,
          error: error?.message || String(error || "unknown_error")
        });
        console.log("===== PDF FLOW END =====");
      }
    } catch (_) {}
    console.error(error);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
