import { readFileSync } from "node:fs";
import vm from "node:vm";

// Use the same pinned validator as Audit, without network, storage or credentials.
const sandbox = vm.createContext({ window: {}, URL, URLSearchParams,
  localStorage: { getItem() { return null; } }, console: { log() {}, warn() {}, error() {} } });
new vm.Script(readFileSync(new URL("./trusted-audit-builders.js", import.meta.url), "utf8"))
  .runInContext(sandbox, { timeout: 1000 });
const validator = sandbox.window.claudeAI;

export function extractAuditResponse(result = {}) {
  const data = result.data || {};
  const textParts = parts => (Array.isArray(parts) ? parts : [])
    .filter(part => ["text", "output_text"].includes(part?.type) && typeof part.text === "string")
    .map(part => part.text).join("\n");
  let content, finishReason;
  if (result.provider === "anthropic") {
    content = textParts(data.content);
    finishReason = data.stop_reason;
  } else if (result.api === "responses") {
    content = typeof data.output_text === "string" && data.output_text.trim() ? data.output_text
      : (Array.isArray(data.output) ? data.output : []).filter(item => item.type === "message")
        .map(item => textParts(item.content)).filter(Boolean).join("\n");
    finishReason = data.incomplete_details?.reason || data.status;
  } else {
    const choice = data.choices?.[0];
    content = typeof choice?.message?.content === "string" ? choice.message.content : textParts(choice?.message?.content);
    finishReason = choice?.finish_reason;
  }
  return { content: content || "", finishReason };
}

export async function recoverAuditConsultative({ initial, regenerate, debug = false, log = () => {} }) {
  let result = initial;
  let lastDiagnostic;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { content, finishReason } = extractAuditResponse(result);
    const inspected = validator.inspectSEOConsultative(content);
    lastDiagnostic = validator.createSEOConsultativeDiagnostic(content, inspected, finishReason);
    if (!result.ok) lastDiagnostic.stage = "provider_response";
    if (debug) {
      try { log({ attempt, ...lastDiagnostic }); } catch (_) { /* Diagnostics must not affect delivery. */ }
    }
    if (result.ok && inspected.analysis) {
      return { analysis: JSON.parse(JSON.stringify(inspected.analysis)), metadata: {
        status: attempt > 1 || inspected.attempts.length > 1 || inspected.attempts[0]?.stage.includes(':envelope') || lastDiagnostic.truncated ? "recovered" : "complete",
        attempts: attempt, finishReason: lastDiagnostic.finishReason
      } };
    }
    if (attempt === 1) {
      try { result = await regenerate(); }
      catch (_) { result = { ok: false }; }
    }
  }
  return { analysis: null, metadata: { status: "consultative-degraded", attempts: 2,
    finishReason: lastDiagnostic.finishReason } };
}
