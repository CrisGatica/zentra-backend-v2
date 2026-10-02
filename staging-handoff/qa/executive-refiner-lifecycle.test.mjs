import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { before, after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import EmbeddedPostgres from './local-postgres.mjs';

const backend = process.env.ZENTRA_BACKEND_DIR;
const { hasUsableExecutiveRefinement } = await import(pathToFileURL(backend + '/release-executive-refiner.js'));
const { createOperationGuard } = await import(pathToFileURL(backend + '/release-operations.js'));
const source = fs.readFileSync(backend + '/server.js', 'utf8');
const text = JSON.stringify({ summary: 'Resumen respaldado', quickWins: 'Prioridad respaldada' });
const result = (status = 'completed', output = text) => ({ ok: true, status: 200, model: 'gpt-6.1-sol',
  provider: 'openai', api: 'responses', data: { status, output_text: output } });

test('executive output must contain usable JSON blocks, not HTTP success/reasoning alone', () => {
  for (const value of ['', '{}', '{"error":"fallo"}', '{"summary":null}', '{"summary":"', 'Texto suelto']) {
    assert.equal(hasUsableExecutiveRefinement(result('incomplete', value), value), false);
  }
  assert.equal(hasUsableExecutiveRefinement(result('incomplete'), text), false);
  assert.equal(hasUsableExecutiveRefinement(result(), '```json\n' + text + '\n```'), true);
  assert.equal(hasUsableExecutiveRefinement({ ...result(), ok: false }, text), false);
  assert.equal(hasUsableExecutiveRefinement(result('failed'), text), false);
});

test('5500 server ceiling overrides older client budgets only for executive', () => {
  const fn = source.slice(source.indexOf('function clampMaxTokens('), source.indexOf('function normalizeTemperature('));
  const context = vm.createContext({ normalizeTaskType: value => value, normalizeCounterValue: Number,
    AI_TASK_ROUTING: { executive_refiner_pdf: { maxTokens: 5500 }, seo_analysis: { maxTokens: 2048 }, chat_basic: { maxTokens: 500 } } });
  vm.runInContext(fn, context);
  for (const budget of [900, 2200, 4096, 99999]) assert.equal(context.clampMaxTokens(budget, 'executive_refiner_pdf'), 5500);
  assert.equal(context.clampMaxTokens(900, 'seo_analysis'), 900);
  assert.equal(context.clampMaxTokens(500, 'chat_basic'), 500);
  assert.match(source, /process\.env\.ZENTRA_EXECUTIVE_REFINER_MAX_TOKENS \|\| 900/);
});

async function route(primary, fallback, releaseError = false) {
  const calls = [], providerCalls = [], id = crypto.randomUUID();
  const body = { messages: [{ role: 'user', content: 'Fixture' }], task_type: 'executive_refiner_pdf', model: 'gpt-6.1-sol' };
  const client = { async rpc(name, args) {
    calls.push({ name, args });
    if (name === 'zentra_read_audit_steps') return { data: { root: { request_hash: 'root', context: {} },
      steps: [{ step_name: 'executive_refiner_pdf', body }] } };
    if (name === 'zentra_begin_request') return { data: { allowed: true, user: { id: 'fixture', plan: 'pro' },
      lease_token: 'lease', paid_counters: ['audits_used', 'premium_pdf_used'] } };
    if (name === 'zentra_release_executive_premium' && releaseError) return { error: new Error('Fixture storage failure') };
    if (name === 'zentra_release_executive_premium' || name === 'zentra_finish_request') return { data: { accepted: true } };
    throw new Error('Unexpected RPC ' + name);
  } };
  const req = { auth: { userId: 'auth', email: 'fixture@example.test' }, path: '/api/chat', method: 'POST',
    body: { ...body, zentra_operation: { id, product: 'subscription' } } };
  const events = [];
  const res = { statusCode: 200, once(event, fn) { events.push([event, fn]); },
    status(n) { this.statusCode = n; return this; }, set() { return this; },
    json(body) { this.body = body; events.filter(([event]) => event === 'finish').forEach(([, fn]) => fn()); return this; } };
  let handler;
  const context = vm.createContext({
    app: { post(_path, fn) { handler = fn; } }, console: { log() {}, warn() {}, error() {} },
    resolveAiRoutingForRequest: async () => ({ taskType: 'executive_refiner_pdf', premiumActive: true,
      model: 'gpt-6.1-sol', provider: 'openai', fallbackModel: 'gpt-6-luna', fallbackProvider: 'openai', maxTokens: 5500 }),
    isPdfFlowTask: () => true, chatRequestContext: () => ({}), isAuditTask: () => true,
    auditTelemetryContext: () => ({}), supabase: client, sanitizeChatMessages: value => value,
    hasUsableExecutiveRefinement, getAiResponseText: value => value.data?.output_text || '{}',
    callAiProvider: async options => {
      providerCalls.push(options);
      if (primary instanceof Error) { req.operation.externalUncertain = true; throw primary; }
      return providerCalls.length === 1 ? primary : fallback;
    }, getAiErrorMessage: () => 'Provider failed', chatTechnicalFallbackContext: value => value,
    parseJsonSafely: value => JSON.parse(value), getIdentityFromRequest: () => ({}), getEmailFromChatRequest: () => '',
    resolveIdentityContext: async () => ({}), getDefaultSubscriptionUser: () => ({ plan: 'pro' }),
    normalizePlan: value => value, formatSubscriptionUsage: value => value, buildPublicUsagePayload: value => value
  });
  vm.runInContext(source.slice(source.indexOf('app.post("/api/chat", async'), source.indexOf('\napp.use((_req, res) => res.status(404)')), context);
  await createOperationGuard({ client })(req, res, () => handler(req, res));
  return { calls, providerCalls, req, res };
}

test('actual route + guard release blank/incomplete executive, but not the Audit receipt', async () => {
  const run = await route(result('incomplete', ''));
  assert.equal(run.res.statusCode, 502);
  assert.equal(run.res.body.code, 'executive_refiner_unavailable');
  assert.equal(run.providerCalls.length, 1);
  const names = run.calls.map(call => call.name);
  assert.equal(names.filter(name => name === 'zentra_release_executive_premium').length, 1);
  assert.ok(names.indexOf('zentra_release_executive_premium') < names.indexOf('zentra_finish_request'));
  assert.equal(run.calls.find(call => call.name === 'zentra_finish_request').args.p_success, false);
  assert.equal(run.req.operation.id, run.calls.find(call => call.name === 'zentra_release_executive_premium').args.p_operation);
  assert.ok(run.req.operation.paidCounters.has('audits_used'));
});
test('usable completed executive is persisted without refund or extra provider', async () => {
  for (const status of ['completed']) {
    const run = await route(result(status));
    assert.equal(run.res.statusCode, 200); assert.equal(run.res.body.success, true);
    assert.equal(run.providerCalls.length, 1);
    assert.ok(!run.calls.some(call => call.name === 'zentra_release_executive_premium'));
    assert.equal(run.calls.find(call => call.name === 'zentra_finish_request').args.p_success, true);
  }
});
test('incomplete with visible valid JSON still releases premium; truncated JSON also releases', async () => {
  for (const output of [text, '{"summary":"visible but truncated']) {
    const run = await route(result('incomplete', output));
    assert.equal(run.res.statusCode, 502);
    assert.equal(run.providerCalls.length, 1);
    assert.equal(run.calls.filter(call => call.name === 'zentra_release_executive_premium').length, 1);
  }
});
test('provider error followed by existing base fallback releases the premium entitlement', async () => {
  const run = await route({ ...result(), ok: false, status: 500 }, { ...result(), model: 'gpt-6-luna' });
  assert.equal(run.providerCalls.length, 2);
  assert.equal(run.providerCalls[1].model, 'gpt-6-luna');
  assert.equal(run.calls.filter(call => call.name === 'zentra_release_executive_premium').length, 1);
});
test('timeout releases premium but preserves external uncertainty fencing (no regenerated operation)', async () => {
  const run = await route(new Error('AbortError'));
  assert.equal(run.providerCalls.length, 1);
  assert.equal(run.calls.filter(call => call.name === 'zentra_release_executive_premium').length, 1);
  assert.ok(!run.calls.some(call => call.name === 'zentra_finish_request'));
  assert.equal(run.res.statusCode, 503); assert.equal(run.res.body.code, 'execution_uncertain');
});
test('failed release stays pending rather than falsely confirming cleanup or executing again', async () => {
  const run = await route(result('incomplete', ''), undefined, true);
  assert.equal(run.res.statusCode, 503);
  assert.equal(run.res.body.code, 'execution_uncertain');
  assert.equal(run.providerCalls.length, 1);
  assert.ok(!run.calls.some(call => call.name === 'zentra_finish_request'));
});

const pg = new EmbeddedPostgres({ databaseDir: '/tmp/zentra-executive-pg-' + process.pid,
  user: 'postgres', password: crypto.randomUUID(), port: 55485, persistent: false,
  postgresFlags: ['-h', '127.0.0.1'], onLog() {}, onError() {} });
let db, db2;
before(async () => {
  await pg.initialise(); await pg.start(); db = pg.getPgClient(); await db.connect();
  db2 = pg.getPgClient(); await db2.connect();
  await db.query('create role anon; create role authenticated; create role service_role');
  for (const file of ['supabase-users.sql', 'supabase-release-guard.sql', 'supabase-execution-guard.sql', 'supabase-executive-refiner.sql', 'supabase-executive-refiner.sql']) {
    await db.query(fs.readFileSync(backend + '/' + file, 'utf8'));
  }
});
after(async () => { await db2?.end(); await db?.end(); await pg.stop(); });
async function fixture() {
  const auth = crypto.randomUUID(), op = crypto.randomUUID(), root = 'a'.repeat(64), hash = 'b'.repeat(64);
  await db.query("insert into users(email,auth_user_id,plan,premium_pdf_used) values($1,$2,'pro',2)", [auth + '@example.test', auth]);
  const begin = async requestHash => (await db.query("select zentra_begin_request($1,$2,'subscription',$3,$4,$5,'audit',false) r", [auth, auth + '@example.test', op, root, requestHash])).rows[0].r;
  const first = await begin(root), user = first.user.id;
  await db.query('select zentra_finish_request($1,$2,$3,$4,$5,true)', [user, op, root, first.lease_token, { text: 'Technical report' }]);
  await db.query("insert into zentra_audit_steps(user_id,operation_key,step_name,request_hash,body) values($1,$2,'executive_refiner_pdf',$3,'{}')", [user, op, hash]);
  const executive = await begin(hash);
  await db.query("select zentra_consume_generation($1,$2,'subscription','premium_pdf_used',$3,$4,$5,false)", [auth, auth + '@example.test', op, hash, executive.lease_token]);
  const args = [user, op, hash, executive.lease_token];
  const release = (connection = db, lease = executive.lease_token) => connection.query('select zentra_release_executive_premium($1,$2,$3,$4) r', [user, op, hash, lease]).then(value => value.rows[0].r);
  const counters = () => db.query('select audits_used,premium_pdf_used from users where id=$1', [user]).then(value => value.rows[0]);
  return { auth, op, root, hash, user, args, executive, begin, release, counters };
}
test('SQL: concurrent releases are idempotent, preserve root and unrelated premium usages', async () => {
  const f = await fixture(); assert.equal((await f.counters()).premium_pdf_used, 3);
  const releases = await Promise.all([f.release(db), f.release(db2)]);
  assert.ok(releases.every(value => value.accepted));
  assert.equal(releases.filter(value => value.released).length, 1);
  assert.deepEqual(await f.counters(), { audits_used: 1, premium_pdf_used: 2 });
  assert.ok((await f.release()).accepted);
  await db.query('select zentra_finish_request($1,$2,$3,$4,null,false)', f.args);
  assert.deepEqual(await f.counters(), { audits_used: 1, premium_pdf_used: 2 });
});
test('SQL: stale/wrong leases and non-executive stages cannot refund', async () => {
  const f = await fixture(); assert.equal((await f.release(db, crypto.randomUUID())).accepted, false);
  await db.query("update zentra_audit_steps set step_name='premium_reasoning_audit' where user_id=$1 and operation_key=$2", [f.user, f.op]);
  assert.equal((await f.release()).accepted, false); assert.equal((await f.counters()).premium_pdf_used, 3);
});
test('SQL: completed output is protected from later releases; retries cannot double debit', async () => {
  const f = await fixture(); await db.query('select zentra_finish_request($1,$2,$3,$4,$5,true)', [...f.args, { text }]);
  assert.equal((await f.release()).accepted, false);
  const replay = await f.begin(f.hash); assert.ok(replay.cached);
  assert.equal((await f.counters()).premium_pdf_used, 3);
});
test('SQL: timeout release does not clear provider-started uncertainty or permit a second execution', async () => {
  const f = await fixture(); await db.query('select zentra_start_provider($1,$2,$3,$4)', f.args);
  await db.query("update zentra_requests set lease_until=now()-interval '1 second' where user_id=$1 and operation_key=$2 and request_hash=$3", [f.user, f.op, f.hash]);
  assert.equal((await f.release()).released, true);
  const retry = await f.begin(f.hash); assert.equal(retry.reason, 'execution_uncertain');
  assert.deepEqual(await f.counters(), { audits_used: 1, premium_pdf_used: 2 });
});
test('SQL: refunded failed retry reserves exactly once under the new lease', async () => {
  const f = await fixture(); await f.release(); await db.query('select zentra_finish_request($1,$2,$3,$4,null,false)', f.args);
  const retry = await f.begin(f.hash); assert.ok(retry.allowed); assert.notEqual(retry.lease_token, f.executive.lease_token);
  const consume = connection => connection.query("select zentra_consume_generation($1,$2,'subscription','premium_pdf_used',$3,$4,$5,false) r", [f.auth, f.auth + '@example.test', f.op, f.hash, retry.lease_token]);
  const attempts = await Promise.all([consume(db), consume(db2)]);
  assert.equal(attempts.filter(value => value.rows[0].r.duplicate).length, 1);
  assert.equal((await f.counters()).premium_pdf_used, 3);
  assert.equal((await f.release()).accepted, false);
});
test('SQL: old billing cycle cannot decrement new usage; refund RPC is service-role-only', async () => {
  const f = await fixture();
  await db.query('update users set billing_cycle_start=billing_cycle_start+1,premium_pdf_used=1 where id=$1', [f.user]);
  assert.equal((await f.release()).released, true);
  assert.equal((await f.counters()).premium_pdf_used, 1);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const permission = await db.query("select has_function_privilege($1, 'zentra_release_executive_premium(uuid,text,text,uuid)', 'EXECUTE') allowed", [role]);
    assert.equal(permission.rows[0].allowed, role === 'service_role');
  }
});
