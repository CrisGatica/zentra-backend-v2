import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const backend = process.env.ZENTRA_BACKEND_DIR;
const client = process.env.ZENTRA_CHAT_ROOT;
const { safeRetryAfter, logRateLimit } = await import(pathToFileURL(backend + '/release-rate-observability.js'));
const { createDistributedRateLimit } = await import(pathToFileURL(backend + '/release-http-boundary.js'));
const { createApiSecurity, createCorsOptions } = await import(pathToFileURL(backend + '/release-security.js'));
const provider = fs.readFileSync(client + '/ai-provider.js', 'utf8');
function runtime(response) {
  const window = { setTimeout, clearTimeout, zentraApiFetch: async () => response };
  vm.runInNewContext(provider, { window, AbortController, console, Date });
  return window.ZentraAIProvider;
}
for (const method of ['sendMessages', 'streamMessages']) {
  test(method + ': internal 429 preserves safe metadata and wait time', async () => {
    const api = runtime(new Response(JSON.stringify({ code: 'rate_limited', error: 'Demasiadas solicitudes. Intentá nuevamente más tarde.' }),
      { status: 429, headers: { 'Retry-After': '17' } }));
    await assert.rejects(api[method]({ body: {} }), error => {
      assert.equal(error.status, 429); assert.equal(error.code, 'rate_limited');
      assert.equal(error.retryAfter, 17); assert.match(error.message, /en 17 segundos/);
      assert.equal(error.backendMessage, 'Demasiadas solicitudes. Intentá nuevamente más tarde.');
      assert.doesNotMatch(error.message, /cuota|Limite de uso/); return true;
    });
  });
  test(method + ': provider 429 is saturation, not monthly quota', async () => {
    const api = runtime(new Response(JSON.stringify({ code: 'provider_rate_limited', error: 'SECRET prompt email@example.invalid' }),
      { status: 429, headers: { 'Retry-After': '9' } }));
    await assert.rejects(api[method]({ body: {} }), error => {
      assert.equal(error.code, 'provider_rate_limited'); assert.equal(error.retryAfter, 9);
      assert.match(error.message, /modelo.*saturado/);
      assert.doesNotMatch(JSON.stringify(error), /SECRET|email@|prompt/); return true;
    });
  });
}
test('unknown legacy 429 remains unclassified; unsafe code/header are discarded', async () => {
  const api = runtime(new Response(JSON.stringify({ code: 'SECRET', error: { message: 'private data' } }),
    { status: 429, headers: { 'Retry-After': 'invalid' } }));
  await assert.rejects(api.sendMessages({ body: {} }), error => {
    assert.equal(error.code, 'http_429'); assert.equal(error.retryAfter, null);
    assert.doesNotMatch(error.message, /modelo|cuota|private/); return true;
  });
});
test('Retry-After normalization supports dates and bounds values', () => {
  const now = Date.parse('2026-10-02T00:00:00Z');
  assert.equal(safeRetryAfter('Fri, 02 Oct 2026 00:00:12 GMT', now), 12);
  assert.equal(safeRetryAfter(null), null); assert.equal(safeRetryAfter('invalid'), null);
  assert.equal(safeRetryAfter('999999'), 86400);
});
function responseMock() {
  return { headers: {}, set(k, v) { this.headers[k] = v; return this; },
    status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; } };
}
test('distributed generation rejects before downstream work, using unchanged default 60', async () => {
  let args, downstream = 0;
  const limit = createDistributedRateLimit({ env: {}, client: { rpc: async (name, input) => {
    assert.equal(name, 'zentra_http_rate_limit'); args = input;
    return { data: { allowed: false, retry_after: 23 } };
  } } });
  const res = responseMock();
  await limit({ path: '/api/chat', method: 'POST', auth: { userId: 'test-user' } }, res, () => downstream++);
  assert.equal(args.p_maximum, 60); assert.equal(args.p_category, 'generation');
  assert.equal(res.statusCode, 429); assert.equal(res.body.code, 'rate_limited');
  assert.equal(res.headers['Retry-After'], '23'); assert.equal(downstream, 0);
});
test('local IP/user guards carry the same internal code; defaults remain 240/120', async () => {
  const identity = { data: { user: { id: 'fixture', email: 'fixture@example.invalid', confirmed_at: '2026-10-01' } } };
  for (const [env, iterations] of [[{ ZENTRA_RATE_AUTH_IP: '1' }, 2], [{}, 121]]) {
    const guard = createApiSecurity({ env, client: { auth: { getUser: async () => identity } } });
    let last;
    for (let i = 0; i < iterations; i++) {
      last = responseMock();
      await guard({ path: '/api/chat', ip: 'fixture', get: name => name === 'Authorization' ? 'Bearer fixture' : null }, last, () => {});
    }
    assert.equal(last.statusCode, 429); assert.equal(last.body.code, 'rate_limited');
    assert.equal(last.headers['Retry-After'], '60');
  }
  assert.ok(createCorsOptions().exposedHeaders.includes('Retry-After'));
});
test('structured logs contain only whitelisted fields and hashed operation; logging failure is harmless', () => {
  const original = console.warn;
  let event;
  try {
    console.warn = (_label, value) => { event = value; };
    logRateLimit({ source: 'provider', endpoint: 'api/chat:fallback', operationId: 'private-operation', retryAfter: '11', email: 'SECRET' });
    assert.deepEqual(Object.keys(event).sort(), ['source','status','code','endpoint','category','operation_id','retry_after'].sort());
    assert.equal(event.endpoint, '/api/chat'); assert.match(event.operation_id, /^[a-f0-9]{24}$/);
    assert.doesNotMatch(JSON.stringify(event), /private-operation|SECRET/);
    console.warn = () => { throw new Error('logger unavailable'); };
    assert.doesNotThrow(() => logRateLimit({ source: 'provider' }));
  } finally { console.warn = original; }
});
test('actual provider wrapper preserves 429 Retry-After and emits safe provider event', async () => {
  const source = fs.readFileSync(backend + '/server.js', 'utf8');
  const fn = source.slice(source.indexOf('async function callOpenAI('), source.indexOf('async function callAnthropic('));
  const events = [];
  const context = vm.createContext({ OPENAI_API_KEY: 'mock-only',
    shouldUseOpenAIResponsesApi: () => false, buildOpenAIRequestBody: () => ({}),
    safeRetryAfter, logRateLimit: event => events.push(event),
    operationContext: { getStore: () => ({ id: 'test-operation' }) },
    fetch: async () => new Response('{}', { status: 429, headers: { 'Retry-After': '14' } }), Date });
  vm.runInContext(fn, context);
  const result = await context.callOpenAI({ model: 'gpt-6-luna', requestContext: { routeName: 'api/chat' } });
  assert.equal(result.status, 429); assert.equal(result.retryAfter, 14);
  assert.equal(events[0].source, 'provider'); assert.equal(events[0].operationId, 'test-operation');
  assert.match(source, /result\.status === 429 \? \{ code: "provider_rate_limited" \}/);
  assert.match(source, /res\.set\("Retry-After", String\(result\.retryAfter\)\)/);
});
