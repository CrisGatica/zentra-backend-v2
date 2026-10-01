import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import crypto from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';

const backend = process.env.ZENTRA_BACKEND_DIR;
const base = process.env.ZENTRA_BASE;
const routing = await import(pathToFileURL(backend + '/release-chat-routing.js'));
const { requestFingerprint } = await import(pathToFileURL(backend + '/release-security.js'));
const { default: express } = await import(pathToFileURL(backend + '/node_modules/express/index.js'));
const { default: cors } = await import(pathToFileURL(backend + '/node_modules/cors/lib/index.js'));
const pg = new EmbeddedPostgres({ databaseDir: '/tmp/zentra-gpt6-pg-' + process.pid,
  user: 'postgres', password: crypto.randomUUID(), port: 55486, persistent: false,
  postgresFlags: ['-h', '127.0.0.1'], onLog() {}, onError() {} });
let db, server, server2, count = 0;
const calls = [], telemetry = [], errors = [], runtimes = [];
let failure = null, needsReasoning = true, holdRelease, enteredHold;
const pass = name => { count++; console.log('PASS', name); };
const source = await readFile(backend + '/server.js', 'utf8');
const imports = {};
for (const line of source.matchAll(/^import \{ ([^}]+) \} from "(\.\/[^" ]+)";/gm)) {
  const module = await import(pathToFileURL(backend + '/' + line[2].slice(2)));
  for (const name of line[1].split(',').map(value => value.trim())) imports[name] = module[name];
}
const client = {
  auth: { async getUser(token) { return token === 'alice' ? { data: { user: { id: 'alice', email: 'alice@example.test', confirmed_at: '2026-09-29' } } } : { error: 'invalid session' }; },
    admin: { async getUserById(id) { return { data: { user: { id, email: 'alice@example.test', confirmed_at: '2026-09-29' } } }; } } },
  async rpc(name, args) {
    try {
      const values = Object.values(args);
      const query = name + '(' + values.map((_, i) => '$' + (i + 1)).join(',') + ')';
      const result = await db.query('select ' + (name === 'zentra_access' ? 'to_jsonb(' + query + ')' : query) + ' r', values);
      return { data: result.rows[0].r };
    } catch (error) { errors.push(name + ': ' + error.message); return { error }; }
  }
};
function runtime() {
  const context = vm.createContext({ ...imports,
    createApiSecurity: options => imports.createApiSecurity({ ...options, env: { ZENTRA_RATE_AUTH_IP: '10000', ZENTRA_RATE_USER_LOCAL: '10000' } }),
    createDistributedRateLimit: options => imports.createDistributedRateLimit({ ...options, env: { ZENTRA_RATE_GENERATION_USER: '10000' } }),
    // Billing association belongs to the existing Lemon suite, not these local routing fixtures.
    createLemonHandlers: options => ({ ...imports.createLemonHandlers(options), reconcile: (_req, _res, next) => next() }),
    express, cors, crypto, createClient: () => client,
    Buffer, URL, AbortSignal, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    process: { env: { SUPABASE_URL: 'https://fixture.test', SUPABASE_SERVICE_ROLE_KEY: 'fixture', OPENAI_API_KEY: 'fixture',
      USER_ACCESS_HAS_AUTH_USER_ID: 'true', NODE_ENV: 'test' } },
    console: { log(label, value) { if (label === '[CHAT COST]') telemetry.push(value); }, warn() {}, error(...args) { errors.push(args.map(String).join(' ')); } },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      const operation = imports.operationContext.getStore();
      calls.push({ url, body, id: operation?.id });
      if (holdRelease && body.model === 'gpt-6.1-sol') { enteredHold?.(); await holdRelease; }
      if (body.model === 'gpt-6.1-sol' && failure === 'uncertain') throw new Error('simulated transport lost');
      if ((body.model === 'gpt-6.1-sol' && ['confirmed', 'both'].includes(failure)) || (body.reasoning?.effort === 'high' && failure === 'both')) return { ok: false, status: 502, json: async () => ({ error: { message: 'confirmed failure' } }) };
      const text = JSON.stringify({ response: body.reasoning?.effort === 'high' ? 'Respuesta razonada alternativa' : body.model === 'gpt-6.1-sol' ? 'Respuesta razonada avanzada' : 'Respuesta base util',
        needsReasoning, reasoningAddedValue: true, reasoningSummary: 'Criterio', intent: 'strategy' });
      return { ok: true, status: 200, json: async () => ({ model: body.model, output_text: text,
        usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 100 } } }) };
    }
  });
  const script = source.replace(/^import .+;\n/gm, '').replace(/app\.listen\(PORT, \(\) => \{[\s\S]*?\n\}\);\s*$/, '');
  vm.runInContext(script, context);
  runtimes.push(context);
  return vm.runInContext('app', context);
}
function root(id = crypto.randomUUID(), task = 'chat_premium', overrides = {}) {
  return { model: 'gpt-5.4-mini', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'Ayudame a planificar la estrategia de esta web' }],
    task_type: task, zentra_operation: { id, product: 'subscription' }, ...overrides };
}
async function send(body, path = '/api/chat', target = server, token = 'alice') {
  const res = await fetch('http://127.0.0.1:' + target.address().port + path, { method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text };
}
async function reset(plan, advanced = 0) {
  await db.query("update users set plan=$1, actions_used=0, premium_chat_used=$2 where auth_user_id='alice'", [plan, advanced]);
}
async function user() { return (await db.query("select * from users where auth_user_id='alice'")).rows[0]; }
function routed(id) { return calls.filter(call => call.id === id).map(call => [call.body.model, call.body.reasoning?.effort]); }

try {
  await pg.initialise(); await pg.start(); db = pg.getPgClient(); await db.connect();
  await db.query('create role anon; create role authenticated; create role service_role');
  for (const file of ['supabase-users.sql', 'supabase-release-guard.sql', 'supabase-execution-guard.sql', 'supabase-http-rate.sql', 'supabase-lemon.sql']) await db.query(await readFile(backend + '/' + file, 'utf8'));
  await db.query("insert into users(email,auth_user_id,plan) values('alice@example.test','alice','free')");
  server = runtime().listen(0, '127.0.0.1'); server2 = runtime().listen(0, '127.0.0.1');
  await Promise.all([server, server2].map(value => new Promise(resolve => value.on('listening', resolve))));
  const transport = vm.runInContext('buildOpenAIResponsesRequestBody', runtimes[0]);
  const legacySeo = transport({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'Fixture' }], maxTokens: 2048,
    responseFormat: { type: 'json_object' }, requestContext: { taskType: 'seo_analysis' } }).body;
  assert.equal(legacySeo.reasoning.effort, 'low'); assert.equal(legacySeo.max_output_tokens, 2048);
  const legacyPdf = transport({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'Fixture' }], maxTokens: 2200,
    responseFormat: { type: 'json_object' }, temperature: .2, requestContext: { taskType: 'pdf_summary' } }).body;
  assert.equal(legacyPdf.reasoning, undefined); assert.equal(legacyPdf.temperature, .2);
  assert.equal(vm.runInContext('AI_TASK_ROUTING.seo_analysis.model', runtimes[0]), 'gpt-6-luna');
  assert.equal(vm.runInContext('AI_TASK_ROUTING.pdf_summary.model', runtimes[0]), 'gpt-6-luna');
  assert.equal(vm.runInContext('AI_TASK_ROUTING.executive_refiner_pdf.model', runtimes[0]), 'gpt-6.1-sol');
  const executive = vm.runInContext('buildChatExecutiveRoute', runtimes[0]);
  for (const granted of [false, true]) {
    const route = routing.chatTierRoute({ needsReasoning: true, premiumGranted: granted });
    assert.equal(executive(route).model, route.model); assert.equal(executive(route).reasoningEffort, route.reasoningEffort);
    assert.equal(executive(route).premiumGranted, granted);
  }
  pass('passive shared transport: legacy parameters preserved, Audit configuration migrated independently; optional chat polish keeps authorized tier');
  const normal = root(undefined, 'chat_basic');
  assert.equal((await send(normal)).status, 200, errors.join('\n'));
  assert.deepEqual(routed(normal.zentra_operation.id), [['gpt-6-luna', 'medium']]);
  assert.equal((await user()).premium_chat_used, 0); assert.equal((await user()).actions_used, 1);
  pass('actual direct handler: normal Luna Medium, one normal receipt, no advanced');

  for (const [plan, cap] of [['free', 3], ['starter', 30], ['pro', 100], ['agency', 300]]) {
    await reset(plan);
    for (let index = 0; index < cap; index++) {
      const body = root(); const res = await send(body);
      assert.equal(res.status, 200, res.text + '\n' + errors.join('\n'));
      assert.deepEqual(routed(body.zentra_operation.id), [['gpt-6.1-sol', 'medium']]);
    }
    const exhausted = root(); const res = await send(exhausted);
    assert.equal(res.status, 200); assert.deepEqual(routed(exhausted.zentra_operation.id), [['gpt-6-luna', 'high']]);
    assert.equal((await user()).premium_chat_used, cap); assert.equal((await user()).actions_used, cap + 1);
    const before = calls.length; await send(exhausted);
    assert.equal(calls.length, before); assert.equal((await user()).actions_used, cap + 1);
    assert.ok(!/gpt-|Luna|Sol|reasoning_effort|logical_tier/.test(res.text));
    pass(plan + ': exactly ' + cap + ' Sol grants, next Luna High, replay adds no receipt/provider, routing invisible');
  }
  for (const [advanced, expected] of [[0, 'gpt-6.1-sol'], [3, 'gpt-6-luna']]) {
    await reset('free', advanced);
    const body = root(); const res = await send(body, '/api/chat/stream');
    assert.equal(res.status, 200, errors.join('\n'));
    assert.deepEqual(routed(body.zentra_operation.id), [['gpt-6-luna', 'medium'], [expected, expected === 'gpt-6-luna' ? 'high' : 'medium']]);
    const events = res.text.trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).type, 'final'); assert.ok(events.some(value => value.type === 'layer'));
    assert.equal((await user()).actions_used, 1); assert.equal((await user()).premium_chat_used, advanced === 0 ? 1 : 3);
    await send(body, '/api/chat/stream'); assert.equal(routed(body.zentra_operation.id).length, 2);
    pass('actual progressive handler: base + ' + expected + ', same operation, one normal receipt and replay');
  }
  await reset('free'); needsReasoning = false;
  const simple = root(); await send(simple, '/api/chat/stream');
  assert.equal(routed(simple.zentra_operation.id).length, 1); assert.equal((await user()).premium_chat_used, 0);
  needsReasoning = true;
  pass('needsReasoning false: no advanced reservation or second layer');

  await reset('free', 2);
  const competing = [root(), root()];
  const results = await Promise.all(competing.map((body, index) => send(body, '/api/chat', index ? server2 : server)));
  assert.ok(results.every(res => res.status === 200), errors.join('\n'));
  assert.deepEqual(competing.flatMap(body => routed(body.zentra_operation.id)).map(([model]) => model).sort(), ['gpt-6-luna', 'gpt-6.1-sol']);
  assert.equal((await user()).premium_chat_used, 3); assert.equal((await user()).actions_used, 2);
  pass('concurrent last advanced grant: one Sol, one Luna High, no overshoot or duplicate normal receipt');

  await reset('free'); failure = 'confirmed';
  const confirmed = root(); assert.equal((await send(confirmed)).status, 200);
  assert.deepEqual(routed(confirmed.zentra_operation.id), [['gpt-6.1-sol', 'medium'], ['gpt-6-luna', 'high']]);
  assert.equal((await user()).premium_chat_used, 1); assert.equal((await user()).actions_used, 1);
  pass('confirmed Sol HTTP failure: one bounded Luna High fallback, same paid receipts');
  await reset('free');
  const progressiveFailure = root(); const kept = await send(progressiveFailure, '/api/chat/stream');
  assert.equal(kept.status, 200); assert.ok(kept.text.includes('Respuesta base util'));
  assert.equal(routed(progressiveFailure.zentra_operation.id).length, 3);
  assert.equal((await user()).actions_used, 1);
  pass('progressive confirmed failure retains useful base before safe fallback');
  await reset('free'); failure = 'both';
  const bothFailed = root(); const useful = await send(bothFailed, '/api/chat/stream');
  assert.equal(useful.status, 200); assert.equal(JSON.parse(useful.text.trim().split('\n').at(-1)).text, 'Respuesta base util');
  assert.equal(routed(bothFailed.zentra_operation.id).length, 3);
  assert.equal((await user()).actions_used, 1); assert.equal((await user()).premium_chat_used, 1);
  await send(bothFailed); assert.equal(routed(bothFailed.zentra_operation.id).length, 3);
  pass('both advanced and technical fallback fail: useful base persisted, no loop/refund/extra receipt');

  await reset('free'); failure = 'uncertain';
  const uncertain = root(); assert.equal((await send(uncertain)).status, 503);
  assert.deepEqual(routed(uncertain.zentra_operation.id), [['gpt-6.1-sol', 'medium']]);
  const attempts = calls.length; assert.equal((await send(uncertain)).status, 425);
  await db.query("update zentra_requests set lease_until=now()-interval '1 second' where operation_key=$1", [uncertain.zentra_operation.id]);
  assert.equal((await send(uncertain)).status, 409);
  assert.equal(calls.length, attempts);
  failure = null;
  pass('uncertain Sol transport: no fallback/replay supplier, receipt protected by existing lifecycle');

  await reset('free');
  let release, entered;
  holdRelease = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; }); enteredHold = entered;
  const resumable = root(); const pending = send(resumable);
  await started;
  assert.equal((await send(resumable, '/api/chat/stream', server2)).status, 425);
  release(); assert.equal((await pending).status, 200); holdRelease = null; enteredHold = null;
  await send(resumable, '/api/chat/stream', server2);
  assert.equal(routed(resumable.zentra_operation.id).length, 1);
  assert.equal((await user()).actions_used, 1); assert.equal((await user()).premium_chat_used, 1);
  pass('popup-style resume while live: in-progress, then cached final; same routing/grant/operation, no second provider');

  await reset('free');
  const legacy = root(); const hash = requestFingerprint(legacy);
  await db.query("select zentra_register_chat_step('alice','alice@example.test','subscription',$1,'root',$2,$3,null)", [legacy.zentra_operation.id, hash, legacy]);
  const lease = (await db.query("select zentra_begin_request('alice','alice@example.test','subscription',$1,$2,$2,'chat',false) r", [legacy.zentra_operation.id, hash])).rows[0].r;
  assert.ok(lease.allowed);
  await db.query("update zentra_requests set lease_until=now()-interval '1 second' where operation_key=$1", [legacy.zentra_operation.id]);
  assert.equal((await send(legacy)).status, 200, errors.join('\n'));
  assert.deepEqual(routed(legacy.zentra_operation.id), [['gpt-6.1-sol', 'medium']]);
  assert.equal((await user()).actions_used, 1); assert.equal((await user()).premium_chat_used, 1);
  pass('legacy gpt-5.4 frozen action: expired pre-provider lease resumes with current authorized tier, no second normal receipt');

  await reset('free');
  const refined = root(undefined, 'chat_premium', { model: 'gpt-6.1-sol' });
  refined.zentra_workflow = { version: 1, userMessage: refined.messages[0].content,
    taskIntent: { label: 'senior' }, responseContract: { outputType: 'response', renderType: 'plain', contextDecision: 'free' },
    state: { webContext: {}, conversation: [], taskMemory: {}, model: 'gpt-6.1-sol', maxTokens: 1800 } };
  assert.equal((await send(refined)).status, 200);
  const refinement = { messages: refined.messages, zentra_operation: refined.zentra_operation, zentra_refinement: { stage: 'reasoning' } };
  assert.equal((await send(refinement)).status, 200, errors.join('\n'));
  assert.deepEqual(routed(refined.zentra_operation.id), [['gpt-6.1-sol', 'medium'], ['gpt-6.1-sol', 'medium']]);
  assert.equal((await user()).actions_used, 1); assert.equal((await user()).premium_chat_used, 1);
  await send(refinement); assert.equal(routed(refined.zentra_operation.id).length, 2);
  pass('actual authorized reasoning refinement with GPT6 builder: same advanced/normal receipts, free completed replay');

  await reset('free');
  const ocr = root(undefined, 'chat_image_ocr', { messages: [{ role: 'user', content: [{ type: 'text', text: 'Lee el texto' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] });
  assert.equal((await send(ocr)).status, 200);
  const imageCall = calls.find(call => call.id === ocr.zentra_operation.id);
  assert.ok(imageCall.body.input.some(message => message.content.some(part => part.type === 'input_image')));
  assert.equal(imageCall.body.text.format.type, 'json_object'); assert.equal(imageCall.body.temperature, undefined);
  assert.equal(imageCall.body.max_output_tokens, 4096); assert.ok(imageCall.url.endsWith('/responses'));
  pass('OCR/image + JSON + Responses + unchanged output budget + incompatible temperature omitted');
  const schema = root(undefined, 'chat_basic', { response_format: { type: 'json_schema', json_schema: { name: 'reply', strict: true,
    schema: { type: 'object', properties: { response: { type: 'string' } }, required: ['response'], additionalProperties: false } } } });
  assert.equal((await send(schema)).status, 200);
  assert.equal(calls.find(call => call.id === schema.zentra_operation.id).body.text.format.type, 'json_schema');
  pass('structured output schema preserved by chat-only Responses transport');

  for (const model of ['gpt-6-luna', 'gpt-6.1-sol']) {
    const event = telemetry.find(value => value.model === model && value.usage_available);
    assert.ok(event); assert.equal(event.reasoning_tokens, 100); assert.equal(event.cached_input_tokens, 200);
    assert.ok(/^[a-f0-9]{24}$/.test(event.operation_id)); assert.equal(event.feature, 'chat');
    assert.ok(!JSON.stringify(event).includes('alice')); assert.ok(!JSON.stringify(event).includes('Respuesta'));
  }
  assert.ok(telemetry.some(value => value.logical_tier === 'chat_advanced_fallback' && !value.premium_granted));
  assert.ok(telemetry.some(value => value.logical_tier === 'chat_advanced_fallback' && value.premium_granted));
  assert.ok(telemetry.some(value => value.status === 'execution_uncertain' && value.estimated_cost_usd === null));
  assert.equal(routing.chatCostTelemetry({ model: 'gpt-6-luna', context: routing.chatRequestContext(routing.chatTierRoute()),
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 100 } } }).estimated_cost_usd, .000232);
  pass('internal telemetry: tiers, granted vs exhausted/technical fallback, cache, reasoning no double billing, no content/identity');
  const high = routing.chatRequestContext(routing.chatTierRoute({ needsReasoning: true }));
  const highCost = routing.chatCostTelemetry({ model: 'gpt-6-luna', context: high, usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 300 } });
  assert.equal(highCost.reasoning_effort, 'high'); assert.equal(highCost.estimated_cost_usd, .000232);
  const solCost = routing.chatCostTelemetry({ model: 'gpt-6.1-sol', context: routing.chatRequestContext(routing.chatTierRoute({ needsReasoning: true, premiumGranted: true })), usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 300 } });
  assert.equal(solCost.estimated_cost_usd, .00462);
  assert.equal(routing.chatCostTelemetry({ model: 'gpt-6-luna', context: high }).estimated_cost_usd, null);
  assert.equal(routing.chatCostTelemetry({ model: 'gpt-5-mini', context: {} }), null);
  const longCost = routing.chatCostTelemetry({ model: 'gpt-6-luna', context: high, usage: { input_tokens: 300000, output_tokens: 1000 } });
  assert.equal(longCost.estimated_cost_usd, .06075);
  pass('cost fixtures: Luna High vs Medium same rates, Sol rate, missing usage unknown not zero, long context, no Audit telemetry');
  const plans = [['free',20,3],['starter',300,30],['pro',800,100],['agency',3000,300]];
  for (const [plan, actions, advanced] of plans) {
    const estimate = (actions - advanced) * .000232 + advanced * .00462;
    console.log('SIMULATION_ONLY', JSON.stringify({ plan, actions, advanced, direct_cost_usd: estimate,
      progressive_cost_usd: actions * .000232 + advanced * .00462,
      assumptions: 'per invocation 1000 input/200 cached/300 output incl 100 reasoning; standard service; no refinements or errors; NOT production spend' }));
  }
  pass('deterministic plan cost simulations, explicitly not measured production spend');

  for (const dir of ['publicacion/chrome-store/zentra-ai-chrome-store-clean', 'ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab']) {
    const context = vm.createContext({ window: {}, document: { addEventListener() {} }, console });
    vm.runInContext(await readFile(base + '/' + dir + '/subscription-manager.js', 'utf8'), context);
    vm.runInContext(await readFile(base + '/' + dir + '/ai-provider.js', 'utf8'), context);
    const manager = context.window.zentraSubscription;
    manager.getUserState = async () => ({ plan: 'free', premium_chat_used: 3 });
    manager.canUsePremiumTask = async () => ({ allowed: false, counterKey: 'advanced_actions_used', remaining: 0 });
    const clientRoute = await manager.getAiRoutingForTask('chat_premium');
    assert.equal(clientRoute.selectedModel, 'gpt-6-luna'); assert.equal(clientRoute.reasoningEffort, 'high'); assert.equal(clientRoute.premiumActive, false);
    const auditRoute = await manager.getAiRoutingForTask('seo_analysis'); assert.equal(auditRoute.selectedModel, 'gpt-6-luna');
    assert.equal(manager.getAiRoutingCatalog().tasks.chat_premium.preferredModel, 'gpt-6.1-sol');
    for (const [tier, contract] of Object.entries(routing.CHAT_TIERS)) assert.deepEqual(JSON.parse(JSON.stringify(context.window.ZentraAIProvider.CHAT_TIERS[tier])), contract);
    pass(dir + ': Chat advisory tiers unchanged; Audit model migrated independently');
  }
  console.log('TOTAL', count);
} finally {
  holdRelease = null;
  for (const value of [server, server2]) if (value) await new Promise(resolve => value.close(resolve));
  await db?.end(); await pg.stop();
}
