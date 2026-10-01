import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { auditFixture } from './audit-fixtures.mjs';

const base = process.env.ZENTRA_BASE;
const clean = base + '/publicacion/chrome-store/zentra-ai-chrome-store-clean';
const { buildAuditStep } = await import(pathToFileURL(base + '/zentra-backend/release-audit-steps.js'));
const json = value => JSON.parse(JSON.stringify(value));
const current = await readFile(clean + '/claude-integration.js', 'utf8');
const pinned = await readFile(base + '/zentra-backend/trusted-audit-builders.js', 'utf8');
const withoutTransportMetadata = current
  .replace(/      if \(options\.auditWorkflow\) requestBody\.zentra_audit_workflow = options\.auditWorkflow;\n/, '')
  .replace(/      if \(options\.auditEvidence\) requestBody\.zentra_audit_evidence = options\.auditEvidence;\n/, '')
  .replace(/    \/\/ Preserve the observed evidence; the server reconstructs the analysis, not a client prompt\.\n    this\.auditCompetitiveEvidence = JSON\.parse\(JSON\.stringify\(\{\n      queries: searchQueries, results: serpResults, enrichedResults, error: serpError\n    \}\)\);\n/, '')
  .replace(/        auditWorkflow: \{\n          version: 1, pageData, auditScope, internalPagesResult, freePreviewPagesResult,\n          executiveRefinerEnabled: this\.labExecutiveRefinerEnabled\n        \},\n/, '')
  .replace(/            auditEvidence: this\.auditCompetitiveEvidence,\n/, '');
assert.equal(withoutTransportMetadata, pinned);
console.log('PASS complete Audit source unchanged except workflow/evidence transport metadata');
for (const plan of ['free', 'starter', 'pro', 'agency']) {
  const { calls, outputs } = await auditFixture(clean, plan);
  assert.equal(calls.length, ['pro', 'agency'].includes(plan) ? 3 : 2);
  const root = { body: calls[0], context: calls[0].zentra_audit_workflow };
  const evidence = calls[1].zentra_audit_evidence;
  const steps = calls.map(body => ({ step_name: body.task_type, body, state: 'done', response: { text: outputs[body.task_type] } }));
  for (const call of calls) {
    const built = await buildAuditStep(call.task_type, root, steps, evidence);
    assert.deepEqual(json(built.messages), call.messages, plan + ': ' + call.task_type);
    assert.equal(built.model, call.model); assert.equal(built.max_tokens, call.max_tokens);
    assert.equal(built.temperature, call.temperature);
    assert.deepEqual(json(built.response_format), call.response_format);
    console.log('PASS unchanged audit prompt and generation options:', plan, call.task_type);
  }
  await assert.rejects(buildAuditStep('premium_reasoning_audit', root, steps, { ...evidence, queries: ['OTRA CONSULTA'] }));
  await assert.rejects(buildAuditStep('premium_reasoning_audit', root, [], evidence));
  await assert.rejects(buildAuditStep('pdf_polish', root, steps, evidence));
  await assert.rejects(buildAuditStep('premium_reasoning_audit', root, steps, {
    ...evidence, enrichedResults: [{ ...evidence.enrichedResults[0], title: 'OTRA CONSULTA' }]
  }));
  console.log('PASS audit rejects unrelated evidence, missing predecessor and unauthorized stage:', plan);
}
for (const plan of ['free', 'starter', 'pro', 'agency']) {
  const { calls, outputs } = await auditFixture(clean, plan, { multiPage: true, emptySearch: true });
  const root = { body: calls[0], context: calls[0].zentra_audit_workflow };
  const steps = calls.map(body => ({ step_name: body.task_type, body, state: 'done', response: { text: outputs[body.task_type] } }));
  for (const call of calls) {
    const built = await buildAuditStep(call.task_type, root, steps, calls[1].zentra_audit_evidence);
    assert.deepEqual(json(built.messages), call.messages);
  }
  console.log('PASS multiple pages and unavailable competitor search preserve full workflow:', plan);
}
{
  const socialResults = [{ url: 'https://www.instagram.com/centrobellezamadrid/', domain: 'instagram.com',
    title: 'Centro Belleza Madrid | Instagram', snippet: 'Tratamientos faciales y manicura en Madrid. Reservas.' }];
  const { calls, outputs } = await auditFixture(clean, 'pro', { webResults: [], socialResults });
  const root = { body: calls[0], context: calls[0].zentra_audit_workflow };
  const evidence = calls[1].zentra_audit_evidence;
  const steps = calls.map(body => ({ step_name: body.task_type, body, state: 'done', response: { text: outputs[body.task_type] } }));
  assert.deepEqual(evidence.searchRuns.map(run => run.scope), ['web', 'social']);
  assert.equal(evidence.results.length, 1);
  for (const call of calls) {
    const built = await buildAuditStep(call.task_type, root, steps, evidence);
    assert.deepEqual(json(built.messages), call.messages, 'social fallback: ' + call.task_type);
  }
  const forged = json(evidence);
  forged.searchRuns[1].results[0].url = 'https://inventado.example/';
  await assert.rejects(buildAuditStep('premium_reasoning_audit', root, steps, forged));
  console.log('PASS social fallback replays all phases and rejects altered evidence');
}
{
  const { calls, outputs } = await auditFixture(clean, 'pro', { emptySearch: true });
  const root = { body: calls[0], context: calls[0].zentra_audit_workflow };
  const steps = calls.map(body => ({ step_name: body.task_type, body, state: 'done', response: { text: outputs[body.task_type] } }));
  const forged = json(calls[1].zentra_audit_evidence);
  const socialQueries = forged.queries.filter(query => !/-site:/i.test(query));
  forged.searchRuns.push({ scope: 'social', queries: socialQueries.length ? socialQueries : forged.queries.slice(0, 1),
    results: [], enrichedResults: [], error: null });
  await assert.rejects(buildAuditStep('premium_reasoning_audit', root, steps, forged));
  console.log('PASS unused social stage cannot be added to frozen evidence');
}
