import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { auditFixture } from './audit-fixtures.mjs';

const base = process.env.ZENTRA_BASE;
const backend = base + '/zentra-backend';
const current = await readFile(backend + '/server.js', 'utf8');
const published = execFileSync('git', ['show', '5adc7635f69042fe8cf343e756033c192f25bead:server.js'], { cwd: backend, encoding: 'utf8' });
let count = 0;
const pass = name => { count++; console.log('PASS', name); };
function fn(source, name) {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n(?:async )?function /);
  assert.ok(end >= 0, name + ' boundary');
  return rest.slice(0, end + 1);
}

const identity = vm.createContext({ normalizeEmail: value => String(value || '').toLowerCase() });
vm.runInContext(fn(current, 'getIdentityFromRequest') + '\n' + fn(current, 'getEmailFromChatRequest') + '\n' + fn(current, 'getPlanTypeFromChatRequest'), identity);
const forged = { body: { user_id: 'victim', email: 'victim@test', zentra_plan_type: 'audit' }, query: { user_id: 'victim' },
  auth: { userId: 'verified', email: 'verified@test' }, operation: { product: 'subscription' } };
assert.equal(identity.getIdentityFromRequest(forged).userId, 'verified');
assert.equal(identity.getEmailFromChatRequest(forged), 'verified@test');
assert.equal(identity.getPlanTypeFromChatRequest(forged), 'subscription');
assert.throws(() => identity.getIdentityFromRequest({ body: forged.body }));
pass('actual server identity functions: body/query/routing cannot replace verified identity or reserved product');
const consume = vm.createContext({ normalizeIdentityInput: value => value,
  normalizeAdvancedChatCounterKey: value => value, operationContext: { getStore: () => null } });
vm.runInContext(fn(current, 'consumeSubscriptionUsage') + '\n' + fn(current, 'consumeAuditCredit'), consume);
assert.equal((await consume.consumeSubscriptionUsage({ userId: 'fixture' })).reason, 'generation_required');
assert.equal((await consume.consumeAuditCredit()).reason, 'generation_required');
for (const dir of ['publicacion/chrome-store/zentra-ai-chrome-store-clean','ZENTRA AUDIT/ZENTRA_AUDIT_v1.0.0']) {
  const source = await readFile(base + '/' + dir + '/subscription-manager.js', 'utf8');
  if (dir.includes('chrome-store')) assert.ok(/async consumeAction\(\)\s*\{\s*return this\.getUserState\(true\);\s*\}/.test(source),dir);
  assert.ok(/async consumeAudit\(\)\s*\{\s*return this\.getUserState\(true\);\s*\}/.test(source),dir);
}
pass('actual separate consume functions deny without generation; Chrome legacy consume only refreshes usage');

const rawBody = Buffer.from('{"meta":{"event_name":"subscription_updated"}}');
const signing = vm.createContext({ crypto, Buffer, LEMON_WEBHOOK_SECRET: 'fixture-signing-key' });
vm.runInContext(fn(current, 'verifyLemonSignature'), signing);
const signature = crypto.createHmac('sha256', 'fixture-signing-key').update(rawBody).digest('hex');
assert.equal(signing.verifyLemonSignature({ rawBody, get: () => signature }), true);
assert.equal(signing.verifyLemonSignature({ rawBody: Buffer.from('altered'), get: () => signature }), false);
assert.equal(signing.verifyLemonSignature({ rawBody, get: () => '' }), false);
assert.equal(signing.verifyLemonSignature({ rawBody, get: () => 'abcd' }), false);
assert.equal(signing.verifyLemonSignature({ rawBody, get: () => signature + 'junk' }), false);
assert.equal(signing.verifyLemonSignature({ rawBody, get: () => signature + 'aa' }), false);
pass('actual webhook signature: valid accepted; altered/missing/short/trailing garbage rejected');

// Reproduce the deployed read/modify/write race without calling production.
let stored = { id: 'fixture-user', email: 'fixture@test', plan: 'starter', status: 'active', actions_used: 299 };
let reads = 0;
let release;
const bothRead = new Promise(resolve => { release = resolve; });
const old = vm.createContext({
  normalizeIdentityInput: value => value, hasUnlimitedAgencyOverride: () => false,
  normalizeAdvancedChatCounterKey: value => value, normalizeCounterValue: value => Number(value) || 0,
  ensureFreshSubscriptionUsage: async () => { const snapshot = { ...stored }; if (++reads === 2) release(); await bothRead; return snapshot; },
  formatSubscriptionUsage: () => ({ base_actions_limit: 300, base_audits_limit: 5 }),
  upsertUserAccess: async value => { stored = { ...value }; return { ...stored }; },
  console: { log() {} }
});
vm.runInContext(fn(published, 'consumeSubscriptionUsage'), old);
const race = await Promise.all([old.consumeSubscriptionUsage({ email: 'fixture@test' }), old.consumeSubscriptionUsage({ email: 'fixture@test' })]);
assert.equal(race.filter(result => result.allowed).length, 2);
assert.equal(stored.actions_used, 300);
pass('published 5adc763 counter race reproduced: two allowed at 299/300, persisted counter only 300');

for (const [dir, name, product] of [
  ['publicacion/chrome-store/zentra-ai-chrome-store-clean', 'Zentra AI', 'subscription'],
  ['ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab', 'Zentra AI', 'subscription'],
  ['ZENTRA AUDIT/ZENTRA_AUDIT_v1.0.0', 'Zentra Audit', 'audit']
]) {
  const requests = [];
  const context = vm.createContext({ window: { supabaseClient: { auth: { getSession: async () => ({ data: { session: { access_token: 'fixture-session' } } }) } } },
    chrome: { runtime: { getManifest: () => ({ name }), sendMessage: async () => ({ success: true }) } }, URL, Headers, Response, crypto: globalThis.crypto, setTimeout, setInterval, clearInterval,
    fetch: async (url, options) => { requests.push({ url, options }); return new Response('{}'); } });
  vm.runInContext(await readFile(base + '/' + dir + '/zentra-api-client.js', 'utf8'), context);
  const id = crypto.randomUUID();
  context.window.zentraOperations.begin('audit', 'https://business.test/', id);
  await context.window.zentraApiFetch('https://zentra-backend-v2.onrender.com/api/chat', {
    method: 'POST', body: JSON.stringify({ task_type: 'seo_analysis', messages: [{ role: 'user', content: 'Audit' }] }) });
  await context.window.zentraApiFetch('https://zentra-backend-v2.onrender.com/api/audit/competitive-search', {
    method: 'POST', body: JSON.stringify({ queries: ['software'], scope: 'web', siteDomain: 'business.test' }) });
  assert.equal(JSON.parse(requests[0].options.body).zentra_operation.id, id);
  assert.deepEqual(JSON.parse(requests[1].options.body).zentra_operation, { id, product });
  assert.equal(requests[1].options.headers.get('Authorization'), 'Bearer fixture-session');
  assert.equal(requests[1].options.redirect, 'error');
  await assert.rejects(context.window.zentraApiFetch('https://foreign.test/api/chat'));
  context.window.zentraOperations.end('audit');
  await context.window.zentraApiFetch('https://zentra-backend-v2.onrender.com/api/audit/competitive-search', { body: '{}' });
  assert.equal(JSON.parse(requests[2].options.body).zentra_operation, undefined);
  pass(dir + ': search transport bound to active audit, credentials restricted, end unchanged');
  context.fetch=async()=>new Response(JSON.stringify({error:'Pending supplier outcome',code:'execution_uncertain'}),{status:409});
  await assert.rejects(context.window.zentraApiFetch('https://zentra-backend-v2.onrender.com/api/chat',{
    method:'POST',body:JSON.stringify({task_type:'seo_analysis',messages:[{role:'user',content:'Audit'}]})
  }),error=>error.code==='execution_uncertain');
  let polls=0;
  context.setTimeout=fn=>fn();context.fetch=async()=>{polls++;return new Response('{}',{status:425});};
  await assert.rejects(context.window.zentraApiFetch('https://zentra-backend-v2.onrender.com/api/chat',{
    method:'POST',body:JSON.stringify({task_type:'seo_analysis',messages:[{role:'user',content:'Audit'}]})
  }),error=>error.code==='execution_pending');
  assert.equal(polls,90);
  pass(dir + ': uncertain and existing in-progress polling retain typed Audit state, no new retry loop');
}

const { buildAuditSearchRequests, createAuditSearchGuard } = await import(pathToFileURL(backend + '/release-audit-steps.js'));
const fixture = await auditFixture(base + '/publicacion/chrome-store/zentra-ai-chrome-store-clean', 'pro', {
  pageOverride: { title: 'Partner management software', h1s: ['Partner management software'], metaDescription: 'Partner relationship management software' }
});
const root = { body: fixture.calls[0], context: fixture.calls[0].zentra_audit_workflow, created_at: new Date().toISOString() };
const steps = [{ step_name: 'seo_analysis', state: 'done', response: { body: { response: JSON.parse(fixture.outputs.seo_analysis) } } }];
const requests = await buildAuditSearchRequests(root, steps);
assert.ok(requests.length > 0 && requests.length <= 2);
assert.deepEqual(requests[0].queries, fixture.calls[1].zentra_audit_evidence.queries);
assert.deepEqual(await buildAuditSearchRequests(root, [{ ...steps[0], state: 'in_progress' }]), []);
assert.deepEqual(await buildAuditSearchRequests(root, [{ ...steps[0], response: { body: { response: { consultativeStatus: 'consultative-degraded', summary: 'No disponible' },
  audit_consultative: { status: 'consultative-degraded' } } } }]), []);
const weak = await auditFixture(base + '/publicacion/chrome-store/zentra-ai-chrome-store-clean');
assert.deepEqual(await buildAuditSearchRequests({ body: weak.calls[0], context: weak.calls[0].zentra_audit_workflow }, steps), []);
pass('search replay: exact frozen queries, no live crawl/provider; running/degraded/weak topic cannot authorize search');
let reached = false;
let status;
const res = { status(value) { status = value; return this; }, json() { return this; } };
const authorize = createAuditSearchGuard({ client: { rpc: async () => ({ data: { root: { ...root, created_at: '2000-01-01' }, steps } }) } });
await authorize({ auth: { userId: 'fixture', email: 'fixture@test' }, body: { zentra_operation: { id: crypto.randomUUID(), product: 'subscription' } } }, res, () => { reached = true; });
assert.equal(status, 403); assert.equal(reached, false);
pass('expired audit cannot authorize further paid searches');

let starts=0,supplierCalls=0;
const activeOperation={startProvider:async()=>{starts++;}};
const supplier=vm.createContext({operationContext:{getStore:()=>activeOperation},normalizeProvider:value=>value,
  callOpenAI:async()=>{supplierCalls++;throw new Error('simulated lost transport');}});
vm.runInContext(fn(current,'callAiProvider'),supplier);
await assert.rejects(supplier.callAiProvider({provider:'openai'}),/lost transport/);
assert.equal(activeOperation.externalUncertain,true);
await assert.rejects(supplier.callAiProvider({provider:'openai'}),/External result not confirmed/);
assert.equal(starts,1);assert.equal(supplierCalls,1);
pass('actual provider wrapper: lost transport prevents any automatic fallback/regeneration from the same worker');
let responseOK=true;
const decoding=vm.createContext({OPENAI_API_KEY:'fixture-only',shouldUseOpenAIResponsesApi:()=>false,
  buildOpenAIRequestBody:()=>({}),fetch:async()=>({ok:responseOK,status:responseOK?200:502,
    json:async()=>{throw new Error('lost response body');}})});
vm.runInContext(fn(current,'callOpenAI'),decoding);
await assert.rejects(decoding.callOpenAI({model:'fixture',messages:[]}),/lost response body/);
responseOK=false;
assert.equal((await decoding.callOpenAI({model:'fixture',messages:[]})).ok,false);
pass('actual supplier extraction: successful response with lost body is not swallowed; negative HTTP failure remains confirmed');
console.log('TOTAL', count);
