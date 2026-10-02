import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { before, after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import EmbeddedPostgres from './local-postgres.mjs';
import { auditFixture } from './audit-fixtures.mjs';

const backend = process.env.ZENTRA_BACKEND_DIR;
const { createAuditSearchGuard, startSearchLeaseReaper, buildAuditSearchRequests } = await import(pathToFileURL(backend + '/release-audit-steps.js'));
const pg = new EmbeddedPostgres({ databaseDir: '/tmp/zentra-search-lifecycle-' + process.pid,
  user: 'postgres', password: crypto.randomUUID(), port: 55486, persistent: false,
  postgresFlags: ['-h', '127.0.0.1'], onLog() {}, onError() {} });
let db, db2;
before(async () => {
  await pg.initialise(); await pg.start(); db = pg.getPgClient(); await db.connect();
  db2 = pg.getPgClient(); await db2.connect();
  await db.query('create role anon; create role authenticated; create role service_role');
  for (const file of ['supabase-users.sql', 'supabase-release-guard.sql', 'supabase-execution-guard.sql',
    'supabase-search-lifecycle.sql', 'supabase-search-lifecycle.sql']) await db.query(fs.readFileSync(backend + '/' + file, 'utf8'));
});
after(async () => { await db2?.end(); await db?.end(); await pg.stop(); });
async function fixture() {
  const auth = crypto.randomUUID(), op = crypto.randomUUID(), root = 'a'.repeat(64);
  await db.query("insert into users(email,auth_user_id,plan) values($1,$2,'pro')", [auth + '@example.test', auth]);
  const initial = (await db.query("select zentra_begin_request($1,$2,'subscription',$3,$4,$4,'audit',false) r", [auth, auth + '@example.test', op, root])).rows[0].r;
  const user = initial.user.id;
  await db.query('select zentra_finish_request($1,$2,$3,$4,$5,true)', [user, op, root, initial.lease_token, { text: 'Technical report' }]);
  await db.query("insert into zentra_audit_steps(user_id,operation_key,step_name,request_hash,body) values($1,$2,'seo_analysis',$3,'{}')", [user, op, root]);
  const begin = async hash => (await db.query("select zentra_begin_search($1,$2,'subscription',$3,$4) r", [auth, auth + '@example.test', op, hash])).rows[0].r;
  const first = await begin('b'.repeat(64));
  const args = [user, op, 'b'.repeat(64), first.lease_token];
  const reserve = (connection = db, a = args) => connection.query('select zentra_reserve_search_budget($1,$2,$3,$4) r', a).then(v => v.rows[0].r);
  const settle = actual => db.query('select zentra_settle_search_budget($1,$2,$3,$4,$5) r', [...args, actual]).then(v => v.rows[0].r);
  const finish = (success = false, connection = db, a = args) => connection.query('select zentra_finish_search($1,$2,$3,$4,$5,$6) r', [...a, { status: success ? 200 : 502, value: { results: [] } }, success]).then(v => v.rows[0].r);
  const state = () => db.query('select state,attempts,provider_started_at,lease_until from zentra_search_requests where user_id=$1 and operation_key=$2 and request_hash=$3', args.slice(0, 3)).then(v => v.rows[0]);
  const budget = () => db.query('select used from zentra_audit_search_budgets where user_id=$1 and operation_key=$2', args.slice(0, 2)).then(v => v.rows[0]?.used || 0);
  const expire = () => db.query("update zentra_search_requests set lease_until=now()-interval '1 second' where user_id=$1 and operation_key=$2", args.slice(0, 2));
  const reap = (connection = db) => connection.query('select zentra_reap_search_leases($1) r', [user]).then(v => v.rows[0].r);
  return { user, op, args, begin, reserve, settle, finish, state, budget, expire, reap };
}
test('confirmed complete usage settles real calls, caches result and preserves global maximum 3', async () => {
  const f = await fixture(); assert.equal(await f.reserve(), 3);
  assert.equal(await f.settle(1), true); assert.equal(await f.finish(true), true);
  assert.equal((await f.state()).state, 'done'); assert.equal(await f.budget(), 1);
  assert.equal((await f.begin(f.args[2])).cached, true);
  const second = await f.begin('c'.repeat(64));
  assert.equal(await f.reserve(db, [f.user, f.op, 'c'.repeat(64), second.lease_token]), 2);
  assert.equal(await f.budget(), 3);
});
test('timeout/HTTP failure after provider start becomes terminal uncertain, never releases slots or regenerates', async () => {
  const f = await fixture(); await f.reserve();
  assert.equal(await f.finish(false), true);
  assert.equal((await f.state()).state, 'execution_uncertain'); assert.equal(await f.budget(), 3);
  assert.equal((await f.begin(f.args[2])).reason, 'execution_uncertain');
  assert.equal((await f.state()).attempts, 1);
  const second = await f.begin('c'.repeat(64));
  assert.equal(await f.reserve(db, [f.user, f.op, 'c'.repeat(64), second.lease_token]), 0);
  assert.equal(await f.settle(0), false);
});
test('HTTP 200 incomplete without confirmed usage is not falsely cached as completed', async () => {
  const f = await fixture(); await f.reserve(); await f.finish(true);
  assert.equal((await f.state()).state, 'execution_uncertain'); assert.equal(await f.budget(), 3);
});
test('pre-provider failure and expired unstarted lease may resume with a fenced new lease', async () => {
  const f = await fixture(); await f.finish(false);
  assert.equal((await f.state()).state, 'failed'); assert.equal(await f.budget(), 0);
  const resumed = await f.begin(f.args[2]); assert.ok(resumed.allowed);
  assert.notEqual(resumed.lease_token, f.args[3]);
  assert.equal(await f.finish(false), false);
  assert.equal(await f.reserve(db, [...f.args.slice(0, 3), resumed.lease_token]), 3);
  const abandoned = await fixture(); await abandoned.expire();
  assert.equal(await abandoned.reap(), 1);
  assert.equal((await abandoned.state()).state, 'failed');
  assert.ok((await abandoned.begin(abandoned.args[2])).allowed);
});
test('legacy reservation proven never started releases only that allocation exactly once', async () => {
  const f = await fixture();
  await db.query('insert into zentra_audit_search_budgets(user_id,operation_key,used) values($1,$2,3)', f.args.slice(0, 2));
  await db.query('insert into zentra_search_allocations(user_id,operation_key,request_hash,lease_token,reserved) values($1,$2,$3,$4,3)', f.args);
  await f.expire(); assert.equal(await f.reap(), 1);
  assert.equal(await f.budget(), 0); assert.equal(await f.reap(), 0);
  const a = (await db.query('select actual from zentra_search_allocations where user_id=$1 and operation_key=$2', f.args.slice(0, 2))).rows[0];
  assert.equal(a.actual, 0);
});
test('crash/abandoned provider-started lease is reaped conservatively; live resume is not reaped', async () => {
  const f = await fixture(); await f.reserve();
  assert.equal(await f.reap(), 0); assert.equal((await f.begin(f.args[2])).reason, 'in_progress');
  await f.expire(); assert.equal(await f.reap(), 1);
  assert.equal((await f.state()).state, 'execution_uncertain'); assert.equal(await f.budget(), 3);
  assert.equal(await f.reap(), 0);
});
test('settled response lost before finish retains only confirmed actual, not running forever', async () => {
  const f = await fixture(); await f.reserve(); await f.settle(2); await f.expire(); await f.reap();
  assert.equal((await f.state()).state, 'failed'); assert.equal(await f.budget(), 2);
  const next = await f.begin(f.args[2]); assert.ok(next.allowed);
  assert.equal(await f.reserve(db, [...f.args.slice(0, 3), next.lease_token]), 1);
});
test('concurrent closure/cleanup is idempotent; stale lease cannot settle/finish/start', async () => {
  const f = await fixture(); await f.reserve(); await f.expire();
  await Promise.all([f.finish(false), f.reap(db2)]);
  assert.equal((await f.state()).state, 'execution_uncertain'); assert.equal(await f.budget(), 3);
  assert.equal(await f.finish(false, db, [...f.args.slice(0, 3), crypto.randomUUID()]), false);
  assert.equal(await f.settle(1), false);
  assert.equal((await db.query('select zentra_start_search($1,$2,$3,$4) r', f.args)).rows[0].r, false);
});
test('reaper RPC remains server-only; cleanup does not change Audit or premium counters', async () => {
  const f = await fixture(); await f.reserve(); await f.expire();
  const before = (await db.query('select audits_used,premium_pdf_used from users where id=$1', [f.user])).rows[0];
  await f.reap();
  assert.deepEqual((await db.query('select audits_used,premium_pdf_used from users where id=$1', [f.user])).rows[0], before);
  for (const role of ['anon', 'authenticated']) assert.equal((await db.query("select has_function_privilege($1,'zentra_reap_search_leases(uuid)','execute') ok", [role])).rows[0].ok, false);
});
test('background cleanup runs at startup + every minute, does not overlap and logs counts only', async () => {
  let tick, release, calls = 0; const events = [];
  const blocker = new Promise(resolve => { release = resolve; });
  startSearchLeaseReaper({ client: { async rpc(name, args) {
    assert.equal(name, 'zentra_reap_search_leases'); assert.deepEqual(args, { p_user: null });
    calls++; await blocker; return { data: 1 };
  } }, schedule(fn, interval) { tick = fn; assert.equal(interval, 60000); return { unref() {} }; },
  logger: { log(_label, data) { events.push(data); }, warn() {} } });
  await tick(); assert.equal(calls, 1); release(); await new Promise(resolve => setImmediate(resolve));
  await tick(); assert.equal(calls, 2); assert.deepEqual(events, [{ terminalized: 1 }, { terminalized: 1 }]);
});
test('real Search guard always closes timeout/error/incomplete paths, including storage failure', async () => {
  const f = await auditFixture(backend + '/../publicacion/chrome-store/zentra-ai-chrome-store-clean', 'pro', {
    pageOverride: { title: 'Partner management software', h1s: ['Partner management software'],
      metaDescription: 'Partner relationship management software for teams', textContent: 'Partner management software for teams.' } });
  const root = { body: f.calls[0], context: f.calls[0].zentra_audit_workflow, created_at: new Date().toISOString() };
  const steps = [{ step_name: 'seo_analysis', state: 'done', response: { body: { response: JSON.parse(f.outputs.seo_analysis) } } }];
  const search = (await buildAuditSearchRequests(root, steps))[0]; assert.ok(search);
  for (const [status, confirmedFailure, storageError] of [[502, false, false], [502, true, false], [200, false, false], [502, false, true]]) {
    const names = []; const events = [];
    const client = { async rpc(name) {
      names.push(name);
      if (name === 'zentra_read_audit_steps') return { data: { root, steps } };
      if (name === 'zentra_begin_search') return { data: { allowed: true, user_id: crypto.randomUUID(), lease_token: crypto.randomUUID() } };
      if (name === 'zentra_finish_search') return storageError ? { error: new Error('fixture') } : { data: true };
      throw new Error('Unexpected RPC');
    } };
    const req = { auth: { userId: 'fixture' }, body: { ...search, zentra_operation: { id: crypto.randomUUID(), product: 'subscription' } }, searchConfirmedFailure: confirmedFailure };
    const res = { statusCode: status, status(n) { this.statusCode = n; return this; }, once(name, fn) { events.push(fn); },
      json(body) { this.body = body; events.forEach(fn => fn()); return this; } };
    await createAuditSearchGuard({ client })(req, res, () => res.json({ error: 'fixture' }));
    assert.equal(names.filter(n => n === 'zentra_finish_search').length, 1);
    assert.equal(res.statusCode, storageError ? 503 : status);
  }
});
