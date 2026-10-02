import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const backend = process.env.ZENTRA_BACKEND_DIR;
const { createLemonHandlers } = await import(pathToFileURL(backend + '/release-lemon.js'));
const { auditEntitlement } = await import(pathToFileURL(backend + '/release-entitlements.js'));
const source = await readFile(backend + '/server.js', 'utf8');
const products = vm.runInNewContext(source.slice(source.indexOf('const LEMON_PRODUCTS = {'),
  source.indexOf('\nfunction getPlanFromLemonKey')) + '\nLEMON_PRODUCTS');
const env = {
  SUPABASE_URL: 'https://qfwmjgoiwketpkuhvixm.supabase.co',
  RENDER_EXTERNAL_HOSTNAME: 'zentra-backend-v2-staging.onrender.com'
};
const userId = '0f45490e-8049-4af6-8dd8-089628738cef';
const row = { plan: 'starter', status: 'active', actions_used: 10, audits_used: 1,
  premium_chat_used: 3, premium_pdf_used: 0, billing_cycle_start: Date.now() };
let passes = 0;
async function check(name, overrides = {}, options = {}, expected = 503) {
  let nextCalls = 0, status = 200, body;
  const calls = [];
  const before = structuredClone(row);
  const handlers = createLemonHandlers({ products, env: { ...env, ...overrides },
    client: { async rpc(name, args) {
      calls.push({ name, args });
      return { data: options.target === undefined ? { unverified: true } : options.target };
    } },
    fetchImpl() { throw new Error('No provider request allowed'); } });
  await handlers.reconcile({ path: '/api/subscription/usage', query: options.query || {},
    auth: options.noAuth ? null : { userId: options.userId || userId }, body: options.body || {} },
  { status(value) { status = value; return this; }, json(value) { body = value; } },
  () => { nextCalls++; });
  assert.equal(status, expected, name);
  assert.equal(nextCalls, expected === 200 ? 1 : 0, name);
  if (expected === 503 && !options.target) assert.equal(body.code, 'billing_association_required');
  assert.deepEqual(row, before, 'no writes/reset of usage or billing cycle');
  if (!options.noAuth) assert.equal(calls[0].args.p_auth, options.userId || userId);
  assert.ok(calls.every(call => !/event|checkout/.test(call.name)));
  console.log('PASS', name); passes++;
}
await check('exact staging fixture reaches authoritative users.plan', {}, {}, 200);
await check('production Supabase cannot bypass', { SUPABASE_URL: 'https://production.supabase.co' });
await check('production Render cannot bypass', { RENDER_EXTERNAL_HOSTNAME: 'zentra-backend-v2.onrender.com' });
await check('missing Render guard cannot bypass', { RENDER_EXTERNAL_HOSTNAME: undefined });
await check('missing Supabase guard cannot bypass', { SUPABASE_URL: undefined });
await check('another staging user cannot bypass', {}, { userId: 'another-user' });
await check('forged query/body identity cannot bypass', {}, { userId: 'another-user',
  query: { user_id: userId }, body: { userId } });
await check('unauthenticated caller does not receive entitlement exception', {}, { noAuth: true }, 200);
await check('linked/busy subscription still blocked', {}, { target: { busy: true } });
await check('normal Free/no reconciliation still passes', {}, { target: null }, 200);
const limits = vm.runInNewContext(source.slice(source.indexOf('const PLAN_LIMITS = {'),
  source.indexOf('const PREMIUM_LIMITS = {')) + '\nPLAN_LIMITS');
assert.equal(limits.starter.actions, 300);
assert.equal(limits.starter.audits, 5);
assert.equal(auditEntitlement(row).maxPages, 5);
console.log('PASS Starter limits remain 300/5/5; counters 10/1/3/0 preserved');
console.log(`${++passes} groups passed`);
