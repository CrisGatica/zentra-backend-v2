import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { auditFixture } from './audit-fixtures.mjs';

const base = process.env.ZENTRA_BASE;
assert.ok(base, 'ZENTRA_BASE is required');
const source = await readFile(base + '/publicacion/chrome-store/zentra-ai-chrome-store-clean/claude-integration.js', 'utf8');
const sandbox = vm.createContext({ window: {}, URL, console, localStorage: { getItem() { return null; } } });
vm.runInContext(source, sandbox);
const ai = sandbox.window.claudeAI;

const complete = '{"seoScore":97,"summary":"Hallazgo concreto","recommendations":[{"action":"Corregir H1"}]}';
assert.equal(ai.parseSEOAnalysis(complete).summary, 'Hallazgo concreto');
assert.equal(ai.recoverPartialSEOAnalysis(complete)?.summary, 'Hallazgo concreto');

const truncated = '{"seoScore":97,"domain":"medalisalon.com","summary":"Revisar \\"inicio\\" y H1","technicalStatus":{"title":"Título observado"},"recommendations":[{"action":"Texto sin terminar';
const recovered = ai.recoverPartialSEOAnalysis(truncated);
assert.equal(recovered?.summary, 'Revisar "inicio" y H1');
assert.equal(recovered?.technicalStatus?.title, 'Título observado');
assert.equal(recovered?.recommendations, undefined);
assert.equal(ai.recoverPartialSEOAnalysis('{"seoScore":97,"summary":"sin cerrar'), null);
assert.equal(ai.recoverPartialSEOAnalysis('respuesta sin JSON'), null);

const prompt = source.match(/const systemPrompt = `(Eres un auditor SEO profesional[\s\S]*?)`;/);
assert.ok(prompt, 'SEO prompt must be present');
assert.match(prompt[1], /1600 tokens/);
assert.equal((prompt[1].match(/"priority": "(?:alta|media|baja)"/g) || []).length, 3);
console.log('Audit JSON recovery and output budget: 6 passed');

const { recoverAuditConsultative, extractAuditResponse } = await import(pathToFileURL(base + '/zentra-backend/release-audit-json.js'));
const value = { summary: 'Servicio de software documentado.', topIssues: [], recommendations: [{ action: 'Precisar la propuesta de valor' }],
  keywords: { primary: ['software SEO'], longTail: [], local: [] } };
const valid = JSON.stringify(value);
const response = (content, finish = 'completed') => ({ ok: true, provider: 'openai', api: 'responses',
  data: { status: finish === 'max_output_tokens' ? 'incomplete' : finish,
    incomplete_details: finish === 'max_output_tokens' ? { reason: finish } : null,
    output: [{ type: 'reasoning', content: [{ type: 'summary_text', text: 'not final' }] },
      { type: 'message', content: [{ type: 'output_text', text: content }] }] } });
let count = 0;
for (const [name, raw, retry] of [
  ['A valid', valid, 0], ['B fences', '```json\n' + valid + '\n```', 0],
  ['C prefix/suffix', 'Resultado:\n' + valid + '\nFin.', 0],
  ['D only missing container', valid.slice(0, -1), 0],
  ['E unfinished value', '{"summary":"Servicio sin terminar', 1],
  ['F missing required fields', '{"summary":"Solo un resumen"}', 1],
  ['G not JSON', 'No puedo completar el informe.', 1],
  ['H long limit', '{"summary":"' + 'x'.repeat(40000), 1],
  ['text block array', valid, 0],
  ['safe envelope', JSON.stringify({ analysis: value }), 0],
  ['literal control in string', valid.replace('documentado.', 'documentado.\nNueva linea.'), 0],
  ['braces in quoted value', valid.replace('documentado.', 'documentado. { } [ ]'), 0]
]) {
  let regenerated = 0;
  const input = name === 'text block array' ? { ok: true, data: { choices: [{ message: { content: [{ type: 'text', text: raw }] }, finish_reason: 'stop' }] } }
    : response(raw, name.startsWith('H') ? 'max_output_tokens' : 'completed');
  const actual = await recoverAuditConsultative({ initial: input, regenerate: async () => { regenerated++; return response(valid); } });
  assert.equal(regenerated, retry, name);
  assert.equal(actual.metadata.attempts, retry + 1, name);
  assert.ok(actual.analysis.summary, name);
  assert.equal(actual.metadata.status, ['A valid', 'text block array', 'braces in quoted value'].includes(name) ? 'complete' : 'recovered', name);
  console.log('PASS', name); count++;
}
for (const regeneration of [async () => response('not JSON'), async () => { throw new Error('secret in provider exception'); }, async () => ({ ok: false })]) {
  let retries = 0;
  const actual = await recoverAuditConsultative({ initial: response('{"summary":"unfinished', 'max_output_tokens'),
    regenerate: async () => { retries++; return regeneration(); } });
  assert.equal(actual.metadata.status, 'consultative-degraded'); assert.equal(actual.analysis, null); assert.equal(retries, 1);
  count++;
}
const diagnostics = [];
await recoverAuditConsultative({ initial: response('{"summary":"name@example.test sk-secret 1234567', 'max_output_tokens'),
  regenerate: async () => response(valid), debug: true, log: item => diagnostics.push(item) });
assert.equal(diagnostics.length, 2);
assert.equal(diagnostics[0].finishReason, 'max_output_tokens'); assert.equal(diagnostics[0].truncated, true);
assert.ok(diagnostics[0].attempts.some(attempt => attempt.error));
assert.ok(diagnostics[0].head.length <= 120 && diagnostics[0].tail.length <= 120);
assert.doesNotMatch(JSON.stringify(diagnostics), /name@|sk-secret|1234567|documentado/);
let logged = false;
await recoverAuditConsultative({ initial: response(valid), regenerate: () => { throw new Error('not expected'); }, log: () => { logged = true; } });
assert.equal(logged, false);
assert.equal(extractAuditResponse({ provider: 'anthropic', data: { content: [{ type: 'text', text: valid }], stop_reason: 'end_turn' } }).content, valid);
assert.equal(ai.inspectSEOConsultative(valid + '\n```').analysis.summary, value.summary);
assert.equal(ai.inspectSEOConsultative('{"summary":"ok","keywords":{}}').analysis, null);
assert.equal(ai.inspectSEOConsultative('x'.repeat(1048577)).attempts[0].error, 'response_too_large');
const missingMetadata = ai.createSEOConsultativeDiagnostic(valid, ai.inspectSEOConsultative(valid));
assert.equal(missingMetadata.recoveryMetadataPresent, false);
assert.equal(missingMetadata.providerAttempts, null); // Unknown is not "no retry".
const confirmedRetry = ai.createSEOConsultativeDiagnostic(valid, ai.inspectSEOConsultative(valid), 'completed', { attempts: 2, status: 'recovered' });
assert.equal(confirmedRetry.recoveryMetadataPresent, true);
assert.equal(confirmedRetry.providerAttempts, 2);
assert.equal(confirmedRetry.recoveryStatus, 'recovered');
const unsafeMetadata = ai.createSEOConsultativeDiagnostic(valid, ai.inspectSEOConsultative(valid), 'secret', { attempts: 'secret', status: 'secret', token: 'secret' });
assert.equal(unsafeMetadata.providerAttempts, null);
assert.equal(unsafeMetadata.recoveryStatus, null);
assert.doesNotMatch(JSON.stringify(unsafeMetadata), /secret/);
console.log('PASS debug distinguishes absent recovery metadata from confirmed retry; values allowlisted');
// The original parser rejected a missing final container, but accepted an incomplete shape.
assert.throws(() => ai.parseSEOAnalysis(valid.slice(0, -1)));
assert.equal(ai.parseSEOAnalysis('{"summary":"Solo un resumen"}').summary, 'Solo un resumen');
assert.equal(ai.inspectSEOConsultative('{"summary":"Solo un resumen"}').analysis, null);
count += 6;
const clean = base + '/publicacion/chrome-store/zentra-ai-chrome-store-clean';
for (const multiPage of [false, true]) {
  const normal = await auditFixture(clean, 'pro', { multiPage });
  const degraded = await auditFixture(clean, 'pro', { multiPage, consultativeResponse: '',
    consultativeMetadata: { status: 'consultative-degraded', attempts: 2 } });
  assert.equal(degraded.result.analysis.consultativeStatus, 'consultative-degraded');
  assert.equal(degraded.calls.length, 1); assert.equal(degraded.counts.crawl, 1); assert.equal(degraded.counts.search, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(degraded.result.analysis.keywords)), { primary: [], longTail: [], local: [] });
  assert.equal(degraded.result.analysis.seoScore, normal.result.analysis.seoScore);
  assert.deepEqual(JSON.parse(JSON.stringify(degraded.result.analysis.coverage)), JSON.parse(JSON.stringify(normal.result.analysis.coverage)));
  const recovered = await auditFixture(clean, 'pro', { multiPage, consultativeResponse: valid, consultativeMetadata: { status: 'recovered', attempts: 2 } });
  assert.equal(recovered.calls.length, 3); assert.equal(recovered.counts.crawl, 1);
  assert.equal(recovered.result.analysis.consultativeStatus, 'recovered');
  console.log('PASS full pipeline, degraded keyword/search isolation, one crawl and normal score:', multiPage ? 'multiple pages' : 'single page'); count++;
}
console.log('Consultative validation/recovery:', count, 'checks passed');
