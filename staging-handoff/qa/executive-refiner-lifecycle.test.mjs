import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { before, after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import EmbeddedPostgres from './local-postgres.mjs';

const backend = process.env.ZENTRA_BACKEND_DIR;
const { hasUsableExecutiveRefinement, hasUsablePremiumReasoning, runExecutiveRefiner, executiveVisibleText, executiveRefinerBudget } = await import(pathToFileURL(backend + '/release-executive-refiner.js'));
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

async function route(primary, fallback, releaseError = false, { task = 'executive_refiner_pdf', plan = 'pro', persistError = false } = {}) {
  const calls = [], providerCalls = [], id = crypto.randomUUID();
  const reasoning = task === 'premium_reasoning_audit';
  const model = reasoning ? 'gpt-6-luna' : 'gpt-6.1-sol';
  const body = { messages: [{ role: 'user', content: 'CONTEXTO MINIMO:\n{}\nTEXTO A REFINAR:\n{}\nDEVUELVE JSON CON:\n{"summary":"...","quickWins":"..."}' }], task_type: task, model };
  const journal = {};
  const client = { async rpc(name, args) {
    calls.push({ name, args });
    if (name === 'zentra_resume_executive') return { data: false };
    if (name === 'zentra_executive_phase') {
      const phase = args.p_phase;
      if (journal[phase]?.state === 'done') return { data: { accepted: true, cached: true, result: journal[phase].result } };
      if (args.p_result) journal[phase] = { state: 'done', result: args.p_result };
      else { if (journal[phase]) return { data: { accepted: false } }; journal[phase] = { state: 'started' }; }
      return { data: { accepted: true } };
    }
    if (name === 'zentra_read_audit_steps') return { data: { root: { request_hash: 'root', context: {} },
      steps: [{ step_name: task, body }] } };
    if (name === 'zentra_begin_request') return { data: { allowed: true, user: { id: 'fixture', plan },
      lease_token: 'lease', paid_counters: ['audits_used', 'premium_pdf_used'] } };
    if (name === 'zentra_release_executive_premium' && releaseError) return { error: new Error('Fixture storage failure') };
    if (name === 'zentra_finish_request' && persistError) return { error: new Error('Fixture persist failure') };
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
    resolveAiRoutingForRequest: async () => ({ taskType: task, premiumActive: true,
      model, provider: 'openai', fallbackModel: 'gpt-6-luna', fallbackProvider: 'openai', maxTokens: reasoning ? 4000 : 5500 }),
    isPdfFlowTask: () => true, chatRequestContext: () => ({}), isAuditTask: () => true,
    auditTelemetryContext: () => ({}), supabase: client, sanitizeChatMessages: value => value,
    hasUsableExecutiveRefinement, hasUsablePremiumReasoning, runExecutiveRefiner, executiveVisibleText,
    getAiResponseText: value => value.data?.output_text ?? '{}',
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
  const finished = new Promise(resolve => res.once('finish', resolve));
  await createOperationGuard({ client })(req, res, () => handler(req, res));
  await finished;
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
test('partial Sol + Luna success retains exactly one premium receipt and preserves visible content in recovery input', async () => {
  const partial = '{"summary":"Resumen respaldado","quickWins":"Prioridad respaldada';
  const run = await route(result('incomplete', partial), { ...result(), model: 'gpt-6-luna' });
  assert.equal(run.res.statusCode, 200);
  assert.equal(run.providerCalls.length, 2);
  const recovery = run.providerCalls[1];
  assert.equal(recovery.model, 'gpt-6-luna');
  assert.equal(JSON.parse(recovery.messages[1].content).partial_visible_output, partial);
  assert.equal(run.res.body.response.summary, 'Resumen respaldado');
  assert.equal(run.calls.filter(c => c.name === 'zentra_release_executive_premium').length, 0);
  assert.equal(run.calls.find(c => c.name === 'zentra_finish_request').args.p_success, true);
});
test('reasoning never enters persisted/recovery visible output; budgets are plan owned', () => {
  assert.equal(executiveRefinerBudget('pro'), 5500);
  assert.equal(executiveRefinerBudget('agency'), 6500);
  assert.equal(executiveVisibleText({ data: { output: [
    { type: 'reasoning', content: [{ type: 'output_text', text: 'PRIVATE REASONING' }] },
    { type: 'message', content: [{ type: 'output_text', text }] }
  ] } }), text);
});
test('incomplete with visible output attempts one recovery; failed recovery releases', async () => {
  for (const output of [text, '{"summary":"visible but truncated']) {
    const run = await route(result('incomplete', output));
    assert.equal(run.res.statusCode, 502);
    assert.equal(run.providerCalls.length, 2);
    assert.equal(run.providerCalls[1].maxTokens, 2500);
    assert.equal(run.providerCalls[1].requestContext.auditRouting.reasoning_effort, 'high');
    assert.equal(run.calls.filter(call => call.name === 'zentra_release_executive_premium').length, 1);
  }
});
test('provider error without partial output refunds without another provider call', async () => {
  const run = await route({ ...result(), ok: false, status: 500 }, { ...result(), model: 'gpt-6-luna' });
  assert.equal(run.providerCalls.length, 1);
  assert.equal(run.calls.filter(call => call.name === 'zentra_release_executive_premium').length, 1);
});
test('timeout is durably terminalized and refunded without provider replay', async () => {
  const run = await route(new Error('AbortError'));
  assert.equal(run.providerCalls.length, 1);
  assert.equal(run.calls.filter(call => call.name === 'zentra_release_executive_premium').length, 1);
  assert.ok(run.calls.some(call => call.name === 'zentra_finish_request'));
  assert.equal(run.res.statusCode, 502);
});
test('failed release stays pending rather than falsely confirming cleanup or executing again', async () => {
  const run = await route(result('incomplete', ''), undefined, true);
  assert.equal(run.res.statusCode, 503);
  assert.equal(run.res.body.code, 'execution_uncertain');
  assert.equal(run.providerCalls.length, 1);
  assert.ok(!run.calls.some(call => call.name === 'zentra_finish_request'));
});

test('Pro/Agency reasoning rejects reasoning-only, incomplete, malformed and provider errors with one refund', async () => {
  for (const plan of ['pro', 'agency']) {
    for (const primary of [result('incomplete', ''), result('completed', ''), result('incomplete'),
      result('completed', '{"summary":"truncated'), result('completed', '{}'),
      { ...result(), ok: false, status: 500 }, new Error('Timeout')]) {
      const run = await route(primary, undefined, false, { task: 'premium_reasoning_audit', plan });
      assert.ok(run.res.statusCode >= 400);
      assert.equal(run.providerCalls.length, 1);
      assert.equal(run.providerCalls[0].maxTokens, 4000);
      assert.equal(run.providerCalls[0].model, 'gpt-6-luna');
      assert.equal(run.calls.filter(c => c.name === 'zentra_release_executive_premium').length, 1);
      assert.ok(run.req.operation.paidCounters.has('audits_used'));
      assert.ok(!run.req.operation.paidCounters.has('premium_pdf_used'));
      assert.ok(run.calls.every(c => !c.args?.p_operation || c.args.p_operation === run.req.operation.id));
      if (!(primary instanceof Error)) assert.equal(run.calls.find(c => c.name === 'zentra_finish_request').args.p_success, false);
      else assert.ok(!run.calls.some(c => c.name === 'zentra_finish_request'));
    }
  }
});
test('usable reasoning persists without refund; failure to persist refunds and stays recoverable', async () => {
  for (const plan of ['pro', 'agency']) {
    for (const persistError of [false, true]) {
      const run = await route(result(), undefined, false, { task: 'premium_reasoning_audit', plan, persistError });
      assert.equal(run.res.statusCode, persistError ? 503 : 200);
      assert.equal(run.providerCalls.length, 1);
      assert.equal(run.calls.filter(c => c.name === 'zentra_release_executive_premium').length, persistError ? 1 : 0);
      assert.equal(run.calls.find(c => c.name === 'zentra_finish_request').args.p_success, true);
    }
    const run = await route(result('incomplete', ''), undefined, true, { task: 'premium_reasoning_audit', plan });
    assert.equal(run.res.statusCode, 503);
    assert.equal(run.calls.filter(c => c.name === 'zentra_release_executive_premium').length, 1);
    assert.ok(!run.calls.some(c => c.name === 'zentra_finish_request'));
  }
});
test('premium reasoning accepts only completed usable structured content', () => {
  for (const output of [text, '{"recommendations":[{"action":"Priorizar onboarding"}]}', '{"topIssues":["Friccion documentada"]}']) {
    assert.ok(hasUsablePremiumReasoning(result(), output));
    assert.equal(hasUsablePremiumReasoning(result('incomplete'), output), false);
  }
  for (const output of ['', '{}', '{"summary":""}', '{"error":"failure"}', 'Texto suelto']) assert.equal(hasUsablePremiumReasoning(result(), output), false);
});

const pg = new EmbeddedPostgres({ databaseDir: '/tmp/zentra-executive-pg-' + process.pid,
  user: 'postgres', password: crypto.randomUUID(), port: 55485, persistent: false,
  postgresFlags: ['-h', '127.0.0.1'], onLog() {}, onError() {} });
let db, db2;
before(async () => {
  await pg.initialise(); await pg.start(); db = pg.getPgClient(); await db.connect();
  db2 = pg.getPgClient(); await db2.connect();
  await db.query('create role anon; create role authenticated; create role service_role');
  for (const file of ['supabase-users.sql', 'supabase-release-guard.sql', 'supabase-execution-guard.sql', 'supabase-executive-refiner.sql', 'supabase-executive-refiner.sql', 'supabase-premium-reasoning.sql', 'supabase-premium-reasoning.sql', 'supabase-executive-recovery.sql', 'supabase-executive-recovery.sql']) {
    await db.query(fs.readFileSync(backend + '/' + file, 'utf8'));
  }
});
after(async () => { await db2?.end(); await db?.end(); await pg.stop(); });
async function fixture(stage = 'executive_refiner_pdf', plan = 'pro') {
  const auth = crypto.randomUUID(), op = crypto.randomUUID(), root = 'a'.repeat(64), hash = 'b'.repeat(64);
  await db.query("insert into users(email,auth_user_id,plan,premium_pdf_used) values($1,$2,$3,2)", [auth + '@example.test', auth, plan]);
  const begin = async requestHash => (await db.query("select zentra_begin_request($1,$2,'subscription',$3,$4,$5,'audit',false) r", [auth, auth + '@example.test', op, root, requestHash])).rows[0].r;
  const first = await begin(root), user = first.user.id;
  await db.query('select zentra_finish_request($1,$2,$3,$4,$5,true)', [user, op, root, first.lease_token, { text: 'Technical report' }]);
  await db.query("insert into zentra_audit_steps(user_id,operation_key,step_name,request_hash,body) values($1,$2,$3,$4,'{}')", [user, op, stage, hash]);
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
test('SQL: stale/wrong leases and non-premium stages cannot refund', async () => {
  const f = await fixture(); assert.equal((await f.release(db, crypto.randomUUID())).accepted, false);
  await db.query("update zentra_audit_steps set step_name='seo_analysis' where user_id=$1 and operation_key=$2", [f.user, f.op]);
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

test('SQL: Pro/Agency failed reasoning refunds exactly once under concurrent callbacks, preserves Audit and fences stale leases', async () => {
  for (const plan of ['pro', 'agency']) {
    const f = await fixture('premium_reasoning_audit', plan);
    assert.equal((await f.release(db, crypto.randomUUID())).accepted, false);
    const releases = await Promise.all([f.release(db), f.release(db2)]);
    assert.equal(releases.filter(r => r.released).length, 1);
    await db.query('select zentra_finish_request($1,$2,$3,$4,null,false)', f.args);
    assert.deepEqual(await f.counters(), { audits_used: 1, premium_pdf_used: 2 });
    const receipts = await db.query("select counter,refunded_at from zentra_usage_receipts where user_id=$1 and operation_key=$2", [f.user, f.op]);
    assert.ok(receipts.rows.find(r => r.counter === 'premium_pdf_used').refunded_at);
    assert.equal(receipts.rows.find(r => r.counter === 'audits_used').refunded_at, null);
  }
});
test('SQL: successful reasoning + executive share exactly one premium debit; reasoning cannot refund downstream work', async () => {
  for (const plan of ['pro', 'agency']) {
    const f = await fixture('premium_reasoning_audit', plan), hash = 'c'.repeat(64);
    await db.query('select zentra_finish_request($1,$2,$3,$4,$5,true)', [...f.args, { text }]);
    await db.query("insert into zentra_audit_steps(user_id,operation_key,step_name,request_hash,body) values($1,$2,'executive_refiner_pdf',$3,'{}')", [f.user, f.op, hash]);
    const exec = await f.begin(hash);
    const consumed = await db.query("select zentra_consume_generation($1,$2,'subscription','premium_pdf_used',$3,$4,$5,false) r", [f.auth, f.auth + '@example.test', f.op, hash, exec.lease_token]);
    assert.equal(consumed.rows[0].r.duplicate, true);
    await db.query('select zentra_finish_request($1,$2,$3,$4,$5,true)', [f.user, f.op, hash, exec.lease_token, { text }]);
    assert.deepEqual(await f.counters(), { audits_used: 1, premium_pdf_used: 3 });
    assert.equal((await f.release()).accepted, false);
    // Simulate an old reasoning callback still marked running: it cannot refund executive work.
    await db.query("update zentra_requests set state='running',lease_until=now()+interval '1 minute' where user_id=$1 and operation_key=$2 and request_hash=$3", [f.user, f.op, f.hash]);
    const release = await f.release();
    assert.equal(release.accepted, false); assert.equal(release.reason, 'downstream_premium_owned');
    assert.equal((await f.counters()).premium_pdf_used, 3);
  }
});

function journalClient(connection = db) {
  return { async rpc(name, args) {
    try { const values = Object.values(args); return { data: (await connection.query(
      'select ' + name + '(' + values.map((_, i) => '$' + (i + 1)).join(',') + ') r', values)).rows[0].r }; }
    catch (error) { return { error }; }
  } };
}
const messages = [{ role: 'user', content: 'CONTEXTO MINIMO:\n{"seoScore":80}\nTEXTO A REFINAR:\n{}\nDEVUELVE JSON CON:\n{"summary":"...","quickWins":"..."}' }];
function runJournal(f, callSol, callRecovery) {
  return runExecutiveRefiner({ client: journalClient(), operation: { id: f.op, user: { id: f.user },
    requestHash: f.hash, leaseToken: f.executive.lease_token }, callSol, callRecovery,
    textOf: executiveVisibleText, messages });
}
test('SQL journal: complete Sol is cached across popup/server resume; no second provider or debit', async () => {
  const f = await fixture(); let count = 0;
  const invoke = () => { count++; return result(); };
  await runJournal(f, invoke, () => assert.fail('Recovery must not run'));
  await runJournal(f, () => assert.fail('Sol must not replay'), () => assert.fail('Recovery must not run'));
  assert.equal(count, 1); assert.equal((await f.counters()).premium_pdf_used, 3);
  await db.query('select zentra_finish_request($1,$2,$3,$4,$5,true)', [...f.args, { text }]);
  assert.ok((await f.begin(f.hash)).cached);
});
test('SQL journal: restart after partial Sol resumes only Luna; successful recovery never duplicates on replay', async () => {
  for (const plan of ['pro', 'agency']) {
    const f = await fixture('executive_refiner_pdf', plan);
    const partial = { ...result('incomplete', '{"summary":"Resumen respaldado'), data: {
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"summary":"Resumen respaldado' } };
    await db.query('select zentra_executive_phase($1,$2,$3,$4,\'sol\',null)', f.args);
    await db.query('select zentra_executive_phase($1,$2,$3,$4,\'sol\',$5)', [...f.args, partial]);
    await db.query("update zentra_requests set lease_until=now()-interval '1 second' where user_id=$1 and operation_key=$2 and request_hash=$3", [f.user, f.op, f.hash]);
    assert.equal((await db.query("select zentra_resume_executive($1,$2,'subscription',$3,$4) r", [f.auth, f.auth + '@example.test', f.op, f.hash])).rows[0].r, true);
    f.executive = await f.begin(f.hash); assert.ok(f.executive.allowed);
    let recovery = 0;
    const recovered = await runJournal(f, () => assert.fail('Sol cannot run after durable checkpoint'), () => { recovery++; return { ...result(), model: 'gpt-6-luna' }; });
    assert.ok(hasUsableExecutiveRefinement(recovered, executiveVisibleText(recovered)));
    await runJournal(f, () => assert.fail('No second Sol'), () => assert.fail('No second Luna'));
    assert.equal(recovery, 1); assert.equal((await f.counters()).premium_pdf_used, 3);
  }
});
test('SQL journal: concurrent phase claims fence duplicate providers and stale callbacks', async () => {
  const f = await fixture();
  const claim = connection => connection.query("select zentra_executive_phase($1,$2,$3,$4,'sol',null) r", f.args);
  const claims = await Promise.all([claim(db), claim(db2)]);
  assert.equal(claims.filter(c => c.rows[0].r.accepted).length, 1);
  const stale = await db.query("select zentra_executive_phase($1,$2,$3,$4,'sol',$5) r", [f.user, f.op, f.hash, crypto.randomUUID(), result()]);
  assert.equal(stale.rows[0].r.accepted, false);
});
test('SQL journal: provider uncertainty is terminal, refund safe, never a second Sol/recovery', async () => {
  for (const phase of ['sol', 'recovery']) {
    const f = await fixture();
    await db.query("select zentra_executive_phase($1,$2,$3,$4,'sol',null)", f.args);
    if (phase === 'recovery') {
      await db.query("select zentra_executive_phase($1,$2,$3,$4,'sol',$5)", [...f.args, result('incomplete', '{"summary":"partial')]);
      await db.query("select zentra_executive_phase($1,$2,$3,$4,'recovery',null)", f.args);
    }
    await db.query("update zentra_requests set lease_until=now()-interval '1 second' where user_id=$1 and operation_key=$2 and request_hash=$3", [f.user, f.op, f.hash]);
    await db.query("select zentra_resume_executive($1,$2,'subscription',$3,$4)", [f.auth, f.auth + '@example.test', f.op, f.hash]);
    f.executive = await f.begin(f.hash);
    const out = await runJournal(f, () => assert.fail('Uncertain Sol cannot replay'), () => assert.fail('Uncertain recovery cannot replay'));
    assert.equal(out.ok, false);
    const release = await db.query('select zentra_release_executive_premium($1,$2,$3,$4) r', [f.user, f.op, f.hash, f.executive.lease_token]);
    assert.equal(release.rows[0].r.released, true);
    assert.equal((await f.counters()).premium_pdf_used, 2);
  }
});
