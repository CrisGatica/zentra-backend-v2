import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from './local-postgres.mjs';

const root = process.env.ZENTRA_CHAT_ROOT;
const backend = process.env.ZENTRA_BACKEND_DIR;
const { createApiSecurity } = await import(pathToFileURL(backend + '/release-security.js'));
const { createDistributedRateLimit } = await import(pathToFileURL(backend + '/release-http-boundary.js'));
function fn(source, name) {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n(?:async )?function /);
  assert.ok(end >= 0, name);
  return rest.slice(0, end + 1);
}
function harness(path = root, cutoff = Infinity) {
  const dom = new JSDOM('<body><div id="user-email">fixture@tryzentra.app</div><div id="user-profile"></div>'
    + ['subscription-bar', 'subscription-plan-badge', 'subscription-usage', 'subscription-action-btn',
      'subscription-notice', 'subscription-model-debug'].map(id => '<div id="' + id + '"></div>').join('')
    + '<div class="subscription-details-content"></div></body>', { url: 'https://fixture.test', runScripts: 'outside-only' });
  const w = dom.window, stored = {}, state = { actions: 0, advanced: 1, audits: 0, calls: 0, events: 0, rendering: true };
  let now = Date.now(), held = null;
  const NativeDate = w.Date;
  w.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  w.setTimeout = () => 1;
  w.clearTimeout = () => {};
  w.console = { log() {}, warn() {}, error() {} };
  w.__zentraUserId = 'fixture';
  w.__zentraUserEmail = 'fixture@tryzentra.app';
  w.chrome = { storage: { local: {
    get(keys, cb) { cb(stored); },
    set(values, cb) { Object.assign(stored, values); cb(); }
  } } };
  w.zentraApiFetch = async () => {
    if (++state.calls >= cutoff) state.rendering = false;
    if (held) await held;
    return new Response(JSON.stringify({ id: 'usage-' + w.__zentraUserId, auth_user_id: w.__zentraUserId, plan: 'free',
      status: 'active', actions_used: state.actions, audits_used: state.audits,
      advanced_actions_used: state.advanced, premium_chat_used: state.advanced,
      advanced_actions_limit: 3, premium_chat_limit: 3, actions_limit: 20, audits_limit: 1,
      billing_cycle_start: new NativeDate(now).toISOString() }), { status: 200 });
  };
  for (const file of ['ai-provider.js', 'subscription-manager.js', 'strategy-model-selector.js', 'model-router.js']) {
    w.eval(readFileSync(path + '/' + file, 'utf8'));
  }
  const popup = readFileSync(path + '/popup.js', 'utf8');
  w.eval('let subscriptionBarRefreshInFlight=false; let currentSeoAuditPlan="free";'
    + 'function shouldShowSubscriptionModelDebug(){return true;}'
    + ['formatPlanName', 'formatUsageValue', 'getSubscriptionCapacityState', 'getPlanActionConfig',
      'refreshSubscriptionModelDebug', 'refreshSubscriptionBar'].map(name => fn(popup, name)).join('\n'));
  w.addEventListener('zentra-subscription-updated', () => {
    state.events++;
    if (state.rendering) w.refreshSubscriptionBar();
  });
  const flush = async () => { for (let i = 0; i < 300; i++) await Promise.resolve(); };
  return { dom, w, sub: w.zentraSubscription, state, flush, advance(ms) { now += ms; },
    hold(promise) { held = promise; } };
}

test('legacy popup reproduces subscription/debug feedback storm, bounded by fixture cutoff', async () => {
  const path = process.env.ZENTRA_BASE + '/ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab';
  const h = harness(path, 30);
  try {
    await h.w.refreshSubscriptionBar();
    await h.flush();
    assert.ok(h.state.calls >= 30, 'Legacy event/render chain must reproduce dozens of reads');
  } finally { h.state.rendering = false; await h.flush(); h.dom.window.close(); }
});
test('popup open plus repeated renders and Advanced action/refinements use bounded usage reads', async () => {
  const h = harness();
  try {
    await h.w.refreshSubscriptionBar(true);
    await h.flush();
    assert.equal(h.state.calls, 1);
    for (let i = 0; i < 20; i++) await h.w.refreshSubscriptionBar();
    await h.flush();
    await Promise.all(Array.from({ length: 20 }, () => h.sub.getAiRoutingForTask('chat_premium')));
    assert.equal(h.state.calls, 1, 'Rendering/routing must share the fresh usage snapshot');
    h.w.eval(readFileSync(root + '/claude-chatbot.js', 'utf8'));
    const bot = Object.create(h.w.ClaudeChatbot.prototype);
    let completed = false, ended = false, refinements = 0;
    h.w.zentraOperations = { begin() {}, end() { ended = true; } };
    Object.assign(bot, {
      loadPendingChatRequest: async () => ({ operationId: 'fixture-operation' }),
      sendToAPI: async () => {
        // Simulate server-side consumption plus sequential refinement completions.
        h.state.actions = 1; h.state.advanced = 2;
        for (let i = 0; i < 3; i++) {
          refinements++;
          h.w.dispatchEvent(new h.w.CustomEvent('zentra-model-debug-updated'));
          await h.w.refreshSubscriptionBar();
          await h.sub.syncPlanFromBackend(h.sub.backendBaseUrl + '/api/subscription/usage');
        }
        return { text: 'Useful final response', routing: { premiumActive: true, counterKey: 'advanced_actions_used' } };
      },
      getEnvironmentContextSummary: () => '', detectContextualSurface: () => 'web',
      finalizeAssistantDraftMessage: async (_draft, text) => { assert.equal(text, 'Useful final response'); completed = true; return true; },
      clearPendingChatRequest: async () => {}, clearPendingImage() {}, clearPendingDocument() {},
      buildSafeAccountAccessGuideFallback: () => null,
      addSystemMessage: message => assert.fail(message), removeAssistantDraftMessage() {}
    });
    await bot.runChatRequest({ message: 'Analiza esta web en profundidad', subscriptionManager: h.sub });
    assert.equal(completed, true);
    assert.equal(ended, true);
    assert.equal(refinements, 3);
    await h.flush();
    assert.equal(h.state.calls, 2, 'One explicit post-action fetch, not one per refinement/render');
    assert.equal(h.sub.cachedUser.actions_used, 1);
    assert.equal(h.sub.cachedUser.advanced_actions_used, 2);
    assert.match(h.w.document.getElementById('subscription-usage').textContent, /1\/20/);
    h.state.audits = 1;
    await h.sub.consumeAudit();
    await h.flush();
    assert.equal(h.state.calls, 3);
    assert.equal(h.sub.cachedUser.audits_used, 1);
    assert.match(h.w.document.getElementById('subscription-usage').textContent, /1\/1/);
  } finally { h.state.rendering = false; h.dom.window.close(); }
});
test('forced reads single-flight, expire, and post-action refresh waits out pre-action data', async () => {
  const h = harness();
  try {
    let release;
    h.hold(new Promise(resolve => { release = resolve; }));
    const reads = Promise.all(Array.from({ length: 40 }, () => h.sub.getUserState(true)));
    await h.flush();
    assert.equal(h.state.calls, 1);
    release(); await reads; h.hold(null); await h.flush();
    h.advance(1600);
    await h.sub.getUserState(true);
    assert.equal(h.state.calls, 2);
    h.advance(1600);
    h.hold(new Promise(resolve => { release = resolve; }));
    const before = h.sub.getUserState(true);
    await h.flush();
    const after = h.sub.consumeAction();
    h.state.actions = 2;
    release(); h.hold(null);
    await before; await after; await h.flush();
    assert.equal(h.state.calls, 4, 'Explicit consumption refresh cannot reuse the pre-action request');
    assert.equal(h.sub.cachedUser.actions_used, 2);
    h.w.__zentraUserId = 'other';
    await h.sub.getUserState(true);
    assert.equal(h.state.calls, 5);
    assert.equal(h.sub.cachedUser.auth_user_id, 'other');
  } finally { h.state.rendering = false; h.dom.window.close(); }
});
function res() { return { set() { return this; }, status(n) { this.statusCode=n; return this; }, json(v) { this.body=v; return this; } }; }
function request(path, user='fixture', ip='fixture') { return { path, method: path.startsWith('/api/chat') ? 'POST' : 'GET', ip,
  get(name) { return name === 'Authorization' ? 'Bearer ' + user : null; } }; }
test('status read flood is locally rate-limited but cannot spend chat user/IP buckets; converse is isolated', async () => {
  const auth = { auth: { getUser: async token => ({ data: { user: { id: token, email: token+'@fixture.test', confirmed_at: 'fixture' } } }) } };
  for (const [env, count] of [[{}, 121], [{ ZENTRA_RATE_AUTH_IP: '3', ZENTRA_RATE_USER_LOCAL: '1000' }, 4]]) {
    const guard = createApiSecurity({ client: auth, env });
    let response;
    for (let i=0; i<count; i++) { response=res(); await guard(request('/api/subscription/usage'),response,()=>{}); }
    assert.equal(response.statusCode,429);
    let admitted=0;
    await guard(request('/api/chat'),res(),()=>admitted++);
    await guard(request('/api/chat/stream'),res(),()=>admitted++);
    assert.equal(admitted,2);
  }
  const guard=createApiSecurity({client:auth,env:{ZENTRA_RATE_USER_LOCAL:'2'}});
  for(let i=0;i<2;i++)await guard(request('/api/chat'),res(),()=>{});
  const blocked=res();await guard(request('/api/chat'),blocked,()=>{});
  assert.equal(blocked.statusCode,429);
  let admitted=0;await guard(request('/api/subscription/usage'),res(),()=>admitted++);
  assert.equal(admitted,1);
  const anonymous=res();const req=request('/api/subscription/usage');req.get=()=>null;
  await guard(req,anonymous,()=>assert.fail('Unauthenticated read'));
  assert.equal(anonymous.statusCode,401);
});
test('persistent read and generation limits/keys remain separate and unchanged', async () => {
  const calls=[];
  const guard=createDistributedRateLimit({client:{rpc:async(name,input)=>{
    calls.push({name,...input});return {data:{allowed:true}};
  }},env:{}});
  for(const path of ['/api/subscription/usage','/api/chat','/api/chat/stream']) {
    const req=request(path);req.auth={userId:'fixture'};
    await guard(req,res(),()=>{});
  }
  assert.deepEqual(calls.map(c=>[c.p_category,c.p_maximum]),[['read',180],['generation',60],['generation',60]]);
});
