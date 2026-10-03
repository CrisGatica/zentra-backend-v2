import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const base = process.env.ZENTRA_BASE;
assert.ok(base, 'ZENTRA_BASE required');
const backend = base + '/zentra-backend';
const chrome = base + '/publicacion/chrome-store/zentra-ai-chrome-store-clean';
const source = await readFile(backend + '/server.js', 'utf8');
const flag = source.match(/^const ZENTRA_AUDIO_TRANSCRIPTION_ENABLED = .*;$/m)?.[0];
assert.ok(flag, 'actual environment flag declaration');
const start = source.indexOf('app.post("/api/audio/transcribe",');
const end = source.indexOf('const lemonHandlers =', start);
assert.ok(start >= 0 && end > start, 'actual audio handler boundary');
const route = source.slice(start, end);
assert.ok(source.indexOf('app.use(createApiSecurity(') < start, 'auth precedes handler');
const { createApiSecurity } = await import(pathToFileURL(backend + '/release-security.js'));
const { createOperationGuard } = await import(pathToFileURL(backend + '/release-operations.js'));
let count = 0;
const pass = name => { count++; console.log('PASS', name); };

function fixture(value, outcome = 'ok') {
  const calls = { provider: 0, quota: 0, auth: 0 };
  let handler;
  const context = vm.createContext({
    process: { env: value === undefined ? {} : { ZENTRA_AUDIO_TRANSCRIPTION_ENABLED: value } },
    app: { post(path, fn) { assert.equal(path, '/api/audio/transcribe'); handler = fn; } },
    transcribeDesktopAudio: async input => {
      calls.provider++;
      assert.deepEqual(Object.keys(input).sort(), ['audioBase64', 'language', 'mimeType']);
      if (outcome === 'timeout') throw Object.assign(new Error('private provider detail'), { name: 'AbortError' });
      if (outcome === 'invalid') return { ok: false, status: 400, error: 'private provider detail' };
      return { ok: true, text: 'Texto editable', model: 'private-model' };
    }
  });
  vm.runInContext(flag + '\n' + route, context);
  const client = {
    auth: { async getUser(token) {
      calls.auth++;
      return token === 'valid'
        ? { data: { user: { id: 'verified-owner', email: 'owner@example.test', confirmed_at: '2026-09-29' } } }
        : { error: 'invalid or expired' };
    } },
    rpc: async () => { calls.quota++; throw new Error('Audio must not consume a Chrome action'); }
  };
  const security = createApiSecurity({ client });
  const operation = createOperationGuard({ client });
  async function request(token = 'valid', body = { audioBase64: 'YWJj', mimeType: 'audio/webm', language: 'es' }) {
    const req = { method: 'POST', path: '/api/audio/transcribe', ip: '127.0.0.1', body,
      get(name) { return name === 'Authorization' && token ? 'Bearer ' + token : undefined; } };
    const res = { code: 200, status(code) { this.code = code; return this; }, set() { return this; },
      json(payload) { this.payload = payload; return this; } };
    await security(req, res, () => operation(req, res, () => handler(req, res)));
    return { req, res };
  }
  return { request, calls };
}

for (const value of [undefined, '', 'false', 'FALSE', '0', '1', 'yes', 'tru']) {
  const test = fixture(value);
  const { res } = await test.request();
  assert.equal(res.code, 503);
  assert.equal(JSON.stringify(res.payload), JSON.stringify({ error: 'Esta funcion no esta disponible.' }));
  assert.equal(test.calls.provider, 0);
  assert.equal(test.calls.quota, 0);
  assert.equal(test.calls.auth, 1);
}
pass('default/unset/false/malformed flag: authenticated rejection, zero provider and zero consumption');

for (const value of [undefined, 'true']) {
  for (const token of [null, 'invalid', 'expired']) {
    const test = fixture(value);
    const { res } = await test.request(token);
    assert.equal(res.code, 401);
    assert.equal(test.calls.provider, 0);
    assert.equal(test.calls.quota, 0);
  }
}
pass('missing/invalid/expired auth: rejected before provider with either flag state');

const disabled = fixture('false');
const forged = { audioBase64: 'YWJj', userId: 'other-user', plan: 'agency',
  ZENTRA_AUDIO_TRANSCRIPTION_ENABLED: true, actionId: 'other-action' };
const blocked = await disabled.request('valid', forged);
assert.equal(blocked.req.auth.userId, 'verified-owner');
assert.equal(blocked.res.code, 503);
await Promise.all([disabled.request('valid', forged), disabled.request('valid', forged)]);
await disabled.request('valid', forged);
assert.equal(disabled.calls.provider, 0);
assert.equal(disabled.calls.quota, 0);
pass('body cannot enable audio; concurrent/replayed requests remain blocked without provider or debit');

for (const value of ['true', ' TRUE ']) {
  const enabled = fixture(value);
  const { req, res } = await enabled.request();
  assert.equal(req.auth.userId, 'verified-owner');
  assert.equal(res.code, 200);
  assert.equal(JSON.stringify(res.payload), JSON.stringify({ success: true, text: 'Texto editable' }));
  assert.equal(enabled.calls.provider, 1);
  assert.equal(enabled.calls.quota, 0);
}
pass('explicit opt-in retains authenticated transcription contract, no invented Beta quota or public model');

for (const [outcome, status] of [['invalid', 400], ['timeout', 504]]) {
  const test = fixture('true', outcome);
  const { res } = await test.request();
  assert.equal(res.code, status);
  assert.equal(JSON.stringify(res.payload), JSON.stringify({ error: 'No se pudo transcribir el audio' }));
  assert.equal(test.calls.provider, 1);
  assert.equal(test.calls.quota, 0);
}
pass('enabled handler retains controlled validation/timeout errors without leaking provider details');

const chatSource = await readFile(chrome + '/claude-chatbot.js', 'utf8');
assert.ok(chatSource.includes('this.isDesktopShell = Boolean(window.zentraDesktop?.onExtensionContextUpdated)'));
assert.equal((chatSource.match(/this\.apiProvider\?\.transcribeAudio\?\./g) || []).length, 1);
const methods = chatSource.slice(chatSource.indexOf('  async startDesktopVoiceRecording()'), chatSource.indexOf('  // ===== IMAGENES ====='));
assert.ok(methods.includes('if (this.isDesktopShell && this.apiProvider?.transcribeAudio)'));
class Recognition {
  start() { this.onstart(); }
  stop() { this.onend(); }
}
const Type = vm.runInNewContext('class VoiceProbe { ' + methods + ' }; VoiceProbe', {
  window: { SpeechRecognition: Recognition }, console
});
const voice = new Type();
const calls = { backend: 0, send: 0, pending: 0 };
Object.assign(voice, {
  isDesktopShell: false,
  elements: { input: { value: '', style: {}, scrollHeight: 40 } },
  setMicButtonState() {}, addSystemMessage() { assert.fail('Unexpected dictation error'); },
  apiProvider: { transcribeAudio() { calls.backend++; assert.fail('Chrome reached paid transcription'); } },
  savePendingChatRequest() { calls.pending++; }, sendMessage() { calls.send++; }
});
await voice.startVoiceRecording();
const final = [{ transcript: 'Preparame un anuncio para esta página' }];
final.isFinal = true;
voice.recognition.onresult({ resultIndex: 0, results: [final] });
voice.stopVoiceRecording();
assert.match(voice.elements.input.value, /Preparame un anuncio/);
assert.deepEqual(calls, { backend: 0, send: 0, pending: 0 });
assert.equal(voice.lastInputModality, 'audio');
pass('actual Chrome microphone path: native recognition fills editable input without backend audio or automatic chat');

console.log('TOTAL', count, '(local source; mocked Auth/provider; no production calls)');
