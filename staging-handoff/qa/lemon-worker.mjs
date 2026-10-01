import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const backend = process.env.ZENTRA_BACKEND_DIR;
const { Pool } = await import(process.env.ZENTRA_TEST_PG_MODULE);
const { default: express } = await import(pathToFileURL(backend + '/node_modules/express/index.js'));
const { createApiSecurity } = await import(pathToFileURL(backend + '/release-security.js'));
const { createLemonHandlers } = await import(pathToFileURL(backend + '/release-lemon.js'));
const pool = new Pool(JSON.parse(process.env.ZENTRA_TEST_PG_CONFIG));
const source = await readFile(backend + '/server.js', 'utf8');
const start = source.indexOf('const LEMON_PRODUCTS = {');
const end = source.indexOf('\nfunction getPlanFromLemonKey', start);
const products = vm.runInNewContext(source.slice(start, end) + '\nLEMON_PRODUCTS');
const logs = [];
let provider;
let providerCalls = 0;
let failDB = false;
const client = {
  auth: { async getUser(token) {
    if (!/^(alice|bob|user\d+)$/.test(token)) return { error: true };
    return { data: { user: { id: token, email: token + '@example.test', confirmed_at: '2026-09-30' } } };
  } },
  async rpc(name, args) {
    if (failDB && name === 'zentra_lemon_event') return { error: new Error('fixture DB outage') };
    try {
      const values = Object.values(args);
      const call = name + '(' + values.map((_, i) => '$' + (i + 1)).join(',') + ')';
      const query = name === 'zentra_access' ? 'to_jsonb(' + call + ')' : call;
      return { data: (await pool.query('select ' + query + ' r', values)).rows[0].r };
    } catch (error) { console.error('Fixture SQL failure', name, error.message); return { error }; }
  }
};
const handlers = createLemonHandlers({ client, products,
  env: { LEMON_SQUEEZY_WEBHOOK_SECRET: 'local-lemon-fixture', LEMON_SQUEEZY_STORE_ID: '42',
    LEMON_SQUEEZY_API_KEY: 'fixture-only', LEMON_ALLOW_TEST_WEBHOOKS: 'true' },
  logger: { warn(...args) { logs.push(args); } },
  fetchImpl: async () => { providerCalls++; return { ok: Boolean(provider), json: async () => provider }; }
});
const app = express();
app.use(createApiSecurity({ client }));
app.use(express.json({ verify(req, _res, raw) { req.rawBody = raw; } }));
app.use(handlers.reconcile);
app.post('/api/lemon/checkout', handlers.checkout);
app.post('/api/lemon/webhook', handlers.webhook);
app.get('/api/subscription/usage', async (req, res) => {
  const r = await client.rpc('zentra_access', { p_auth_id: req.auth.userId, p_email: req.auth.email, p_product: 'subscription' });
  res.status(r.error ? 503 : 200).json(r.error ? { error: 'fixture' } : r.data);
});
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.on('listening', resolve));
process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port, pid: process.pid });
process.on('message', async message => {
  let value;
  if (message.type === 'provider') { provider = message.payload; value = true; }
  if (message.type === 'failDB') { failDB = message.enabled; value = true; }
  if (message.type === 'metrics') value = { logs, providerCalls };
  if (message.type === 'stop') {
    await new Promise(resolve => server.close(resolve)); await pool.end();
    process.send({ id: message.id, value: true }); process.disconnect(); return;
  }
  process.send({ id: message.id, value });
});
