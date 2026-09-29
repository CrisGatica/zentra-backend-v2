import test from "node:test";
import assert from "node:assert/strict";
import { extractAuditResponse, inspectAuditJson, recoverAuditConsultative } from "./release-audit-json.js";

const report = {
  summary: "La pagina muestra una oferta verificable.",
  topIssues: ["Revisar el titulo observado"],
  recommendations: [{ action: "Revisar el titulo de inicio", priority: "media" }],
  keywords: { primary: ["servicio observado"], longTail: [], local: [] }
};
const valid = JSON.stringify(report);
const response = (content, finishReason = "completed") => ({
  ok: true, provider: "openai", api: "responses",
  data: { status: finishReason === "max_output_tokens" ? "incomplete" : finishReason,
    incomplete_details: finishReason === "max_output_tokens" ? { reason: finishReason } : null,
    output: [{ type: "reasoning", content: [{ type: "summary_text", text: "not final" }] },
      { type: "message", content: [{ type: "output_text", text: content }] }] }
});

test("valid, fenced, prefixed and safely closed JSON return the full report", async () => {
  for (const [text, retryExpected] of [[valid, false], ["```json\n" + valid + "\n```", false],
    ["Informe:\n" + valid + "\nFin", false], [valid.slice(0, -1), false]]) {
    let retries = 0;
    const result = await recoverAuditConsultative({ initial: response(text), regenerate: async () => {
      retries++; return response(valid);
    } });
    assert.equal(retries, Number(retryExpected));
    assert.deepEqual(result.analysis, report);
  }
});

test("real observed shape: unterminated string and missing fields regenerates only consultative phase", async () => {
  const observed = '{"seoScore":97,"domain":"tryzentra.app","summary":"Observacion completa","technicalStatus":{"title":"Texto sin terminar';
  const first = inspectAuditJson(observed);
  assert.equal(first.analysis, null);
  assert.equal(first.truncated, true);
  assert.deepEqual(first.missingFields, ["topIssues", "recommendations", "keywords"]);
  let calls = 0;
  const result = await recoverAuditConsultative({ initial: response(observed, "max_output_tokens"),
    regenerate: async () => { calls++; return response(valid); } });
  assert.equal(calls, 1);
  assert.equal(result.metadata.status, "recovered");
  assert.equal(result.metadata.attempts, 2);
  assert.deepEqual(result.analysis, report);
});

test("partial object, invalid text, exhausted output and failed retry degrade once", async () => {
  for (const text of ['{"summary":"Solo un resumen"}', "not JSON", '{"summary":"' + "x".repeat(40000)]) {
    let retries = 0;
    const result = await recoverAuditConsultative({ initial: response(text, "max_output_tokens"),
      regenerate: async () => { retries++; return response("still invalid"); } });
    assert.equal(retries, 1);
    assert.equal(result.analysis, null);
    assert.equal(result.metadata.status, "consultative-degraded");
    assert.equal(result.metadata.attempts, 2);
  }
});

test("provider transport exception is bounded to one retry", async () => {
  let retries = 0;
  const result = await recoverAuditConsultative({ initial: response("invalid"), regenerate: async () => {
    retries++; throw new Error("secret provider exception");
  } });
  assert.equal(retries, 1);
  assert.equal(result.metadata.status, "consultative-degraded");
});

test("concurrent reports keep their own retry and do not trigger another workflow step", async () => {
  const calls = [0, 0];
  const run = index => recoverAuditConsultative({
    initial: response('{"summary":"unfinished'),
    regenerate: async () => {
      calls[index]++;
      await new Promise(resolve => setTimeout(resolve, 5));
      return response(valid);
    }
  });
  const [a, b] = await Promise.all([run(0), run(1)]);
  assert.deepEqual(calls, [1, 1]);
  assert.equal(a.metadata.status, "recovered");
  assert.equal(b.metadata.status, "recovered");
});

test("extracts only final text and a safe finish reason", () => {
  assert.equal(extractAuditResponse(response(valid)).content, valid);
  assert.equal(extractAuditResponse(response("", "max_output_tokens")).finishReason, "max_output_tokens");
  assert.equal(extractAuditResponse({ provider: "anthropic", data: { content: [{ type: "text", text: valid }], stop_reason: "end_turn" } }).content, valid);
  assert.equal(extractAuditResponse({ provider: "openai", api: "chat_completions", data: {
    choices: [{ message: { content: valid }, finish_reason: "stop" }] } }).content, valid);
});

test("development diagnostics cannot reveal prompt values or credentials", async () => {
  const logs = [];
  const privateContent = '{"summary":"name@example.test sk-secret 123456789';
  await recoverAuditConsultative({ initial: response(privateContent, "max_output_tokens"),
    regenerate: async () => response(valid), debug: true, log: item => logs.push(item) });
  assert.equal(logs.length, 2);
  assert.deepEqual(logs.map(item => item.attempt), [1, 2]);
  assert.equal(logs[0].finishReason, "max_output_tokens");
  assert.equal(logs[0].truncated, true);
  assert.doesNotMatch(JSON.stringify(logs), /name@example|sk-secret|123456789|servicio observado/);
  let called = false;
  await recoverAuditConsultative({ initial: response(valid), regenerate: () => { throw new Error("unexpected retry"); },
    log: () => { called = true; } });
  assert.equal(called, false);
});
