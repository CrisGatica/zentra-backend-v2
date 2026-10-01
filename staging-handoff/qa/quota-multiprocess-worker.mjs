import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const backend = process.env.ZENTRA_BACKEND_DIR;
const { Pool } = await import(process.env.ZENTRA_TEST_PG_MODULE);
const { default: express } = await import(pathToFileURL(backend + '/node_modules/express/index.js'));
const { createApiSecurity } = await import(pathToFileURL(backend + '/release-security.js'));
const { createDistributedRateLimit } = await import(pathToFileURL(backend + '/release-http-boundary.js'));
const { createOperationGuard, operationContext } = await import(pathToFileURL(backend + '/release-operations.js'));
const { createAuditSearchGuard } = await import(pathToFileURL(backend + '/release-audit-steps.js'));
const { createCompetitiveSearchHandler } = await import(pathToFileURL(backend + '/release-competitive-search.js'));
const { createAuditAcquisitionHandler } = await import(pathToFileURL(backend + '/release-audit-acquisition.js'));
const pool = new Pool(JSON.parse(process.env.ZENTRA_TEST_PG_CONFIG));
const providerCalls = new Map();
const searchCalls = new Map();
const delayed = new Map();
const searchHolds = new Set();
const serverSource=await readFile(backend+'/server.js','utf8');
const providerStart=serverSource.indexOf('async function callAiProvider(');
const providerEnd=serverSource.indexOf('\nfunction normalizeAudioMimeType(',providerStart);
if(providerStart<0||providerEnd<0)throw new Error('Provider wrapper boundary missing');
const lostSupplier=vm.createContext({operationContext,normalizeProvider:value=>value,callOpenAI:async()=>{
  const id=operationContext.getStore().id;
  providerCalls.set(id,(providerCalls.get(id)||0)+1);
  throw new Error('Simulated loss of supplier transport');
}});
vm.runInContext(serverSource.slice(providerStart,providerEnd),lostSupplier);
const client = {
  auth: { async getUser(token) {
    if (!['alice', 'bob'].includes(token)) return { error: 'invalid fixture session' };
    return { data: { user: { id: token, email: token + '@example.test', confirmed_at: '2026-09-29' } } };
  } },
  async rpc(name, args) {
    try {
      const values = Object.values(args);
      const call = name + '(' + values.map((_, i) => '$' + (i + 1)).join(',') + ')';
      const result = await pool.query('select ' + (name === 'zentra_access' ? 'to_jsonb(' + call + ')' : call) + ' r', values);
      return { data: result.rows[0].r };
    } catch (error) { return { error }; }
  }
};

const app = express();
app.use(createApiSecurity({ client }));
if (process.env.ZENTRA_TEST_HTTP_RATE) app.use(createDistributedRateLimit({ client,
  env: { ZENTRA_RATE_GENERATION_USER: process.env.ZENTRA_TEST_HTTP_RATE } }));
app.use(express.json({ limit: '10mb' }));
app.use(createOperationGuard({ client }));
app.post('/api/audit/reserve', createAuditAcquisitionHandler({ client }));
app.post('/api/audit/release', createAuditAcquisitionHandler({ client, release: true }));
// Real reservation middleware, simulated supplier. Each child has independent memory.
app.post(['/api/chat', '/api/chat/stream'], async (req, res) => {
  const id = req.operation.id;
  if (req.body.fixture_hold_before) await new Promise(resolve => delayed.set(id, resolve));
  if(req.body.fixture_transport_loss) {
    try { await lostSupplier.callAiProvider({provider:'openai'}); }
    catch (_) { return res.status(502).json({error:'simulated lost transport'}); }
  }
  try { await req.startProviderOperation(); }
  catch (_) { return res.status(409).json({ error: 'ownership unavailable' }); }
  providerCalls.set(id, (providerCalls.get(id) || 0) + 1);
  if (req.body.fixture_checkpoint) await req.checkpointOperation('Contenido util de prueba');
  if (req.body.fixture_hold) await new Promise(resolve => delayed.set(id, resolve));
  else await new Promise(resolve => setTimeout(resolve, 60));
  if (req.body.fixture_fail) return res.status(502).json({ error: 'simulated provider failure' });
  if (req.body.fixture_fail_once) {
    const current = await pool.query('select attempts from zentra_requests where user_id=$1 and operation_key=$2 and request_hash=$3',
      [req.operation.user.id, id, req.operation.requestHash]);
    if (current.rows[0].attempts === 1) return res.status(502).json({ error: 'simulated first-attempt failure' });
  }
  const text = req.body.fixture_result || 'Contenido util de prueba';
  if (req.path.endsWith('/stream')) {
    await req.checkpointOperation(text);
    if (!await req.completeOperation(text)) return res.status(503).end();
    res.setHeader('Content-Type', 'application/x-ndjson');
    return res.end(JSON.stringify({ type: 'final', text }) + '\n');
  }
  return res.json({ success: true, response: text });
});
app.post('/api/audit/competitive-search', createAuditSearchGuard({ client }), createCompetitiveSearchHandler({
  apiKey: 'fixture-not-a-real-key',
  fetchImpl: async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).input);
    const key = input.auditedDomain;
    searchCalls.set(key, (searchCalls.get(key) || 0) + 1);
    if (searchHolds.has(key)) await new Promise(resolve => delayed.set('search:'+key,resolve));
    await new Promise(resolve => setTimeout(resolve, 60));
    return { ok: true, json: async () => ({ status: 'completed', output: [
      { type: 'web_search_call', action: { sources: [{ url: 'https://competitor.test/' }] } },
      { type: 'message', content: [{ type: 'output_text', text: '{"results":[{"title":"Competidor","url":"https://competitor.test/","snippet":"Partner management software"}]}' }] }
    ] }) };
  }
}));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.on('listening', resolve));
process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port, pid: process.pid });
process.on('message', async message => {
  try {
    let value;
    if (message.type === 'sql') value = (await pool.query(message.sql, message.args)).rows;
    if (message.type === 'metrics') value = { provider: Object.fromEntries(providerCalls), search: Object.fromEntries(searchCalls) };
    if (message.type === 'hold-search') { searchHolds.add(message.domain); value=true; }
    if (message.type === 'release') { delayed.get(message.operation)?.(); delayed.delete(message.operation); value = true; }
    if (message.type === 'stop') {
      for (const release of delayed.values()) release();
      await new Promise(resolve => server.close(resolve));
      await pool.end();
      process.send({ id: message.id, value: true });
      process.disconnect();
      return;
    }
    if (process.connected) process.send({ id: message.id, value });
  } catch (error) { process.send({ id: message.id, error: error.message }); }
});
