import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import EmbeddedPostgres from './local-postgres.mjs';
import { JSDOM } from './local-postgres.mjs';
import { auditFixture } from './audit-fixtures.mjs';

const backend = process.env.ZENTRA_BACKEND_DIR;
assert.ok(backend);
const pg = new EmbeddedPostgres({ databaseDir: '/tmp/zentra-multiprocess-pg-' + process.pid,
  user: 'postgres', password: crypto.randomUUID(), port: 55483, persistent: false,
  postgresFlags: ['-h', '127.0.0.1'], onLog() {}, onError() {} });
const workers = [];
let db;
let passed = 0;
const pass = name => { passed++; console.log('PASS', name); };
const uuid = () => crypto.randomUUID();
async function child(config, httpRate = '') {
  const process = fork(fileURLToPath(new URL('./quota-multiprocess-worker.mjs', import.meta.url)), [], {
    execArgv: [], env: { ...globalThis.process.env, ZENTRA_TEST_PG_CONFIG: JSON.stringify(config), ZENTRA_TEST_HTTP_RATE: httpRate },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const pending = new Map();
  let seq = 0;
  let output = '';
  process.stdout.on('data', chunk => { output += chunk; });
  process.stderr.on('data', chunk => { output += chunk; });
  const ready = await new Promise((resolve, reject) => {
    process.on('message', message => {
      if (message.type === 'ready') return resolve(message);
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message.value); }
    });
    process.on('exit', code => {
      if (code !== 0) reject(new Error('Child exit ' + code + ': ' + output));
      for (const waiter of pending.values()) waiter.reject(new Error('Child exited: ' + output));
    });
  });
  return { ...ready, process, call(type, data = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); process.send({ type, id, ...data }); });
  } };
}
async function post(worker, body, token = 'alice', path = '/api/chat') {
  const response = await fetch(worker.url + path, { method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, text: await response.text() };
}
const root = (id, overrides = {}) => ({ messages: [{ role: 'user', content: 'Consulta de prueba de atomicidad' }],
  task_type: 'chat_basic', zentra_operation: { id, product: 'subscription' }, ...overrides });
async function totalCalls(id, type = 'provider') {
  const metrics = await Promise.all(workers.filter(worker => worker.process.connected).map(worker => worker.call('metrics')));
  return metrics.reduce((sum, value) => sum + (value[type][id] || 0), 0);
}
async function until(check, timeout=10000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for fixture');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function account(auth = 'alice', product = 'subscription') {
  return (await db.query('select * from users where auth_user_id=$1 and plan_type=$2', [auth, product])).rows[0];
}
async function reset(used, plan = 'starter') {
  await db.query("update users set plan=$1,actions_used=$2,audits_used=0 where auth_user_id='alice' and plan_type='subscription'", [plan, used]);
}
async function state(id, auth = 'alice', product = 'subscription') {
  const user = await account(auth, product);
  const requests = (await db.query('select * from zentra_requests where user_id=$1 and operation_key=$2', [user.id, id])).rows;
  const receipts = (await db.query('select * from zentra_usage_receipts where user_id=$1 and operation_key=$2', [user.id, id])).rows;
  return { user, requests, receipts };
}
async function finish(worker, snapshot, success) {
  const req = snapshot.requests[0];
  return worker.call('sql', { sql: 'select zentra_finish_request($1,$2,$3,$4,$5,$6) r',
    args: [snapshot.user.id, req.operation_key, req.request_hash, req.lease_token, success ? { text: 'Resultado util' } : null, success] });
}

try {
  await pg.initialise(); await pg.start(); db = pg.getPgClient(); await db.connect();
  await db.query('create role anon; create role authenticated; create role service_role');
  await db.query(await readFile(backend + '/supabase-users.sql', 'utf8'));
  await db.query(await readFile(backend + '/supabase-release-guard.sql', 'utf8'));
  await db.query(await readFile(backend + '/supabase-execution-guard.sql', 'utf8'));
  await db.query(await readFile(backend + '/supabase-http-rate.sql', 'utf8'));
  await db.query(await readFile(backend + '/supabase-lemon.sql', 'utf8'));
  await db.query("insert into users(email,auth_user_id,plan) values('alice@example.test','alice','starter'),('bob@example.test','bob','starter')");
  const config = { ...db.connectionParameters, password: db.connectionParameters.password, host: '127.0.0.1', port: 55483, max: 12 };
  delete config.ssl;
  workers.push(await child(config)); workers.push(await child(config));
  assert.notEqual(workers[0].pid, workers[1].pid);
  console.log('Two independent Node processes; shared real PostgreSQL; simulated Auth/suppliers');

  for (const [plan, cap] of [['free', 20], ['starter', 300], ['pro', 800], ['agency', 3000]]) {
    await reset(cap - 1, plan);
    const ids = [uuid(), uuid()];
    const results = await Promise.all(ids.map((id, i) => post(workers[i], root(id), 'alice', i ? '/api/chat/stream' : '/api/chat')));
    assert.equal(results.filter(value => value.status === 200).length, 1, JSON.stringify(results));
    assert.equal(results.filter(value => value.status === 403).length, 1);
    assert.equal((await account()).actions_used, cap);
    assert.equal(await totalCalls(ids[0]) + await totalCalls(ids[1]), 1);
    for (const id of ids) {
      const s = await state(id);
      assert.equal(s.requests.length, s.receipts.length);
      assert.ok(s.requests.length <= 1);
      assert.ok(s.requests.every(request => request.state === 'done'));
    }
    pass(plan + ': remaining 1, competing chat/stream across processes: one supplier, one debit, zero remaining');
  }
  await reset(290);
  const ids = Array.from({ length: 20 }, uuid);
  const burst = await Promise.all(ids.map((id, i) => post(workers[i % 2], root(id))));
  assert.equal(burst.filter(value => value.status === 200).length, 10);
  assert.equal(burst.filter(value => value.status === 403).length, 10);
  assert.equal((await account()).actions_used, 300);
  assert.equal((await Promise.all(ids.map(id => totalCalls(id)))).reduce((a, b) => a + b), 10);
  const burstRecords = await Promise.all(ids.map(id => state(id)));
  assert.equal(burstRecords.reduce((n, s) => n + s.requests.length, 0), 10);
  assert.equal(burstRecords.reduce((n, s) => n + s.receipts.filter(r => !r.refunded_at).length, 0), 10);
  pass('remaining 10, 20 concurrent roots: exactly 10 suppliers/reservations/receipts, no partial debit');

  await reset(0);
  const same = uuid();
  const repeated = await Promise.all(Array.from({ length: 10 }, (_, i) => post(workers[i % 2], root(same))));
  assert.ok(repeated.every(value => [200, 425].includes(value.status)));
  assert.equal(await totalCalls(same), 1);
  let snapshot = await state(same);
  assert.equal(snapshot.user.actions_used, 1); assert.equal(snapshot.requests.length, 1); assert.equal(snapshot.receipts.length, 1);
  assert.equal(snapshot.requests[0].state, 'done');
  await Promise.all(workers.map(worker => post(worker, root(same))));
  assert.equal(await totalCalls(same), 1);
  pass('same action/request 10 times, plus completed replay: one supplier/debit/result');
  const refusedRefunds = await Promise.all(workers.map(worker => finish(worker, snapshot, false)));
  assert.ok(refusedRefunds.every(rows => !rows[0].r.accepted));
  assert.equal((await state(same)).receipts[0].refunded_at, null);
  assert.equal((await account()).actions_used, 1);
  pass('useful persisted result: concurrent late failures cannot refund or replace it');

  await reset(0);
  const ocr = uuid();
  const ocrBody = root(ocr, { task_type: 'chat_image_ocr', messages: [{ role: 'user', content: [
    { type: 'text', text: 'Dame los textos de esta imagen' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
  ] }] });
  const ocrResults = await Promise.all(Array.from({ length: 10 }, (_, i) => post(workers[i % 2], ocrBody)));
  assert.ok(ocrResults.every(value => [200, 425].includes(value.status)));
  snapshot = await state(ocr);
  assert.equal(await totalCalls(ocr), 1); assert.equal(snapshot.user.actions_used, 1);
  assert.equal(snapshot.requests.length, 1); assert.equal(snapshot.receipts.length, 1);
  pass('same OCR request concurrently: one supplier/reservation/receipt across processes');

  await reset(0);
  const hold = uuid();
  const pending = post(workers[0], root(hold, { fixture_hold: true }));
  await until(async () => await totalCalls(hold) > 0);
  snapshot = await state(hold);
  const concurrentRefunds = await Promise.all(workers.map(worker => finish(worker, snapshot, false)));
  assert.equal(concurrentRefunds.filter(rows => rows[0].r.accepted).length, 1);
  assert.equal(concurrentRefunds.filter(rows => rows[0].r.refunded).length, 1);
  snapshot = await state(hold);
  assert.equal(snapshot.user.actions_used, 0); assert.equal(snapshot.requests[0].state, 'failed');
  assert.ok(snapshot.receipts[0].refunded_at);
  await workers[0].call('release', { operation: hold }); await pending;
  assert.equal((await account()).actions_used, 0);
  pass('two simultaneous failure handlers: exactly one accepted refund; stale completion cannot credit again');

  const retry = uuid();
  await post(workers[0], root(retry, { fixture_fail_once: true }));
  snapshot = await state(retry);
  assert.equal(snapshot.requests[0].state, 'failed'); assert.ok(snapshot.receipts[0].refunded_at);
  const retryBody = root(retry, { fixture_fail_once: true });
  const retried = await Promise.all(Array.from({ length: 10 }, (_, i) => post(workers[i % 2], retryBody)));
  assert.ok(retried.every(value => [200, 425].includes(value.status)));
  assert.equal(await totalCalls(retry), 2);
  snapshot = await state(retry);
  assert.equal(snapshot.user.actions_used, 1); assert.equal(snapshot.requests.length, 1); assert.equal(snapshot.requests[0].attempts, 2);
  assert.equal(snapshot.receipts.length, 1); assert.equal(snapshot.receipts[0].refunded_at, null);
  pass('failed root + 10 legitimate concurrent retries: one retry supplier, one net debit, one receipt');

  await reset(0);
  const refine = uuid();
  const message = 'Explicame cómo organizar mis servicios paso a paso.';
  const original = root(refine, { messages: [{ role: 'user', content: message }], zentra_workflow: {
    version: 1, userMessage: message, taskIntent: { label: 'senior' },
    responseContract: { outputType: 'response', renderType: 'plain', contextDecision: 'free' },
    state: { webContext: {}, conversation: [], taskMemory: {}, model: 'gpt-5-mini', maxTokens: 2200 }
  } });
  await post(workers[0], original);
  const repaired = await Promise.all(Array.from({ length: 10 }, (_, i) => post(workers[i % 2], {
    ...original, zentra_refinement: { stage: 'visible' }
  })));
  assert.ok(repaired.every(value => [200, 425].includes(value.status)));
  assert.equal(await totalCalls(refine), 2);
  snapshot = await state(refine);
  assert.equal(snapshot.user.actions_used, 1); assert.equal(snapshot.receipts.length, 1); assert.equal(snapshot.requests.length, 2);
  assert.ok(snapshot.requests.every(request => request.state === 'done'));
  const forbidden = await post(workers[1], { ...original, zentra_refinement: { stage: 'unlimited' } });
  assert.equal(forbidden.status, 409); assert.equal(await totalCalls(refine), 2);
  pass('10 concurrent authorized refinements: one refinement execution, same debit; arbitrary stage rejected');

  await reset(0);
  const mix = uuid();
  const waiting = post(workers[0], root(mix, { fixture_hold: true }));
  await until(async () => await totalCalls(mix) > 0);
  snapshot = await state(mix);
  const [failed, consumed] = await Promise.all([
    finish(workers[0], snapshot, false),
    workers[1].call('sql', { sql: "select zentra_consume('alice','alice@example.test','subscription','actions_used',$1,false) r", args: [uuid()] })
  ]);
  assert.ok(failed[0].r.refunded); assert.ok(consumed[0].r.allowed);
  assert.equal((await account()).actions_used, 1);
  assert.equal((await state(mix)).requests[0].state, 'failed');
  await workers[0].call('release', { operation: mix }); await waiting;
  pass('concurrent consume/refund serialize on DB: unrelated charge remains, own failed receipt refunded once');

  await reset(299);
  await db.query("update users set actions_used=299 where auth_user_id='bob'");
  const independent = [uuid(), uuid()];
  await db.query('begin');
  await db.query("select id from users where auth_user_id='alice' and plan_type='subscription' for update");
  const alice = post(workers[0], root(independent[0]), 'alice');
  const bob = await post(workers[1], root(independent[1]), 'bob');
  assert.equal(bob.status, 200); assert.equal((await account('bob')).actions_used, 300);
  await db.query('commit'); await alice;
  assert.equal((await account()).actions_used, 300);
  assert.equal(await totalCalls(independent[0]), 1); assert.equal(await totalCalls(independent[1]), 1);
  pass('different users: locked Alice does not block Bob; separate counters/receipts');

  await reset(0, 'pro');
  await db.query("update users set audits_used=9 where auth_user_id='alice' and plan_type='subscription'");
  const audit = await auditFixture(backend + '/../publicacion/chrome-store/zentra-ai-chrome-store-clean', 'pro', {
    pageOverride: { title: 'Partner management software', h1s: ['Partner management software'], metaDescription: 'Partner management software' }
  });
  const audits = [uuid(), uuid()];
  const auditBody = id => ({ ...audit.calls[0], fixture_result: JSON.parse(audit.outputs.seo_analysis), zentra_operation: { id, product: 'subscription' } });
  const reservedAudit = async (worker, id, product = 'subscription') => {
    const reserved = await post(worker, { zentra_operation: { id, product,
      source: audit.calls[0].zentra_audit_workflow.pageData.url } }, 'alice', '/api/audit/reserve');
    if (reserved.status !== 200) return reserved;
    return post(worker, { ...auditBody(id), zentra_operation: { id, product },
      zentra_acquisition: { token: JSON.parse(reserved.text).lease_token } });
  };
  const auditResults = await Promise.all(audits.map((id, i) => reservedAudit(workers[i], id)));
  assert.equal(auditResults.filter(value => value.status === 200).length, 1);
  assert.equal(auditResults.filter(value => value.status === 403).length, 1);
  assert.equal((await account()).audits_used, 10);
  assert.equal(await totalCalls(audits[0]) + await totalCalls(audits[1]), 1);
  const winning = audits[auditResults.findIndex(value => value.status === 200)];
  const losing = audits.find(id => id !== winning);
  assert.equal((await state(losing)).requests.length, 0);
  assert.equal((await state(losing)).receipts.length, 0);
  pass('subscription Audit last credit: one server generation/reservation, losing root has no debit/request');

  const searchRequest = audit.calls[1].zentra_audit_evidence;
  const searchBody = id => ({ queries: searchRequest.queries, siteDomain: new URL(audit.calls[0].zentra_audit_workflow.pageData.url).hostname,
    scope: 'web', zentra_operation: { id, product: 'subscription' } });
  const deniedSearch = await post(workers[1], searchBody(losing), 'alice', '/api/audit/competitive-search');
  assert.equal(deniedSearch.status, 403);
  const authorizedSearch = await Promise.all(workers.map(worker => post(worker, searchBody(winning), 'alice', '/api/audit/competitive-search')));
  assert.ok(authorizedSearch.every(value => [200,425].includes(value.status)));
  assert.ok(authorizedSearch.some(value => value.status === 200));
  const searchReplay = await post(workers[1], searchBody(winning), 'alice', '/api/audit/competitive-search');
  assert.equal(searchReplay.status,200);
  assert.equal((await account()).audits_used, 10);
  assert.equal(await totalCalls(searchBody(winning).siteDomain, 'search'), 1);
  const searchRows = (await db.query('select * from zentra_search_requests where operation_key=$1',[winning])).rows;
  assert.equal(searchRows.length,1); assert.equal(searchRows[0].state,'done');
  pass('E/I: identical competitive search across processes: one supplier, persisted replay, no second debit');

  const searchUser = (await account()).id;
  assert.equal((await db.query('select used from zentra_audit_search_budgets where user_id=$1 and operation_key=$2', [searchUser, winning])).rows[0].used, 1);
  const searchLeases = await Promise.all(workers.slice(0, 2).map(async (worker, i) => {
    const hash = crypto.createHash('sha256').update('allowed-search-budget-fixture-' + i).digest('hex');
    const begin = await worker.call('sql', { sql: 'select zentra_begin_search($1,$2,$3,$4,$5) r',
      args: ['alice', 'alice@example.test', 'subscription', winning, hash] });
    assert.equal(begin[0].r.allowed, true);
    return [searchUser, winning, hash, begin[0].r.lease_token];
  }));
  const allowances = await Promise.all(workers.slice(0, 2).map((worker, i) => worker.call('sql', {
    sql: 'select zentra_reserve_search_budget($1,$2,$3,$4) r', args: searchLeases[i]
  })));
  assert.deepEqual(allowances.map(rows => rows[0].r).sort(), [-1, 2]);
  assert.equal((await db.query('select used from zentra_audit_search_budgets where user_id=$1 and operation_key=$2', [searchUser, winning])).rows[0].used, 3);
  pass('Search global: two real processes contend for remaining 2 slots; one reserves 2, other pending, total <=3');
  const owner = allowances.findIndex(rows => rows[0].r === 2), waiter = 1 - owner;
  for (let i = 0; i < 2; i++) {
    const settled = await workers[owner].call('sql', { sql: 'select zentra_settle_search_budget($1,$2,$3,$4,$5) r', args: [...searchLeases[owner], 1] });
    assert.equal(settled[0].r, true);
    assert.equal((await db.query('select used from zentra_audit_search_budgets where user_id=$1 and operation_key=$2', [searchUser, winning])).rows[0].used, 2);
  }
  const lastAllowance = await workers[waiter].call('sql', { sql: 'select zentra_reserve_search_budget($1,$2,$3,$4) r', args: searchLeases[waiter] });
  assert.equal(lastAllowance[0].r, 1);
  assert.equal((await workers[waiter].call('sql', { sql: 'select zentra_settle_search_budget($1,$2,$3,$4,$5) r', args: [...searchLeases[waiter], 1] }))[0].r, true);
  pass('Search global: actual-call settlement idempotent, unused slot can fund one retry/social call, never a fourth');
  const resumedWorker = await child(config); workers.push(resumedWorker);
  const resumedHash = crypto.createHash('sha256').update('resume-after-three-searches').digest('hex');
  const resumedBegin = (await resumedWorker.call('sql', { sql: 'select zentra_begin_search($1,$2,$3,$4,$5) r',
    args: ['alice', 'alice@example.test', 'subscription', winning, resumedHash] }))[0].r;
  assert.equal((await resumedWorker.call('sql', { sql: 'select zentra_reserve_search_budget($1,$2,$3,$4) r',
    args: [searchUser, winning, resumedHash, resumedBegin.lease_token] }))[0].r, 0);
  assert.equal((await resumedWorker.call('sql', { sql: 'select zentra_settle_search_budget($1,$2,$3,$4,$5) r',
    args: [searchUser, winning, searchLeases[owner][2], uuid(), 0] }))[0].r, false);
  pass('Search global: newly started worker/resume retains exhausted budget; stale lease cannot refund');

  await reset(0,'pro');
  const uncertainSearchId=uuid();
  assert.equal((await reservedAudit(workers[0],uncertainSearchId)).status,200);
  const searchWorker=await child(config);workers.push(searchWorker);
  const domain=searchBody(uncertainSearchId).siteDomain;
  await searchWorker.call('hold-search',{domain});
  const dyingSearch=post(searchWorker,searchBody(uncertainSearchId),'alice','/api/audit/competitive-search').catch(()=>({status:0}));
  await until(async()=> (await searchWorker.call('metrics')).search[domain]===1);
  const initialSearch=(await db.query('select * from zentra_search_requests where operation_key=$1',[uncertainSearchId])).rows[0];
  assert.ok(initialSearch.provider_started_at);
  const searchDeath=new Promise(resolve=>searchWorker.process.once('exit',resolve));searchWorker.process.kill('SIGKILL');await searchDeath;await dyingSearch;
  await db.query("update zentra_search_requests set lease_until=now()-interval '1 second' where operation_key=$1",[uncertainSearchId]);
  const uncertainSearchReply=await post(workers[1],searchBody(uncertainSearchId),'alice','/api/audit/competitive-search');
  assert.equal(uncertainSearchReply.status,409);assert.match(uncertainSearchReply.text,/execution_uncertain/);
  const retainedSearch=(await db.query('select * from zentra_search_requests where operation_key=$1',[uncertainSearchId])).rows[0];
  assert.equal(retainedSearch.lease_token,initialSearch.lease_token);assert.equal(retainedSearch.state,'running');
  assert.equal((await account()).audits_used,1);
  assert.equal((await db.query('select used from zentra_audit_search_budgets where operation_key=$1', [uncertainSearchId])).rows[0].used, 3);
  pass('E/L: search supplier started then SIGKILL/expired: another process cannot regenerate, even with a local cache');

  await db.query("insert into users(email,auth_user_id,plan,plan_type,audit_credits) values('alice@example.test','alice','pro','audit',1)");
  const paidIds = [uuid(), uuid()];
  const paid = await Promise.all(paidIds.map((id, i) => reservedAudit(workers[i], id, 'audit')));
  assert.equal(paid.filter(value => value.status === 200).length, 1);
  assert.equal(paid.filter(value => value.status === 403).length, 1);
  const paidUser = await account('alice', 'audit');
  assert.equal(paidUser.audit_credits_used, 1); assert.equal(paidUser.audits_used, 0);
  assert.equal(await totalCalls(paidIds[0]) + await totalCalls(paidIds[1]), 1);
  for (const id of paidIds) {
    const s = await state(id, 'alice', 'audit');
    assert.equal(s.requests.length, s.receipts.length);
  }
  pass('paid Audit last credit across processes: one supplier/receipt; subscription isolated');

  // Force a lost heartbeat while the original supplier is still alive. No real 5-minute wait.
  await reset(0);
  const expired = uuid();
  const oldAttempt = post(workers[0], root(expired, { fixture_hold: true }));
  await until(async () => await totalCalls(expired) > 0);
  const oldState = await state(expired);
  await db.query("update zentra_requests set lease_until=now()-interval '1 second' where user_id=$1 and operation_key=$2",
    [oldState.user.id, expired]);
  const newAttempt = await post(workers[1], root(expired, { fixture_hold: true }));
  assert.equal(newAttempt.status,409); assert.match(newAttempt.text,/execution_uncertain/);
  assert.equal(await totalCalls(expired),1);
  const uncertain = await state(expired);
  assert.equal(uncertain.requests[0].lease_token,oldState.requests[0].lease_token);
  assert.equal(uncertain.user.actions_used,1);
  assert.equal(uncertain.receipts[0].refunded_at,null);
  await workers[0].call('release', { operation: expired });
  const oldReply = await oldAttempt;
  assert.equal(oldReply.status, 200); assert.match(oldReply.text, /Contenido util/);
  assert.equal((await state(expired)).requests[0].state,'done');
  assert.equal((await account()).actions_used,1);
  pass('A: provider-started expiry cannot take over; original owner reconciles late response, debit preserved');

  await reset(0);
  const lostTransport=uuid(),lostBody=root(lostTransport,{fixture_transport_loss:true});
  const lostReply=await post(workers[0],lostBody);
  assert.equal(lostReply.status,503);assert.match(lostReply.text,/execution_uncertain/);
  assert.equal((await state(lostTransport)).requests[0].state,'running');
  assert.equal((await state(lostTransport)).receipts[0].refunded_at,null);
  assert.equal((await post(workers[1],lostBody)).status,425);
  await db.query("update zentra_requests set lease_until=now()-interval '1 second' where operation_key=$1",[lostTransport]);
  assert.equal((await post(workers[1],lostBody)).status,409);
  assert.equal(await totalCalls(lostTransport),1);assert.equal((await account()).actions_used,1);
  pass('A/L: actual provider wrapper loses transport: controlled uncertain, no failure/refund/re-generation across processes');

  // Safe takeover before the first supplier call must fence every old-token mutation.
  await reset(0);
  const safe=uuid();
  const safeOld=post(workers[0],root(safe,{fixture_hold_before:true}));
  await until(async()=> (await state(safe)).requests.length===1);
  const safeState=await state(safe);
  assert.equal(safeState.requests[0].provider_started_at,null);
  await db.query("update zentra_requests set lease_until=now()-interval '1 second' where operation_key=$1",[safe]);
  const safeNew=post(workers[1],root(safe,{fixture_hold_before:true}));
  await until(async()=> (await state(safe)).requests[0].lease_token!==safeState.requests[0].lease_token);
  assert.equal((await finish(workers[0],safeState,false))[0].r.accepted,false);
  assert.equal((await finish(workers[0],safeState,true))[0].r.accepted,false);
  assert.equal((await state(safe)).receipts[0].refunded_at,null);
  await workers[1].call('release',{operation:safe});assert.equal((await safeNew).status,200);
  await workers[0].call('release',{operation:safe});assert.equal((await safeOld).status,503);
  assert.equal(await totalCalls(safe),1);
  assert.equal((await state(safe)).requests[0].state,'done');
  pass('B/C: safe pre-provider takeover rotates token; stale worker cannot start, refund, commit or deliver');

  await reset(0);
  const partial=uuid();
  const partialPending=post(workers[0],root(partial,{fixture_hold:true,fixture_checkpoint:true}));
  await until(async()=> (await state(partial)).requests[0]?.useful_response===true);
  const partialState=await state(partial);
  await db.query("update zentra_requests set lease_until=now()-interval '1 second' where operation_key=$1",[partial]);
  const blockedPartial=await post(workers[1],root(partial,{fixture_hold:true,fixture_checkpoint:true}));
  assert.equal(blockedPartial.status,409);assert.equal(await totalCalls(partial),1);
  const partialFail=(await finish(workers[0],partialState,false))[0].r;
  assert.equal(partialFail.accepted,true);assert.equal(partialFail.refunded,false);
  const savedPartial=await state(partial);
  assert.equal(savedPartial.user.actions_used,1);assert.equal(savedPartial.requests[0].state,'done');
  assert.match(savedPartial.requests[0].response.text,/Contenido util/);
  await workers[0].call('release',{operation:partial});await partialPending;
  const partialReplay=await post(workers[1],root(partial,{fixture_hold:true,fixture_checkpoint:true}));
  assert.equal(partialReplay.status,200);assert.equal(await totalCalls(partial),1);
  pass('D: persisted useful content plus expiry/failure cannot refund; cached partial never regenerates');

  await reset(0);
  const renewed=uuid();
  const longRunning=post(workers[0],root(renewed,{fixture_hold:true}));
  await until(async()=> await totalCalls(renewed)===1);
  const renewState=await state(renewed), renewReq=renewState.requests[0];
  await db.query("update zentra_requests set lease_until=now()-interval '1 second' where operation_key=$1",[renewed]);
  const renewal=await workers[0].call('sql',{sql:'select zentra_renew_request($1,$2,$3,$4) r',
    args:[renewState.user.id,renewed,renewReq.request_hash,renewReq.lease_token]});
  assert.equal(renewal[0].r,true);
  await db.query("update zentra_requests set lease_until=now()-interval '1 second' where operation_key=$1",[renewed]);
  await until(async()=>new Date((await state(renewed)).requests[0].lease_until).getTime()>Date.now(),40000);
  const liveReply=await post(workers[1],root(renewed,{fixture_hold:true}));
  assert.equal(liveReply.status,425);assert.equal(await totalCalls(renewed),1);
  assert.equal((await state(renewed)).requests[0].lease_token,renewReq.lease_token);
  await workers[0].call('release',{operation:renewed});await longRunning;
  pass('J: actual 30-second heartbeat + conditional PostgreSQL renewal preserve long-running ownership and prevent takeover');

  for(const started of [false,true]) {
    await reset(0);
    const dying=await child(config);workers.push(dying);
    const deadId=uuid(), fixture=started?{fixture_hold:true}:{fixture_hold_before:true};
    const killedRequest=post(dying,root(deadId,fixture)).catch(()=>({status:0}));
    await until(async()=> started ? (await dying.call('metrics')).provider[deadId]===1 : (await state(deadId)).requests.length===1);
    const deadState=await state(deadId);
    assert.equal(Boolean(deadState.requests[0].provider_started_at),started);
    const died=new Promise(resolve=>dying.process.once('exit',resolve));dying.process.kill('SIGKILL');await died;await killedRequest;
    await db.query("update zentra_requests set lease_until=now()-interval '1 second' where operation_key=$1",[deadId]);
    if(started) {
      const afterDeath=await post(workers[1],root(deadId,fixture));
      assert.equal(afterDeath.status,409);assert.match(afterDeath.text,/execution_uncertain/);
      assert.equal(await totalCalls(deadId),0);
      assert.equal((await state(deadId)).requests[0].lease_token,deadState.requests[0].lease_token);
      assert.equal((await state(deadId)).receipts[0].refunded_at,null);
      assert.equal((await state(deadId)).user.actions_used,1);
      pass('L: SIGKILL after provider-started keeps uncertain/debit, surviving process performs no supplier call');
    } else {
      const resumed=post(workers[1],root(deadId,fixture));
      await until(async()=> (await state(deadId)).requests[0].lease_token!==deadState.requests[0].lease_token);
      assert.equal((await finish(workers[0],deadState,false))[0].r.accepted,false);
      await workers[1].call('release',{operation:deadId});assert.equal((await resumed).status,200);
      assert.equal(await totalCalls(deadId),1);assert.equal((await state(deadId)).user.actions_used,1);
      pass('K: SIGKILL before provider-started safely resumes once with rotated ownership');
    }
  }

  // Auth + atomic acquisition precedes the actual frontend read callback, across two servers.
  await reset(0,'pro');await db.query("update users set audits_used=9 where auth_user_id='alice' and plan_type='subscription'");
  const acquiredIds=[uuid(),uuid()];
  const acquisitions=await Promise.all(acquiredIds.map((id,i)=>post(workers[i],{
    zentra_operation:{id,product:'subscription',source:audit.calls[0].zentra_audit_workflow.pageData.url}
  },'alice','/api/audit/reserve')));
  assert.equal(acquisitions.filter(r=>r.status===200).length,1);assert.equal(acquisitions.filter(r=>r.status===403).length,1);
  const winnerIndex=acquisitions.findIndex(r=>r.status===200), winnerId=acquiredIds[winnerIndex];
  const winnerLease=JSON.parse(acquisitions[winnerIndex].text).lease_token;
  const acquiredReply=await post(workers[winnerIndex],{...auditBody(winnerId),zentra_acquisition:{token:winnerLease}});
  assert.equal(acquiredReply.status,200,acquiredReply.text);
  assert.equal((await account()).audits_used,10);assert.equal(await totalCalls(winnerId),1);
  assert.equal((await state(acquiredIds[1-winnerIndex])).requests.length,0);
  assert.equal((await state(acquiredIds[1-winnerIndex])).receipts.length,0);
  const acquiredReplay=await post(workers[1-winnerIndex],{...auditBody(winnerId),zentra_acquisition:{token:winnerLease}});
  assert.equal(acquiredReplay.status,200);assert.equal(await totalCalls(winnerId),1);
  pass('F/I: last Audit acquired before generation; losing operation performs zero IA/search; handoff/replay reuse single debit');

  await reset(0,'pro');await db.query("update users set audits_used=9 where auth_user_id='alice' and plan_type='subscription'");
  const chromeDir=backend+'/../publicacion/chrome-store/zentra-ai-chrome-store-clean';
  const frontendSource=await readFile(chromeDir+'/zentra-api-client.js','utf8');
  const generatorSource=await readFile(chromeDir+'/claude-pdf-generator.js','utf8');
  const frontends=workers.slice(0,2).map(worker=>{
    const dom=new JSDOM('<!doctype html><body></body>',{url:'https://audit.test',runScripts:'outside-only'});
    const w=dom.window, counts={crawl:0,ia:0,search:0}, storage={};
    const source=audit.calls[0].zentra_audit_workflow.pageData.url;
    w.Response=Response;w.Headers=Headers;
    w.fetch=(url,options)=>fetch(String(url).replace('https://zentra-backend-v2.onrender.com',worker.url),options);
    w.supabaseClient={auth:{getSession:async()=>({data:{session:{access_token:'alice'}}})}};
    w.chrome={runtime:{getManifest:()=>({name:'Zentra AI'}),sendMessage:async request=>{
      if (['beginAuditCrawl','endAuditCrawl'].includes(request.action)) return { success: true };
      counts.crawl++;return {success:true,page:{url:source}};
    }},tabs:{get:async()=>({id:1,url:source})},storage:{local:{
      get(_key,cb){cb(storage);},set(data,cb){Object.assign(storage,data);cb();},remove(key,cb){delete storage[key];cb();}
    }}};
    w.console={log(){}};w.jspdf={jsPDF:class{}};
    w.zentraSubscription={getUserState:async()=>({plan:'pro'}),consumeAudit:async()=>{}};
    w.claudeAI={getStatus:async()=>({isReady:true}),getAuditScope:()=>({totalPages:7}),analyzeSEO:async()=>{
      counts.ia++;
      const response=await w.zentraApiFetch('https://zentra-backend-v2.onrender.com/api/chat',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(auditBody(uuid()))
      });
      assert.equal(response.status,200);await response.json();
      return {success:true,analysis:{recommendations:[],keywords:{}}};
    }};
    w.eval(frontendSource);w.eval(generatorSource);
    const generator=w.claudePDFGenerator;
    generator.collectPageData=async()=>{counts.crawl++;return {url:source};};
    generator.showProgressIndicator=()=>{};generator.hideProgressIndicator=()=>{};generator.updateAuditPhase=()=>{};
    generator.updateProgress=async()=>true;generator.createPDF=async()=>new w.Blob(['fixture']);generator.downloadPDF=async()=>1;
    return {dom,generator,counts};
  });
  try {
    await Promise.all(frontends.map(f=>f.generator.generateAIReport(1)));
    const active=frontends.filter(f=>f.counts.ia===1), rejected=frontends.filter(f=>f.counts.ia===0);
    assert.equal(active.length,1);assert.equal(rejected.length,1);
    assert.equal(active[0].counts.crawl,2);assert.deepEqual(rejected[0].counts,{crawl:0,ia:0,search:0});
    assert.equal((await account()).audits_used,10);
    pass('F: actual Chrome generator + transport against two processes: losing frontend has zero crawl, read, IA or search');
  } finally {for(const f of frontends) f.dom.window.close();}

  await reset(0,'pro');await db.query("update users set audits_used=9 where auth_user_id='alice' and plan_type='subscription'");
  const abandoned=uuid();
  const abandonedReply=await post(workers[0],{zentra_operation:{id:abandoned,product:'subscription',source:'https://acquisition.test/'}},'alice','/api/audit/reserve');
  assert.equal(abandonedReply.status,200);
  const abandonedLease=JSON.parse(abandonedReply.text).lease_token;
  await db.query("update zentra_audit_acquisitions set lease_until=now()-interval '1 second' where operation_key=$1",[abandoned]);
  const nextAcquisition=uuid();
  const newAcquisition=await post(workers[1],{zentra_operation:{id:nextAcquisition,product:'subscription',source:'https://acquisition.test/'}},'alice','/api/audit/reserve');
  assert.equal(newAcquisition.status,200,newAcquisition.text);
  assert.ok((await state(abandoned)).receipts[0].refunded_at);
  const oldRelease=await post(workers[0],{zentra_operation:{id:abandoned,product:'subscription'},lease_token:abandonedLease},'alice','/api/audit/release');
  assert.equal(JSON.parse(oldRelease.text).released,false);
  assert.equal((await account()).audits_used,10);
  const nextLease=JSON.parse(newAcquisition.text).lease_token;
  const released=await Promise.all(workers.slice(0,2).map(w=>post(w,{zentra_operation:{id:nextAcquisition,product:'subscription'},lease_token:nextLease},'alice','/api/audit/release')));
  assert.equal(released.filter(r=>JSON.parse(r.text).released).length,1);assert.equal((await account()).audits_used,9);
  pass('H/K: abandoned pre-IA acquisition returns quota once; old holder cannot refund a new acquisition');
  const exposed=(await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'zentra_%' and
    (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))`)).rows;
  assert.deepEqual(exposed,[]);
  pass('new provider/search/acquisition RPCs remain service-role-only; no public quota/refund/ownership path');
  await reset(0, 'agency');
  const httpWorkers = await Promise.all([child(config, '10'), child(config, '10')]);
  workers.push(...httpWorkers);
  const rateIds = Array.from({ length: 20 }, uuid);
  const rateReplies = await Promise.all(rateIds.map((id, i) => post(httpWorkers[i % 2], root(id))));
  assert.equal(rateReplies.filter(r => r.status === 200).length, 10);
  assert.equal(rateReplies.filter(r => r.status === 429).length, 10);
  assert.equal((await account()).actions_used, 10);
  const rateMetrics = await Promise.all(httpWorkers.map(w => w.call('metrics')));
  assert.equal(rateMetrics.reduce((sum, m) => sum + Object.values(m.provider).reduce((a, n) => a + n, 0), 0), 10);
  for (let i = 0; i < rateIds.length; i++) if (rateReplies[i].status === 429) {
    const rejected = await state(rateIds[i]);
    assert.equal(rejected.receipts.length, 0); assert.equal(rejected.requests.length, 0);
  }
  pass('HTTP rate: two Node processes, 20 requests / limit 10; exactly 10 providers/debits, rejected requests have zero reservations');
  console.log('TOTAL', passed, 'quota groups PASS');
} finally {
  if (db) await db.query('rollback').catch(() => {});
  for (const worker of workers) {
    if (!worker.process.connected) continue;
    await worker.call('stop').catch(() => worker.process.kill());
  }
  if (db) await db.end();
  await pg.stop();
}
