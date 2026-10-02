import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import crypto from 'node:crypto';
import EmbeddedPostgres from './local-postgres.mjs';
import { auditFixture } from './audit-fixtures.mjs';

const backend = process.env.ZENTRA_BACKEND_DIR, base = process.env.ZENTRA_BASE;
const clean = base + '/publicacion/chrome-store/zentra-ai-chrome-store-clean';
const audit = await import(pathToFileURL(backend + '/release-audit-routing.js'));
const { default: express } = await import(pathToFileURL(backend + '/node_modules/express/index.js'));
const { default: cors } = await import(pathToFileURL(backend + '/node_modules/cors/lib/index.js'));
const pg = new EmbeddedPostgres({ databaseDir: '/tmp/zentra-audit-gpt6-' + process.pid,
  user: 'postgres', password: crypto.randomUUID(), port: 55487, persistent: false,
  postgresFlags: ['-h', '127.0.0.1'], onLog() {}, onError() {} });
const calls = [], telemetry = [], errors = [], runtimes = [];
let db, servers = [], passed = 0, currentOutput, invalidRemaining = 0, searchSize = 1;
const pass = name => { passed++; console.log('PASS', name); };
const source = await readFile(backend + '/server.js', 'utf8');
const imports = {};
for (const line of source.matchAll(/^import \{ ([^}]+) \} from "(\.\/[^" ]+)";/gm)) {
  const module = await import(pathToFileURL(backend + '/' + line[2].slice(2)));
  for (const name of line[1].split(',').map(v => v.trim())) imports[name] = module[name];
}
const client = {
  auth: { async getUser(token) { return token === 'alice' ? { data: { user: { id: 'alice', email: 'alice@example.test', confirmed_at: '2026-09-29' } } } : { error: 'invalid' }; },
    admin: { async getUserById(id) { return { data: { user: { id, email: 'alice@example.test', confirmed_at: '2026-09-29' } } }; } } },
  async rpc(name, args) {
    try {
      const values = Object.values(args), call = name + '(' + values.map((_, i) => '$' + (i + 1)).join(',') + ')';
      return { data: (await db.query('select ' + (name === 'zentra_access' ? 'to_jsonb(' + call + ')' : call) + ' r', values)).rows[0].r };
    } catch (error) { errors.push(name + ': ' + error.message); return { error }; }
  }
};
function runtime() {
  const context = vm.createContext({ ...imports,
    createApiSecurity: opts => imports.createApiSecurity({ ...opts, env: { ZENTRA_RATE_AUTH_IP: '10000', ZENTRA_RATE_USER_LOCAL: '10000' } }),
    createDistributedRateLimit: opts => imports.createDistributedRateLimit({ ...opts, env: { ZENTRA_RATE_GENERATION_USER: '10000' } }),
    createLemonHandlers: opts => ({ ...imports.createLemonHandlers(opts), reconcile: (_req, _res, next) => next() }),
    createCompetitiveSearchHandler: opts => imports.createCompetitiveSearchHandler({ ...opts, logTelemetry: event => telemetry.push(event) }),
    express, cors, crypto, createClient: () => client, Buffer, URL, AbortSignal, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    process: { env: { SUPABASE_URL: 'https://fixture.test', SUPABASE_SERVICE_ROLE_KEY: 'fixture', OPENAI_API_KEY: 'fixture', USER_ACCESS_HAS_AUTH_USER_ID: 'true', NODE_ENV: 'test', ZENTRA_EXECUTIVE_REFINER_MAX_TOKENS: '5500' } },
    console: { log(label, value) { if (label === '[AUDIT COST]') telemetry.push(value); }, warn() {}, error(...args) { errors.push(args.map(String).join(' ')); } },
    fetch: async (url, opts) => {
      const body = JSON.parse(opts.body), id = imports.operationContext.getStore()?.id;
      calls.push({ body, url, id });
      const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 100 } };
      if (body.tools) {
        assert.equal(body.model, 'gpt-6-luna'); assert.equal(body.reasoning.effort, 'high');
        const n = Math.min(searchSize, body.max_tool_calls);
        const output = Array.from({ length: n }, () => ({ type: 'web_search_call', action: { sources: [{ url: 'https://competitor.test/' }] } }));
        output.push({ type: 'message', content: [{ type: 'output_text', text: '{"results":[]}' }] });
        return { ok: true, status: 200, json: async () => ({ status: 'completed', output, usage }) };
      }
      const text = invalidRemaining-- > 0 ? '{"summary":"unfinished' : currentOutput;
      return { ok: true, status: 200, json: async () => ({ model: body.model, output_text: text, usage,
        status: text.endsWith('unfinished') ? 'incomplete' : 'completed', incomplete_details: text.endsWith('unfinished') ? { reason: 'max_output_tokens' } : null }) };
    }
  });
  vm.runInContext(source.replace(/^import .+;\n/gm, '').replace(/app\.listen\(PORT, \(\) => \{[\s\S]*?\n\}\);\s*$/, ''), context);
  runtimes.push(context); return vm.runInContext('app', context);
}
async function post(body, path = '/api/chat', server = servers[0]) {
  const res = await fetch('http://127.0.0.1:' + server.address().port + path, { method: 'POST', headers: { Authorization: 'Bearer alice', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}
async function reset(plan) { await db.query("update users set plan=$1,audits_used=0,premium_pdf_used=0 where auth_user_id='alice' and plan_type='subscription'", [plan]); }
async function fixture(plan = 'pro', domain = crypto.randomUUID() + '.example.test') {
  return auditFixture(clean, plan, { webResults: [], socialResults: [],
    consultativeResponse: JSON.stringify({ summary: 'Partner management software for partner programs.', topIssues: [],
      recommendations: [{ action: 'Clarify partner onboarding' }], keywords: { primary: ['partner management software'], longTail: [], local: [] } }),
    pageOverride: { url: 'https://' + domain + '/', domain, title: 'Partner management software', h1s: ['Partner management software'],
      metaDescription: 'Partner management software for partner programs, onboarding and relationships.',
      textContent: 'Partner management software for partner programs. Manage onboarding and partner relationships.' } });
}
async function start(f, product = 'subscription') {
  const id = crypto.randomUUID(), envelope = { id, product }, reserve = await post({ zentra_operation: { ...envelope, source: f.calls[0].zentra_audit_workflow.pageData.url } }, '/api/audit/reserve');
  assert.equal(reserve.status, 200, reserve.text + errors.join('\n'));
  // The acquisition endpoint returns its fencing token; preserve the existing handoff contract.
  const data = JSON.parse(reserve.text);
  const body = { ...f.calls[0], zentra_operation: envelope, zentra_acquisition: { token: data.lease_token || data.token } };
  currentOutput = f.outputs.seo_analysis;
  const root = await post(body);
  assert.equal(root.status, 200, root.text + errors.join('\n'));
  return { id, envelope, body, root, token: body.zentra_acquisition.token };
}
async function step(f, op, index) { currentOutput = f.outputs[f.calls[index].task_type]; return post({ ...f.calls[index], zentra_operation: op.envelope, zentra_acquisition: { token: op.token } }); }
function searchBody(f, op, scope = 'web') {
  const run = f.calls[1].zentra_audit_evidence.searchRuns.find(r => r.scope === scope);
  return { queries: run.queries, scope, siteDomain: f.calls[0].zentra_audit_workflow.pageData.domain, zentra_operation: op.envelope };
}
async function budget(op) { return Number((await db.query('select used from zentra_audit_search_budgets where operation_key=$1', [op.id])).rows[0]?.used || 0); }
try {
  await pg.initialise(); await pg.start(); db = pg.getPgClient(); await db.connect();
  await db.query('create role anon; create role authenticated; create role service_role');
  for (const file of ['supabase-users.sql', 'supabase-release-guard.sql', 'supabase-execution-guard.sql', 'supabase-search-lifecycle.sql', 'supabase-executive-refiner.sql', 'supabase-http-rate.sql', 'supabase-lemon.sql']) await db.query(await readFile(backend + '/' + file, 'utf8'));
  await db.query("insert into users(email,auth_user_id,plan) values('alice@example.test','alice','pro')");
  servers = [runtime().listen(0, '127.0.0.1'), runtime().listen(0, '127.0.0.1')];
  await Promise.all(servers.map(s => new Promise(resolve => s.on('listening', resolve))));
  for (const plan of ['free', 'starter', 'pro', 'agency']) {
    await reset(plan); const f = await fixture(plan), op = await start(f);
    assert.equal((await step(f, op, 1)).status, 200, errors.join('\n'));
    if (f.calls.length === 3) assert.equal((await step(f, op, 2)).status, 200, errors.join('\n'));
    assert.deepEqual(calls.filter(c => c.id === op.id).map(c => [c.body.model, c.body.reasoning.effort]),
      [['gpt-6-luna', 'medium'], ['gpt-6-luna', ['pro', 'agency'].includes(plan) ? 'high' : 'medium'],
        ...(['pro', 'agency'].includes(plan) ? [['gpt-6.1-sol', 'high']] : [])]);
    assert.ok(calls.filter(c => c.id === op.id).every(c => !('temperature' in c.body) && c.url.endsWith('/responses')));
    for (const call of calls.filter(c => c.id === op.id && c.body.model === 'gpt-6.1-sol')) assert.equal(call.body.max_output_tokens, 5500);
    const u = (await db.query("select * from users where auth_user_id='alice' and plan_type='subscription'")).rows[0];
    assert.equal(u.audits_used, 1); assert.equal(u.premium_pdf_used, ['pro', 'agency'].includes(plan) ? 1 : 0);
    pass(plan + ': actual Audit routes/efforts, shared receipt, existing premium rights and Responses transport');
  }
  await reset('free');
  const denied = await fixture('free'), denial = await start(denied);
  currentOutput = '{}'; const before = calls.length;
  const attempted = await post({ ...denied.calls[1], task_type: 'executive_refiner_pdf', zentra_routing: { taskType: 'executive_refiner_pdf' }, zentra_operation: denial.envelope });
  assert.equal(attempted.status, 409); assert.equal(calls.length, before);
  pass('unauthorized executive step: no Sol and no provider work');
  await reset('pro');
  const changing = await fixture('pro'), changed = await start(changing);
  assert.equal((await step(changing, changed, 1)).status, 200);
  await db.query("update users set plan='free' where auth_user_id='alice' and plan_type='subscription'");
  assert.equal((await step(changing, changed, 2)).status, 200);
  assert.deepEqual(calls.filter(c => c.id === changed.id).map(c => [c.body.model, c.body.reasoning.effort]),
    [['gpt-6-luna', 'medium'], ['gpt-6-luna', 'high'], ['gpt-6-luna', 'medium']]);
  pass('valid final step after loss of commercial authorization: Luna base, never premium Sol');
  await db.query("insert into users(email,auth_user_id,plan,plan_type,audit_credits) values('alice@example.test','alice','pro','audit',1)");
  const standalone = await fixture('pro'), paid = await start(standalone, 'audit');
  assert.equal((await step(standalone, paid, 1)).status, 200);
  assert.deepEqual(calls.filter(c => c.id === paid.id).map(c => [c.body.model, c.body.reasoning.effort]), [['gpt-6-luna', 'medium'], ['gpt-6-luna', 'high']]);
  const paidUser = (await db.query("select * from users where auth_user_id='alice' and plan_type='audit'")).rows[0];
  assert.equal(paidUser.audit_credits_used, 1); assert.equal(paidUser.audits_used, 0);
  pass('standalone credit: Luna Medium/High, one individual credit, SaaS counters not mixed');
  for (const n of [1, 2, 3]) {
    await reset('pro'); const f = await fixture(), op = await start(f); searchSize = n;
    const web = await post(searchBody(f, op), '/api/audit/competitive-search');
    assert.equal(web.status, 200, web.text + errors.join('\n'));
    assert.equal(await budget(op), n);
    const beforeReplay = calls.length;
    assert.equal((await post(searchBody(f, op), '/api/audit/competitive-search', servers[1])).status, 200);
    assert.equal(calls.length, beforeReplay); assert.equal(await budget(op), n);
    if (n < 3) {
      searchSize = 3;
      const social = await post(searchBody(f, op, 'social'), '/api/audit/competitive-search', servers[1]);
      assert.equal(social.status, 200, social.text + errors.join('\n'));
      assert.equal(calls.at(-1).body.max_tool_calls, 3 - n); assert.equal(await budget(op), 3);
    } else {
      const exhausted = await post(searchBody(f, op, 'social'), '/api/audit/competitive-search', servers[1]);
      assert.equal(exhausted.status, 200); assert.ok(exhausted.text.includes('search_budget_exhausted')); assert.equal(calls.length, beforeReplay);
    }
    pass('Search ' + n + ' actual calls: adaptive allowance/refund, durable resume/cache, combined web/social <=3');
  }
  await reset('pro'); invalidRemaining = 1;
  const rec = await fixture(), recovery = await start(rec);
  assert.equal(calls.filter(c => c.id === recovery.id).length, 2);
  const ownerId = (await db.query("select id from users where auth_user_id='alice' and plan_type='subscription'")).rows[0].id;
  const recEvents = telemetry.filter(e => e.operation_id === audit.auditTelemetryContext({ product: 'subscription', user: { id: ownerId }, operationId: recovery.id }).operation_id);
  assert.deepEqual(recEvents.map(e => e.stage), ['seo_analysis', 'recovery']);
  searchSize = 2; await post(searchBody(rec, recovery), '/api/audit/competitive-search');
  assert.equal(await budget(recovery), 2);
  await post(recovery.body); assert.equal(await budget(recovery), 2);
  assert.equal(calls.filter(c => c.id === recovery.id).length, 2);
  pass('one consultative recovery: same reservation, no repeat crawl, no Search budget reset on replay');
  await reset('pro'); invalidRemaining = 2;
  const bad = await fixture(), degraded = await start(bad);
  assert.ok(degraded.root.text.includes('consultative-degraded'));
  const beforeBad = calls.length;
  assert.equal((await post(searchBody(bad, degraded), '/api/audit/competitive-search')).status, 403);
  assert.equal(calls.length, beforeBad);
  pass('two invalid consultative responses: bounded fallback, no competitive search from degraded output');
  const forbidden = { ...searchBody(rec, recovery), zentra_operation: { id: crypto.randomUUID(), product: 'subscription' } };
  const beforeForbidden = calls.length; assert.equal((await post(forbidden, '/api/audit/competitive-search')).status, 403); assert.equal(calls.length, beforeForbidden);
  pass('no Audit reservation/root: zero Search work');
  await db.query("update users set plan='pro',audits_used=10,extra_audits_balance=0 where auth_user_id='alice' and plan_type='subscription'");
  const exhaustedFixture = await fixture(), exhaustedId = crypto.randomUUID();
  const beforeExhausted = calls.length;
  const exhaustedReserve = await post({ zentra_operation: { id: exhaustedId, product: 'subscription', source: exhaustedFixture.calls[0].zentra_audit_workflow.pageData.url } }, '/api/audit/reserve');
  assert.equal(exhaustedReserve.status, 403);
  assert.equal((await post(searchBody(exhaustedFixture, { envelope: { id: exhaustedId, product: 'subscription' } }), '/api/audit/competitive-search')).status, 403);
  assert.equal(calls.length, beforeExhausted);
  assert.equal(Number((await db.query('select count(*) n from zentra_audit_search_budgets where operation_key=$1', [exhaustedId])).rows[0].n), 0);
  pass('actual exhausted Audit quota: reservation denied before IA/Search, no budget allocated');
  assert.ok(telemetry.some(e => e.stage === 'executive_refiner' && e.reasoning_effort === 'high' && e.reasoning_tokens === 100 && e.visible_output_tokens === 200));
  assert.ok(telemetry.some(e => e.product === 'zentra_audit'));
  assert.ok(telemetry.some(e => e.stage === 'competitor_search' && e.web_search_calls > 0));
  const totalThree = audit.auditCostTotal(telemetry).find(e => e.web_search_calls === 3);
  assert.ok(totalThree && totalThree.estimated_cost_usd > .03);
  assert.doesNotMatch(JSON.stringify(telemetry), /alice|example.test|fixture|summary|content|sk-/);
  const totals = audit.auditCostTotal(telemetry); assert.ok(totals.every(e => e.estimated_cost_usd > 0 && e.complete));
  const context = { auditRouting: audit.auditTelemetryContext({ product: 'subscription', operationId: 'private', task: 'seo_analysis', reasoningEffort: 'medium', context: { pageData: { url: 'a', title: 'a', h1Count: 1 }, internalPagesResult: { pages: [{ url: 'b', readStatus: 'partial' }, { url: 'a', readStatus: 'complete' }] } } }) };
  context.auditRouting.secret = 'sk-private';
  const measured = audit.auditCostTelemetry({ model: 'gpt-6-luna', context, usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 300 }, searchCalls: 2 });
  assert.equal(measured.estimated_cost_usd, .020232); assert.equal(measured.pages_processed, 1); assert.equal(measured.reasoning_tokens, null);
  const scopedId = user => audit.auditTelemetryContext({ product: 'subscription', operationId: 'same-client-uuid', user: { id: user } }).operation_id;
  assert.notEqual(scopedId('alice'), scopedId('bob'));
  assert.notEqual(scopedId('alice'), audit.auditTelemetryContext({ product: 'audit', operationId: 'same-client-uuid', user: { id: 'alice' } }).operation_id);
  assert.ok(!JSON.stringify(measured).includes('private')); assert.equal(audit.auditCostTotal([measured, audit.auditCostTelemetry({ model: 'gpt-6-luna', context, searchCalls: null })])[0].estimated_cost_usd, null);
  for (const usage of [{}, { input_tokens: 100 }, { input_tokens: null, output_tokens: 200 }]) {
    const partial = audit.auditCostTelemetry({ model: 'gpt-6-luna', context, usage });
    assert.equal(partial.usage_available, false);
    assert.equal(partial.estimated_cost_usd, null);
    assert.equal(audit.auditCostTotal([partial])[0].estimated_cost_usd, null);
  }
  pass('safe per-stage telemetry, cached/reasoning accounting, partial pages excluded, total derivable; uncertainty not zero cost');
  console.log('AUDIT GPT6:', passed, 'groups passed');
} finally {
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  await db?.end(); await pg.stop();
}
