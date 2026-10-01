import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
const deps = createRequire('/tmp/zentra-topic-check-runtime/package.json');
const { default: EmbeddedPostgres } = await import(pathToFileURL(deps.resolve('embedded-postgres')));
const { Pool } = deps('pg');
const backend = process.env.ZENTRA_BACKEND_DIR;
const { default: express } = await import(pathToFileURL(backend + '/node_modules/express/index.js'));
const { default: cors } = await import(pathToFileURL(backend + '/node_modules/cors/lib/index.js'));
const { createCorsOptions, createApiSecurity, publicStreamEvent } = await import(pathToFileURL(backend + '/release-security.js'));
const { configureHttpProxy, createHttpBoundary, createDistributedRateLimit, minimalHealth, publicHttpError } = await import(pathToFileURL(backend + '/release-http-boundary.js'));
const { createOperationGuard } = await import(pathToFileURL(backend + '/release-operations.js'));
const { createAuditAcquisitionHandler } = await import(pathToFileURL(backend + '/release-audit-acquisition.js'));
const password = crypto.randomUUID();
const pg = new EmbeddedPostgres({ databaseDir: '/tmp/zentra-http-pg-' + process.pid,
  user: 'postgres', password, port: 55481, persistent: false,
  postgresFlags: ['-h', '127.0.0.1'], onLog() {}, onError() {} });
const servers = [];
const closedConnections = [];
let pool, count = 0, clock = Date.now(), providers = 0, acquisitions = 0;
const pass = label => { count++; console.log('PASS', label); };
const source = await readFile(backend + '/server.js', 'utf8');
assert.ok(source.includes('app.use((req, res, next) => lemonHandlers.reconcile(req, res, next))'));
assert.ok(source.indexOf('lemonHandlers.reconcile(req, res, next)') < source.indexOf('app.use(createOperationGuard('));
assert.ok(source.indexOf('app.use(createDistributedRateLimit(') < source.indexOf('app.use(createOperationGuard('));
assert.ok(source.indexOf('app.use(createDistributedRateLimit(') < source.indexOf('app.use(express.json('));
assert.match(source, /app\.get\(\["\/api\/health", "\/health"\], minimalHealth\)/);
assert.match(source, /app\.disable\("x-powered-by"\)/);
assert.match(source, /res\.setHeader\("Cache-Control", "no-store, no-cache, no-transform"\)/);
pass('actual server ordering: rate before body, reservations and providers; health and framework protection wired');
for (const origin of ['*', 'https://*.example.test', 'null', 'https://example.test/path', 'https://a:b@example.test', 'http://localhost:3000']) {
  assert.throws(() => createCorsOptions(origin, 'production'));
}
createCorsOptions('http://localhost:3000', 'development');
for (const proxy of ['true', '1', '0.0.0.0/0', '::/0', '127.0.0.1/99']) assert.throws(() => configureHttpProxy(express(), { ZENTRA_TRUSTED_PROXY_CIDRS: proxy }));
pass('production wildcard/null/path/credentials/localhost rejected; dev localhost explicit; unsafe proxy policies rejected');
try {
  await pg.initialise(); await pg.start();
  pool = new Pool({ user: 'postgres', password, host: '127.0.0.1', database: 'postgres', port: 55481, max: 24 });
  pool.on('connect', client => {
    closedConnections.push(new Promise(resolve => client.once('end', resolve)));
  });
  await pool.query('create role anon; create role authenticated; create role service_role');
  for (const file of ['supabase-users.sql','supabase-release-guard.sql','supabase-execution-guard.sql','supabase-http-rate.sql','supabase-http-rate.sql','supabase-lemon.sql']) await pool.query(await readFile(backend + '/' + file, 'utf8'));
  await pool.query("insert into users(email,auth_user_id,plan) values('alice@example.test','alice','agency'),('bob@example.test','bob','agency')");
  pass('new independent HTTP migration applies twice on real ephemeral PostgreSQL');
  const client = {
    auth: { getUser: async token => ['alice','bob'].includes(token)
      ? { data: { user: { id: token, email: token + '@example.test', confirmed_at: '2026-09-30' } } }
      : { error: 'fixture-invalid-session' } },
    rpc: async (name, args) => {
      try {
        const call = name + '(' + Object.values(args).map((_, i) => '$' + (i + 1)).join(',') + ')';
        return { data: (await pool.query('select ' + (name === 'zentra_access' ? 'to_jsonb(' + call + ')' : call) + ' result', Object.values(args))).rows[0].result };
      }
      catch (error) { return { error }; }
    }
  };
  const extension = 'chrome-extension://' + 'a'.repeat(32);
  function appFor(env = {}, database = client) {
    const app = express(); app.disable('x-powered-by'); configureHttpProxy(app, env);
    app.use(createHttpBoundary({ env: { ZENTRA_RATE_PUBLIC_IP: '2', ZENTRA_RATE_HEALTH_IP: '4', ZENTRA_RATE_WEBHOOK_IP: '6', ...env }, now: () => clock }));
    app.use(cors(createCorsOptions('https://frontend.test,' + extension + (env.NODE_ENV === 'development' ? ',http://localhost:3000' : ''), env.NODE_ENV)));
    app.use(createApiSecurity({ client: database, origins: 'https://frontend.test,' + extension + (env.NODE_ENV === 'development' ? ',http://localhost:3000' : ''), env: { ...env, ZENTRA_RATE_AUTH_IP: '1000', ZENTRA_RATE_USER_LOCAL: '1000' }, now: () => clock }));
    app.use(createDistributedRateLimit({ client: database, env: { ZENTRA_RATE_GENERATION_USER: '2', ZENTRA_RATE_AUDIT_USER: '1', ...env } }));
    app.use(express.json()); app.use(createOperationGuard({ client: database }));
    app.get(['/health','/api/health'], minimalHealth);
    app.get('/api/user', (req, res) => res.json({ ok: true }));
    app.post('/api/lemon/webhook', (req, res) => res.json({ success: true }));
    app.post('/api/audit/reserve', (req, res, next) => { acquisitions++; next(); }, createAuditAcquisitionHandler({ client: database }));
    app.post(['/api/chat','/api/chat/stream'], async (req, res) => {
      await req.startProviderOperation(); providers++;
      if (req.body.fixture === 'fail') return res.status(502).json({ error: 'Failure' });
      if (req.body.fixture === 'useful-fail') {
        await req.checkpointOperation('Respuesta util');
        await req.completeOperation(null, false);
        return res.json({ success: true, response: 'Respuesta util' });
      }
      if (req.path.endsWith('/stream')) {
        await req.checkpointOperation('Respuesta util');
        await req.completeOperation('Respuesta util');
        res.type('application/x-ndjson');
        return res.end(JSON.stringify(publicStreamEvent({ type: 'final', text: 'Respuesta util', provider: 'secret', model: 'secret', zentra_routing: {} })) + '\n');
      }
      return res.json({ success: true, response: 'Respuesta util' });
    });
    app.get('/explode', () => { const error = new Error('SELECT password FROM /private/server secret-token'); error.stack = 'private-stack'; throw error; });
    app.get('/ip', (req, res) => res.json({ ip: req.ip }));
    app.use((_req, res) => res.status(404).json({ error: 'Ruta no disponible.' }));
    app.use(publicHttpError);
    return app;
  }
  async function serve(app) { const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise(resolve => server.on('listening', resolve)); return 'http://127.0.0.1:' + server.address().port; }
  const url = await serve(appFor({ NODE_ENV: 'production' })), url2 = await serve(appFor({ NODE_ENV: 'production' }));
  const request = (base, path, token = 'alice', body, origin) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(origin ? { Origin: origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  for (const origin of ['https://frontend.test', extension]) {
    const result = await request(url, '/api/user', 'alice', null, origin); assert.equal(result.status, 200); assert.equal(result.headers.get('access-control-allow-origin'), origin); assert.equal(result.headers.get('access-control-allow-credentials'), null);
  }
  assert.equal((await request(url, '/api/user', 'alice', null, 'https://evil.test')).status, 403);
  const denied = await request(url, '/api/user', 'alice', null, 'https://evil.test'); assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.equal((await request(url, '/api/user', null, null, 'https://frontend.test')).status, 401);
  assert.equal((await request(url, '/api/user', 'invalid')).status, 401);
  pass('allowed web/extension origins receive exact CORS, denied origins no permission; CORS never bypasses verified auth');
  const options = await fetch(url + '/api/chat', { method: 'OPTIONS', headers: { Origin: extension, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(options.status, 204); assert.equal(options.headers.get('access-control-allow-origin'), extension);
  assert.equal((await pool.query("select count(*) from zentra_usage_receipts")).rows[0].count, '0');
  pass('valid preflight works without auth, quota or supplier');
  clock += 60001;
  const dev = await serve(appFor({ NODE_ENV: 'development' }));
  assert.equal((await request(dev, '/api/user', 'alice', null, 'http://localhost:3000')).headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.equal((await request(url, '/api/user', 'alice', null, 'http://localhost:3000')).status, 403);
  assert.equal((await request(url, '/api/lemon/webhook', null, { fixture: true })).status, 200);
  const webhook = await request(url, '/api/lemon/webhook', null, { fixture: true }, 'https://unlisted.test'); assert.equal(webhook.status, 200); assert.equal(webhook.headers.get('access-control-allow-origin'), null);
  pass('localhost explicitly dev-only; server-to-server and webhook without Origin preserved; unlisted webhook Origin grants no browser access');
  clock += 60001;
  for (const path of ['/health','/api/health']) { const result = await request(url, path, null); assert.deepEqual(await result.json(), { ok: true }); assert.equal(result.headers.get('x-powered-by'), null); assert.equal(result.headers.get('x-content-type-options'), 'nosniff'); assert.equal(result.headers.get('cache-control'), 'no-store'); }
  pass('both health paths expose only ok; nosniff/no-store and no framework header');
  clock += 60001;
  assert.equal((await request(url, '/missing', null)).status, 404); assert.equal((await request(url, '/api/missing', null)).status, 404);
  assert.equal((await request(url, '/api/missing', null)).status, 429);
  clock += 60001;
  const error = await request(url, '/explode', null); assert.equal(error.status, 500); assert.deepEqual(await error.json(), { error: 'Error en el servidor.' });
  pass('unknown/public endpoints limited; production error has no stack, path, SQL or token');
  clock += 60001;
  const ip = await fetch(url + '/ip', { headers: { 'X-Forwarded-For': '1.2.3.4' } }); assert.equal((await ip.json()).ip, '127.0.0.1');
  const proxyApp = express(); configureHttpProxy(proxyApp, { ZENTRA_TRUSTED_PROXY_CIDRS: '127.0.0.1/32' }); proxyApp.get('/ip', (req, res) => res.json({ ip: req.ip }));
  const proxy = await serve(proxyApp); assert.equal((await (await fetch(proxy + '/ip', { headers: { 'X-Forwarded-For': '1.2.3.4' } })).json()).ip, '1.2.3.4');
  pass('untrusted spoofed XFF ignored; only explicit proxy CIDR enables forwarding interpretation');
  const body = fixture => ({ messages: [{ role: 'user', content: 'Hola' }], zentra_operation: { id: crypto.randomUUID(), product: 'subscription' }, ...(fixture ? { fixture } : {}) });
  assert.equal((await request(url, '/api/chat', 'alice', body())).status, 200);
  assert.equal((await request(url2, '/api/chat/stream', 'alice', body())).status, 200);
  const used = (await pool.query("select actions_used from users where auth_user_id='alice'")).rows[0].actions_used;
  const before = providers; assert.equal((await request(url, '/api/chat', 'alice', body())).status, 429);
  assert.equal(providers, before); assert.equal((await pool.query("select actions_used from users where auth_user_id='alice'")).rows[0].actions_used, used);
  assert.equal((await request(url, '/api/chat', 'bob', body())).status, 200);
  pass('shared PostgreSQL limit across two app instances: 429 before quota/provider, independent authenticated users, normal chat/stream preserved');
  const reserve = { zentra_operation: { id: crypto.randomUUID(), product: 'subscription', source: 'https://business.test/' } };
  const reserve1 = await request(url, '/api/audit/reserve', 'alice', reserve); assert.equal(reserve1.status, 200);
  const acquisitionBefore = acquisitions;
  const auditUsed = (await pool.query("select audits_used from users where auth_user_id='alice'")).rows[0].audits_used;
  assert.equal((await request(url2, '/api/audit/reserve', 'alice', { ...reserve, zentra_operation: { ...reserve.zentra_operation, id: crypto.randomUUID() } })).status, 429);
  assert.equal(acquisitions, acquisitionBefore); assert.equal((await pool.query("select audits_used from users where auth_user_id='alice'")).rows[0].audits_used, auditUsed);
  pass('Audit rate rejection precedes real acquisition: zero reservation/crawl/IA/search work');
  const broken = await serve(appFor({}, { ...client, rpc: async () => ({ error: new Error('private SQL diagnostic') }) }));
  assert.equal((await request(broken, '/api/chat', 'alice', body())).status, 503); assert.equal(providers, before + 1);
  pass('unavailable rate store fails closed before provider or quota; no SQL exposed');
  const high = await serve(appFor({ ZENTRA_RATE_GENERATION_USER: '50' }));
  assert.equal((await request(high, '/api/chat', 'bob', body('fail'))).status, 502);
  const bobUsed = (await pool.query("select actions_used from users where auth_user_id='bob'")).rows[0].actions_used; assert.equal(bobUsed, 1);
  assert.equal((await request(high, '/api/chat/stream', 'bob', body('useful-fail'))).status, 200);
  assert.equal((await pool.query("select actions_used from users where auth_user_id='bob'")).rows[0].actions_used, 2);
  pass('real operation guard: total known failure refunds once; useful streaming checkpoint plus later failure does not refund');
  const concurrent = await Promise.all(Array.from({ length: 20 }, (_, i) => client.rpc('zentra_http_rate_limit', { p_subject: 'race', p_category: 'generation', p_maximum: 10 })));
  assert.equal(concurrent.filter(r => r.data.allowed).length, 10);
  assert.equal((await pool.query("select count from zentra_http_rate_buckets where subject='race'")).rows[0].count, 11);
  await pool.query("update zentra_http_rate_buckets set expires_at=clock_timestamp()-interval '1 second' where subject='race'");
  assert.ok((await client.rpc('zentra_http_rate_limit', { p_subject: 'race', p_category: 'generation', p_maximum: 10 })).data.allowed);
  pass('20 concurrent PostgreSQL attempts / limit 10 admits exactly 10; expired window resets atomically');
  const privileged = await pool.connect();
  try { await privileged.query('set role authenticated'); await assert.rejects(privileged.query("select zentra_http_rate_limit('forged','generation',100000)"), /permission denied/); await assert.rejects(privileged.query('select * from zentra_http_rate_buckets'), /permission denied/); }
  finally { await privileged.query('reset role'); privileged.release(); }
  pass('public/authenticated database roles cannot raise their own HTTP limits or read buckets');
  console.log('TOTAL', count);
} finally {
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  if (pool) await pool.end();
  // Pool removal can precede the clients' socket shutdown; stop PG only after end.
  await Promise.all(closedConnections);
  await pg.stop();
}
