import crypto from "node:crypto";
import { CHAT_TOKEN_PRICES } from "./release-chat-routing.js";

const tasks = new Set(["seo_analysis", "pdf_summary", "pdf_polish", "premium_reasoning_audit", "executive_refiner_pdf"]);
export function isAuditTask(task) { return tasks.has(task); }
export function auditTierRoute(task, premiumActive = false) {
  const final = task === "executive_refiner_pdf" && premiumActive;
  return { provider: "openai", model: final ? "gpt-6.1-sol" : "gpt-6-luna",
    reasoningEffort: final ? "xhigh" : premiumActive ? "high" : "medium",
    fallbackProvider: "openai", fallbackModel: "gpt-6-luna" };
}

export function auditPagesProcessed(context) {
  if (!context) return null;
  const pages = [context.pageData, ...(context.internalPagesResult?.pages || []), ...(context.freePreviewPagesResult?.pages || [])];
  return new Set(pages.filter((page, index) => page && !page.error && (page.readStatus
    ? page.readStatus === "complete"
    : !page.lightweightFallback && (page.technicalScoreReliable === true || (index === 0
      && page.technicalScoreReliable !== false && typeof page.h1Count === "number" && typeof page.title === "string"))))
    .map(page => page.finalUrl || page.url).filter(Boolean)).size;
}
export function auditTelemetryContext({ product, user, context, operationId, task, reasoningEffort }) {
  return { product: product === "audit" ? "zentra_audit" : "zentra_ai",
    plan: ["free", "starter", "pro", "agency", "audit"].includes(user?.plan) ? user.plan : null,
    credit_type: product === "audit" ? user?.plan === "free" ? "free_audit" : "individual_audit_credit" : "subscription_audit",
    operation_id: operationId ? crypto.createHash("sha256").update(JSON.stringify([product, user?.id || null, operationId])).digest("hex").slice(0, 24) : null,
    stage: ({ premium_reasoning_audit: "premium_reasoning", executive_refiner_pdf: "executive_refiner" })[task] || task,
    reasoning_effort: reasoningEffort, pages_processed: auditPagesProcessed(context) };
}
const count = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : 0;
const measuredCount = value => value !== undefined && value !== null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : null;
export function auditCostTelemetry({ model, context, usage, searchCalls = 0, status, latencyMs, providerStatus, incompleteDetails, maxOutputTokens, usableJson }) {
  const meta = context?.auditRouting;
  if (!meta) return null;
  const input = measuredCount(usage?.input_tokens ?? usage?.prompt_tokens);
  const output = measuredCount(usage?.output_tokens ?? usage?.completion_tokens);
  const usageAvailable = input !== null && output !== null;
  const cached = input === null ? null : Math.min(input, count(usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens));
  const reasoningValue = usage?.output_tokens_details?.reasoning_tokens ?? usage?.completion_tokens_details?.reasoning_tokens;
  const measuredReasoning = measuredCount(reasoningValue);
  const reasoning = output === null || measuredReasoning === null ? null : Math.min(output, measuredReasoning);
  const price = CHAT_TOKEN_PRICES[model];
  const rates = input > 272000 ? price?.long : price;
  const toolCalls = searchCalls === null ? null : count(searchCalls);
  return { feature: "audit", product: meta.product, plan: meta.plan, credit_type: meta.credit_type,
    operation_id: meta.operation_id, stage: meta.stage, reasoning_effort: meta.reasoning_effort,
    pages_processed: meta.pages_processed, model, input_tokens: input,
    cached_input_tokens: cached, output_tokens: output,
    reasoning_tokens: reasoning, visible_output_tokens: reasoning !== null ? output - reasoning : null,
    web_search_calls: toolCalls, estimated_cost_usd: usageAvailable && rates && toolCalls !== null
      ? ((input - cached) * rates.input + cached * rates.cached + output * rates.output) / 1000000 + toolCalls * .01 : null,
    latency_ms: Number.isFinite(latencyMs) ? latencyMs : null, usage_available: usageAvailable, status,
    price_version: "2026-10-01-standard",
    ...(["executive_refiner", "premium_reasoning"].includes(meta.stage) ? {
      max_output_tokens: measuredCount(maxOutputTokens),
      usable_json: typeof usableJson === "boolean" ? usableJson : null,
      provider_status: ["completed", "incomplete", "failed", "cancelled", "in_progress", "queued"].includes(providerStatus) ? providerStatus : null,
      incomplete_details: providerStatus === "incomplete" && typeof incompleteDetails?.reason === "string"
        ? { reason: ["max_output_tokens", "content_filter"].includes(incompleteDetails.reason) ? incompleteDetails.reason : "unknown" } : null
    } : {}) };
}
export function auditCostTotal(events) {
  const audits = new Map();
  for (const event of events) {
    if (event?.feature !== "audit" || !event.operation_id) continue;
    const total = audits.get(event.operation_id) || { operation_id: event.operation_id, product: event.product,
      estimated_cost_usd: 0, web_search_calls: 0, complete: true, stages: 0 };
    total.stages++;
    total.complete &&= Number.isFinite(event.estimated_cost_usd);
    total.estimated_cost_usd += event.estimated_cost_usd || 0;
    total.web_search_calls += event.web_search_calls || 0;
    audits.set(event.operation_id, total);
  }
  return [...audits.values()].map(total => ({ ...total, estimated_cost_usd: total.complete ? total.estimated_cost_usd : null }));
}
