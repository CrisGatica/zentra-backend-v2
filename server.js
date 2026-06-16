import express from "express";
import cors from "cors";
import fetch, { File, FormData } from "node-fetch";
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
const ZENTRA_BASE_MODEL = process.env.ZENTRA_BASE_MODEL || "gpt-5-mini";
const ZENTRA_PREMIUM_MODEL = process.env.ZENTRA_PREMIUM_MODEL || "gpt-5.4-mini";
const ZENTRA_PREMIUM_FINAL_MODEL = process.env.ZENTRA_PREMIUM_FINAL_MODEL || "gpt-5";
const ZENTRA_EXECUTIVE_REFINER_ENABLED = String(process.env.ZENTRA_EXECUTIVE_REFINER_ENABLED || "false").trim().toLowerCase() === "true";
const ZENTRA_EXECUTIVE_REFINER_PROVIDER = normalizeProvider(process.env.ZENTRA_EXECUTIVE_REFINER_PROVIDER || ZENTRA_PREMIUM_FINAL_PROVIDER);
const ZENTRA_EXECUTIVE_REFINER_MODEL = process.env.ZENTRA_EXECUTIVE_REFINER_MODEL || ZENTRA_PREMIUM_FINAL_MODEL;
const ZENTRA_EXECUTIVE_REFINER_MAX_TOKENS = Math.max(
  256,
  normalizeCounterValue(process.env.ZENTRA_EXECUTIVE_REFINER_MAX_TOKENS || 900) || 900
);
const ZENTRA_EXECUTIVE_REFINER_TEMPERATURE = normalizeTemperature(process.env.ZENTRA_EXECUTIVE_REFINER_TEMPERATURE || 0.2);
const ZENTRA_CHAT_FAST_PROVIDER = normalizeProvider(process.env.ZENTRA_CHAT_FAST_PROVIDER || ZENTRA_BASE_PROVIDER);
const ZENTRA_CHAT_FAST_MODEL = process.env.ZENTRA_CHAT_FAST_MODEL || ZENTRA_BASE_MODEL;
const ZENTRA_CHAT_REASONING_PROVIDER = normalizeProvider(process.env.ZENTRA_CHAT_REASONING_PROVIDER || ZENTRA_PREMIUM_PROVIDER);
const ZENTRA_CHAT_REASONING_MODEL = process.env.ZENTRA_CHAT_REASONING_MODEL || ZENTRA_PREMIUM_MODEL;
const ZENTRA_CHAT_REASONING_MAX_TOKENS = Math.max(
  512,
  normalizeCounterValue(process.env.ZENTRA_CHAT_REASONING_MAX_TOKENS || 1800) || 1800
);
const ZENTRA_CHAT_EXECUTIVE_ENABLED = String(process.env.ZENTRA_CHAT_EXECUTIVE_ENABLED || "false").trim().toLowerCase() !== "false";
const ZENTRA_CHAT_EXECUTIVE_PROVIDER = normalizeProvider(process.env.ZENTRA_CHAT_EXECUTIVE_PROVIDER || ZENTRA_PREMIUM_FINAL_PROVIDER);
const ZENTRA_CHAT_EXECUTIVE_MODEL = process.env.ZENTRA_CHAT_EXECUTIVE_MODEL || ZENTRA_PREMIUM_MODEL;
const ZENTRA_CHAT_EXECUTIVE_MAX_TOKENS = Math.max(
  256,
  normalizeCounterValue(process.env.ZENTRA_CHAT_EXECUTIVE_MAX_TOKENS || 1200) || 1200
);
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
  starter: { actions: 300, audits: 5 },
  pro: { actions: 800, audits: 10 },
  agency: { actions: 3000, audits: 30 }
};

const PREMIUM_LIMITS = {
  free: { premium_chat_used: 3, premium_pdf_used: 0 },
  starter: { premium_chat_used: 30, premium_pdf_used: 0 },
  pro: { premium_chat_used: 100, premium_pdf_used: 30 },
  agency: { premium_chat_used: 300, premium_pdf_used: 80 }
};
const TEMP_UNLIMITED_LIMIT = 999999;
const TEMP_UNLIMITED_AGENCY_EMAILS = new Set([
  "cristiangaticanegocios@gmail.com"
]);

const AI_TASK_ROUTING = {
  chat_basic: {
    provider: ZENTRA_CHAT_FAST_PROVIDER,
    model: ZENTRA_CHAT_FAST_MODEL,
    premium: false,
    maxTokens: 4096
  },
  chat_image_ocr: {
    provider: ZENTRA_CHAT_FAST_PROVIDER,
    model: ZENTRA_CHAT_FAST_MODEL,
    premium: false,
    maxTokens: 4096
  },
  chat_premium: {
    provider: ZENTRA_CHAT_REASONING_PROVIDER,
    model: ZENTRA_CHAT_REASONING_MODEL,
    fallbackProvider: ZENTRA_CHAT_FAST_PROVIDER,
    fallbackModel: ZENTRA_CHAT_FAST_MODEL,
    premium: true,
    counterKey: "advanced_actions_used",
    allowedPlans: ["free", "starter", "pro", "agency"],
    maxTokens: ZENTRA_CHAT_REASONING_MAX_TOKENS
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
    provider: ZENTRA_PREMIUM_PROVIDER,
    model: ZENTRA_PREMIUM_MODEL,
    fallbackProvider: ZENTRA_BASE_PROVIDER,
    fallbackModel: ZENTRA_BASE_MODEL,
    premium: true,
    counterKey: "premium_pdf_used",
    allowedPlans: ["agency"],
    maxTokens: 3072
  },
  premium_reasoning_audit: {
    provider: ZENTRA_PREMIUM_PROVIDER,
    model: ZENTRA_PREMIUM_MODEL,
    fallbackProvider: ZENTRA_BASE_PROVIDER,
    fallbackModel: ZENTRA_BASE_MODEL,
    premium: true,
    counterKey: "premium_pdf_used",
    allowedPlans: ["pro", "agency"],
    maxTokens: 2200
  },
  executive_refiner_pdf: {
    provider: ZENTRA_EXECUTIVE_REFINER_PROVIDER,
    model: ZENTRA_EXECUTIVE_REFINER_MODEL,
    fallbackProvider: ZENTRA_PREMIUM_FINAL_PROVIDER,
    fallbackModel: ZENTRA_PREMIUM_FINAL_MODEL,
    premium: true,
    counterKey: "premium_pdf_used",
    allowedPlans: ["pro", "agency"],
    maxTokens: ZENTRA_EXECUTIVE_REFINER_MAX_TOKENS
  }
};
const PDF_FLOW_TASKS = new Set([
  "seo_analysis",
  "pdf_summary",
  "pdf_polish",
  "premium_reasoning_audit",
  "executive_refiner_pdf"
]);
const USER_ACCESS_HAS_AUTH_USER_ID = String(process.env.USER_ACCESS_HAS_AUTH_USER_ID || "").toLowerCase() === "true";
const USER_ACCESS_SELECT_FIELDS = [
  "id",
  ...(USER_ACCESS_HAS_AUTH_USER_ID ? ["auth_user_id"] : []),
  "email",
  "plan",
  "plan_type",
  "status",
  "audit_credits",
  "audit_credits_used",
  "actions_used",
  "audits_used",
  "premium_chat_used",
  "premium_pdf_used",
  "extra_actions_balance",
  "extra_audits_balance",
  "extra_actions_used_cycle",
  "extra_audits_used_cycle",
  "extra_actions_purchased_total",
  "extra_audits_purchased_total",
  "purchase_history",
  "billing_cycle_start",
  "updated_at"
].join(", ");
let PREMIUM_AUDIT_ROUTE_HIT_COUNT = 0;
const DESKTOP_TRANSCRIPTION_MODEL = process.env.ZENTRA_DESKTOP_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";

const LEMON_PRODUCTS = {
  SAAS: {
    starter_monthly: {
      productId: 1073703,
      variantId: 1683122,
      link: "https://tryzentra.lemonsqueezy.com/checkout/buy/21aecf13-832a-491f-89fd-fd9b156caefd",
      actions: 300,
      audits: 5
    },
    starter_yearly: {
      productId: 1073699,
      variantId: 1683117,
      link: "https://tryzentra.lemonsqueezy.com/checkout/buy/6f68c93e-3ed7-439b-afd0-eea51e2b539a",
      actions: 300,
      audits: 5
    },
    pro_monthly: {
      productId: 1073694,
      variantId: 1683111,
      link: "https://tryzentra.lemonsqueezy.com/checkout/buy/eed650b0-8365-40a1-a09e-72eeb3692fc4",
      actions: 800,
      audits: 10
    },
    pro_yearly: {
      productId: 1073685,
      variantId: 1683097,
      link: "https://tryzentra.lemonsqueezy.com/checkout/buy/83236d4b-ca5a-4ab9-b962-20ba32abba40",
      actions: 800,
      audits: 10
    },
    agency_monthly: {
      productId: 1073671,
      variantId: 1683071,
      link: "https://tryzentra.lemonsqueezy.com/checkout/buy/a1505c0f-e6f2-45b0-8454-8185368da11d",
      actions: 3000,
      audits: 30
    },
    agency_yearly: {
      productId: 1073676,
      variantId: 1683081,
      link: "https://tryzentra.lemonsqueezy.com/checkout/buy/3b8b9482-8cd2-49f3-b459-75fb267fab78",
      actions: 3000,
      audits: 30
    }
  },
  AUDIT: {
    auditStarter: {
      productId: 1073733,
      variantId: 1683161,
      link: "https://tryzentra.lemonsqueezy.com/checkout/buy/05464642-b8eb-4fb8-ac8a-1e646531a502",
      pages: 5
    },
    auditPro: {
      productId: 1073731,
      variantId: 1683159,
      link: "https://tryzentra.lemonsqueezy.com/checkout/buy/2deb6b4e-04e6-4185-a9d5-03b5e720b3f8",
      pages: 7
    },
    auditAgency: {
      productId: 1023507,
      variantId: 1605502,
      link: "https://tryzentra.lemonsqueezy.com/checkout/buy/b925afce-d61a-4b54-9f21-5212a2451208",
      pages: 11
    }
  },
  EXTRAS: {
    growth: {
      productId: 1073777,
      variantId: 1683224,
      link: "https://tryzentra.lemonsqueezy.com/checkout/buy/35c0bd93-8328-441b-b085-0d095ffc3922",
      actions: 300,
      audits: 5,
      price: 19
    },
    scale: {
      productId: 1073780,
      variantId: 1683227,
      link: "https://tryzentra.lemonsqueezy.com/checkout/buy/493c4cd5-661a-4319-a001-b27da103376a",
      actions: 700,
      audits: 15,
      price: 39
    },
    unlimited: {
      productId: 1073781,
      variantId: 1683228,
      link: "https://tryzentra.lemonsqueezy.com/checkout/buy/922b0487-7962-448d-aaf1-ab0725d091c0",
      actions: 1500,
      audits: 30,
      price: 59
    }
  }
};

function getPlanFromLemonKey(productKey = "") {
  const key = String(productKey || "").toLowerCase();
  if (key.includes("agency")) return "agency";
  if (key.includes("pro")) return "pro";
  if (key.includes("starter")) return "starter";
  return "free";
}

function createLemonMapping(productFamily = "SAAS", productKey = "", config = {}) {
  const family = String(productFamily || "SAAS").toUpperCase();
  const isAudit = family === "AUDIT";
  const isExtra = family === "EXTRAS";
  const plan = isExtra ? "agency" : getPlanFromLemonKey(productKey);

  return {
    plan,
    plan_type: isAudit ? "audit" : (isExtra ? "extra" : "subscription"),
    product_key: productKey,
    product_family: isAudit ? "audit" : (isExtra ? "extra" : "subscription"),
    checkout_link: config.link || "",
    actions: normalizeCounterValue(config.actions),
    audits: normalizeCounterValue(config.audits),
    pages: normalizeCounterValue(config.pages),
    price: normalizeCounterValue(config.price)
  };
}

function buildLemonMaps() {
  const productMap = {};
  const variantMap = {};

  Object.entries(LEMON_PRODUCTS).forEach(([family, products]) => {
    Object.entries(products || {}).forEach(([productKey, config]) => {
      const mapping = createLemonMapping(family, productKey, config);
      const productId = normalizeLemonId(config.productId);
      const variantId = normalizeLemonId(config.variantId);

      if (productId) productMap[productId] = mapping;
      if (variantId) variantMap[variantId] = mapping;
    });
  });

  return { productMap, variantMap };
}

function buildDefaultAgencyCapacityPacks() {
  return Object.entries(LEMON_PRODUCTS.EXTRAS || {})
    .map(([packId, config], index) => normalizeCapacityPackRecord({
      packId,
      label: `+${normalizeCounterValue(config.audits)} auditorias +${normalizeCounterValue(config.actions)} acciones`,
      lemonCheckoutUrl: config.link,
      extraActions: config.actions,
      extraAudits: config.audits,
      productId: config.productId,
      variantId: config.variantId
    }, index))
    .filter(Boolean);
}

const { productMap: LEMON_PRODUCT_MAP, variantMap: LEMON_VARIANT_MAP } = buildLemonMaps();

function normalizeCapacityPackRecord(rawPack = {}, index = 0) {
  const packId = String(rawPack.packId || rawPack.id || `agency-pack-${index + 1}`).trim();
  const lemonCheckoutUrl = String(rawPack.lemonCheckoutUrl || rawPack.checkoutUrl || rawPack.url || "").trim();
  const extraActions = normalizeCounterValue(rawPack.extraActions || rawPack.actions || 0);
  const extraAudits = normalizeCounterValue(rawPack.extraAudits || rawPack.audits || 0);
  const productIds = Array.isArray(rawPack.productIds)
    ? rawPack.productIds.map((value) => normalizeLemonId(value)).filter(Boolean)
    : (rawPack.productId ? [normalizeLemonId(rawPack.productId)] : []);
  const variantIds = Array.isArray(rawPack.variantIds)
    ? rawPack.variantIds.map((value) => normalizeLemonId(value)).filter(Boolean)
    : (rawPack.variantId ? [normalizeLemonId(rawPack.variantId)] : []);
  const label = String(rawPack.label || `+${extraAudits} auditorias +${extraActions} acciones`).trim();

  if (!packId || !lemonCheckoutUrl || (!extraActions && !extraAudits)) {
    return null;
  }

  return {
    packId,
    label,
    lemonCheckoutUrl,
    extraActions,
    extraAudits,
    productIds,
    variantIds
  };
}

function parseAgencyCapacityPacksConfig() {
  const rawConfig = String(process.env.ZENTRA_AGENCY_CAPACITY_PACKS_JSON || "").trim();
  if (!rawConfig) return [];

  try {
    const parsed = JSON.parse(rawConfig);
    const packs = Array.isArray(parsed) ? parsed : [];
    return packs
      .map((pack, index) => normalizeCapacityPackRecord(pack, index))
      .filter(Boolean);
  } catch (error) {
    console.error("[capacity:packs] No se pudo parsear ZENTRA_AGENCY_CAPACITY_PACKS_JSON:", error);
    return [];
  }
}

const DEFAULT_AGENCY_CAPACITY_PACKS = buildDefaultAgencyCapacityPacks();
const AGENCY_CAPACITY_PACKS = DEFAULT_AGENCY_CAPACITY_PACKS.length
  ? DEFAULT_AGENCY_CAPACITY_PACKS
  : parseAgencyCapacityPacksConfig();

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

function normalizeAuthUserId(value = "") {
  return String(value || "").trim();
}

function normalizeIdentityInput(identity = {}, fallbackEmail = "") {
  if (typeof identity === "string") {
    return {
      email: normalizeEmail(identity),
      userId: "",
      identitySource: identity ? "email" : "unknown"
    };
  }

  const raw = identity || {};
  const email = normalizeEmail(
    raw.email ||
    raw.userEmail ||
    raw.customer_email ||
    raw.zentra_user_email ||
    fallbackEmail ||
    ""
  );
  const userId = normalizeAuthUserId(
    raw.userId ||
    raw.user_id ||
    raw.auth_user_id ||
    raw.zentra_user_id ||
    raw.id ||
    ""
  );
  const identitySource = String(raw.identitySource || raw.identity_source || "").trim() || (userId ? "auth_user_id" : (email ? "email" : "unknown"));

  return {
    email,
    userId,
    identitySource
  };
}

function getIdentityFromRequest(req = {}, routing = {}) {
  const body = req?.body || {};
  const query = req?.query || {};
  const email = normalizeEmail(
    body.zentra_user_email ||
    body.user_email ||
    query.email ||
    routing.email ||
    routing.userEmail ||
    ""
  );
  const userId = normalizeAuthUserId(
    body.zentra_user_id ||
    body.user_id ||
    body.auth_user_id ||
    query.user_id ||
    query.auth_user_id ||
    routing.userId ||
    routing.authUserId ||
    ""
  );
  const identitySource = body.zentra_user_id || body.user_id || body.auth_user_id
    ? "body.user_id"
    : (query.user_id || query.auth_user_id)
      ? "query.user_id"
      : (routing.userId || routing.authUserId)
        ? "routing.user_id"
        : (email ? "email" : "unknown");

  return {
    email,
    userId,
    identitySource
  };
}

async function fetchAuthUserById(userId = "") {
  const normalizedUserId = normalizeAuthUserId(userId);
  if (!normalizedUserId || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !supabase?.auth?.admin?.getUserById) {
    return null;
  }

  try {
    const { data, error } = await supabase.auth.admin.getUserById(normalizedUserId);
    if (error) return null;
    return data?.user || null;
  } catch (_) {
    return null;
  }
}

async function resolveIdentityContext(identity = {}, planType = "subscription") {
  const normalizedIdentity = normalizeIdentityInput(identity);
  let authUser = null;

  if (normalizedIdentity.userId) {
    authUser = await fetchAuthUserById(normalizedIdentity.userId);
    if (!normalizedIdentity.email) {
      normalizedIdentity.email = normalizeEmail(authUser?.email || "");
    }
  }

  return {
    ...normalizedIdentity,
    planType,
    authUser,
    isEmailConfirmed: Boolean(authUser?.email_confirmed_at || authUser?.confirmed_at),
    emailConfirmedAt: authUser?.email_confirmed_at || null,
    confirmedAt: authUser?.confirmed_at || null,
    lastSignInAt: authUser?.last_sign_in_at || null
  };
}

function buildAuthDebugPayload({
  emailFromFrontend = "",
  identity = {},
  plan = null,
  usageRow = null,
  authUser = null,
  extra = {}
} = {}) {
  const normalizedIdentity = normalizeIdentityInput(identity);
  return {
    emailFromFrontend: normalizeEmail(emailFromFrontend),
    resolvedEmail: normalizedIdentity.email || null,
    userId: normalizedIdentity.userId || null,
    plan: plan || usageRow?.plan || null,
    usageRowId: usageRow?.id || null,
    isEmailConfirmed: authUser ? Boolean(authUser.email_confirmed_at || authUser.confirmed_at) : null,
    emailConfirmedAt: authUser?.email_confirmed_at || null,
    confirmedAt: authUser?.confirmed_at || null,
    lastSignInAt: authUser?.last_sign_in_at || null,
    identitySource: normalizedIdentity.identitySource || null,
    ...extra
  };
}

function buildUsageDebugPayload(user = {}, extra = {}) {
  const usage = formatSubscriptionUsage(user || {});
  return {
    actionsUsed: Number(usage.actions_used || 0),
    actionsLimit: Number(usage.actions_limit || 0),
    premiumChatUsed: Number(usage.premium_chat_used || 0),
    advancedActionsUsed: Number(usage.advanced_actions_used || usage.premium_chat_used || 0),
    advancedActionsLimit: Number(usage.advanced_actions_limit || usage.premium_chat_limit || 0),
    advancedActionsRemaining: Number(usage.advanced_actions_remaining || usage.advancedActionsRemaining || 0),
    ...extra
  };
}

async function logAuthDebug(context = {}) {
  console.log("[AUTH DEBUG]", context);
}

function logUsageDebug(context = {}) {
  console.log("[USAGE DEBUG]", context);
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

function normalizeAdvancedChatCounterKey(counterKey = "") {
  const normalized = String(counterKey || "").trim();
  if (!normalized) return "";
  if (normalized === "premium_chat_used" || normalized === "premiumChatUsed") return "advanced_actions_used";
  if (normalized === "advancedActionsUsed" || normalized === "advanced_actions" || normalized === "advancedActions") return "advanced_actions_used";
  return normalized;
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

async function resolveAiRoutingForRequest(req, options = {}) {
  const { consumePremium = true } = options;
  const routing = req.body?.zentra_routing || {};
  const incomingTaskType = routing.taskType || req.body?.task_type || "chat_basic";
  const taskType = normalizeTaskType(incomingTaskType);
  const route = AI_TASK_ROUTING[taskType] || AI_TASK_ROUTING.chat_basic;
  const maxTokens = clampMaxTokens(req.body?.max_tokens || routing.maxTokens, taskType);
  const planType = getPlanTypeFromChatRequest(req, routing);
  const identityRequest = getIdentityFromRequest(req, routing);
  const authContext = await resolveIdentityContext(identityRequest, planType);
  const email = authContext.email || getEmailFromChatRequest(req, routing);
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

  await logAuthDebug(buildAuthDebugPayload({
    emailFromFrontend: getEmailFromChatRequest(req, routing),
    identity: authContext,
    plan: planType,
    authUser: authContext.authUser,
    extra: {
      route: "chat",
      taskType: incomingTaskType,
      resolvedTask: taskType,
      requestedModel,
      isEmailConfirmed: authContext.isEmailConfirmed
    }
  }));

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
    premiumAvailable: false,
    premiumActive: false,
    premiumConsumed: false,
    premiumAllowed: false,
    premiumQuotaAvailable: false,
    premiumFallbackReason: null,
    counterKey: route.counterKey || null,
    advancedActionsUsed: 0,
    advancedActionsLimit: 0,
    advancedActionsRemaining: 0,
    planType,
    userId: authContext.userId || null,
    authUserId: authContext.userId || null,
    identitySource: authContext.identitySource || null,
    isEmailConfirmed: authContext.isEmailConfirmed,
    emailConfirmedAt: authContext.emailConfirmedAt || null,
    confirmedAt: authContext.confirmedAt || null,
    lastSignInAt: authContext.lastSignInAt || null,
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
        premiumAvailable: true,
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

    const auditUser = await getUserByIdentity(authContext, "audit");
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
      premiumAvailable: true,
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

  const user = await ensureFreshSubscriptionUsage(authContext);
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

  const usage = formatSubscriptionUsage(user);
  const limitMap = {
    premium_chat_used: usage.premium_chat_limit,
    advanced_actions_used: usage.advanced_actions_limit ?? usage.premium_chat_limit,
    premium_pdf_used: usage.premium_pdf_limit
  };
  const currentUsed = normalizeCounterValue(usage[route.counterKey] ?? user[route.counterKey]);
  const limit = normalizeCounterValue(limitMap[route.counterKey]);
  const premiumQuotaAvailable = route.counterKey ? currentUsed < limit : false;
  const premiumFallbackReason = premiumQuotaAvailable ? null : "advanced_quota_exceeded";

  if (route.counterKey === "advanced_actions_used" && !premiumQuotaAvailable) {
    logPdfFlow("resolve:advanced_quota_exceeded", {
      provider: resolved.provider,
      resolvedModel: resolved.model,
      reason: premiumFallbackReason,
      plan,
      used: currentUsed,
      limit
    });
    return {
      ...resolved,
      plan,
      premiumAvailable: true,
      premiumActive: false,
      premiumConsumed: false,
      premiumAllowed: false,
      premiumQuotaAvailable: false,
      premiumFallbackReason,
      advancedActionsUsed: currentUsed,
      advancedActionsLimit: limit,
      advancedActionsRemaining: 0,
      reason: premiumFallbackReason
    };
  }

  if (!consumePremium) {
    if (hasUnlimitedAgencyOverride(email)) {
      const previewPremium = {
        ...resolved,
        plan,
        provider: premiumProvider,
        model: premiumModel,
        premiumAvailable: true,
        premiumActive: false,
        premiumConsumed: false,
        premiumAllowed: true,
        premiumQuotaAvailable: true,
        premiumFallbackReason: null,
        reason: "premium_available_unlimited_override"
      };
      logPdfFlow("resolve:premium_available_unlimited_override", {
        provider: previewPremium.provider,
        resolvedModel: previewPremium.model,
        reason: previewPremium.reason,
        plan
      });
      return previewPremium;
    }

    if (currentUsed >= limit) {
      logPdfFlow("resolve:premium_limit_reached_preview", {
        provider: resolved.provider,
        resolvedModel: resolved.model,
        reason: "premium_limit_reached",
        plan
      });
      return {
        ...resolved,
        plan,
        premiumAllowed: false,
        premiumQuotaAvailable: false,
        premiumFallbackReason,
        advancedActionsUsed: currentUsed,
        advancedActionsLimit: limit,
        advancedActionsRemaining: 0,
        reason: "premium_limit_reached"
      };
    }

    const previewPremium = {
      ...resolved,
      plan,
      provider: premiumProvider,
      model: premiumModel,
      premiumAvailable: true,
      premiumActive: false,
      premiumConsumed: false,
      premiumAllowed: true,
      premiumQuotaAvailable: true,
      premiumFallbackReason: null,
      advancedActionsUsed: currentUsed,
      advancedActionsLimit: limit,
      advancedActionsRemaining: Math.max(limit - currentUsed, 0),
      reason: "premium_available"
    };
    logPdfFlow("resolve:premium_available", {
      provider: previewPremium.provider,
      resolvedModel: previewPremium.model,
      reason: previewPremium.reason,
      plan
    });
    return previewPremium;
  }

  const premiumUsage = await consumeSubscriptionUsage(authContext, route.counterKey);
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
      premiumAllowed: false,
      premiumQuotaAvailable: false,
      premiumFallbackReason: premiumUsage.reason || premiumFallbackReason,
      advancedActionsUsed: currentUsed,
      advancedActionsLimit: limit,
      advancedActionsRemaining: Math.max(limit - currentUsed, 0),
      reason: premiumUsage.reason || "premium_limit_reached"
    };
  }

  const resolvedPremium = {
    ...resolved,
    plan,
    provider: premiumProvider,
    model: premiumModel,
    premiumAvailable: true,
    premiumActive: true,
    premiumConsumed: true,
    premiumAllowed: true,
    premiumQuotaAvailable: true,
    premiumFallbackReason: null,
    advancedActionsUsed: currentUsed + 1,
    advancedActionsLimit: limit,
    advancedActionsRemaining: Math.max(limit - (currentUsed + 1), 0),
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

  if (value.includes("extra") || value.includes("capacity") || value.includes("capacidad")) return "extra";
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
    product_key: idMapping?.product_key || "",
    product_family: idMapping?.product_family || family,
    checkout_link: idMapping?.checkout_link || "",
    actions: normalizeCounterValue(idMapping?.actions),
    audits: normalizeCounterValue(idMapping?.audits),
    pages: normalizeCounterValue(idMapping?.pages),
    price: normalizeCounterValue(idMapping?.price),
    lemon_id: data.id || "",
    lemon_type: data.type || "",
    lemon_status: attributes.status || ""
  };
}

function getAgencyCapacityPackByLemonIds({ productId = "", variantId = "" } = {}) {
  const normalizedProductId = normalizeLemonId(productId);
  const normalizedVariantId = normalizeLemonId(variantId);

  return AGENCY_CAPACITY_PACKS.find((pack) =>
    pack.variantIds.includes(normalizedVariantId) ||
    pack.productIds.includes(normalizedProductId)
  ) || null;
}

function serializeAgencyCapacityPack(pack = {}) {
  return {
    packId: pack.packId,
    label: pack.label,
    extraActions: normalizeCounterValue(pack.extraActions),
    extraAudits: normalizeCounterValue(pack.extraAudits),
    checkoutUrl: String(pack.lemonCheckoutUrl || "").trim()
  };
}

async function grantSubscriptionCapacityUpgrade(paymentInfo = {}, pack = null) {
  if (!pack || !paymentInfo.email) {
    throw new Error("Capacity pack invalido");
  }

  const email = normalizeEmail(paymentInfo.email);
  const existingUser = await getUserByEmail(email, "subscription");
  const isAgency = normalizePlan(existingUser?.plan || "free") === "agency" && String(existingUser?.status || "active") === "active";

  if (!isAgency && !hasUnlimitedAgencyOverride(email)) {
    await recordPaymentLog("extraRejected", paymentInfo, {
      reason: "extra_requires_agency",
      packId: pack.packId
    });

    return {
      user: existingUser || getDefaultSubscriptionUser(email),
      skipped: true,
      reason: "extra_requires_agency"
    };
  }

  const result = await addCreditsByEmail(email, pack.extraActions, pack.extraAudits, {
    type: "agency_extra",
    packId: pack.packId,
    productFamily: paymentInfo.product_family || "extra",
    productKey: paymentInfo.product_key || pack.packId,
    lemonOrderId: paymentInfo.lemon_id || "",
    productId: paymentInfo.product_id || "",
    variantId: paymentInfo.variant_id || ""
  });

  if (!result.duplicate) {
    await recordPaymentLog("creditsAdded", paymentInfo, {
      packId: pack.packId,
      extraActions: normalizeCounterValue(pack.extraActions),
      extraAudits: normalizeCounterValue(pack.extraAudits)
    });
    await recordPaymentLog("extraAdded", paymentInfo, {
      packId: pack.packId,
      totalActionsAfterUpgrade: formatSubscriptionUsage(result.user).totalActionsAfterUpgrade,
      totalAuditsAfterUpgrade: formatSubscriptionUsage(result.user).totalAuditsAfterUpgrade
    });
  }

  return result;
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
  const normalizedIdentity = normalizeIdentityInput({
    email: userData.email || userData.customer_email || "",
    userId: userData.auth_user_id || userData.user_id || ""
  });
  const payload = {
    email: normalizedIdentity.email,
    auth_user_id: normalizedIdentity.userId || null,
    plan: normalizePlan(userData.plan),
    plan_type: userData.plan_type,
    status: userData.status,
    audit_credits: normalizeCounterValue(userData.audit_credits),
    audit_credits_used: normalizeCounterValue(userData.audit_credits_used),
    actions_used: normalizeCounterValue(userData.actions_used),
    audits_used: normalizeCounterValue(userData.audits_used),
    premium_chat_used: normalizeCounterValue(userData.premium_chat_used),
    premium_pdf_used: normalizeCounterValue(userData.premium_pdf_used),
    extra_actions_balance: normalizeCounterValue(userData.extra_actions_balance),
    extra_audits_balance: normalizeCounterValue(userData.extra_audits_balance),
    extra_actions_used_cycle: normalizeCounterValue(userData.extra_actions_used_cycle),
    extra_audits_used_cycle: normalizeCounterValue(userData.extra_audits_used_cycle),
    extra_actions_purchased_total: normalizeCounterValue(userData.extra_actions_purchased_total),
    extra_audits_purchased_total: normalizeCounterValue(userData.extra_audits_purchased_total),
    purchase_history: normalizePurchaseHistory(userData.purchase_history),
    billing_cycle_start: normalizeCounterValue(userData.billing_cycle_start || Date.now()),
    updated_at: new Date().toISOString()
  };
  const storagePayload = { ...payload };
  if (!USER_ACCESS_HAS_AUTH_USER_ID) {
    delete storagePayload.auth_user_id;
  }

  const normalizedPlanType = payload.plan_type === "audit" ? "audit" : "subscription";
  const existingUser = await getUserByIdentity({
    email: payload.email,
    userId: payload.auth_user_id
  }, normalizedPlanType);

  if (existingUser?.id) {
    const { data, error } = await client
      .from("users")
      .update(storagePayload)
      .eq("id", existingUser.id)
      .select(USER_ACCESS_SELECT_FIELDS)
      .single();

    if (error) {
      throw error;
    }

    return data;
  }

  const { data, error } = await client
    .from("users")
    .insert(storagePayload)
    .select(USER_ACCESS_SELECT_FIELDS)
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function getUserByIdentity(identityOrEmail = {}, planType = "subscription") {
  const client = getSupabaseClient();
  const identity = normalizeIdentityInput(identityOrEmail);
  const normalizedPlanType = String(planType || "subscription").trim().toLowerCase() === "audit" ? "audit" : "subscription";
  const matches = [];

  if (USER_ACCESS_HAS_AUTH_USER_ID && identity.userId) {
    const authQuery = await client
      .from("users")
      .select(USER_ACCESS_SELECT_FIELDS)
      .eq("auth_user_id", identity.userId)
      .eq("plan_type", normalizedPlanType)
      .order("updated_at", { ascending: false })
      .limit(5);
    if (authQuery.error) {
      throw authQuery.error;
    }
    if (Array.isArray(authQuery.data)) {
      matches.push(...authQuery.data);
    }
  }

  if (identity.email) {
    const emailQuery = await client
      .from("users")
      .select(USER_ACCESS_SELECT_FIELDS)
      .eq("email", identity.email)
      .eq("plan_type", normalizedPlanType)
      .order("updated_at", { ascending: false })
      .limit(5);
    if (emailQuery.error) {
      throw emailQuery.error;
    }
    if (Array.isArray(emailQuery.data)) {
      matches.push(...emailQuery.data);
    }
  }

  const dedupedRows = [];
  const seenIds = new Set();
  for (const row of matches) {
    const rowId = String(row?.id || "");
    if (!rowId || seenIds.has(rowId)) continue;
    seenIds.add(rowId);
    dedupedRows.push(row);
  }

  if (dedupedRows.length > 1) {
    console.warn("[AUTH DEBUG] duplicate_usage_rows", {
      planType: normalizedPlanType,
      identity: {
        email: identity.email || null,
        userId: identity.userId || null,
        identitySource: identity.identitySource || null
      },
      rowIds: dedupedRows.map((row) => row.id)
    });
  }

  return dedupedRows.sort((left, right) => {
    const leftAuthMatch = identity.userId && normalizeAuthUserId(left?.auth_user_id) === identity.userId ? 1 : 0;
    const rightAuthMatch = identity.userId && normalizeAuthUserId(right?.auth_user_id) === identity.userId ? 1 : 0;

    if (leftAuthMatch !== rightAuthMatch) {
      return rightAuthMatch - leftAuthMatch;
    }

    const leftPremiumUsage = normalizeCounterValue(left?.premium_chat_used || left?.advanced_actions_used || 0);
    const rightPremiumUsage = normalizeCounterValue(right?.premium_chat_used || right?.advanced_actions_used || 0);
    if (leftPremiumUsage !== rightPremiumUsage) {
      return rightPremiumUsage - leftPremiumUsage;
    }

    const leftBaseActions = normalizeCounterValue(left?.actions_used || 0);
    const rightBaseActions = normalizeCounterValue(right?.actions_used || 0);
    if (leftBaseActions !== rightBaseActions) {
      return rightBaseActions - leftBaseActions;
    }

    const leftUpdated = new Date(left?.updated_at || 0).getTime();
    const rightUpdated = new Date(right?.updated_at || 0).getTime();
    return rightUpdated - leftUpdated;
  })[0] || null;
}

async function getUserByEmail(email, planType = "subscription") {
  return getUserByIdentity({ email }, planType);
}

function getDefaultSubscriptionUser(identity = "") {
  const normalizedIdentity = normalizeIdentityInput(identity);
  return {
    id: null,
    email: normalizedIdentity.email,
    auth_user_id: normalizedIdentity.userId || null,
    is_email_confirmed: null,
    email_confirmed_at: null,
    confirmed_at: null,
    last_sign_in_at: null,
    plan: "free",
    plan_type: "subscription",
    status: "active",
    audit_credits: 0,
    audit_credits_used: 0,
    actions_used: 0,
    audits_used: 0,
    premium_chat_used: 0,
    premium_pdf_used: 0,
    extra_actions_balance: 0,
    extra_audits_balance: 0,
    extra_actions_used_cycle: 0,
    extra_audits_used_cycle: 0,
    extra_actions_purchased_total: 0,
    extra_audits_purchased_total: 0,
    purchase_history: [],
    billing_cycle_start: Date.now(),
    identity_source: normalizedIdentity.identitySource || (normalizedIdentity.userId ? "auth_user_id" : "email")
  };
}

function normalizePurchaseHistory(value = []) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function getAuditInstructionMessage() {
  return [
    "Instala Zentra Audit.",
    "Inicia sesion con el mismo correo usado en la compra.",
    "Entra a tu web.",
    "Abre Zentra.",
    "Elige paginas manualmente o automatico.",
    "Genera auditoria."
  ];
}

async function recordPaymentLog(logType = "", paymentInfo = {}, metadata = {}) {
  if (!supabase || !logType) return null;

  try {
    const payload = {
      email: normalizeEmail(paymentInfo.email),
      log_type: String(logType || "").trim(),
      lemon_event: String(metadata.eventName || paymentInfo.eventName || "").trim(),
      lemon_id: String(paymentInfo.lemon_id || "").trim(),
      lemon_type: String(paymentInfo.lemon_type || "").trim(),
      product_id: String(paymentInfo.product_id || "").trim(),
      variant_id: String(paymentInfo.variant_id || "").trim(),
      product_key: String(paymentInfo.product_key || "").trim(),
      product_family: String(paymentInfo.product_family || paymentInfo.plan_type || "").trim(),
      plan: normalizePlan(paymentInfo.plan),
      plan_type: String(paymentInfo.plan_type || "").trim(),
      actions: normalizeCounterValue(paymentInfo.actions),
      audits: normalizeCounterValue(paymentInfo.audits),
      pages: normalizeCounterValue(paymentInfo.pages),
      metadata: {
        productLabel: paymentInfo.product_label || "",
        productName: paymentInfo.product_name || "",
        variantName: paymentInfo.variant_name || "",
        checkoutLink: paymentInfo.checkout_link || "",
        ...metadata
      }
    };

    const { data, error } = await supabase
      .from("payment_activation_logs")
      .insert(payload)
      .select("id")
      .maybeSingle();

    if (error) throw error;
    return data;
  } catch (error) {
    console.warn("[payment:logs] No se pudo guardar log de activacion:", error?.message || error);
    return null;
  }
}

async function addCreditsByEmail(email, actions = 0, audits = 0, options = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error("Email requerido para sumar creditos");
  }

  const existingUser = await getUserByEmail(normalizedEmail, "subscription");
  const user = existingUser || getDefaultSubscriptionUser(normalizedEmail);
  const purchaseHistory = normalizePurchaseHistory(user.purchase_history);
  const lemonOrderId = String(options.lemonOrderId || "").trim();

  if (lemonOrderId && purchaseHistory.some((entry) => String(entry?.lemonOrderId || "").trim() === lemonOrderId)) {
    const savedUser = await upsertUserAccess({
      ...user,
      purchase_history: purchaseHistory
    });

    return {
      user: savedUser,
      duplicate: true
    };
  }

  const extraActions = normalizeCounterValue(actions);
  const extraAudits = normalizeCounterValue(audits);
  const nextHistory = [
    {
      type: options.type || "credits",
      packId: options.packId || "",
      productFamily: options.productFamily || "extra",
      productKey: options.productKey || "",
      extraActions,
      extraAudits,
      purchasedAt: new Date().toISOString(),
      lemonOrderId,
      lemonProductId: options.productId || "",
      lemonVariantId: options.variantId || ""
    },
    ...purchaseHistory
  ].slice(0, 100);

  const savedUser = await upsertUserAccess({
    ...user,
    email: normalizedEmail,
    plan: user.plan || "free",
    plan_type: "subscription",
    status: user.status || "active",
    extra_actions_balance: normalizeCounterValue(user.extra_actions_balance) + extraActions,
    extra_audits_balance: normalizeCounterValue(user.extra_audits_balance) + extraAudits,
    extra_actions_purchased_total: normalizeCounterValue(user.extra_actions_purchased_total) + extraActions,
    extra_audits_purchased_total: normalizeCounterValue(user.extra_audits_purchased_total) + extraAudits,
    purchase_history: nextHistory
  });

  return {
    user: savedUser,
    duplicate: false
  };
}

function formatSubscriptionUsage(user = {}) {
  const identitySource = String(user.identity_source || (user.auth_user_id ? "auth_user_id" : "email") || "").trim() || (user.auth_user_id ? "auth_user_id" : "email");
  const normalizedAuthUserId = normalizeAuthUserId(user.auth_user_id);

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
    id: user.id || null,
    auth_user_id: normalizedAuthUserId || null,
    identity_source: identitySource,
    is_email_confirmed: user.is_email_confirmed ?? null,
    email_confirmed_at: user.email_confirmed_at || null,
    confirmed_at: user.confirmed_at || null,
    last_sign_in_at: user.last_sign_in_at || null,
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
      advanced_actions_used: premiumChatUsed,
      advancedActionsUsed: premiumChatUsed,
      premium_chat_limit: premiumChatLimit,
      advanced_actions_limit: premiumChatLimit,
      advancedActionsLimit: premiumChatLimit,
      premium_chat_remaining: Math.max(premiumChatLimit - premiumChatUsed, 0),
      advanced_actions_remaining: Math.max(premiumChatLimit - premiumChatUsed, 0),
      advancedActionsRemaining: Math.max(premiumChatLimit - premiumChatUsed, 0),
      premium_pdf_used: premiumPdfUsed,
      premium_pdf_limit: premiumPdfLimit,
      premium_pdf_remaining: Math.max(premiumPdfLimit - premiumPdfUsed, 0),
      extra_actions_balance: TEMP_UNLIMITED_LIMIT,
      extra_audits_balance: TEMP_UNLIMITED_LIMIT,
      extra_actions_used_cycle: 0,
      extra_audits_used_cycle: 0,
      extra_actions_purchased_total: TEMP_UNLIMITED_LIMIT,
      extra_audits_purchased_total: TEMP_UNLIMITED_LIMIT,
      purchase_history: normalizePurchaseHistory(user.purchase_history),
      totalActionsAfterUpgrade: actionsLimit,
      totalAuditsAfterUpgrade: auditsLimit,
      extraActionsPurchased: TEMP_UNLIMITED_LIMIT,
      extraAuditsPurchased: TEMP_UNLIMITED_LIMIT,
      billing_cycle_start: normalizeCounterValue(user.billing_cycle_start || Date.now()),
      unlimited_agency: true
    };
  }

  const plan = normalizePlan(user.plan);
  const limits = getPlanLimits(plan);
  const premiumLimits = getPremiumLimits(plan);
  const baseActionsUsed = normalizeCounterValue(user.actions_used);
  const baseAuditsUsed = normalizeCounterValue(user.audits_used);
  const premiumChatUsed = normalizeCounterValue(user.premium_chat_used);
  const premiumPdfUsed = normalizeCounterValue(user.premium_pdf_used);
  const extraActionsBalance = normalizeCounterValue(user.extra_actions_balance);
  const extraAuditsBalance = normalizeCounterValue(user.extra_audits_balance);
  const extraActionsUsedCycle = normalizeCounterValue(user.extra_actions_used_cycle);
  const extraAuditsUsedCycle = normalizeCounterValue(user.extra_audits_used_cycle);
  const extraActionsPurchasedTotal = normalizeCounterValue(user.extra_actions_purchased_total);
  const extraAuditsPurchasedTotal = normalizeCounterValue(user.extra_audits_purchased_total);
  const actionsLimit = limits.actions + extraActionsBalance + extraActionsUsedCycle;
  const auditsLimit = limits.audits + extraAuditsBalance + extraAuditsUsedCycle;
  const actionsUsed = baseActionsUsed + extraActionsUsedCycle;
  const auditsUsed = baseAuditsUsed + extraAuditsUsedCycle;

  return {
    id: user.id || null,
    auth_user_id: normalizedAuthUserId || null,
    identity_source: identitySource,
    is_email_confirmed: user.is_email_confirmed ?? null,
    email_confirmed_at: user.email_confirmed_at || null,
    confirmed_at: user.confirmed_at || null,
    last_sign_in_at: user.last_sign_in_at || null,
    plan,
    plan_type: "subscription",
    status: user.status || "active",
    actions_used: actionsUsed,
    actions_limit: actionsLimit,
    actions_remaining: Math.max(actionsLimit - actionsUsed, 0),
    audits_used: auditsUsed,
    audits_limit: auditsLimit,
    audits_remaining: Math.max(auditsLimit - auditsUsed, 0),
    premium_chat_used: premiumChatUsed,
    advanced_actions_used: premiumChatUsed,
    advancedActionsUsed: premiumChatUsed,
    premium_chat_limit: premiumLimits.premium_chat_used,
    advanced_actions_limit: premiumLimits.premium_chat_used,
    advancedActionsLimit: premiumLimits.premium_chat_used,
    premium_chat_remaining: Math.max(premiumLimits.premium_chat_used - premiumChatUsed, 0),
    advanced_actions_remaining: Math.max(premiumLimits.premium_chat_used - premiumChatUsed, 0),
    advancedActionsRemaining: Math.max(premiumLimits.premium_chat_used - premiumChatUsed, 0),
    premium_pdf_used: premiumPdfUsed,
    premium_pdf_limit: premiumLimits.premium_pdf_used,
    premium_pdf_remaining: Math.max(premiumLimits.premium_pdf_used - premiumPdfUsed, 0),
    base_actions_limit: limits.actions,
    base_actions_used: baseActionsUsed,
    base_audits_limit: limits.audits,
    base_audits_used: baseAuditsUsed,
    extra_actions_balance: extraActionsBalance,
    extra_audits_balance: extraAuditsBalance,
    extra_actions_used_cycle: extraActionsUsedCycle,
    extra_audits_used_cycle: extraAuditsUsedCycle,
    extra_actions_purchased_total: extraActionsPurchasedTotal,
    extra_audits_purchased_total: extraAuditsPurchasedTotal,
    purchase_history: normalizePurchaseHistory(user.purchase_history),
    totalActionsAfterUpgrade: actionsLimit,
    totalAuditsAfterUpgrade: auditsLimit,
    extraActionsPurchased: extraActionsPurchasedTotal,
    extraAuditsPurchased: extraAuditsPurchasedTotal,
    billing_cycle_start: normalizeCounterValue(user.billing_cycle_start || Date.now())
  };
}

async function ensureFreshSubscriptionUsage(identityOrEmail) {
  const identity = normalizeIdentityInput(identityOrEmail);

  if (hasUnlimitedAgencyOverride(identity.email)) {
    const existingUser = await getUserByIdentity(identity, "subscription");
    const linkedUser = existingUser && identity.userId && normalizeAuthUserId(existingUser.auth_user_id) !== identity.userId
      ? await upsertUserAccess({
          ...existingUser,
          email: existingUser.email || identity.email,
          auth_user_id: identity.userId,
          plan_type: "subscription",
          status: existingUser.status || "active"
        })
      : existingUser;
    return applyUnlimitedAgencySubscriptionUser(identity.email, linkedUser || getDefaultSubscriptionUser(identity));
  }

  let existingUser = await getUserByIdentity(identity, "subscription");
  let user = existingUser || getDefaultSubscriptionUser(identity);

  if (existingUser && identity.userId && normalizeAuthUserId(existingUser.auth_user_id) !== identity.userId) {
    user = await upsertUserAccess({
      ...existingUser,
      email: existingUser.email || identity.email,
      auth_user_id: identity.userId,
      plan_type: "subscription",
      status: existingUser.status || "active"
    });
    existingUser = user;
  }

  if (user.status === "cancelled") {
    return {
      ...getDefaultSubscriptionUser(identity),
      status: "cancelled"
    };
  }

  if (!existingUser || shouldResetMonthlyUsage(user)) {
    return upsertUserAccess({
      ...user,
      plan: user.plan || "free",
      plan_type: "subscription",
      status: user.status || "active",
      auth_user_id: identity.userId || normalizeAuthUserId(user.auth_user_id) || null,
      actions_used: 0,
      audits_used: 0,
      premium_chat_used: 0,
      premium_pdf_used: 0,
      extra_actions_used_cycle: 0,
      extra_audits_used_cycle: 0,
      billing_cycle_start: Date.now()
    });
  }

  return user;
}

async function consumeSubscriptionUsage(identityOrEmail, counterKey = "actions_used") {
  const identity = normalizeIdentityInput(identityOrEmail);

  if (hasUnlimitedAgencyOverride(identity.email)) {
    const user = await ensureFreshSubscriptionUsage(identity);
    return {
      allowed: true,
      reason: "unlimited_agency_override",
      user
    };
  }

  const normalizedCounterKey = normalizeAdvancedChatCounterKey(counterKey);
  const allowedCounters = new Set(["actions_used", "audits_used", "premium_chat_used", "premium_pdf_used", "advanced_actions_used"]);
  if (!allowedCounters.has(normalizedCounterKey)) {
    return {
      allowed: false,
      reason: "invalid_counter"
    };
  }

  const user = await ensureFreshSubscriptionUsage(identity);
  if (!user || user.status !== "active") {
    return {
      allowed: false,
      reason: "no_active_subscription",
      user
    };
  }

  const usage = formatSubscriptionUsage(user);
  const baseActionsLimit = normalizeCounterValue(usage.base_actions_limit);
  const baseAuditsLimit = normalizeCounterValue(usage.base_audits_limit);
  const currentBaseActionsUsed = normalizeCounterValue(user.actions_used);
  const currentBaseAuditsUsed = normalizeCounterValue(user.audits_used);
  const currentExtraActionsBalance = normalizeCounterValue(user.extra_actions_balance);
  const currentExtraAuditsBalance = normalizeCounterValue(user.extra_audits_balance);
  const currentExtraActionsUsedCycle = normalizeCounterValue(user.extra_actions_used_cycle);
  const currentExtraAuditsUsedCycle = normalizeCounterValue(user.extra_audits_used_cycle);
  const storageCounterKey = normalizedCounterKey === "advanced_actions_used" ? "premium_chat_used" : normalizedCounterKey;
  const currentUsed = normalizeCounterValue(user[storageCounterKey]);
  const limitMap = {
    premium_chat_used: usage.premium_chat_limit,
    advanced_actions_used: usage.advanced_actions_limit ?? usage.premium_chat_limit,
    premium_pdf_used: usage.premium_pdf_limit
  };

  const nextUser = {
    ...user,
    plan_type: "subscription",
    status: "active"
  };

  if (counterKey === "actions_used") {
    if (currentBaseActionsUsed < baseActionsLimit) {
      nextUser.actions_used = currentBaseActionsUsed + 1;
    } else if (currentExtraActionsBalance > 0) {
      nextUser.extra_actions_balance = currentExtraActionsBalance - 1;
      nextUser.extra_actions_used_cycle = currentExtraActionsUsedCycle + 1;
    } else {
      return {
        allowed: false,
        reason: "usage_limit_reached",
        user
      };
    }
  } else if (counterKey === "audits_used") {
    if (currentBaseAuditsUsed < baseAuditsLimit) {
      nextUser.audits_used = currentBaseAuditsUsed + 1;
    } else if (currentExtraAuditsBalance > 0) {
      nextUser.extra_audits_balance = currentExtraAuditsBalance - 1;
      nextUser.extra_audits_used_cycle = currentExtraAuditsUsedCycle + 1;
    } else {
      return {
        allowed: false,
        reason: "usage_limit_reached",
        user
      };
    }
  } else {
    const limit = normalizeCounterValue(limitMap[normalizedCounterKey]);
    if (currentUsed >= limit) {
      if (normalizedCounterKey === "advanced_actions_used") {
        console.log("[USAGE ADVANCED ACTION]", {
          email: identity.email || null,
          userId: identity.userId || null,
          plan: user?.plan || "free",
          used: currentUsed,
          limit,
          reason: "usage_limit_reached"
        });
      }
      return {
        allowed: false,
        reason: "usage_limit_reached",
        user
      };
    }
    nextUser[storageCounterKey] = currentUsed + 1;
  }

  const savedUser = await upsertUserAccess(nextUser);

  if (normalizedCounterKey === "advanced_actions_used") {
    console.log("[USAGE ADVANCED ACTION]", {
      email: identity.email || null,
      userId: identity.userId || null,
      plan: savedUser?.plan || user?.plan || "free",
      used: normalizeCounterValue(savedUser?.premium_chat_used),
      limit: normalizeCounterValue(limitMap.advanced_actions_used)
    });
  }

  return {
    allowed: true,
    user: savedUser
  };
}

async function grantAuditAccess(paymentInfo = {}) {
  const identity = normalizeIdentityInput(paymentInfo);
  const email = identity.email;
  const existingUser = await getUserByIdentity(identity, "audit");
  const user = existingUser || {
    ...getDefaultSubscriptionUser(identity),
    plan: paymentInfo.plan,
    plan_type: "audit"
  };
  const purchaseHistory = normalizePurchaseHistory(user.purchase_history);
  const lemonOrderId = String(paymentInfo.lemon_id || "").trim();

  if (lemonOrderId && purchaseHistory.some((entry) => String(entry?.lemonOrderId || "").trim() === lemonOrderId)) {
    const savedUser = await upsertUserAccess({
      ...user,
      purchase_history: purchaseHistory
    });

    return {
      user: savedUser,
      duplicate: true
    };
  }

  const nextHistory = [
    {
      type: "audit_credit",
      productFamily: paymentInfo.product_family || "audit",
      productKey: paymentInfo.product_key || "",
      pages: normalizeCounterValue(paymentInfo.pages),
      purchasedAt: new Date().toISOString(),
      lemonOrderId,
      lemonProductId: paymentInfo.product_id || "",
      lemonVariantId: paymentInfo.variant_id || ""
    },
    ...purchaseHistory
  ].slice(0, 100);

  const savedUser = await upsertUserAccess({
    ...user,
    email,
    auth_user_id: identity.userId || normalizeAuthUserId(user.auth_user_id) || null,
    plan: paymentInfo.plan,
    plan_type: "audit",
    status: "active",
    audit_credits: normalizeCounterValue(user.audit_credits) + 1,
    audit_credits_used: normalizeCounterValue(user.audit_credits_used),
    purchase_history: nextHistory
  });

  await recordPaymentLog("auditActivated", paymentInfo, {
    auditInstructions: getAuditInstructionMessage(),
    pages: normalizeCounterValue(paymentInfo.pages)
  });

  return {
    user: savedUser,
    duplicate: false
  };
}

async function consumeAuditCredit(email) {
  const identity = normalizeIdentityInput(email);

  if (hasUnlimitedAgencyOverride(identity.email)) {
    const user = await getUserByIdentity(identity, "audit");
    return {
      allowed: true,
      reason: "unlimited_agency_override",
      user: getUnlimitedAuditUsage(identity.email, user || {})
    };
  }

  const user = await getUserByIdentity(identity, "audit");

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
    auth_user_id: identity.userId || normalizeAuthUserId(user.auth_user_id) || null,
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
  const body = {
    model,
    response_format: responseFormat || { type: "json_object" },
    messages,
    max_tokens: maxTokens
  };

  if (!shouldOmitTemperatureForModel(model)) {
    body.temperature = normalizeTemperature(temperature);
  }

  return body;
}

function shouldUseOpenAIResponsesApi(model = "") {
  return /^gpt-5/i.test(String(model || "").trim());
}

function shouldOmitTemperatureForModel(model = "") {
  return /^gpt-5($|-)/i.test(String(model || "").trim());
}

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === "[object Object]";
}

function cloneSafeText(text = "") {
  return String(text || "").trim();
}

function normalizeOpenAIResponsesContent(content = "", role = "user") {
  const normalizedRole = role === "assistant" ? "assistant" : "user";

  const mapTextPart = (text = "") => {
    const safeText = cloneSafeText(text);
    return normalizedRole === "assistant"
      ? { type: "output_text", text: safeText }
      : { type: "input_text", text: safeText };
  };

  if (typeof content === "string") {
    return [mapTextPart(content)];
  }

  if (!Array.isArray(content)) {
    return [mapTextPart(String(content || ""))];
  }

  return content
    .map((item) => {
      if (!item || typeof item !== "object") return null;

      if (normalizedRole === "assistant") {
        if (item.type === "refusal") {
          return { type: "refusal", refusal: cloneSafeText(item.refusal || item.text || "") };
        }

        if (item.type === "output_text") {
          return { type: "output_text", text: cloneSafeText(item.text || item.output_text || "") };
        }

        if (item.type === "input_text" || item.type === "text" || typeof item.text === "string") {
          return { type: "output_text", text: cloneSafeText(item.text || item.output_text || "") };
        }

        if (item.type === "input_image" || item.type === "image_url") {
          const imageUrl = item.image_url?.url || item.image_url || item.url || "";
          return imageUrl
            ? { type: "output_text", text: "[imagen omitida del historial]" }
            : null;
        }

        return null;
      }

      if (item.type === "image_url" && (item.image_url?.url || item.image_url || item.url)) {
        return { type: "input_image", image_url: item.image_url?.url || item.image_url || item.url };
      }

      if (item.type === "input_image" && (item.image_url?.url || item.image_url || item.url)) {
        return { type: "input_image", image_url: item.image_url?.url || item.image_url || item.url };
      }

      if (item.type === "input_text" || item.type === "text" || typeof item.text === "string") {
        return { type: "input_text", text: cloneSafeText(item.text || item.output_text || "") };
      }

      if (item.type === "output_text" && typeof item.text === "string") {
        return { type: "input_text", text: cloneSafeText(item.text) };
      }

      if (item.type === "refusal") {
        return { type: "input_text", text: cloneSafeText(item.refusal || item.text || "") };
      }

      if (isPlainObject(item.content)) {
        const nestedText = extractTextFromContent(item.content);
        if (nestedText) {
          return normalizedRole === "assistant"
            ? { type: "output_text", text: nestedText }
            : { type: "input_text", text: nestedText };
        }
      }

      const fallbackText = extractTextFromContent(item);
      if (fallbackText) {
        return normalizedRole === "assistant"
          ? { type: "output_text", text: fallbackText }
          : { type: "input_text", text: fallbackText };
      }

      return null;
    })
    .filter(Boolean);
}

function sanitizeResponsesContentParts(content = [], role = "user", stats = null, path = "content") {
  const normalizedRole = role === "assistant" ? "assistant" : "user";
  const source = Array.isArray(content) ? content : [content];
  const sanitized = [];

  source.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;

    if (item == null) {
      if (stats) stats.dropped += 1;
      return;
    }

    if (Array.isArray(item)) {
      const nested = sanitizeResponsesContentParts(item, normalizedRole, stats, itemPath);
      if (nested.length) sanitized.push(...nested);
      return;
    }

    if (typeof item === "string") {
      const text = cloneSafeText(item);
      if (!text) {
        if (stats) stats.dropped += 1;
        return;
      }

      sanitized.push(normalizedRole === "assistant"
        ? { type: "output_text", text }
        : { type: "input_text", text });
      if (stats) stats.stringParts += 1;
      return;
    }

    if (!isPlainObject(item)) {
      const fallbackText = extractTextFromContent(item);
      if (fallbackText) {
        sanitized.push(normalizedRole === "assistant"
          ? { type: "output_text", text: fallbackText }
          : { type: "input_text", text: fallbackText });
        if (stats) stats.coerced += 1;
      } else if (stats) {
        stats.dropped += 1;
      }
      return;
    }

    const rawType = String(item.type || "").trim().toLowerCase();
    const textFromItem = cloneSafeText(item.text || item.output_text || item.refusal || item.content || "");

    if (normalizedRole === "assistant") {
      if (rawType === "refusal") {
        if (textFromItem) {
          sanitized.push({ type: "refusal", refusal: textFromItem });
        } else if (stats) {
          stats.dropped += 1;
        }
        return;
      }

      if (rawType === "output_text") {
        if (textFromItem) {
          sanitized.push({ type: "output_text", text: textFromItem });
        } else if (stats) {
          stats.dropped += 1;
        }
        return;
      }

      if (rawType === "input_text" || rawType === "text") {
        if (textFromItem) {
          sanitized.push({ type: "output_text", text: textFromItem });
          if (stats) stats.fixedAssistantInputText += 1;
        } else if (stats) {
          stats.dropped += 1;
        }
        return;
      }

      if (rawType === "input_image" || rawType === "image_url" || item.image_url?.url || item.url) {
        const imageUrl = item.image_url?.url || item.image_url || item.url || "";
        if (imageUrl) {
          sanitized.push({ type: "output_text", text: "[imagen omitida del historial]" });
          if (stats) stats.fixedAssistantImage += 1;
        } else if (stats) {
          stats.dropped += 1;
        }
        return;
      }

      if (Array.isArray(item.content)) {
        const nested = sanitizeResponsesContentParts(item.content, normalizedRole, stats, `${itemPath}.content`);
        if (nested.length) {
          sanitized.push(...nested);
          if (stats) stats.coerced += 1;
          return;
        }
      }

      if (textFromItem) {
        sanitized.push({ type: "output_text", text: textFromItem });
        if (stats) stats.coerced += 1;
        return;
      }

      if (stats) stats.dropped += 1;
      return;
    }

    if (rawType === "input_image" || rawType === "image_url" || item.image_url?.url || item.url) {
      const imageUrl = item.image_url?.url || item.image_url || item.url || "";
      if (imageUrl) {
        sanitized.push({ type: "input_image", image_url: imageUrl });
      } else if (stats) {
        stats.dropped += 1;
      }
      return;
    }

    if (rawType === "input_text" || rawType === "text") {
      if (textFromItem) {
        sanitized.push({ type: "input_text", text: textFromItem });
      } else if (stats) {
        stats.dropped += 1;
      }
      return;
    }

    if (rawType === "output_text") {
      if (textFromItem) {
        sanitized.push({ type: "input_text", text: textFromItem });
        if (stats) stats.fixedOutputText += 1;
      } else if (stats) {
        stats.dropped += 1;
      }
      return;
    }

    if (rawType === "refusal") {
      if (textFromItem) {
        sanitized.push({ type: "input_text", text: textFromItem });
        if (stats) stats.fixedRefusal += 1;
      } else if (stats) {
        stats.dropped += 1;
      }
      return;
    }

    if (Array.isArray(item.content)) {
      const nested = sanitizeResponsesContentParts(item.content, normalizedRole, stats, `${itemPath}.content`);
      if (nested.length) {
        sanitized.push(...nested);
        if (stats) stats.coerced += 1;
        return;
      }
    }

    if (textFromItem) {
      sanitized.push({ type: "input_text", text: textFromItem });
      if (stats) stats.coerced += 1;
      return;
    }

    if (stats) stats.dropped += 1;
  });

  return sanitized;
}

function sanitizeResponsesMessage(message = {}, index = 0, stats = null) {
  const role = message?.role === "assistant"
    ? "assistant"
    : (message?.role === "system" ? "system" : (message?.role === "developer" ? "developer" : "user"));
  const content = sanitizeResponsesContentParts(message?.content, role === "assistant" ? "assistant" : "user", stats, `messages[${index}].content`);
  return {
    role: role === "assistant" ? "assistant" : (role === "system" ? "system" : (role === "developer" ? "developer" : "user")),
    content
  };
}

function sanitizeResponsesInput(input = [], meta = {}) {
  const stats = {
    fixedAssistantInputText: 0,
    fixedAssistantImage: 0,
    fixedOutputText: 0,
    fixedRefusal: 0,
    coerced: 0,
    dropped: 0,
    stringParts: 0
  };

  const source = Array.isArray(input) ? input : [];
  const sanitized = source.map((message, index) => sanitizeResponsesMessage(message, index, stats));

  return {
    input: sanitized,
    stats: {
      ...stats,
      corrected: Boolean(
        stats.fixedAssistantInputText
        || stats.fixedAssistantImage
        || stats.fixedOutputText
        || stats.fixedRefusal
        || stats.coerced
      ),
      routeName: meta.routeName || null,
      taskType: meta.taskType || null,
      requestedModel: meta.requestedModel || null,
      contextDecision: meta.contextDecision || null,
      outputType: meta.outputType || null,
      renderType: meta.renderType || null,
      hasHistory: sanitized.length > 1,
      messageCount: sanitized.length
    }
  };
}

function summarizeOpenAIResponsesInputForLog(input = []) {
  return Array.isArray(input)
    ? input.map((msg, index) => ({
        index,
        role: msg?.role || "user",
        contentTypes: Array.isArray(msg?.content) ? msg.content.map((item) => item?.type).filter(Boolean) : [],
        textPreview: extractTextFromContent(msg?.content).slice(0, 120)
      }))
    : [];
}

function buildOpenAIResponsesRequestBody({ model, messages, responseFormat, temperature, maxTokens, requestContext = {} }) {
  const sanitized = sanitizeResponsesInput(messages, {
    routeName: requestContext.routeName || requestContext.taskType || null,
    taskType: requestContext.taskType || null,
    requestedModel: requestContext.requestedModel || model || null,
    contextDecision: requestContext.contextDecision || null,
    outputType: requestContext.outputType || null,
    renderType: requestContext.renderType || null
  });

  const body = {
    model,
    input: sanitized.input,
    max_output_tokens: maxTokens
  };

  if (responseFormat?.type === "json_object") {
    body.text = { format: { type: "json_object" } };
  }

  if (!shouldOmitTemperatureForModel(model)) {
    body.temperature = normalizeTemperature(temperature);
  }

  return {
    body,
    sanitizerStats: sanitized.stats
  };
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

async function callOpenAI({ model, messages, responseFormat, temperature, maxTokens, requestContext = {} }) {
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
  const responseBody = useResponsesApi
    ? buildOpenAIResponsesRequestBody({ model, messages, responseFormat, temperature, maxTokens, requestContext })
    : { body: buildOpenAIRequestBody({ model, messages, responseFormat, temperature, maxTokens }), sanitizerStats: null };
  const body = responseBody.body;

  if (useResponsesApi) {
    console.log("[OPENAI RESPONSES INPUT]", {
      routeName: requestContext.routeName || requestContext.route || null,
      taskType: requestContext.taskType || null,
      requestedModel: requestContext.requestedModel || model,
      provider: requestContext.provider || "openai",
      contextDecision: requestContext.contextDecision || null,
      outputType: requestContext.outputType || null,
      renderType: requestContext.renderType || null,
      hasHistory: Boolean(responseBody.sanitizerStats?.hasHistory),
      corrected: Boolean(responseBody.sanitizerStats?.corrected),
      corrections: responseBody.sanitizerStats ? {
        fixedAssistantInputText: responseBody.sanitizerStats.fixedAssistantInputText,
        fixedAssistantImage: responseBody.sanitizerStats.fixedAssistantImage,
        fixedOutputText: responseBody.sanitizerStats.fixedOutputText,
        fixedRefusal: responseBody.sanitizerStats.fixedRefusal,
        coerced: responseBody.sanitizerStats.coerced,
        dropped: responseBody.sanitizerStats.dropped
      } : null,
      summary: summarizeOpenAIResponsesInputForLog(body.input)
    });

    if (responseBody.sanitizerStats?.fixedAssistantInputText) {
      console.warn("[FIXED ASSISTANT INPUT_TEXT]", {
        routeName: requestContext.routeName || requestContext.route || null,
        taskType: requestContext.taskType || null,
        requestedModel: requestContext.requestedModel || model,
        fixedCount: responseBody.sanitizerStats.fixedAssistantInputText
      });
    }
  }

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

async function callAiProvider({ provider, model, messages, responseFormat, temperature, maxTokens, requestContext = {} }) {
  const normalizedProvider = normalizeProvider(provider);

  if (normalizedProvider === "anthropic") {
    return callAnthropic({ model, messages, temperature, maxTokens });
  }

  return callOpenAI({ model, messages, responseFormat, temperature, maxTokens, requestContext: {
    provider: normalizedProvider,
    ...requestContext
  } });
}

function normalizeAudioMimeType(mimeType = "") {
  const value = String(mimeType || "").trim().toLowerCase();
  if (value.startsWith("audio/webm")) return "audio/webm";
  if (value.startsWith("audio/mp4")) return "audio/mp4";
  if (value.startsWith("audio/m4a")) return "audio/m4a";
  if (value.startsWith("audio/wav")) return "audio/wav";
  if (value.startsWith("audio/mpeg")) return "audio/mpeg";
  return "audio/webm";
}

function extensionFromMimeType(mimeType = "") {
  switch (normalizeAudioMimeType(mimeType)) {
    case "audio/mp4":
      return "mp4";
    case "audio/m4a":
      return "m4a";
    case "audio/wav":
      return "wav";
    case "audio/mpeg":
      return "mp3";
    case "audio/webm":
    default:
      return "webm";
  }
}

async function transcribeDesktopAudio({ audioBase64, mimeType = "audio/webm", language = "es" }) {
  if (!OPENAI_API_KEY) {
    return {
      ok: false,
      status: 500,
      error: "OPENAI_API_KEY no esta configurada"
    };
  }

  const cleanedBase64 = String(audioBase64 || "").replace(/^data:.*;base64,/, "").trim();
  if (!cleanedBase64) {
    return {
      ok: false,
      status: 400,
      error: "Audio vacio"
    };
  }

  const normalizedMimeType = normalizeAudioMimeType(mimeType);
  const audioBuffer = Buffer.from(cleanedBase64, "base64");
  const audioSizeBytes = audioBuffer.byteLength;

  if (!audioSizeBytes) {
    return {
      ok: false,
      status: 400,
      error: "Audio vacio"
    };
  }

  const maxBytes = 25 * 1024 * 1024;
  if (audioSizeBytes > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: "El audio supera el limite de 25MB"
    };
  }

  const audioFile = new File(
    [audioBuffer],
    `zentra-desktop-audio.${extensionFromMimeType(normalizedMimeType)}`,
    { type: normalizedMimeType }
  );

  const form = new FormData();
  form.append("file", audioFile);
  form.append("model", DESKTOP_TRANSCRIPTION_MODEL);
  form.append("language", String(language || "es").trim() || "es");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: form
  });

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const payloadText = await response.text();

  if (!response.ok) {
    let payload = null;
    try {
      payload = payloadText ? JSON.parse(payloadText) : null;
    } catch (_) {}

    return {
      ok: false,
      status: response.status,
      error: payload?.error?.message || payload?.error || payloadText || "No se pudo transcribir el audio"
    };
  }

  let transcriptText = payloadText;
  if (contentType.includes("application/json")) {
    try {
      const payload = payloadText ? JSON.parse(payloadText) : {};
      transcriptText = String(payload?.text || "").trim();
    } catch (_) {
      transcriptText = String(payloadText || "").trim();
    }
  } else {
    transcriptText = String(payloadText || "").trim();
  }

  return {
    ok: true,
    status: 200,
    text: transcriptText,
    model: DESKTOP_TRANSCRIPTION_MODEL
  };
}

function sanitizeChatMessages(messages = []) {
  return messages.map((msg, index) => {
    const isLastMessage = index === messages.length - 1;

    if (Array.isArray(msg?.content)) {
      return {
        ...msg,
        content: msg.content.map((item) => {
          if (item?.type === "image_url") {
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
}

function buildJsonControlMessage(text = "Responde SOLO en JSON valido. Sin texto extra.") {
  return {
    role: "system",
    content: [
      {
        type: "text",
        text
      }
    ]
  };
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "si", "yes", "1", "ok"].includes(normalized)) return true;
    if (["false", "no", "0"].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeStringArray(values = []) {
  const source = Array.isArray(values) ? values : [values];
  return source
    .map((value) => {
      if (typeof value === "string") return value.trim();
      if (value && typeof value === "object") {
        return firstNonEmptyString(value.text, value.label, value.title, value.name);
      }
      return "";
    })
    .filter(Boolean)
    .slice(0, 6);
}

function looksLikeJsonText(text = "") {
  const normalized = String(text || "").trim();
  if (!normalized) return false;
  return (
    (normalized.startsWith("{") && normalized.endsWith("}"))
    || (normalized.startsWith("[") && normalized.endsWith("]"))
  );
}

function normalizeComparableText(text = "") {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isMeaningfullyDifferentText(nextText = "", previousText = "") {
  const nextNormalized = normalizeComparableText(nextText);
  const previousNormalized = normalizeComparableText(previousText);

  if (!nextNormalized && !previousNormalized) return false;
  if (!nextNormalized || !previousNormalized) return true;
  if (nextNormalized === previousNormalized) return false;
  if (Math.abs(nextNormalized.length - previousNormalized.length) >= 24) return true;

  return !nextNormalized.includes(previousNormalized) && !previousNormalized.includes(nextNormalized);
}

function normalizeChatFastLayerPayload(payload = {}, fallbackText = "") {
  const safeFallback = looksLikeJsonText(fallbackText) ? "" : String(fallbackText || "").trim();
  return {
    intent: firstNonEmptyString(payload.intent, payload.intencion, payload.task_intent, "general"),
    visibleSignals: normalizeStringArray(
      payload.visible_signals
      || payload.visibleSignals
      || payload.senales_visibles
      || payload.signals
    ),
    response: firstNonEmptyString(
      payload.response,
      payload.respuesta,
      payload.reply,
      payload.reply_text,
      payload.text,
      safeFallback
    ),
    needsReasoning: normalizeBoolean(
      payload.needs_reasoning
      ?? payload.needsReasoning
      ?? payload.reasoning_needed
      ?? payload.requiere_razonamiento,
      false
    ),
    reasoningGoal: firstNonEmptyString(
      payload.reasoning_goal,
      payload.reasoningGoal,
      payload.objetivo_razonamiento
    ),
    shouldPolish: normalizeBoolean(
      payload.should_polish
      ?? payload.shouldPolish
      ?? payload.polish_recommended,
      false
    ),
    polishGoal: firstNonEmptyString(
      payload.polish_goal,
      payload.polishGoal,
      payload.objetivo_pulido
    )
  };
}

function normalizeChatReasoningLayerPayload(payload = {}, fallbackText = "") {
  const safeFallback = looksLikeJsonText(fallbackText) ? "" : String(fallbackText || "").trim();
  return {
    response: firstNonEmptyString(
      payload.response,
      payload.respuesta,
      payload.reply,
      payload.reply_text,
      payload.text,
      safeFallback
    ),
    reasoningAddedValue: normalizeBoolean(
      payload.reasoning_added_value
      ?? payload.reasoningAddedValue
      ?? payload.added_value
      ?? payload.aporta_valor,
      true
    ),
    reasoningSummary: firstNonEmptyString(
      payload.reasoning_summary,
      payload.reasoningSummary,
      payload.razonamiento,
      payload.summary
    ),
    polishRecommended: normalizeBoolean(
      payload.polish_recommended
      ?? payload.polishRecommended
      ?? payload.should_polish,
      false
    ),
    polishGoal: firstNonEmptyString(
      payload.polish_goal,
      payload.polishGoal,
      payload.objetivo_pulido
    )
  };
}

function normalizeChatExecutiveLayerPayload(payload = {}, fallbackText = "") {
  const safeFallback = looksLikeJsonText(fallbackText) ? "" : String(fallbackText || "").trim();
  return {
    response: firstNonEmptyString(
      payload.response,
      payload.respuesta,
      payload.reply,
      payload.reply_text,
      payload.text,
      safeFallback
    ),
    changed: normalizeBoolean(
      payload.changed
      ?? payload.did_change
      ?? payload.cambio_real,
      true
    ),
    changeReason: firstNonEmptyString(
      payload.change_reason,
      payload.changeReason,
      payload.razon_del_cambio,
      payload.why
    )
  };
}

function compactChatLayerForPrompt(layer = {}) {
  return JSON.stringify({
    intent: layer.intent || "",
    visibleSignals: normalizeStringArray(layer.visibleSignals || []),
    response: firstNonEmptyString(layer.response),
    needsReasoning: Boolean(layer.needsReasoning),
    reasoningGoal: firstNonEmptyString(layer.reasoningGoal),
    shouldPolish: Boolean(layer.shouldPolish || layer.polishRecommended),
    polishGoal: firstNonEmptyString(layer.polishGoal),
    reasoningSummary: firstNonEmptyString(layer.reasoningSummary)
  });
}

function buildLayeredChatFastInstruction() {
  return [
    "Sos la CAPA 1 del chat de Zentra.",
    "Objetivo: dar una respuesta inicial util, rapida y natural sin esperar razonamiento profundo.",
    "Tareas:",
    "- detectar la intencion real del usuario",
    "- leer senales visibles del contexto ya disponible",
    "- responder como un operador senior: humano, directo, claro y sin sonar a chatbot generico",
    "- marcar si vale la pena activar una capa de razonamiento premium despues",
    "",
    "Reglas:",
    "- no uses encabezados roboticos",
    "- no llenes de teoria",
    "- si el usuario pidio accion, da una primera accion o lectura concreta",
    "- si el pedido es complejo, igual entrega una primera respuesta util y deja la profundidad para despues",
    "",
    "Responde SOLO en JSON valido con este esquema exacto:",
    "{",
    '  "intent": "string",',
    '  "visible_signals": ["string"],',
    '  "response": "respuesta inicial lista para mostrar al usuario",',
    '  "needs_reasoning": true,',
    '  "reasoning_goal": "string",',
    '  "should_polish": false,',
    '  "polish_goal": "string"',
    "}"
  ].join("\n");
}

function buildLayeredChatReasoningInstruction(fastLayer = {}) {
  return [
    "Sos la CAPA 2 del chat de Zentra.",
    "Tu trabajo es mejorar la respuesta inicial solo si agregas criterio real.",
    "Foco:",
    "- priorizacion",
    "- comparacion",
    "- estrategia contextual",
    "- claridad de decision",
    "",
    "No conviertas la respuesta en un informe pesado.",
    "No repitas la capa 1 si no sumas nada.",
    "Manten tono humano, directo y operador senior.",
    "",
    `Resultado de capa 1: ${compactChatLayerForPrompt(fastLayer)}`,
    "",
    "Responde SOLO en JSON valido con este esquema exacto:",
    "{",
    '  "response": "respuesta mejorada para el usuario",',
    '  "reasoning_added_value": true,',
    '  "reasoning_summary": "que valor nuevo agregaste",',
    '  "polish_recommended": false,',
    '  "polish_goal": "string"',
    "}"
  ].join("\n");
}

function buildLayeredChatExecutiveInstruction(fastLayer = {}, reasoningLayer = {}) {
  return [
    "Sos la CAPA 3 del chat de Zentra.",
    "Tu trabajo es pulir la respuesta final solo si ganas claridad, ritmo o criterio ejecutivo.",
    "No agregues datos nuevos no respaldados.",
    "No vuelvas la respuesta mas larga por defecto.",
    "No repitas encabezados ni estructura innecesaria.",
    "Debe sonar premium, pero ligera.",
    "",
    `Capa 1: ${compactChatLayerForPrompt(fastLayer)}`,
    `Capa 2: ${compactChatLayerForPrompt(reasoningLayer)}`,
    "",
    "Responde SOLO en JSON valido con este esquema exacto:",
    "{",
    '  "response": "respuesta final pulida",',
    '  "changed": true,',
    '  "change_reason": "por que el pulido si aporto claridad"',
    "}"
  ].join("\n");
}

function sumAiUsage(usages = []) {
  const validUsages = usages.filter((usage) => usage && typeof usage === "object");
  if (!validUsages.length) return undefined;

  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let hasPromptTokens = false;
  let hasCompletionTokens = false;
  let hasTotalTokens = false;

  validUsages.forEach((usage) => {
    const prompt = Number(usage.prompt_tokens);
    const completion = Number(usage.completion_tokens);
    const total = Number(usage.total_tokens);

    if (Number.isFinite(prompt)) {
      promptTokens += prompt;
      hasPromptTokens = true;
    }

    if (Number.isFinite(completion)) {
      completionTokens += completion;
      hasCompletionTokens = true;
    }

    if (Number.isFinite(total)) {
      totalTokens += total;
      hasTotalTokens = true;
    }
  });

  return {
    prompt_tokens: hasPromptTokens ? promptTokens : undefined,
    completion_tokens: hasCompletionTokens ? completionTokens : undefined,
    total_tokens: hasTotalTokens
      ? totalTokens
      : (hasPromptTokens || hasCompletionTokens ? promptTokens + completionTokens : undefined),
    layers: validUsages
  };
}

function shouldAttemptExecutiveChatPolish(fastLayer = {}, reasoningLayer = {}) {
  if (!ZENTRA_CHAT_EXECUTIVE_ENABLED) return false;
  if (!isProviderConfigured(ZENTRA_CHAT_EXECUTIVE_PROVIDER)) return false;
  if (!ZENTRA_CHAT_EXECUTIVE_MODEL) return false;

  const candidateText = firstNonEmptyString(reasoningLayer.response);
  if (!candidateText || candidateText.length < 90) return false;

  return Boolean(
    reasoningLayer.polishRecommended
    || fastLayer.shouldPolish
    || firstNonEmptyString(reasoningLayer.polishGoal, fastLayer.polishGoal)
  );
}

function buildChatExecutiveRoute(reasoningRoute = {}) {
  return {
    taskType: "chat_executive",
    provider: ZENTRA_CHAT_EXECUTIVE_PROVIDER,
    model: ZENTRA_CHAT_EXECUTIVE_MODEL,
    fallbackProvider: reasoningRoute.provider || ZENTRA_CHAT_REASONING_PROVIDER,
    fallbackModel: reasoningRoute.model || ZENTRA_CHAT_REASONING_MODEL,
    maxTokens: ZENTRA_CHAT_EXECUTIVE_MAX_TOKENS
  };
}

async function callLayeredChatStep({
  route,
  instruction,
  cleanMessages,
  temperature = 0.4,
  maxTokens = 900,
  responseFormat = { type: "json_object" },
  requestContext = {}
}) {
  const layerMessages = [
    buildJsonControlMessage(instruction),
    ...cleanMessages
  ];

  let result = await callAiProvider({
    provider: route.provider,
    model: route.model,
    messages: layerMessages,
    responseFormat,
    temperature,
    maxTokens,
    requestContext: {
      routeName: route.taskType || "layered_chat",
      taskType: route.taskType || null,
      requestedModel: route.model || null,
      ...requestContext
    }
  });

  let fallbackError = null;
  let requestedProvider = route.provider;
  let requestedModel = route.model;

  if (
    !result.ok
    && route.fallbackModel
    && route.fallbackProvider
    && (route.fallbackModel !== route.model || route.fallbackProvider !== route.provider)
  ) {
    fallbackError = getAiErrorMessage(result);
      result = await callAiProvider({
        provider: route.fallbackProvider,
        model: route.fallbackModel,
        messages: layerMessages,
        responseFormat,
        temperature,
        maxTokens,
        requestContext: {
          routeName: route.taskType || "layered_chat_fallback",
          taskType: route.taskType || null,
          requestedModel: route.fallbackModel || route.model || null,
          ...requestContext
        }
      });
    requestedProvider = route.fallbackProvider;
    requestedModel = route.fallbackModel;
  }

  const content = result.ok ? getAiResponseText(result) : "";

  return {
    ok: result.ok,
    status: result.status,
    error: result.ok ? null : getAiErrorMessage(result),
    content,
    parsed: result.ok ? parseJsonSafely(content) : {},
    usage: result.ok ? getAiUsage(result) : undefined,
    provider: result.provider || requestedProvider,
    model: result.model || requestedModel,
    requestedProvider: route.provider,
    requestedModel: route.model,
    fallbackError,
    raw: result
  };
}

function writeNdjsonEvent(res, payload = {}) {
  res.write(`${JSON.stringify(payload)}\n`);
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
      premium_final_model: ZENTRA_PREMIUM_FINAL_MODEL,
      executive_refiner_enabled: ZENTRA_EXECUTIVE_REFINER_ENABLED,
      executive_refiner_provider: ZENTRA_EXECUTIVE_REFINER_PROVIDER,
      executive_refiner_model: ZENTRA_EXECUTIVE_REFINER_MODEL,
      executive_refiner_max_tokens: ZENTRA_EXECUTIVE_REFINER_MAX_TOKENS
    }
  });
});

app.post("/api/audio/transcribe", async (req, res) => {
  try {
    const {
      audioBase64 = "",
      mimeType = "audio/webm",
      language = "es"
    } = req.body || {};

    const result = await transcribeDesktopAudio({
      audioBase64,
      mimeType,
      language
    });

    if (!result.ok) {
      return res.status(result.status || 500).json({
        error: result.error || "No se pudo transcribir el audio"
      });
    }

    return res.json({
      success: true,
      text: result.text || "",
      model: result.model || DESKTOP_TRANSCRIPTION_MODEL
    });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "No se pudo transcribir el audio"
    });
  }
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

    const paymentInfo = {
      ...extractLemonPaymentInfo(payload, eventName),
      eventName
    };
    const capacityPack = getAgencyCapacityPackByLemonIds({
      productId: paymentInfo.product_id,
      variantId: paymentInfo.variant_id
    });

    if (!paymentInfo.email) {
      console.warn(`[lemon:webhook] Evento ${eventName} sin email`, {
        lemon_id: paymentInfo.lemon_id,
        product: paymentInfo.product_label
      });
      return res.status(400).json({ error: "Webhook sin email de usuario" });
    }

    await recordPaymentLog("paymentReceived", paymentInfo, { eventName });

    if (eventName === "order_created" && (capacityPack || paymentInfo.plan_type === "extra")) {
      if (!capacityPack) {
        await recordPaymentLog("extraRejected", paymentInfo, {
          reason: "capacity_pack_not_found"
        });

        return res.status(200).json({
          success: true,
          ignored: true,
          event: eventName,
          reason: "capacity_pack_not_found"
        });
      }

      const result = await grantSubscriptionCapacityUpgrade(paymentInfo, capacityPack);
      const savedUser = result.user;
      console.log("[lemon:webhook] Expansion de capacidad sincronizada", {
        email: savedUser.email,
        packId: capacityPack.packId,
        extraActions: capacityPack.extraActions,
        extraAudits: capacityPack.extraAudits,
        skipped: Boolean(result.skipped),
        duplicate: Boolean(result.duplicate)
      });

      return res.status(200).json({
        success: true,
        event: eventName,
        packId: capacityPack.packId,
        skipped: Boolean(result.skipped),
        reason: result.reason || null,
        user: savedUser
      });
    }

    if (paymentInfo.plan === "free") {
      console.warn(`[lemon:webhook] Producto sin plan reconocible: ${paymentInfo.product_label}`);
      return res.status(400).json({ error: "Producto sin plan reconocible" });
    }

    if (eventName === "order_created" && paymentInfo.plan_type === "audit") {
      const result = await grantAuditAccess(paymentInfo);
      const savedUser = result.user;

      if (!result.duplicate) {
        await recordPaymentLog("creditsAdded", paymentInfo, {
          auditCreditsAdded: 1,
          auditInstructions: getAuditInstructionMessage()
        });
      }

      console.log("[lemon:webhook] Compra Audit sincronizada", {
        email: savedUser.email,
        plan: savedUser.plan,
        credits: savedUser.audit_credits,
        used: savedUser.audit_credits_used,
        product: paymentInfo.product_label,
        duplicate: Boolean(result.duplicate)
      });

      return res.status(200).json({
        success: true,
        event: eventName,
        duplicate: Boolean(result.duplicate),
        auditInstructions: getAuditInstructionMessage(),
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
      extra_actions_balance: Number(existingUser?.extra_actions_balance || 0),
      extra_audits_balance: Number(existingUser?.extra_audits_balance || 0),
      extra_actions_used_cycle: Number(existingUser?.extra_actions_used_cycle || 0),
      extra_audits_used_cycle: Number(existingUser?.extra_audits_used_cycle || 0),
      extra_actions_purchased_total: Number(existingUser?.extra_actions_purchased_total || 0),
      extra_audits_purchased_total: Number(existingUser?.extra_audits_purchased_total || 0),
      purchase_history: normalizePurchaseHistory(existingUser?.purchase_history),
      billing_cycle_start: Number(existingUser?.billing_cycle_start || Date.now())
    });

    console.log("[lemon:webhook] Suscripcion SaaS sincronizada", {
      event: eventName,
      email: savedUser.email,
      plan: savedUser.plan,
      status: savedUser.status,
      product: paymentInfo.product_label
    });

    await recordPaymentLog("planActivated", paymentInfo, {
      eventName,
      status: savedUser.status
    });

    if (savedUser.status === "active" && eventName !== "subscription_cancelled") {
      const planLimits = getPlanLimits(savedUser.plan);
      await recordPaymentLog("creditsAdded", paymentInfo, {
        baseActions: planLimits.actions,
        baseAudits: planLimits.audits
      });
    }

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
    const requestedPlanType = String(req.query.plan_type || "subscription").toLowerCase();
    const planType = requestedPlanType === "audit" ? "audit" : "subscription";
    const identity = getIdentityFromRequest(req, {
      email: req.query.email,
      userId: req.query.user_id || req.query.auth_user_id,
      identitySource: req.query.user_id || req.query.auth_user_id ? "query.user_id" : "query.email"
    });
    const authContext = await resolveIdentityContext(identity, planType);
    const email = authContext.email || normalizeEmail(req.query.email);

    if (!email && !authContext.userId) {
      return res.status(400).json({ error: "email o user_id es requerido" });
    }

    const user = planType === "subscription"
      ? await ensureFreshSubscriptionUsage(authContext)
      : await getUserByIdentity(authContext, planType);

    await logAuthDebug(buildAuthDebugPayload({
      emailFromFrontend: req.query.email,
      identity: authContext,
      plan: user?.plan || planType,
      usageRow: user,
      authUser: authContext.authUser,
      extra: {
        route: "/api/user",
        planType,
        isEmailConfirmed: authContext.isEmailConfirmed
      }
    }));

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
        extra_actions_balance: 0,
        extra_audits_balance: 0,
        extra_actions_used_cycle: 0,
        extra_audits_used_cycle: 0,
        extra_actions_purchased_total: 0,
        extra_audits_purchased_total: 0,
        purchase_history: [],
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
    const identity = getIdentityFromRequest(req, {
      email: req.query.email,
      userId: req.query.user_id || req.query.auth_user_id,
      identitySource: req.query.user_id || req.query.auth_user_id ? "query.user_id" : "query.email"
    });
    const authContext = await resolveIdentityContext(identity, "subscription");
    const email = authContext.email || normalizeEmail(req.query.email);

    if (!email && !authContext.userId) {
      return res.status(400).json({ error: "email o user_id es requerido" });
    }

    if (hasUnlimitedAgencyOverride(email)) {
      const user = await ensureFreshSubscriptionUsage(authContext);
      logAuthDebug(buildAuthDebugPayload({
        emailFromFrontend: req.query.email,
        identity: authContext,
        plan: user?.plan || "agency",
        usageRow: user,
        authUser: authContext.authUser,
        extra: {
          route: "/api/subscription/usage",
          isEmailConfirmed: authContext.isEmailConfirmed
        }
      }));
      logUsageDebug(buildUsageDebugPayload(user, {
        route: "/api/subscription/usage",
        identitySource: authContext.identitySource || null,
        userId: authContext.userId || null
      }));
      return res.json({
        ...formatSubscriptionUsage(user),
        found: true,
        unlimited_agency: true
      });
    }

    const user = await ensureFreshSubscriptionUsage(authContext);

    if (!user || user.status === "cancelled") {
      logAuthDebug(buildAuthDebugPayload({
        emailFromFrontend: req.query.email,
        identity: authContext,
        plan: user?.plan || "free",
        usageRow: user,
        authUser: authContext.authUser,
        extra: {
          route: "/api/subscription/usage",
          isEmailConfirmed: authContext.isEmailConfirmed
        }
      }));
      logUsageDebug(buildUsageDebugPayload(user || getDefaultSubscriptionUser(authContext), {
        route: "/api/subscription/usage",
        identitySource: authContext.identitySource || null,
        userId: authContext.userId || null,
        reason: user?.status === "cancelled" ? "cancelled" : "not_found"
      }));
      return res.json({
        ...formatSubscriptionUsage(getDefaultSubscriptionUser(authContext)),
        status: user?.status || "active",
        found: Boolean(user)
      });
    }

    await logAuthDebug(buildAuthDebugPayload({
      emailFromFrontend: req.query.email,
      identity: authContext,
      plan: user?.plan || "free",
      usageRow: user,
      authUser: authContext.authUser,
      extra: {
        route: "/api/subscription/usage",
        isEmailConfirmed: authContext.isEmailConfirmed
      }
    }));
    await logUsageDebug(buildUsageDebugPayload(user, {
      route: "/api/subscription/usage",
      identitySource: authContext.identitySource || null,
      userId: authContext.userId || null
    }));

    return res.json({
      ...formatSubscriptionUsage(user),
      found: true
    });
  } catch (error) {
    console.error("[api:subscription:usage] Error consultando consumo:", error);
    return res.status(500).json({ error: "Error consultando consumo de suscripcion" });
  }
});

app.get("/api/subscription/capacity/offers", async (req, res) => {
  try {
    const identity = getIdentityFromRequest(req, {
      email: req.query.email,
      userId: req.query.user_id || req.query.auth_user_id,
      identitySource: req.query.user_id || req.query.auth_user_id ? "query.user_id" : "query.email"
    });
    const authContext = await resolveIdentityContext(identity, "subscription");
    const email = authContext.email || normalizeEmail(req.query.email);

    if (!email && !authContext.userId) {
      return res.status(400).json({ error: "email o user_id es requerido" });
    }

    const user = await ensureFreshSubscriptionUsage(authContext);
    const usage = formatSubscriptionUsage(user || getDefaultSubscriptionUser(authContext));
    const isAgency = normalizePlan(user?.plan || "free") === "agency" && String(user?.status || "active") === "active";
    const offers = isAgency
      ? AGENCY_CAPACITY_PACKS.map((pack) => serializeAgencyCapacityPack(pack))
      : [];

    await logAuthDebug(buildAuthDebugPayload({
      emailFromFrontend: req.query.email,
      identity: authContext,
      plan: user?.plan || "free",
      usageRow: user,
      authUser: authContext.authUser,
      extra: {
        route: "/api/subscription/capacity/offers",
        isEmailConfirmed: authContext.isEmailConfirmed
      }
    }));
    await logUsageDebug(buildUsageDebugPayload(user, {
      route: "/api/subscription/capacity/offers",
      identitySource: authContext.identitySource || null,
      userId: authContext.userId || null
    }));

    return res.json({
      available: offers.length > 0,
      eligible: isAgency,
      plan: normalizePlan(user?.plan || "free"),
      offers
    });
  } catch (error) {
    console.error("[api:subscription:capacity:offers] Error consultando ofertas:", error);
    return res.status(500).json({ error: "Error consultando expansiones de capacidad" });
  }
});

app.post("/api/subscription/consume", async (req, res) => {
  try {
    const identity = getIdentityFromRequest(req);
    const authContext = await resolveIdentityContext(identity, "subscription");
    const email = authContext.email || normalizeEmail(req.body?.email);
    const counterKey = String(req.body?.counter || "actions_used").trim();

    if (!email && !authContext.userId) {
      return res.status(400).json({ error: "email o user_id es requerido" });
    }

    const result = await consumeSubscriptionUsage(authContext, counterKey);

    if (!result.allowed) {
      const fallbackUser = result.user || await ensureFreshSubscriptionUsage(authContext);
      await logAuthDebug(buildAuthDebugPayload({
        emailFromFrontend: req.body?.email,
        identity: authContext,
        plan: fallbackUser?.plan || "free",
        usageRow: fallbackUser,
        authUser: authContext.authUser,
        extra: {
          route: "/api/subscription/consume",
          counterKey,
          isEmailConfirmed: authContext.isEmailConfirmed
        }
      }));
      await logUsageDebug(buildUsageDebugPayload(fallbackUser || getDefaultSubscriptionUser(authContext), {
        route: "/api/subscription/consume",
        identitySource: authContext.identitySource || null,
        userId: authContext.userId || null,
        counterKey,
        allowed: false,
        reason: result.reason
      }));
      return res.status(403).json({
        allowed: false,
        reason: result.reason,
        ...formatSubscriptionUsage(fallbackUser || getDefaultSubscriptionUser(authContext))
      });
    }

    await logAuthDebug(buildAuthDebugPayload({
      emailFromFrontend: req.body?.email,
      identity: authContext,
      plan: result.user?.plan || "free",
      usageRow: result.user,
      authUser: authContext.authUser,
      extra: {
        route: "/api/subscription/consume",
        counterKey,
        isEmailConfirmed: authContext.isEmailConfirmed
      }
    }));
    await logUsageDebug(buildUsageDebugPayload(result.user, {
      route: "/api/subscription/consume",
      identitySource: authContext.identitySource || null,
      userId: authContext.userId || null,
      counterKey,
      allowed: true
    }));

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
    const identity = getIdentityFromRequest(req);
    const authContext = await resolveIdentityContext(identity, "audit");
    const email = authContext.email || normalizeEmail(req.body?.email);

    if (!email && !authContext.userId) {
      return res.status(400).json({ error: "email o user_id es requerido" });
    }

    const result = await consumeAuditCredit(authContext);

    if (!result.allowed) {
      await logAuthDebug(buildAuthDebugPayload({
        emailFromFrontend: req.body?.email,
        identity: authContext,
        plan: result.user?.plan || "free",
        usageRow: result.user,
        authUser: authContext.authUser,
        extra: {
          route: "/api/audit/consume",
          isEmailConfirmed: authContext.isEmailConfirmed
        }
      }));
      await logUsageDebug(buildUsageDebugPayload(result.user || getDefaultSubscriptionUser(authContext), {
        route: "/api/audit/consume",
        identitySource: authContext.identitySource || null,
        userId: authContext.userId || null,
        allowed: false,
        reason: result.reason
      }));
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
    await logAuthDebug(buildAuthDebugPayload({
      emailFromFrontend: req.body?.email,
      identity: authContext,
      plan: user?.plan || "free",
      usageRow: user,
      authUser: authContext.authUser,
      extra: {
        route: "/api/audit/consume",
        isEmailConfirmed: authContext.isEmailConfirmed
      }
    }));
    await logUsageDebug(buildUsageDebugPayload(user, {
      route: "/api/audit/consume",
      identitySource: authContext.identitySource || null,
      userId: authContext.userId || null,
      allowed: true
    }));
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

app.post("/api/chat/stream", async (req, res) => {
  let streamOpened = false;
  let clientClosed = false;

  req.on("close", () => {
    clientClosed = true;
  });

  const openStream = () => {
    if (streamOpened) return;

    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    streamOpened = true;
  };

  const pushEvent = (payload = {}) => {
    if (clientClosed || res.writableEnded) return false;
    openStream();
    writeNdjsonEvent(res, payload);
    return true;
  };

  const closeStream = () => {
    if (!res.writableEnded) {
      res.end();
    }
  };

  try {
    const {
      messages = [],
      temperature = 0.7,
      response_format
    } = req.body || {};

    const incomingRouting = req.body?.zentra_routing || {};
    const requestedTaskType = incomingRouting.taskType || req.body?.task_type || "chat_basic";
    const taskType = normalizeTaskType(requestedTaskType);
    const responseFormat = response_format || { type: "json_object" };
    const cleanMessages = sanitizeChatMessages(messages);
    const maxTokens = clampMaxTokens(req.body?.max_tokens || incomingRouting.maxTokens, taskType);
    const responseContract = req.body?.responseContract || req.body?.response_contract || req.body?.zentra_response_contract || req.body?.zentra_contract || null;
    const requestedPremium = taskType === "chat_premium";
    const premiumPreview = requestedPremium
      ? await resolveAiRoutingForRequest(req, { consumePremium: false })
      : {
          taskType,
          email: getEmailFromChatRequest(req, incomingRouting),
          counterKey: null,
          premiumAvailable: false,
          premiumActive: false,
          premiumConsumed: false,
          reason: "premium_not_requested"
        };
    const requestContext = {
      routeName: "api/chat/stream",
      taskType,
      requestedModel: req.body?.model || req.body?.zentra_routing?.selectedModel || null,
      contextDecision: responseContract?.contextDecision || req.body?.contextDecision || req.body?.zentra_contextDecision || null,
      outputType: responseContract?.outputType || req.body?.outputType || req.body?.zentra_outputType || null,
      renderType: responseContract?.renderType || req.body?.renderType || req.body?.zentra_renderType || null
    };

    const fastRoute = {
      taskType: "chat_basic",
      provider: ZENTRA_CHAT_FAST_PROVIDER,
      model: ZENTRA_CHAT_FAST_MODEL,
      fallbackProvider: ZENTRA_BASE_PROVIDER,
      fallbackModel: ZENTRA_BASE_MODEL,
      maxTokens: Math.min(maxTokens, 1100)
    };

    pushEvent({
      type: "status",
      phase: "fast",
      label: "Entendiendo",
      message: "Leyendo contexto y armando una primera respuesta."
    });

    const fastStartedAt = Date.now();
    const fastStep = await callLayeredChatStep({
      route: fastRoute,
      instruction: buildLayeredChatFastInstruction(),
      cleanMessages,
      temperature: 0.55,
      maxTokens: fastRoute.maxTokens,
      responseFormat,
      requestContext
    });

    if (!fastStep.ok) {
      throw new Error(fastStep.error || "No se pudo generar la respuesta inicial.");
    }

    const fastLayer = normalizeChatFastLayerPayload(fastStep.parsed, fastStep.content);
    let finalText = firstNonEmptyString(fastLayer.response);

    if (!finalText) {
      throw new Error("La capa rapida no devolvio una respuesta util.");
    }

    const aggregatedUsages = [];
    if (fastStep.usage) aggregatedUsages.push(fastStep.usage);

    const layers = {
      fast: {
        success: true,
        requestedModel: fastStep.requestedModel,
        actualModel: fastStep.model,
        provider: fastStep.provider,
        inputTokens: Number(fastStep.usage?.prompt_tokens || 0) || null,
        outputTokens: Number(fastStep.usage?.completion_tokens || 0) || null,
        latencyMs: Date.now() - fastStartedAt,
        intent: fastLayer.intent,
        visibleSignals: fastLayer.visibleSignals
      },
      reasoning: null,
      executive: null
    };

    let finalRouting = {
      taskType,
      provider: fastStep.provider,
      model: fastStep.model,
      premiumAvailable: Boolean(premiumPreview.premiumAvailable),
      premiumActive: false,
      premiumConsumed: false,
      counterKey: premiumPreview.counterKey || null,
      advancedActionsUsed: Number(premiumPreview.advancedActionsUsed || 0),
      advancedActionsLimit: Number(premiumPreview.advancedActionsLimit || 0),
      advancedActionsRemaining: Number(premiumPreview.advancedActionsRemaining || 0),
      reason: requestedPremium && !premiumPreview.premiumAvailable
        ? (premiumPreview.reason || "fast_layer_only")
        : "fast_layer_only",
      premiumFallbackError: null
    };

    pushEvent({
      type: "layer",
      phase: "fast",
      text: finalText,
      replace: true,
      intent: fastLayer.intent,
      visibleSignals: fastLayer.visibleSignals,
      meta: {
        provider: fastStep.provider,
        model: fastStep.model,
        latencyMs: layers.fast.latencyMs
      }
    });

    const wantsReasoning = requestedPremium && Boolean(fastLayer.needsReasoning);
    if (wantsReasoning && premiumPreview.premiumAvailable && !clientClosed) {
      pushEvent({
        type: "status",
        phase: "reasoning",
        label: "Refinando criterio",
        message: "Priorizando y comparando antes de cerrar la respuesta."
      });

      let reasoningRouting = {
        ...premiumPreview,
        premiumActive: false,
        premiumConsumed: false
      };

      if (reasoningRouting.counterKey && reasoningRouting.planType !== "audit") {
        const premiumUsage = await consumeSubscriptionUsage({
          email: reasoningRouting.email,
          userId: reasoningRouting.userId || reasoningRouting.authUserId,
          auth_user_id: reasoningRouting.authUserId || reasoningRouting.userId,
          identitySource: reasoningRouting.identitySource
        }, reasoningRouting.counterKey);
        if (premiumUsage.allowed) {
          const savedPremiumUsage = premiumUsage.user ? formatSubscriptionUsage(premiumUsage.user) : null;
          const savedPremiumUsed = normalizeCounterValue(
            savedPremiumUsage?.advanced_actions_used ??
            savedPremiumUsage?.premium_chat_used ??
            premiumUsage.user?.premium_chat_used ??
            (Number(reasoningRouting.advancedActionsUsed || 0) + 1)
          );
          const savedPremiumLimit = normalizeCounterValue(
            savedPremiumUsage?.advanced_actions_limit ??
            savedPremiumUsage?.premium_chat_limit ??
            reasoningRouting.advancedActionsLimit
          );
          reasoningRouting = {
            ...reasoningRouting,
            premiumAvailable: true,
            premiumActive: true,
            premiumConsumed: true,
            advancedActionsUsed: savedPremiumUsed,
            advancedActionsLimit: savedPremiumLimit || Number(reasoningRouting.advancedActionsLimit || 0),
            advancedActionsRemaining: Math.max((savedPremiumLimit || Number(reasoningRouting.advancedActionsLimit || 0)) - savedPremiumUsed, 0),
            reason: "premium_authorized"
          };
        } else {
          reasoningRouting = {
            ...reasoningRouting,
            premiumAvailable: false,
            premiumActive: false,
            premiumConsumed: false,
            reason: premiumUsage.reason || "premium_limit_reached"
          };
        }
      } else {
        reasoningRouting = {
          ...reasoningRouting,
          premiumAvailable: true,
          premiumActive: true,
          premiumConsumed: false
        };
      }

      finalRouting = {
        ...finalRouting,
        taskType: reasoningRouting.taskType || taskType,
        premiumAvailable: Boolean(reasoningRouting.premiumAvailable),
        premiumActive: Boolean(reasoningRouting.premiumActive),
        premiumConsumed: Boolean(reasoningRouting.premiumConsumed),
        advancedActionsUsed: Number(reasoningRouting.advancedActionsUsed || finalRouting.advancedActionsUsed || 0),
        advancedActionsLimit: Number(reasoningRouting.advancedActionsLimit || finalRouting.advancedActionsLimit || 0),
        advancedActionsRemaining: Number(reasoningRouting.advancedActionsRemaining || finalRouting.advancedActionsRemaining || 0),
        reason: reasoningRouting.reason || finalRouting.reason
      };

      if (reasoningRouting.premiumAvailable) {
        const reasoningStartedAt = Date.now();
        const reasoningStep = await callLayeredChatStep({
          route: reasoningRouting,
          instruction: buildLayeredChatReasoningInstruction(fastLayer),
          cleanMessages,
          temperature: 0.35,
          maxTokens: Math.min(
            reasoningRouting.maxTokens || ZENTRA_CHAT_REASONING_MAX_TOKENS,
            ZENTRA_CHAT_REASONING_MAX_TOKENS
          ),
          responseFormat,
          requestContext
        });

        finalRouting.premiumFallbackError = reasoningStep.fallbackError || null;

        if (reasoningStep.ok) {
          if (reasoningStep.usage) aggregatedUsages.push(reasoningStep.usage);

          const reasoningLayer = normalizeChatReasoningLayerPayload(reasoningStep.parsed, reasoningStep.content);
          const reasoningApplied = Boolean(reasoningLayer.response) && (
            reasoningLayer.reasoningAddedValue
            || isMeaningfullyDifferentText(reasoningLayer.response, finalText)
          );

          layers.reasoning = {
            success: true,
            requestedModel: reasoningStep.requestedModel,
            actualModel: reasoningStep.model,
            provider: reasoningStep.provider,
            inputTokens: Number(reasoningStep.usage?.prompt_tokens || 0) || null,
            outputTokens: Number(reasoningStep.usage?.completion_tokens || 0) || null,
            latencyMs: Date.now() - reasoningStartedAt,
            applied: reasoningApplied,
            summary: reasoningLayer.reasoningSummary,
            routingReason: reasoningRouting.reason || null,
            routingTaskType: reasoningRouting.taskType || taskType,
            routingModel: reasoningRouting.model || null,
            routingPremiumActive: Boolean(reasoningRouting.premiumActive),
            routingFallbackError: reasoningStep.fallbackError || null
          };

          finalRouting.provider = reasoningStep.provider;
          finalRouting.model = reasoningStep.model;
          finalRouting.reason = reasoningApplied ? "reasoning_applied" : "reasoning_kept_fast";

          if (reasoningApplied) {
            finalText = reasoningLayer.response;
            pushEvent({
              type: "layer",
              phase: "reasoning",
              text: finalText,
              replace: true,
              summary: reasoningLayer.reasoningSummary,
              meta: {
                provider: reasoningStep.provider,
                model: reasoningStep.model,
                latencyMs: layers.reasoning.latencyMs
              }
            });
          }

          if (shouldAttemptExecutiveChatPolish(fastLayer, reasoningLayer) && !clientClosed) {
            pushEvent({
              type: "status",
              phase: "executive",
              label: "Puliendo claridad",
              message: "Ajustando el cierre final para que suene mas claro y senior."
            });

            const executiveRoute = buildChatExecutiveRoute(reasoningRouting);
            const executiveStartedAt = Date.now();
            const executiveStep = await callLayeredChatStep({
              route: executiveRoute,
              instruction: buildLayeredChatExecutiveInstruction(fastLayer, reasoningLayer),
              cleanMessages,
              temperature: 0.2,
              maxTokens: executiveRoute.maxTokens,
              responseFormat,
              requestContext
            });

            if (executiveStep.ok) {
              if (executiveStep.usage) aggregatedUsages.push(executiveStep.usage);

              const executiveLayer = normalizeChatExecutiveLayerPayload(executiveStep.parsed, executiveStep.content);
              const executiveApplied = Boolean(executiveLayer.response) && (
                executiveLayer.changed
                || isMeaningfullyDifferentText(executiveLayer.response, finalText)
              );

              layers.executive = {
                success: true,
                requestedModel: executiveStep.requestedModel,
                actualModel: executiveStep.model,
                provider: executiveStep.provider,
                inputTokens: Number(executiveStep.usage?.prompt_tokens || 0) || null,
                outputTokens: Number(executiveStep.usage?.completion_tokens || 0) || null,
                latencyMs: Date.now() - executiveStartedAt,
                applied: executiveApplied,
                changeReason: executiveLayer.changeReason,
                routingReason: finalRouting.reason,
                routingTaskType: executiveRoute.taskType,
                routingModel: executiveRoute.model,
                routingPremiumActive: true,
                routingFallbackError: executiveStep.fallbackError || null
              };

              if (executiveApplied) {
                finalText = executiveLayer.response;
                finalRouting.provider = executiveStep.provider;
                finalRouting.model = executiveStep.model;
                finalRouting.reason = "executive_polish_applied";
                pushEvent({
                  type: "layer",
                  phase: "executive",
                  text: finalText,
                  replace: true,
                  summary: executiveLayer.changeReason,
                  meta: {
                    provider: executiveStep.provider,
                    model: executiveStep.model,
                    latencyMs: layers.executive.latencyMs
                  }
                });
              }
            } else {
              layers.executive = {
                success: false,
                error: executiveStep.error,
                requestedModel: executiveStep.requestedModel,
                actualModel: executiveStep.model,
                provider: executiveStep.provider
              };
            }
          }
        } else {
          layers.reasoning = {
            success: false,
            error: reasoningStep.error,
            requestedModel: reasoningStep.requestedModel,
            actualModel: reasoningStep.model,
            provider: reasoningStep.provider,
            routingReason: reasoningRouting.reason || null,
            routingTaskType: reasoningRouting.taskType || taskType,
            routingModel: reasoningRouting.model || null,
            routingPremiumActive: Boolean(reasoningRouting.premiumActive),
            routingFallbackError: reasoningStep.fallbackError || null
          };
          finalRouting.provider = fastStep.provider;
          finalRouting.model = fastStep.model;
          finalRouting.reason = "reasoning_failed_fast_kept";
        }
      }
    }

    const finalPayload = {
      type: "final",
      text: finalText,
      usage: sumAiUsage(aggregatedUsages),
      provider: finalRouting.provider,
      model: finalRouting.model,
      zentra_routing: finalRouting,
      layers
    };

    pushEvent(finalPayload);
    closeStream();
  } catch (error) {
    if (!streamOpened) {
      return res.status(500).json({ error: "Error en el servidor" });
    }

    pushEvent({
      type: "error",
      message: error?.message || "Error en el servidor"
    });
    closeStream();
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
    const responseContract = req.body?.responseContract || req.body?.response_contract || req.body?.zentra_response_contract || req.body?.zentra_contract || null;
    const requestContext = {
      routeName: "api/chat",
      taskType: aiRouting.taskType,
      requestedModel: req.body?.model || req.body?.zentra_routing?.selectedModel || null,
      contextDecision: responseContract?.contextDecision || req.body?.contextDecision || req.body?.zentra_contextDecision || null,
      outputType: responseContract?.outputType || req.body?.outputType || req.body?.zentra_outputType || null,
      renderType: responseContract?.renderType || req.body?.renderType || req.body?.zentra_renderType || null
    };
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
      reason: aiRouting.reason,
      premiumAllowed: Boolean(aiRouting.premiumAllowed),
      premiumQuotaAvailable: Boolean(aiRouting.premiumQuotaAvailable),
      premiumFallbackReason: aiRouting.premiumFallbackReason || null,
      advancedActionsUsed: Number(aiRouting.advancedActionsUsed || 0),
      advancedActionsLimit: Number(aiRouting.advancedActionsLimit || 0),
      advancedActionsRemaining: Number(aiRouting.advancedActionsRemaining || 0)
    });

    const cleanMessages = sanitizeChatMessages(messages);

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
      maxTokens: aiRouting.maxTokens,
      requestContext
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
        maxTokens: aiRouting.maxTokens,
        requestContext: {
          ...requestContext,
          routeName: "api/chat:fallback",
          requestedModel: aiRouting.fallbackModel
        }
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
      provider: result.provider,
      premiumAllowed: Boolean(aiRouting.premiumAllowed),
      premiumQuotaAvailable: Boolean(aiRouting.premiumQuotaAvailable),
      premiumFallbackReason: aiRouting.premiumFallbackReason || null,
      advancedActionsUsed: Number(aiRouting.advancedActionsUsed || 0),
      advancedActionsLimit: Number(aiRouting.advancedActionsLimit || 0),
      advancedActionsRemaining: Number(aiRouting.advancedActionsRemaining || 0)
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
        premiumAllowed: aiRouting.premiumAllowed,
        premiumQuotaAvailable: aiRouting.premiumQuotaAvailable,
        premiumFallbackReason: aiRouting.premiumFallbackReason,
        counterKey: aiRouting.counterKey,
        advancedActionsUsed: aiRouting.advancedActionsUsed,
        advancedActionsLimit: aiRouting.advancedActionsLimit,
        advancedActionsRemaining: aiRouting.advancedActionsRemaining,
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
