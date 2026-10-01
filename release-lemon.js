import crypto from "node:crypto";

const subscriptionEvents = new Set([
  "subscription_created", "subscription_updated", "subscription_cancelled", "subscription_expired",
  "subscription_resumed", "subscription_paused", "subscription_unpaused"
]);
const refundEvents = new Set(["order_refunded", "subscription_payment_refunded"]);
const paymentEvents = new Set(["subscription_payment_success", "subscription_payment_failed", "subscription_payment_recovered"]);
const subscriptionStatuses = new Set(["on_trial", "active", "paused", "past_due", "unpaid", "cancelled", "expired"]);

export function validLemonSignature(rawBody, signature, secret) {
  if (!secret || !Buffer.isBuffer(rawBody) || !/^[a-f0-9]{64}$/i.test(signature || "")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  return crypto.timingSafeEqual(Buffer.from(signature, "hex"), expected);
}

export function lemonCatalog(products) {
  const byKey = new Map();
  const byVariant = new Map();
  for (const [family, entries] of Object.entries(products)) {
    for (const [key, entry] of Object.entries(entries)) {
      const variant = String(entry.variantId);
      const plan = family === "EXTRAS" ? "agency" :
        /agency/i.test(key) ? "agency" : /pro/i.test(key) ? "pro" : /starter/i.test(key) ? "starter" : null;
      const url = new URL(entry.link);
      if (!plan || !/^\d+$/.test(variant) || !/^\d+$/.test(String(entry.productId))
        || byVariant.has(variant) || url.protocol !== "https:" || url.hostname !== "tryzentra.lemonsqueezy.com"
        || url.username || url.password) throw new Error("Invalid Lemon catalog");
      const value = Object.freeze({ key, variant, product: String(entry.productId), plan,
        family: family === "SAAS" ? "subscription" : family === "AUDIT" ? "audit" : "extra",
        interval: family === "SAAS" ? key.endsWith("_yearly") ? "year" : "month" : null,
        url: url.href, actions: family === "EXTRAS" ? entry.actions : 0,
        audits: family === "EXTRAS" ? entry.audits : 0 });
      byKey.set(key, value);
      byVariant.set(variant, value);
    }
  }
  return { byKey, byVariant };
}

function providerDate(value, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("Invalid provider date");
  }
  return new Date(value).toISOString();
}

export function lemonSubscription(payload, catalog, storeId) {
  const data = payload?.data;
  const a = data?.attributes;
  if (data?.type !== "subscriptions" || !/^\d+$/.test(String(data.id)) || !a
    || String(a.store_id) !== String(storeId) || !/^\d+$/.test(String(a.customer_id))
    || !subscriptionStatuses.has(a.status)) {
    throw new Error("Invalid subscription identity");
  }
  const mapping = catalog.byVariant.get(String(a.variant_id));
  if (!mapping || mapping.family !== "subscription" || mapping.product !== String(a.product_id)) return null;
  if ((a.status === "cancelled" && !a.ends_at) || (a.status === "on_trial" && !a.trial_ends_at)
    || (a.status === "paused" && !["free", "void"].includes(a.pause?.mode))) {
    throw new Error("Incomplete provider state");
  }
  return { store: String(a.store_id), customer: String(a.customer_id), subscription: String(data.id),
    variant: mapping.variant, product: mapping.product, plan: mapping.plan, interval: mapping.interval,
    status: a.status, pause_mode: a.pause?.mode || null,
    ends_at: providerDate(a.ends_at), renews_at: providerDate(a.renews_at),
    trial_ends_at: providerDate(a.trial_ends_at), updated_at: providerDate(a.updated_at, true),
    created_at: providerDate(a.created_at, true) };
}

function eventKey(event, type, resource, item) {
  // Stable across JSON formatting/redelivery; data.id identifies a resource,
  // not a delivery. Provider version and refund amount distinguish changes.
  return crypto.createHash("sha256").update(JSON.stringify([
    event, type, String(resource), item.store, item.updated_at,
    refundEvents.has(event) ? item.refunded_amount : null
  ])).digest("hex");
}

export function createLemonHandlers({ client, products, env = process.env, logger = console, fetchImpl = fetch }) {
  const catalog = lemonCatalog(products);
  const storeId = String(env.LEMON_SQUEEZY_STORE_ID || "");
  const configured = () => /^\d+$/.test(storeId) && client;
  const rpc = async (name, args) => {
    const result = await client.rpc(name, args);
    if (result.error) throw result.error;
    return result.data;
  };
  const safeFailure = (res, code = "billing_unavailable") => res.status(503).json({ error: "No se pudo sincronizar la suscripcion.", code });
  const readSubscription = async (subscription, customer) => {
    if (!configured() || !env.LEMON_SQUEEZY_API_KEY || !/^\d+$/.test(subscription)) throw new Error("Billing sync not configured");
    const response = await fetchImpl("https://api.lemonsqueezy.com/v1/subscriptions/" + subscription, {
      headers: { Authorization: "Bearer " + env.LEMON_SQUEEZY_API_KEY, Accept: "application/vnd.api+json" },
      redirect: "error", signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error("Provider unavailable");
    const payload = await response.json();
    if (payload.data?.attributes?.test_mode === true && env.LEMON_ALLOW_TEST_WEBHOOKS !== "true") throw new Error("Invalid billing mode");
    const item = lemonSubscription(payload, catalog, storeId);
    if (!item || item.customer !== customer || item.subscription !== subscription) throw new Error("Billing identity conflict");
    return { ...item, authoritative_api: true };
  };
  return {
    async reconcile(req, res, next) {
      const routes = new Set(["/api/user", "/api/subscription/usage", "/api/subscription/capacity/offers",
        "/api/chat", "/api/chat/stream", "/api/audit/reserve"]);
      const path = req.path.replace(/\/+$/, "").toLowerCase();
      const auditProduct = path === "/api/user" ? String(req.query?.plan_type || "").toLowerCase() === "audit" :
        ["/api/chat", "/api/chat/stream", "/api/audit/reserve"].includes(path) && req.body?.zentra_operation?.product === "audit";
      if (!req.auth || !routes.has(path) || auditProduct) return next();
      let target;
      let success = false;
      try {
        target = await rpc("zentra_lemon_sync_claim", { p_auth: req.auth.userId });
        if (!target) return next();
        if (target.busy) return safeFailure(res, "billing_sync_pending");
        if (target.unverified) return safeFailure(res, "billing_association_required");
        if (target.store !== storeId) throw new Error("Billing store conflict");
        const item = await readSubscription(target.subscription, target.customer);
        await rpc("zentra_lemon_event", { p_key: crypto.createHash("sha256").update("sync:" + JSON.stringify(item)).digest("hex"),
          p_event: "subscription_updated", p_type: "subscriptions", p_resource: item.subscription, p_binding: null, p_item: item });
        success = true;
        const finished = await rpc("zentra_lemon_sync_finish", { p_store: target.store, p_subscription: target.subscription,
          p_token: target.token, p_success: true });
        if (finished !== true) throw new Error("Billing ownership changed");
        return next();
      } catch (_) { return safeFailure(res); }
      finally {
        if (target?.token && !success) {
          try { await rpc("zentra_lemon_sync_finish", { p_store: target.store, p_subscription: target.subscription,
            p_token: target.token, p_success: false }); } catch (_) { /* The DB lease expires without acknowledging success. */ }
        }
      }
    },
    async checkout(req, res) {
      if (!req.auth?.userId) return res.status(401).json({ error: "Inicia sesion para continuar." });
      if (!configured()) return safeFailure(res);
      const mapping = catalog.byKey.get(req.body?.productKey);
      if (!mapping || Object.keys(req.body || {}).some(key => key !== "productKey")) {
        return res.status(400).json({ error: "Opcion de compra no permitida." });
      }
      try {
        const token = crypto.randomBytes(32).toString("hex");
        await rpc("zentra_lemon_checkout", { p_auth: req.auth.userId, p_email: req.auth.email,
          p_hash: crypto.createHash("sha256").update(token).digest("hex"), p_store: storeId,
          p_variant: mapping.variant, p_product: mapping.product, p_family: mapping.family,
          p_plan: mapping.plan, p_interval: mapping.interval });
        const url = new URL(mapping.url);
        url.searchParams.set("checkout[custom][zentra_binding]", token);
        // Email is only a convenience; the opaque DB-backed binding is the authority.
        url.searchParams.set("checkout[email]", req.auth.email);
        return res.json({ success: true, url: url.href });
      } catch (_) { return safeFailure(res); }
    },
    async webhook(req, res) {
      if (!env.LEMON_SQUEEZY_WEBHOOK_SECRET) return safeFailure(res);
      if (!validLemonSignature(req.rawBody, req.get("X-Signature"), env.LEMON_SQUEEZY_WEBHOOK_SECRET)) {
        return res.status(401).json({ error: "Invalid webhook signature" });
      }
      if (!configured()) return safeFailure(res);
      const payload = req.body || {};
      const event = payload.meta?.event_name;
      const headerEvent = req.get("X-Event-Name");
      if (typeof event !== "string" || (headerEvent && headerEvent !== event)) {
        return res.status(400).json({ error: "Invalid webhook event" });
      }
      const data = payload.data || {};
      const a = data.attributes || {};
      if (String(a.store_id) !== storeId) return res.status(400).json({ error: "Invalid webhook store" });
      if ((a.test_mode === true || payload.meta?.test_mode === true) && env.LEMON_ALLOW_TEST_WEBHOOKS !== "true") {
        return res.json({ success: true, ignored: true });
      }
      if (!subscriptionEvents.has(event) && !paymentEvents.has(event) && !refundEvents.has(event) && event !== "order_created") {
        return res.json({ success: true, ignored: true });
      }
      try {
        const token = payload.meta?.custom_data?.zentra_binding;
        const bindingHash = typeof token === "string" && /^[a-f0-9]{64}$/.test(token)
          ? crypto.createHash("sha256").update(token).digest("hex") : null;
        let item;
        let receiptKey;
        if (subscriptionEvents.has(event)) {
          item = lemonSubscription(payload, catalog, storeId);
          if (!item) {
            logger.warn("[lemon] rejected", { reason: "unknown_variant_or_product" });
            return res.json({ success: true, ignored: true, reason: "unknown_variant_or_product" });
          }
        } else if (paymentEvents.has(event)) {
          if (data.type !== "subscription-invoices" || !/^\d+$/.test(String(data.id))) throw new Error("Invalid payment resource");
          receiptKey = eventKey(event, data.type, data.id, { store: storeId, updated_at: providerDate(a.updated_at, true) });
          if (await rpc("zentra_lemon_event_seen", { p_key: receiptKey })) return res.json({ success: true, duplicate: true });
          // Invoice IDs are never used as subscription IDs. A paid invoice alone
          // cannot override a cancelled/expired subscription or reset its usage.
          item = await readSubscription(String(a.subscription_id), String(a.customer_id));
        } else if (refundEvents.has(event)) {
          if (data.type !== (event === "order_refunded" ? "orders" : "subscription-invoices")) throw new Error("Invalid refund type");
          item = { store: storeId, customer: String(a.customer_id || ""),
            subscription: a.subscription_id == null ? null : String(a.subscription_id),
            order: event === "order_refunded" ? String(data.id) : null,
            refunded_amount: Number.isSafeInteger(a.refunded_amount) && a.refunded_amount >= 0 ? a.refunded_amount : null,
            refunded: a.refunded === true,
            updated_at: providerDate(a.updated_at, true) };
        } else {
          if (data.type !== "orders") throw new Error("Invalid order type");
          if (a.status !== "paid") return res.json({ success: true, ignored: true });
          const orderItem = a.first_order_item || {};
          const mapping = catalog.byVariant.get(String(orderItem.variant_id));
          if (!mapping || mapping.product !== String(orderItem.product_id)) {
            return res.json({ success: true, ignored: true, reason: "unknown_variant_or_product" });
          }
          // The accompanying subscription event, not an order, grants SaaS access.
          if (mapping.family === "subscription") return res.json({ success: true, ignored: true });
          item = { store: storeId, customer: String(a.customer_id), order: String(data.id),
            variant: mapping.variant, product: mapping.product, plan: mapping.plan, family: mapping.family,
            actions: mapping.actions, audits: mapping.audits, created_at: providerDate(a.created_at, true),
            updated_at: providerDate(a.updated_at, true) };
        }
        const result = await rpc("zentra_lemon_event", {
          p_key: receiptKey || eventKey(event, data.type, data.id, item),
          p_event: event, p_type: data.type, p_resource: String(data.id), p_binding: bindingHash, p_item: item
        });
        return res.json({ success: true, duplicate: Boolean(result.duplicate), ignored: Boolean(result.ignored) });
      } catch (_) {
        // No body, email, tokens, signature, provider URLs or DB exception details.
        logger.warn("[lemon] processing_failed", { event: subscriptionEvents.has(event) ? event : "order_or_refund" });
        return safeFailure(res);
      }
    }
  };
}
