import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
const backend = process.env.ZENTRA_BACKEND_DIR;
const { createCompetitiveSearchHandler } = await import(pathToFileURL(backend + '/release-competitive-search.js'));
const { auditCostTelemetry, auditTelemetryContext, auditTierRoute } = await import(pathToFileURL(backend + '/release-audit-routing.js'));
const { hasUsableExecutiveRefinement } = await import(pathToFileURL(backend + '/release-executive-refiner.js'));
const source = fs.readFileSync(backend + '/server.js', 'utf8');
const meta = auditTelemetryContext({ operationId: 'private-operation', product: 'subscription', user: { id: 'private-user', plan: 'pro' }, task: 'executive_refiner_pdf', reasoningEffort: 'high' });

test('executive incomplete output exposes only safe reason/status/tokens and hashed operation', () => {
  const event = auditCostTelemetry({ model: 'gpt-6.1-sol', context: { auditRouting: meta },
    status: 200, providerStatus: 'incomplete', incompleteDetails: { reason: 'max_output_tokens', content: 'SECRET' },
    usage: { input_tokens: 100, output_tokens: 900, output_tokens_details: { reasoning_tokens: 890 } } });
  assert.equal(event.status, 200); assert.equal(event.provider_status, 'incomplete');
  assert.deepEqual(event.incomplete_details, { reason: 'max_output_tokens' });
  assert.equal(event.output_tokens, 900); assert.equal(event.reasoning_tokens, 890);
  assert.equal(event.visible_output_tokens, 10); assert.equal(event.reasoning_effort, 'high');
  assert.equal(event.model, 'gpt-6.1-sol'); assert.match(event.operation_id, /^[a-f0-9]{24}$/);
  assert.doesNotMatch(JSON.stringify(event), /SECRET|private-operation|private-user/);
});
test('completed/missing/unknown statuses do not leak provider content or invent usage', () => {
  for (const status of ['completed', undefined, 'SECRET']) {
    const event = auditCostTelemetry({ model: 'gpt-6.1-sol', context: { auditRouting: meta }, providerStatus: status, incompleteDetails: { reason: 'SECRET' } });
    assert.equal(event.incomplete_details, null); assert.equal(event.output_tokens, null);
    assert.equal(event.reasoning_tokens, null); assert.equal(event.estimated_cost_usd, null);
    assert.doesNotMatch(JSON.stringify(event), /SECRET/);
  }
  const unknown = auditCostTelemetry({ context: { auditRouting: meta }, providerStatus: 'incomplete', incompleteDetails: { reason: 'SECRET' } });
  assert.deepEqual(unknown.incomplete_details, { reason: 'unknown' });
  const filtered = auditCostTelemetry({ context: { auditRouting: meta }, providerStatus: 'incomplete', incompleteDetails: { reason: 'content_filter' } });
  assert.deepEqual(filtered.incomplete_details, { reason: 'content_filter' });
});
test('5500 is a ceiling, not billed usage; completed JSON availability is explicit', () => {
  const event = auditCostTelemetry({ model: 'gpt-6.1-sol', context: { auditRouting: meta },
    maxOutputTokens: 5500, usableJson: true, providerStatus: 'completed', status: 200,
    usage: { input_tokens: 2250, output_tokens: 2200, output_tokens_details: { reasoning_tokens: 1552 } } });
  assert.equal(event.max_output_tokens, 5500); assert.equal(event.usable_json, true);
  assert.equal(event.visible_output_tokens, 648); assert.equal(event.estimated_cost_usd, .0265);
  assert.equal(event.incomplete_details, null);
});
test('other stages retain telemetry shape and routing/budget stay unchanged', () => {
  const event = auditCostTelemetry({ context: { auditRouting: { stage: 'seo_analysis' } }, providerStatus: 'incomplete', incompleteDetails: { reason: 'max_output_tokens' } });
  assert.ok(!Object.hasOwn(event, 'provider_status')); assert.ok(!Object.hasOwn(event, 'incomplete_details'));
  assert.equal(auditTierRoute('seo_analysis').reasoningEffort, 'medium');
  assert.equal(auditTierRoute('premium_reasoning_audit', true).reasoningEffort, 'high');
  assert.equal(auditTierRoute('executive_refiner_pdf', true).reasoningEffort, 'high');
  assert.match(source, /process\.env\.ZENTRA_EXECUTIVE_REFINER_MAX_TOKENS \|\| 900/);
  const sql = fs.readFileSync(backend + '/supabase-execution-guard.sql', 'utf8');
  assert.match(sql, /check\(used between 0 and 3\)/);
  assert.match(sql, /select 3-used into remaining/);
  assert.match(sql, /lease_token=p_lease/);
  assert.match(fs.readFileSync(backend + '/release-audit-steps.js', 'utf8'), /task: "competitor_search", reasoningEffort: "high"/);
});
test('actual provider wrapper forwards incomplete details only to safe executive telemetry', async () => {
  const events = [];
  const fn = source.slice(source.indexOf('async function callOpenAI('), source.indexOf('async function callAnthropic('));
  const context = vm.createContext({ OPENAI_API_KEY: 'mock-only', Date,
    shouldUseOpenAIResponsesApi: () => true, buildOpenAIResponsesRequestBody: () => ({ body: { input: [] } }),
    safeRetryAfter: () => null, auditCostTelemetry, hasUsableExecutiveRefinement,
    getAiResponseText: result => result.data?.output_text || '{}',
    console: { log: (label, event) => { if (label === '[AUDIT COST]') events.push(event); } },
    fetch: async () => new Response(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      usage: { input_tokens: 100, output_tokens: 900, output_tokens_details: { reasoning_tokens: 880 } } }), { status: 200 }) });
  vm.runInContext(fn, context);
  const result = await context.callOpenAI({ model: 'gpt-6.1-sol', maxTokens: 5500, requestContext: { auditRouting: meta } });
  assert.equal(result.status, 200); assert.equal(events.length, 1);
  assert.equal(events[0].provider_status, 'incomplete');
  assert.equal(events[0].incomplete_details.reason, 'max_output_tokens');
  assert.equal(events[0].reasoning_tokens, 880);
  assert.equal(events[0].max_output_tokens, 5500);
  assert.equal(events[0].usable_json, false);
});
function responseMock() {
  return { status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; } };
}
test('Search executes Luna High and honors remaining global allowance across web/social/replay', async () => {
  let reserved = 0, providerCalls = 0;
  const events = [], requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body); providerCalls++;
    assert.equal(body.model, 'gpt-6-luna'); assert.equal(body.reasoning.effort, 'high');
    const n = body.max_tool_calls;
    return new Response(JSON.stringify({ status: 'completed', usage: { input_tokens: 100, output_tokens: 100 },
      output: [...Array.from({ length: n }, () => ({ type: 'web_search_call', action: { sources: [{ url: 'https://competitor.test/' }] } })),
        { type: 'message', content: [{ type: 'output_text', text: '{"results":[{"title":"Business software","snippet":"Software category","url":"https://competitor.test/"}]}' }] }] }), { status: 200 });
  };
  const handlers = [0, 1].map(() => createCompetitiveSearchHandler({ apiKey: 'mock-only', fetchImpl, logTelemetry: event => events.push(event) }));
  const req = scope => ({ auth: { userId: 'fixture' }, body: { queries: ['software business'], siteDomain: 'fixture.test', scope },
    auditSearch: { telemetry: { stage: 'competitor_search', reasoning_effort: 'high', operation_id: 'fixture-hash' } },
    startSearch: async () => {}, reserveSearchBudget: async () => { const n = 3 - reserved; reserved += n; return n; },
    settleSearchBudget: async actual => { assert.equal(actual, reserved); } });
  const web = responseMock(); await handlers[0](req('web'), web);
  assert.equal(web.statusCode, 200); assert.equal(reserved, 3);
  const social = responseMock(); await handlers[1](req('social'), social);
  assert.equal(social.body.error, 'search_budget_exhausted'); assert.equal(providerCalls, 1);
  await handlers[0](req('web'), responseMock()); assert.equal(providerCalls, 1);
  assert.equal(requests[0].max_tool_calls, 3); assert.equal(events[0].web_search_calls, 3);
  assert.equal(events[0].reasoning_effort, 'high');
});

test('concurrent Search callbacks do not execute a second provider while global slots are reserved', async () => {
  let reserved = 0, settled = false, executions = 0, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const handlers = [0, 1].map(() => createCompetitiveSearchHandler({ apiKey: 'mock-only', logTelemetry() {},
    fetchImpl: async (_url, init) => {
      executions++; assert.equal(JSON.parse(init.body).max_tool_calls, 3); entered(); await hold;
      return new Response(JSON.stringify({ status: 'completed', output: Array.from({ length: 3 }, () => ({ type: 'web_search_call', action: { sources: [] } })) }), { status: 200 });
    } }));
  const request = scope => ({ auth: { userId: 'fixture' }, body: { queries: ['software'], siteDomain: 'fixture.test', scope },
    reserveSearchBudget: async () => {
      if (reserved === 3) return settled ? 0 : -1;
      reserved = 3; return 3;
    }, settleSearchBudget: async actual => { assert.equal(actual, 3); settled = true; } });
  const first = handlers[0](request('web'), responseMock());
  await started;
  const second = responseMock(); await handlers[1](request('social'), second);
  assert.equal(second.statusCode, 425); assert.equal(second.body.error, 'search_in_progress');
  assert.equal(executions, 1); release(); await first;
  const exhausted = responseMock(); await handlers[1](request('social'), exhausted);
  assert.equal(exhausted.body.error, 'search_budget_exhausted'); assert.equal(executions, 1);
});
