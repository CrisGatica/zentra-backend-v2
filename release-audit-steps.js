import { readFileSync } from "node:fs";
import vm from "node:vm";
import { requestFingerprint } from "./release-security.js";
import { auditEntitlement, validateAuditEntitlement } from "./release-entitlements.js";
import { auditPublicUrl, auditUrlKey } from "./release-audit-urls.js";
import { auditTelemetryContext } from "./release-audit-routing.js";

// Pinned application code only. The sandbox has no network or browser credentials.
const script = new vm.Script(readFileSync(new URL("./trusted-audit-builders.js", import.meta.url), "utf8"));
const stages = new Set(["seo_analysis", "premium_reasoning_audit", "executive_refiner_pdf"]);
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function createAudit(context, rootBody) {
  const sandbox = vm.createContext({
    window: {}, URL, URLSearchParams,
    localStorage: { getItem() { return null; }, removeItem() {} },
    console: { log() {}, warn() {}, error() {} }
  });
  script.runInContext(sandbox, { timeout: 1000 });
  const bot = sandbox.window.claudeAI;
  bot.debugLog = () => {};
  bot.recordLabAuditSample = () => {};
  bot.model = rootBody.model || bot.model;
  bot.labExecutiveRefinerEnabled = context.executiveRefinerEnabled !== false;
  bot.resolveAuditScope = async () => clone(context.auditScope);
  bot.fetchInternalPagesContext = async () => clone(context.internalPagesResult);
  bot.fetchFreePreviewPagesContext = async () => clone(context.freePreviewPagesResult);
  return bot;
}

function validateEvidence(evidence) {
  if (!evidence || !Array.isArray(evidence.queries) || !Array.isArray(evidence.results)
    || !Array.isArray(evidence.enrichedResults) || evidence.results.length > 6
    || evidence.enrichedResults.length > 6 || JSON.stringify(evidence).length > 262144) {
    throw new Error("Invalid competitive evidence");
  }
  for (const candidate of [...evidence.results, ...evidence.enrichedResults]) {
    const url = new URL(candidate.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid evidence URL");
  }
  if (evidence.searchRuns !== undefined) {
    const runs = evidence.searchRuns;
    if (!Array.isArray(runs) || runs.length < 1 || runs.length > 2
      || runs[0]?.scope !== "web" || (runs.length === 2 && runs[1]?.scope !== "social")
      || !same(runs[0]?.queries, evidence.queries)) throw new Error("Invalid search stages");
    if (runs.length === 2) {
      const socialQueries = evidence.queries.filter(query => !/-site:/i.test(query));
      if (!same(runs[1]?.queries, socialQueries.length ? socialQueries : evidence.queries.slice(0, 1))) {
        throw new Error("Mismatched social search");
      }
    }
    for (const run of runs) {
      if (!Array.isArray(run.results) || !Array.isArray(run.enrichedResults)
        || run.results.length > 3 || run.enrichedResults.length !== run.results.length) {
        throw new Error("Invalid search stage evidence");
      }
    }
    if (!same(runs.flatMap(run => run.results), evidence.results)
      || !same(runs.flatMap(run => run.enrichedResults), evidence.enrichedResults)) {
      throw new Error("Mismatched search stages");
    }
  }
  const base = evidence.searchRuns ? evidence.results : evidence.results.slice(0, 4);
  if (base.length !== evidence.enrichedResults.length) throw new Error("Mismatched evidence");
  for (let i = 0; i < base.length; i++) {
    const { pagePreview, ...candidate } = evidence.enrichedResults[i];
    if (!same(candidate, base[i])) throw new Error("Mismatched candidate");
  }
  return clone(evidence);
}

/** Replays the validated pipeline with frozen page data and persisted model outputs. */
export async function buildAuditStep(stage, root, steps = [], evidence = null) {
  if (!stages.has(stage)) throw new Error("Unknown audit step");
  const context = root.context;
  if (context?.version !== 1 || !context.pageData?.url || !context.auditScope
    || !Array.isArray(context.internalPagesResult?.pages)
    || !Array.isArray(context.freePreviewPagesResult?.pages)) throw new Error("Invalid original audit");
  const bot = createAudit(context, root.body);
  if (!validateAuditEntitlement(context, context.auditScope.plan)) throw new Error("Invalid audit scope or page count");
  let expectedSearchRuns = 0;
  let searchIndex = 0;
  let enrichIndex = 0;
  if (stage !== "seo_analysis") {
    evidence = validateEvidence(evidence);
    const runs = evidence.searchRuns || [{ scope: "web", queries: evidence.queries,
      results: evidence.results, enrichedResults: evidence.enrichedResults, error: evidence.error }];
    expectedSearchRuns = runs.length;
    bot.fetchExpandedCompetitiveResults = async (queries, _site, _limit, _budget, scope = "web") => {
      const run = runs[searchIndex++];
      if (!run || run.scope !== scope || !same(queries, run.queries)) {
        throw new Error("Evidence belongs to another audit");
      }
      return { results: clone(run.results), error: run.error || null };
    };
    bot.enrichCompetitiveCandidates = async candidates => {
      const run = runs[enrichIndex++];
      if (!run || !same(candidates, run.results)) throw new Error("Evidence mismatch");
      return clone(run.enrichedResults);
    };
  }
  let captured;
  let evidenceError = false;
  // A search failure is normally recoverable. A provenance mismatch is not a search failure.
  if (stage !== "seo_analysis") {
    const search = bot.fetchExpandedCompetitiveResults;
    bot.fetchExpandedCompetitiveResults = async (...args) => {
      try { return await search(...args); } catch (error) { evidenceError = true; throw error; }
    };
  }
  bot.callAPI = async (messages, options) => {
    const task = options.taskType;
    if (task === stage) {
      captured = {
        model: options.forceModel || root.body.model || bot.model,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        messages: [{ role: "system", content: options.system }, ...clone(messages)],
        task_type: task,
        zentra_routing: { ...root.body.zentra_routing, taskType: task },
        zentra_user_email: root.body.zentra_user_email || "",
        ...(options.jsonMode ? { response_format: { type: "json_object" } } : {})
      };
      throw new Error("Audit request captured");
    }
    const previous = steps.find(step => step.step_name === task);
    if (!previous || previous.state !== "done" || !previous.response) throw new Error("Audit prerequisite incomplete");
    const content = previous.response.body?.response ?? previous.response.text;
    const model = previous.body.model || bot.model;
    return {
      success: true, content: typeof content === "string" ? content : JSON.stringify(content),
      model, actualModel: model, requestedModel: model,
      rawResponse: { audit_consultative: previous.response.body?.audit_consultative }
    };
  };
  await bot.analyzeSEO(clone(context.pageData));
  if (!captured || evidenceError || (stage !== "seo_analysis" &&
    (searchIndex !== expectedSearchRuns || enrichIndex !== expectedSearchRuns))) {
    throw new Error("Audit step not applicable");
  }
  return captured;
}

// Only replay frozen data: no crawl, provider call or new quota reservation.
export async function buildAuditSearchRequests(root, steps) {
  const initial = steps.find(step => step.step_name === "seo_analysis");
  if (!root?.context || initial?.state !== "done" || !initial.response) return [];
  const bot = createAudit(root.context, root.body);
  const requests = [];
  bot.callAPI = async (_messages, options) => {
    if (options.taskType !== "seo_analysis") throw new Error("Search authorization captured");
    const content = initial.response.body?.response ?? initial.response.text;
    return {
      success: true, content: typeof content === "string" ? content : JSON.stringify(content),
      model: root.body.model || bot.model,
      rawResponse: { audit_consultative: initial.response.body?.audit_consultative }
    };
  };
  bot.requestCompetitiveSearch = async (queries, siteDomain, _limit, _timeout, scope = "web") => {
    requests.push({ queries, siteDomain: bot.extractHostnameFromUrl(siteDomain), scope });
    return { results: [], error: null };
  };
  bot.enrichCompetitiveCandidates = async () => [];
  await bot.analyzeSEO(clone(root.context.pageData));
  return clone(requests);
}

export function createAuditSearchGuard({ client, now = Date.now }) {
  return async function authorizeAuditSearch(req, res, next) {
    if (!req.auth?.userId) return res.status(401).json({ error: "Inicia sesion para continuar." });
    const envelope = req.body?.zentra_operation;
    if (!/^[0-9a-f-]{36}$/i.test(envelope?.id || "")
      || !["subscription", "audit"].includes(envelope?.product)) {
      return res.status(403).json({ error: "La busqueda requiere una auditoria autorizada." });
    }
    try {
      const { data, error } = await client.rpc("zentra_read_audit_steps", {
        p_auth_id: req.auth.userId, p_email: req.auth.email,
        p_product: envelope.product, p_operation: envelope.id
      });
      if (error) throw error;
      const created = Date.parse(data?.root?.created_at);
      if (!Number.isFinite(created) || now() - created > 30 * 60000) {
        return res.status(403).json({ error: "La auditoria no habilita esta busqueda." });
      }
      const allowed = await buildAuditSearchRequests(data.root, data.steps || []);
      const normalize = values => Array.isArray(values) ? values.map(value =>
        String(value || "").replace(/\s+/g, " ").trim().slice(0, 140)).filter(Boolean).slice(0, 3) : [];
      const expected = allowed.find(request => request.scope === req.body.scope);
      if (!expected || expected.siteDomain !== req.body.siteDomain
        || !same(normalize(expected.queries), normalize(req.body.queries))) {
        return res.status(403).json({ error: "La consulta no pertenece a esta auditoria." });
      }
      req.auditSearch = { operationId: envelope.id, product: envelope.product };
      const crypto = await import("node:crypto");
      const hash = crypto.createHash("sha256").update(JSON.stringify({
        queries: normalize(expected.queries), scope: expected.scope, siteDomain: expected.siteDomain
      })).digest("hex");
      const begin = await client.rpc("zentra_begin_search", {
        p_auth_id: req.auth.userId, p_email: req.auth.email, p_product: envelope.product,
        p_operation: envelope.id, p_hash: hash
      });
      if (begin.error) throw begin.error;
      if (!begin.data?.allowed) return res.status(begin.data?.reason === "in_progress" ? 425 : 409).json({
        error: "La busqueda sigue pendiente de confirmacion.", code: begin.data?.reason || "operation_conflict"
      });
      if (begin.data.cached) return res.status(begin.data.response.status).json(begin.data.response.value);
      const lease = { p_user: begin.data.user_id, p_operation: envelope.id, p_hash: hash, p_lease: begin.data.lease_token };
      req.auditSearch.telemetry = auditTelemetryContext({ product: envelope.product,
        user: { id: begin.data.user_id, plan: data.root.context?.auditScope?.plan }, context: data.root.context,
        operationId: envelope.id, task: "competitor_search", reasoningEffort: "high" });
      req.reserveSearchBudget = async () => {
        const reserved = await client.rpc("zentra_reserve_search_budget", lease);
        if (reserved.error || !Number.isInteger(reserved.data) || reserved.data < -1 || reserved.data > 3) {
          throw new Error("Search budget unavailable");
        }
        return reserved.data;
      };
      req.settleSearchBudget = async actual => {
        const settled = await client.rpc("zentra_settle_search_budget", { ...lease, p_actual: actual });
        if (settled.error || settled.data !== true) throw new Error("Search budget settlement unavailable");
      };
      req.startSearch = async () => {
        const started = await client.rpc("zentra_start_search", lease);
        if (started.error || started.data !== true) throw new Error("Search ownership unavailable");
      };
      let renewing = false;
      const heartbeat = setInterval(async () => {
        if (renewing) return;
        renewing = true;
        try { await client.rpc("zentra_renew_search", lease); }
        catch (_) { /* Persistent ownership still fences start and completion. */ }
        finally { renewing = false; }
      }, 30000);
      heartbeat.unref?.();
      res.once("finish", () => clearInterval(heartbeat));
      res.once("close", () => clearInterval(heartbeat));
      const originalJson = res.json.bind(res);
      res.json = async value => {
        try {
          // SQL decides certainty from provider-start and settled usage, never HTTP success alone.
          const finished = await client.rpc("zentra_finish_search", {
            ...lease, p_response: { status: res.statusCode, value }, p_success: res.statusCode === 200
          });
          if (finished.error || finished.data !== true) throw new Error("Search completion unavailable");
        } catch (_) {
          return originalJson.call(res.status(503), {
            error: "La busqueda sigue pendiente de confirmacion.", code: "execution_uncertain"
          });
        }
        return originalJson(value);
      };
      return next();
    } catch (_) {
      return res.status(503).json({ error: "No se pudo verificar la auditoria." });
    }
  };
}

export function startSearchLeaseReaper({ client, schedule = setInterval, logger = console }) {
  let running = false;
  const reap = async () => {
    if (running) return;
    running = true;
    try {
      const result = await client.rpc("zentra_reap_search_leases", { p_user: null });
      if (result.error) throw result.error;
      if (result.data > 0) logger.log("[SEARCH LIFECYCLE]", { terminalized: result.data });
    } catch (_) { logger.warn("[SEARCH LIFECYCLE]", { code: "cleanup_unavailable" }); }
    finally { running = false; }
  };
  void reap();
  const timer = schedule(reap, 60000);
  timer.unref?.();
  return timer;
}

export async function prepareAuditStep({ client, identity, product, operationId, body }) {
  const args = { p_auth_id: identity.userId, p_email: identity.email, p_product: product, p_operation: operationId };
  const read = await client.rpc("zentra_read_audit_steps", args);
  if (read.error) throw read.error;
  const workflow = read.data || {};
  const stage = body.zentra_routing?.taskType || body.task_type;
  if (!stages.has(stage)) return { conflict: true };
  const root = workflow.root;
  if (stage === "seo_analysis" && root && requestFingerprint(body) !== root.request_hash) return { conflict: true };
  const existing = workflow.steps?.find(step => step.step_name === stage);
  if (existing) return { body: existing.body, sourceHash: root.request_hash };
  let context = null;
  let canonical;
  try {
    if (stage === "seo_analysis") {
      context = body.zentra_audit_workflow;
      const access = await client.rpc("zentra_access", {
        p_auth_id: identity.userId, p_email: identity.email, p_product: product
      });
      if (access.error || !access.data) throw access.error || new Error("Entitlement unavailable");
      const entitlement = auditEntitlement(access.data);
      if (!validateAuditEntitlement(context, entitlement.plan)) return { conflict: true };
      // A new root must describe the target reserved by this authenticated user,
      // not merely repeat a client-provided operation.source or domain label.
      if (!workflow.acquisitionSource || auditUrlKey(auditPublicUrl(workflow.acquisitionSource))
        !== auditUrlKey(auditPublicUrl(context.pageData.url))) return { conflict: true };
      const built = await buildAuditStep(stage, { body, context });
      if (!same(body.messages, built.messages)) return { conflict: true };
      // Keep the existing validated root routing and token budget.
      canonical = { ...body };
    } else {
      if (!root?.context) return { conflict: true };
      const reasoning = workflow.steps?.find(step => step.step_name === "premium_reasoning_audit");
      const evidence = stage === "premium_reasoning_audit" ? body.zentra_audit_evidence : reasoning?.context;
      canonical = await buildAuditStep(stage, root, workflow.steps, evidence);
      if (stage === "premium_reasoning_audit") context = validateEvidence(evidence);
    }
  } catch (_) { return { conflict: true }; }
  delete canonical.zentra_audit_workflow;
  delete canonical.zentra_audit_evidence;
  delete canonical.zentra_operation;
  delete canonical.zentra_acquisition;
  const saved = await client.rpc("zentra_register_audit_step", {
    ...args, p_step: stage, p_hash: requestFingerprint(canonical), p_body: canonical, p_context: context
  });
  if (saved.error) throw saved.error;
  if (!saved.data?.allowed) return { conflict: true };
  return { body: saved.data.body, sourceHash: saved.data.root_hash };
}
