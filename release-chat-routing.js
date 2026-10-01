import crypto from "node:crypto";

// Chat-only contract. Audit/PDF retain their independent model configuration.
export const CHAT_TIERS = Object.freeze({
  chat_base: Object.freeze({ model: "gpt-6-luna", reasoningEffort: "medium" }),
  chat_advanced: Object.freeze({ model: "gpt-6.1-sol", reasoningEffort: "medium" }),
  chat_advanced_fallback: Object.freeze({ model: "gpt-6-luna", reasoningEffort: "high" })
});
export function isChatTask(task) {
  return ["chat_basic", "chat_image_ocr", "chat_premium", "chat_executive"].includes(task);
}
export function chatTierRoute({ needsReasoning = false, premiumGranted = false } = {}) {
  const logicalTier = !needsReasoning ? "chat_base" : premiumGranted ? "chat_advanced" : "chat_advanced_fallback";
  return { ...CHAT_TIERS[logicalTier], logicalTier, provider: "openai",
    fallbackProvider: "openai", fallbackModel: CHAT_TIERS.chat_advanced_fallback.model,
    premiumGranted: Boolean(needsReasoning && premiumGranted) };
}
export function chatRequestContext(route) {
  if (!route?.logicalTier) return {};
  return { chatRouting: { logicalTier: route.logicalTier, reasoningEffort: route.reasoningEffort,
    premiumGranted: Boolean(route.premiumGranted), plan: route.plan || null } };
}
export function chatTechnicalFallbackContext(context = {}) {
  if (!context.chatRouting) return context;
  return { ...context, chatRouting: { ...context.chatRouting,
    logicalTier: "chat_advanced_fallback", reasoningEffort: "high" } };
}

// USD per 1M tokens, standard service; verified 2026-10-01 against model docs.
export const CHAT_TOKEN_PRICES = Object.freeze({
  "gpt-6-luna": Object.freeze({ input: .10, cached: .01, output: .50,
    long: Object.freeze({ input: .20, cached: .02, output: .75 }) }),
  "gpt-6.1-sol": Object.freeze({ input: 2, cached: .10, output: 10,
    long: Object.freeze({ input: 4, cached: .20, output: 15 }) })
});
const tokens = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : 0;
export function chatCostTelemetry({ model, context, usage, operationId, status }) {
  if (!context?.chatRouting) return null;
  const input = tokens(usage?.input_tokens ?? usage?.prompt_tokens);
  const output = tokens(usage?.output_tokens ?? usage?.completion_tokens);
  const cached = Math.min(input, tokens(usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens));
  const reasoning = tokens(usage?.output_tokens_details?.reasoning_tokens ?? usage?.completion_tokens_details?.reasoning_tokens);
  const price = CHAT_TOKEN_PRICES[model];
  const rates = input > 272000 ? price?.long : price;
  const measured = Boolean(usage && rates);
  return { feature: "chat", plan: ["free", "starter", "pro", "agency"].includes(context.chatRouting.plan) ? context.chatRouting.plan : null,
    logical_tier: context.chatRouting.logicalTier, model,
    reasoning_effort: context.chatRouting.reasoningEffort,
    premium_granted: Boolean(context.chatRouting.premiumGranted),
    operation_id: operationId ? crypto.createHash("sha256").update(String(operationId)).digest("hex").slice(0, 24) : null,
    input_tokens: usage ? input : null, cached_input_tokens: usage ? cached : null,
    output_tokens: usage ? output : null, reasoning_tokens: usage ? reasoning : null,
    // Reasoning is already included in output_tokens: never charge it twice.
    estimated_cost_usd: measured ? ((input - cached) * rates.input + cached * rates.cached + output * rates.output) / 1000000 : null,
    usage_available: Boolean(usage), status, price_version: "2026-10-01-standard" };
}
