const REQUIRED_KEYWORDS = ["primary", "longTail", "local"];
const FINISH_REASONS = new Set(["stop", "length", "max_output_tokens", "max_tokens", "completed", "incomplete", "end_turn", "content_filter"]);

function missingFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["object"];
  const missing = [];
  if (typeof value.summary !== "string" || !value.summary.trim()) missing.push("summary");
  if (!Array.isArray(value.topIssues) || value.topIssues.some(item => typeof item !== "string")) missing.push("topIssues");
  if (!Array.isArray(value.recommendations) || value.recommendations.some(item =>
    !item || typeof item !== "object" || Array.isArray(item) || typeof item.action !== "string" || !item.action.trim())) missing.push("recommendations");
  if (!value.keywords || typeof value.keywords !== "object" || REQUIRED_KEYWORDS.some(key =>
    !Array.isArray(value.keywords[key]) || value.keywords[key].some(item => typeof item !== "string"))) missing.push("keywords");
  return missing;
}

export function inspectAuditJson(content) {
  const attempts = [];
  let lastMissing = ["object"];
  const accept = (value, stage) => {
    if (value && typeof value === "object" && !value.summary) {
      for (const key of ["analysis", "response", "result"]) {
        if (value[key] && typeof value[key] === "object" && value[key].summary) {
          value = value[key];
          stage += ":envelope";
          break;
        }
      }
    }
    lastMissing = missingFields(value);
    attempts.push({ stage, valid: lastMissing.length === 0, missingFields: lastMissing });
    return lastMissing.length === 0 ? value : null;
  };
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return { analysis: accept(content, "object"), attempts, missingFields: lastMissing, truncated: false };
  }
  const raw = typeof content === "string" ? content.trim() : "";
  if (raw.length > 1048576) {
    return { analysis: null, attempts: [{ stage: "size", valid: false, error: "response_too_large" }], missingFields: lastMissing, truncated: false };
  }
  const parse = (value, stage) => {
    try { return accept(JSON.parse(value), stage); }
    catch (error) {
      const message = String(error.message || "");
      const position = message.match(/position (\d+)/)?.[1];
      const category = /unterminated/i.test(message) ? "unterminated_string"
        : /end of JSON/i.test(message) ? "unexpected_end"
        : /control character/i.test(message) ? "control_character"
        : /property name/i.test(message) ? "expected_property_name"
        : /after property value/i.test(message) ? "expected_comma_or_close" : "invalid_json";
      attempts.push({ stage, valid: false, error: category, ...(position ? { position: Number(position) } : {}) });
      return null;
    }
  };
  let analysis = parse(raw, "parse");
  if (analysis) return { analysis, attempts, missingFields: [], truncated: false };
  const clean = raw.replace(/^\s*`{3}(?:json)?\s*/i, "").replace(/\s*`{3}\s*$/, "").trim();
  if (clean !== raw) {
    analysis = parse(clean, "fences");
    if (analysis) return { analysis, attempts, missingFields: [], truncated: false };
  }
  const start = clean.indexOf("{");
  const stack = [];
  let quoted = false, escaped = false, mismatch = false, end = false;
  let balanced = "";
  if (start >= 0) for (let i = start; i < clean.length; i++) {
    const char = clean[i];
    if (quoted) {
      balanced += !escaped && char.charCodeAt(0) < 32 ? JSON.stringify(char).slice(1, -1) : char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else {
      balanced += char;
      if (char === '"') quoted = true;
      else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
      else if (char === "}" || char === "]") {
        if (stack.pop() !== char) { mismatch = true; break; }
        if (!stack.length) { end = true; break; }
      }
    }
  }
  if (end) {
    analysis = parse(balanced, "balanced_object");
    if (analysis) return { analysis, attempts, missingFields: [], truncated: false };
  }
  const truncated = start >= 0 && (quoted || stack.length > 0);
  // Only close complete containers; never invent a missing value or finish a string.
  if (!mismatch && !quoted && stack.length) {
    analysis = parse(balanced + stack.slice().reverse().join(""), "container_closures");
    if (analysis) return { analysis, attempts, missingFields: [], truncated: true };
  }
  // A complete top-level prefix can reveal missing fields, but never substitute for them.
  if (start >= 0) {
    let depth = 0, inString = false, escape = false, prefix = null;
    for (let i = start; i < clean.length; i++) {
      const char = clean[i];
      if (inString) {
        if (escape) escape = false;
        else if (char === "\\") escape = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") depth--;
      else if (char === "," && depth === 1) {
        try { prefix = JSON.parse(clean.slice(start, i) + "}"); } catch (_) {}
      }
      if (depth < 0) break;
    }
    if (prefix) {
      analysis = accept(prefix, "complete_prefix");
      if (analysis) return { analysis, attempts, missingFields: [], truncated: true };
    }
  }
  return { analysis: null, attempts, missingFields: lastMissing, truncated };
}

export function extractAuditResponse(result = {}) {
  const data = result.data || {};
  const partsText = parts => (Array.isArray(parts) ? parts : [])
    .filter(part => ["text", "output_text"].includes(part?.type) && typeof part.text === "string")
    .map(part => part.text).join("\n");
  let content, finishReason;
  if (result.provider === "anthropic") {
    content = partsText(data.content);
    finishReason = data.stop_reason;
  } else if (result.api === "responses") {
    content = typeof data.output_text === "string" && data.output_text.trim() ? data.output_text
      : (Array.isArray(data.output) ? data.output : []).filter(item => item.type === "message")
        .map(item => partsText(item.content)).filter(Boolean).join("\n");
    finishReason = data.incomplete_details?.reason || data.status;
  } else {
    const choice = data.choices?.[0];
    content = typeof choice?.message?.content === "string" ? choice.message.content : partsText(choice?.message?.content);
    finishReason = choice?.finish_reason;
  }
  return { content: content || "", finishReason: FINISH_REASONS.has(finishReason) ? finishReason : null };
}

function diagnostic(content, inspected, finishReason, attempt) {
  const structural = content.replace(/[^\s{}\[\],:"\\]/g, "x");
  return {
    attempt, length: content.length, finishReason,
    truncated: Boolean(inspected.truncated || ["length", "max_output_tokens", "max_tokens"].includes(finishReason)),
    head: structural.slice(0, 120), tail: structural.slice(-120),
    stage: inspected.analysis ? "validated" : "consultative_validation",
    attempts: inspected.attempts, missingFields: inspected.missingFields
  };
}

export async function recoverAuditConsultative({ initial, regenerate, debug = false, log = () => {} }) {
  let result = initial;
  let lastReason = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { content, finishReason } = extractAuditResponse(result);
    const inspected = inspectAuditJson(content);
    lastReason = finishReason;
    if (debug) {
      try { log({ ...diagnostic(content, inspected, finishReason, attempt), providerOk: Boolean(result.ok) }); }
      catch (_) { /* Logging cannot affect the report. */ }
    }
    if (result.ok && inspected.analysis) {
      return { analysis: inspected.analysis, metadata: {
        status: attempt > 1 || inspected.attempts.length > 1 || inspected.attempts[0]?.stage.includes(":envelope") ? "recovered" : "complete",
        attempts: attempt, finishReason
      } };
    }
    if (attempt === 1) {
      try { result = await regenerate(); }
      catch (_) { result = { ok: false }; }
    }
  }
  return { analysis: null, metadata: { status: "consultative-degraded", attempts: 2, finishReason: lastReason } };
}
