import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import vm from 'node:vm';
import EmbeddedPostgres from 'embedded-postgres';

const base = process.env.ZENTRA_BASE;
const backend = process.env.ZENTRA_BACKEND_DIR;
const { PLAN_ENTITLEMENTS, ANNUAL_PLAN_LABEL, auditEntitlement, normalizeEntitlementPlan, validateAuditEntitlement } =
  await import(pathToFileURL(backend + '/release-entitlements.js'));
const { createAuditAcquisitionHandler } = await import(pathToFileURL(backend + '/release-audit-acquisition.js'));
const { prepareAuditStep } = await import(pathToFileURL(backend + '/release-audit-steps.js'));
const expected = {
  free: [20, 1, 3, 0, 0], starter: [300, 5, 5, 12, 10],
  pro: [800, 10, 7, 29, 25], agency: [3000, 30, 11, 99, 83]
};
let count = 0;
const pass = label => { count++; console.log('PASS', label); };
const json = value => JSON.parse(JSON.stringify(value));
const serverSource = await readFile(backend + '/server.js', 'utf8');
const matrix = serverSource.match(/const PLAN_LIMITS = (\{[\s\S]*?\n\});/);
assert.ok(matrix);
const serverMatrix = vm.runInNewContext('(' + matrix[1] + ')');
for (const [plan, values] of Object.entries(expected)) {
  const config = PLAN_ENTITLEMENTS[plan];
  assert.deepEqual([config.actions, config.audits, config.maxPages, config.monthlyPrice, config.annualMonthlyPrice], values);
  assert.deepEqual(json(serverMatrix[plan]), { actions: config.actions, audits: config.audits });
  assert.equal(auditEntitlement({ plan, status: 'active' }, 11).totalPages, values[2]);
  pass(plan + ': canonical actions/audits/pages/prices and oversized request capped');
}
assert.equal(ANNUAL_PLAN_LABEL, 'Pagá 10 meses y usá 12');
assert.equal(auditEntitlement({ plan: 'free', status: 'active' }, 2).totalPages, 2);
assert.equal(auditEntitlement({ plan: 'starter', status: 'active' }, 3).totalPages, 3);
assert.equal(auditEntitlement([{ plan: 'pro', status: 'active' }], 3).totalPages, 3);
assert.equal(auditEntitlement({ plan: 'agency', status: 'cancelled' }).plan, 'free');
assert.throws(() => auditEntitlement('(malformed composite)'));
for (const value of [null, undefined, '', 'enterprise', 'premium', 'constructor', '__proto__', 'toString']) {
  assert.equal(normalizeEntitlementPlan(value), 'free');
  assert.equal(auditEntitlement({ plan: value, status: 'active' }, 11).maxPages, 3);
}
pass('smaller requests, cancelled/unknown plans, malformed authority and PostgREST row shape');

for (const directory of ['publicacion/chrome-store/zentra-ai-chrome-store-clean', 'ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab', 'ZENTRA AUDIT/ZENTRA_AUDIT_v1.0.0']) {
  const path = base + '/' + directory;
  const sandbox = vm.createContext({ window: {}, URL, URLSearchParams,
    localStorage: { getItem() { return null; } }, console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(await readFile(path + '/subscription-manager.js', 'utf8'), sandbox);
  vm.runInContext(await readFile(path + '/claude-integration.js', 'utf8'), sandbox);
  const manager = sandbox.window.zentraSubscription;
  manager.debugUnlimitedFree = false;
  manager.debugPlanOverride = null;
  for (const [plan, [actions, audits, pages]] of Object.entries(expected)) {
    assert.deepEqual(json(manager.getPlanLimits(plan)), { actions, audits });
    assert.equal(sandbox.window.claudeAI.getAuditScope(plan).totalPages, pages);
    for (const invalid of [null, undefined, '', NaN, Infinity, -1, 'bad']) {
      const user = manager.normalizeUser({ plan, actions_limit: invalid, audits_limit: invalid,
        actions_used: invalid, audits_used: invalid, extra_actions_balance: -50, extra_audits_balance: -50 });
      assert.equal(user.actions_used, 0);
      assert.equal(user.audits_used, 0);
      assert.deepEqual(json(manager.getPlanLimits(plan, user)), { actions, audits });
    }
  }
  for (const value of [null, '', 'premium', 'enterprise', 'constructor', '__proto__']) {
    assert.equal(manager.normalizePlan(value), 'free');
    assert.equal(sandbox.window.claudeAI.getAuditScope(value).totalPages, 3);
  }
  const plan = 'starter';
  const overused = manager.normalizeUser({ plan, actions_used: 9999, audits_used: 9999 });
  assert.equal((await manager.canUseAction(overused)).remaining, 0);
  if (!directory.includes('ZENTRA AUDIT')) assert.equal((await manager.canGenerateAudit(overused)).remaining, 0);
  const entitlement = auditEntitlement({ plan: 'free', status: 'active' }, 2);
  sandbox.window.zentraOperations = { getAuditEntitlement: () => entitlement };
  manager.getUserState = async () => ({ plan: 'agency' });
  assert.deepEqual(json(await sandbox.window.claudeAI.resolveAuditScope({})), {
    plan: 'free', totalPages: 2, internalPages: 1, allowsManualSelection: true
  });
  vm.runInContext(await readFile(path + '/claude-pdf-generator.js', 'utf8'), sandbox);
  const generator = sandbox.window.claudePDFGenerator;
  generator.getDefaultBrandLogoDataUrl = async () => 'data:zentra-logo';
  manager.getPDFBranding = async () => ({ brand_name: '', brand_color: '#111111', logo_data_url: 'data:custom-logo' });
  for (const plan of Object.keys(expected)) {
    const branding = await generator.getPDFBrandingContext(plan);
    assert.equal(branding.useCustomBranding, ['pro', 'agency'].includes(plan));
    assert.equal(branding.showGeneratedWith, ['free', 'starter'].includes(plan));
    assert.equal(branding.logoDataUrl, plan === 'agency' ? 'data:custom-logo' : plan === 'pro' ? '' : 'data:zentra-logo');
  }
  const popup = await readFile(path + '/popup.js', 'utf8');
  const scopes = popup.match(/const ZENTRA_SEO_AUDIT_SCOPES = (\{[\s\S]*?\n\});/);
  assert.ok(scopes);
  const uiScopes = vm.runInNewContext('(' + scopes[1] + ')');
  for (const [plan, values] of Object.entries(expected)) assert.equal(uiScopes[plan].totalPages, values[2]);
  const start = popup.indexOf('function getPromptProfileAccess(');
  const end = popup.indexOf('\nfunction ', start + 1);
  vm.runInContext(popup.slice(start, end), sandbox);
  sandbox.formatPlanName = value => value;
  assert.equal(sandbox.getPromptProfileAccess('free', manager).enabled, false);
  assert.deepEqual(json(sandbox.getPromptProfileAccess('starter', manager).allowedFields), ['profile_name', 'tone', 'response_depth']);
  assert.equal(sandbox.getPromptProfileAccess('pro', manager).allowedFields.includes('advanced_instructions'), false);
  assert.equal(sandbox.getPromptProfileAccess('agency', manager).allowedFields.includes('advanced_instructions'), true);
  const api = await readFile(path + '/zentra-api-client.js', 'utf8');
  assert.ok(api.includes('getAuditEntitlement()'));
  const pdf = await readFile(path + '/claude-pdf-generator.js', 'utf8');
  assert.ok(pdf.indexOf('await window.zentraOperations.reserveAudit(sourceUrl') < pdf.indexOf('await this.collectPageData(tabId)'));
  pass(directory + ': active matrix, invalid counters/limits, gates, authoritative pre-crawl scope and branding');
}

for (const plan of Object.keys(expected)) {
  const scope = auditEntitlement({ plan, status: 'active' });
  const context = { pageData: { url: 'https://example.test/' }, auditScope: { plan, totalPages: scope.totalPages, internalPages: scope.internalPages,
    allowsManualSelection: scope.allowsManualSelection }, internalPagesResult: { pages: [] }, freePreviewPagesResult: { pages: [] } };
  assert.equal(validateAuditEntitlement(context, plan), true);
  context.internalPagesResult.pages = Array.from({ length: scope.internalPages + 1 }, (_, i) => ({ url: 'https://example.test/' + i }));
  assert.equal(validateAuditEntitlement(context, plan), false);
}
const forgedContext = { version: 1, auditScope: { plan: 'agency', totalPages: 11, internalPages: 10, allowsManualSelection: true },
  internalPagesResult: { pages: [] }, freePreviewPagesResult: { pages: [] } };
let registrations = 0;
const spoof = await prepareAuditStep({ client: { async rpc(name) {
  if (name === 'zentra_read_audit_steps') return { data: { plan: 'free', steps: [] } };
  if (name === 'zentra_access') return { data: { plan: 'free', status: 'active' } };
  registrations++; throw new Error('Must reject before register/provider');
} }, identity: { userId: 'verified', email: 'verified@test' }, product: 'subscription', operationId: crypto.randomUUID(),
body: { task_type: 'seo_analysis', plan: 'agency', maxPages: 11, zentra_audit_workflow: forgedContext } });
assert.equal(spoof.conflict, true); assert.equal(registrations, 0);
pass('server refuses spoofed scope and over-limit page evidence before registration/provider');

{
  let responseEntitlement = auditEntitlement({ plan: 'free', status: 'active' }, 2);
  const requests = [];
  const sandbox = vm.createContext({ window: { supabaseClient: { auth: {
    async getSession() { return { data: { session: { access_token: 'fixture-only' } } }; }
  } } }, chrome: { runtime: { getManifest() { return { name: 'Zentra AI' }; }, async sendMessage() { return { success: true }; } } },
  crypto, URL, Headers, Response, setInterval() { return 1; }, clearInterval() {},
  async fetch(_url, init) {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true, lease_token: crypto.randomUUID(), entitlement: responseEntitlement }));
  } });
  vm.runInContext(await readFile(base + '/publicacion/chrome-store/zentra-ai-chrome-store-clean/zentra-api-client.js', 'utf8'), sandbox);
  const operations = sandbox.window.zentraOperations;
  await operations.reserveAudit('https://example.test/', crypto.randomUUID(), 2);
  assert.equal(requests[0].requestedPages, 2);
  assert.equal(operations.getAuditEntitlement().totalPages, 2);
  assert.equal(Object.isFrozen(operations.getAuditEntitlement()), true);
  operations.end('audit');
  responseEntitlement = undefined;
  await assert.rejects(operations.reserveAudit('https://example.test/', crypto.randomUUID()), /profundidad autorizada/);
  operations.end('audit');
  pass('actual Chrome transport: reduced request, immutable server policy; missing policy stops before crawl');
}

const pg = new EmbeddedPostgres({ databaseDir: '/tmp/zentra-plan-pg-' + process.pid,
  user: 'postgres', password: crypto.randomUUID(), port: 55484, persistent: false,
  postgresFlags: ['-h', '127.0.0.1'], onLog() {}, onError() {} });
let db;
try {
  await pg.initialise(); await pg.start(); db = pg.getPgClient(); await db.connect();
  await db.query('create role anon; create role authenticated; create role service_role');
  for (const file of ['supabase-users.sql', 'supabase-release-guard.sql', 'supabase-execution-guard.sql', 'supabase-lemon.sql']) {
    await db.query(await readFile(backend + '/' + file, 'utf8'));
  }
  await db.query("insert into users(email,auth_user_id) values('plans@example.test','plans')");
  const client = { async rpc(name, args) {
    const values = Object.values(args);
    const call = name + '(' + values.map((_, i) => '$' + (i + 1)).join(',') + ')';
    const result = await db.query('select ' + (name === 'zentra_access' ? 'to_jsonb(' + call + ')' : call) + ' r', values);
    return { data: result.rows[0].r };
  } };
  const consume = counter => db.query("select zentra_consume('plans','plans@example.test','subscription',$1,$2,false) r", [counter, crypto.randomUUID()]).then(value => value.rows[0].r);
  for (const [plan, [actions, audits]] of Object.entries(expected)) {
    await db.query("update users set plan=$1,actions_used=$2,audits_used=$3 where auth_user_id='plans'", [plan, actions - 1, audits - 1]);
    assert.equal((await consume('actions_used')).allowed, true);
    assert.equal((await consume('actions_used')).allowed, false);
    assert.equal((await consume('audits_used')).allowed, true);
    assert.equal((await consume('audits_used')).allowed, false);
    pass(plan + ': real SQL last action/audit allowed, next denied');
  }
  for (const plan of ['free', 'starter', 'pro', 'agency', 'pro', 'starter', 'free']) {
    await db.query("update users set plan=$1,actions_used=0,audits_used=0 where auth_user_id='plans'", [plan]);
    const id = crypto.randomUUID();
    const req = { auth: { userId: 'plans', email: 'plans@example.test' }, body: {
      zentra_operation: { id, product: 'subscription', source: 'https://example.test/' }, requestedPages: 11,
      plan: 'agency', actionsLimit: 3000, auditLimit: 30, maxPages: 11, pdfBranding: false, advancedInstructions: true
    } };
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.value = value; return this; } };
    await createAuditAcquisitionHandler({ client })(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.value.entitlement.plan, plan);
    assert.equal(res.value.entitlement.totalPages, expected[plan][2]);
    assert.equal((await db.query("select audits_used from users where auth_user_id='plans'")).rows[0].audits_used, 1);
    await client.rpc('zentra_release_audit', { p_auth_id: 'plans', p_email: 'plans@example.test',
      p_product: 'subscription', p_operation: id, p_lease: res.value.lease_token });
    pass('authoritative ' + plan + ': spoof ignored, depth before crawl and single existing reservation');
  }
  await db.query("update users set plan='pro',actions_used=800 where auth_user_id='plans'");
  assert.equal((await consume('actions_used')).allowed, false);
  await db.query("update users set plan='agency' where auth_user_id='plans'");
  assert.equal((await consume('actions_used')).allowed, true);
  await db.query("update users set plan='free' where auth_user_id='plans'");
  assert.equal((await consume('actions_used')).allowed, false);
  assert.equal((await db.query("select actions_used from users where auth_user_id='plans'")).rows[0].actions_used, 801);
  pass('internal upgrade/downgrade uses new limit without silently resetting accumulated usage');
  const fresh = await client.rpc('zentra_access', { p_auth_id: 'new-free', p_email: 'new-free@example.test', p_product: 'subscription' });
  assert.equal(fresh.data.plan, 'free');
  assert.equal(fresh.data.actions_used, 0);
  assert.equal(auditEntitlement(fresh.data).maxPages, 3);
  pass('new verified account is Free, zero used, three-page depth');
} finally {
  await db?.end(); await pg.stop();
}
console.log(count + ' plan/entitlement test groups passed');
