import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { auditEntitlement, PLAN_ENTITLEMENTS } from '../../release-entitlements.js';
import { buildAuditStep } from '../../release-audit-steps.js';
import { auditFixture } from './audit-fixtures.mjs';

const extension = new URL('../../../STAGING/ZENTRA_AI_CHROME_LAB_STAGING/', import.meta.url);
const frontend = readFileSync(new URL('claude-integration.js', extension), 'utf8');
const authorized = readFileSync(new URL('../../trusted-audit-builders.js', import.meta.url), 'utf8');
const pdf = readFileSync(new URL('claude-pdf-generator.js', extension), 'utf8');
const subscription = readFileSync(new URL('subscription-manager.js', extension), 'utf8');
const { jsPDF } = createRequire(import.meta.url)(fileURLToPath(new URL('lib/jspdf.umd.min.js', extension)));
const clone = value => JSON.parse(JSON.stringify(value));
function fixture({ plan = 'free', entitlement = plan, unlimited = false, branding = {}, source = frontend } = {}) {
  const texts = [];
  function RecordingPDF() {
    const doc = new jsPDF();
    const original = doc.text.bind(doc);
    doc.text = (text, ...args) => { texts.push(...(Array.isArray(text) ? text : [text])); return original(text, ...args); };
    doc.output = () => ({ text: texts.join('\n'), pages: doc.getNumberOfPages() });
    return doc;
  }
  const sandbox = vm.createContext({ window: { jspdf: { jsPDF: RecordingPDF } }, URL, URLSearchParams,
    localStorage: { getItem() { return null; }, removeItem() {} }, console: { log() {}, warn() {}, error() {} },
    fetch: () => assert.fail('No providers or network') });
  vm.runInContext(subscription, sandbox);
  const manager = sandbox.window.zentraSubscription;
  manager.getUserState = async () => ({ plan, status: 'active', unlimited_agency: unlimited });
  manager.getPDFBranding = async () => branding;
  sandbox.window.zentraOperations = { getAuditEntitlement: () => entitlement ? auditEntitlement({ plan: entitlement, status: 'active' }) : null };
  vm.runInContext(source, sandbox);
  vm.runInContext(pdf, sandbox);
  const generator = sandbox.window.claudePDFGenerator;
  generator.getDefaultBrandLogoDataUrl = async () => '';
  return { bot: sandbox.window.claudeAI, generator, manager, sandbox, texts };
}
const page = { url: 'https://provider.example.test/', domain: 'provider.example.test', readStatus: 'complete',
  title: 'Marketing para peluquerías, barberías, estéticas y spa', h1s: ['Marketing para negocios de belleza'], h1Count: 1,
  metaDescription: 'Diseño web y publicidad digital para negocios de belleza en España.',
  textContent: 'Ayudamos con marketing y diseño web para negocios de belleza. No ofrecemos tratamientos de salón.',
  contactInfo: { geolocationKeywords: ['España'] }, totalImages: 3, imagesWithoutAlt: 0, canonical: 'https://provider.example.test/',
  viewport: 'width=device-width, initial-scale=1', hasHttps: true };
const analysis = () => ({ seoScore: 79, summary: 'Lectura provisional de las URLs observadas.',
  technicalStatus: {}, recommendations: [], topIssues: [], keywords: { primary: [], local: [], longTail: [] },
  coverage: { discovered: 3, attempted: 3, complete: 3, partial: 0, insufficient: 0, failed: 0 },
  freeExpandedContext: { pagesObserved: 3, seoScoreAverage: 79,
    heavyImagesInsights: { totalHeavyImages: 3, totalPagesWithHeavyImages: 1 } } });

for (const plan of ['free', 'starter', 'pro', 'agency']) test(plan + ': actual PDF text keeps promo Free-only and default Zentra identity', async () => {
  const { generator } = fixture({ plan });
  const result = await generator.createPDF(clone(page), analysis());
  assert.equal(/Este PDF gratuito/.test(result.text), plan === 'free');
  assert.equal(/Subí de plan/.test(result.text), plan === 'free');
  assert.match(result.text, /ZENTRA AI/);
  assert.doesNotMatch(result.text, /imagen\(es\) pesadas/);
  if (plan === 'free') {
    assert.match(result.text, /Starter: 300 acciones y 5 auditorías/);
    assert.doesNotMatch(result.text, /Starter:.*3 auditorías/);
    assert.match(result.text, /Medir los bytes/);
  }
});
test('Agency test identity survives underlying Free reservation only in PDF presentation; no scope mutation', async () => {
  const { generator, sandbox, manager } = fixture({ plan: 'agency', entitlement: 'free', unlimited: true });
  const before = clone(sandbox.window.zentraOperations.getAuditEntitlement());
  const limits = clone(manager.planLimits);
  const result = await generator.createPDF(clone(page), analysis());
  assert.doesNotMatch(result.text, /Este PDF gratuito|Subí de plan|Starter:/);
  assert.deepEqual(clone(sandbox.window.zentraOperations.getAuditEntitlement()), before);
  assert.deepEqual(clone(manager.planLimits), limits);
});
test('normal reservation remains authoritative; missing reservation uses known active account for presentation', async () => {
  assert.equal(await fixture({ plan: 'agency', entitlement: 'free' }).generator.resolvePDFPresentationPlan(), 'free');
  assert.equal(await fixture({ plan: 'pro', entitlement: null }).generator.resolvePDFPresentationPlan(), 'pro');
});
for (const plan of ['free', 'starter', 'pro', 'agency']) test(plan + ': unchanged branding permissions, empty default and configured values', async () => {
  const input = { brand_name: 'Estudio Ejemplo', brand_color: '#245678', logo_data_url: 'data:custom-logo', logo_name: 'example.png' };
  const { generator } = fixture({ plan, branding: input });
  generator.getDefaultBrandLogoDataUrl = async () => 'data:zentra-logo';
  const result = await generator.getPDFBrandingContext(plan);
  assert.equal(result.useCustomBranding, ['pro', 'agency'].includes(plan));
  assert.equal(result.brandName, ['pro', 'agency'].includes(plan) ? input.brand_name : 'ZENTRA AI');
  assert.equal(result.logoDataUrl, plan === 'agency' ? input.logo_data_url : plan === 'pro' ? '' : 'data:zentra-logo');
  assert.deepEqual(clone(result.accentRgb), ['pro', 'agency'].includes(plan) ? [36, 86, 120] : [17, 17, 17]);
  assert.deepEqual(input, { brand_name: 'Estudio Ejemplo', brand_color: '#245678', logo_data_url: 'data:custom-logo', logo_name: 'example.png' });
  const empty = await fixture({ plan }).generator.getPDFBrandingContext(plan);
  assert.equal(empty.useCustomBranding, false); assert.equal(empty.brandName, 'ZENTRA AI');
});
test('commercial copy reads existing plan configuration, never unlimited effective allowance', () => {
  const { generator, manager } = fixture({ plan: 'agency', unlimited: true });
  for (const plan of ['starter', 'pro', 'agency']) assert.equal(manager.planLimits[plan].audits, PLAN_ENTITLEMENTS[plan].audits);
  manager.planLimits.starter = { actions: 301, audits: 6 };
  assert.match(generator.getFreePDFPlanCopy()[0], /301 acciones y 6 auditorías/);
  assert.doesNotMatch(generator.getFreePDFPlanCopy().join(' '), /999999/);
});
test('existing UI permissions agree with PDF gates; no Starter color permission is introduced', () => {
  const popup = readFileSync(new URL('popup.js', extension), 'utf8');
  const code = popup.slice(popup.indexOf('function getPDFBrandingAccess('), popup.indexOf('function hasPDFBrandingContent('));
  const sandbox = vm.createContext({ formatPlanName: value => value });
  vm.runInContext(code, sandbox);
  for (const plan of ['free', 'starter', 'pro', 'agency']) {
    const access = sandbox.getPDFBrandingAccess(plan);
    assert.equal(access.enabled, ['pro', 'agency'].includes(plan));
    assert.equal(access.showLogo, plan === 'agency');
  }
});
for (const [label, source] of [['extension', frontend], ['authorized builder', authorized]]) {
  test(label + ': provider activity stays distinct from client sector; keywords remain hypotheses', () => {
    const { bot } = fixture({ source });
    const input = { keywords: { primary: ['spa', 'peluquería', 'barbería'], longTail: ['spa en España'], local: [] } };
    const result = bot.ensureSeoKeywordSuggestions(input, clone(page), { plan: 'pro' }, []);
    assert.match(result.keywords.primary[0], /Marketing para/);
    assert.doesNotMatch(JSON.stringify(result.keywords), /"(?:spa|peluquería|barbería)(?: en españa| españa)?"/i);
    assert.match(result.businessFocus.observedAudience.join(' '), /peluquerías/);
    assert.equal(result.keywordStatus, 'observed_topics');
    assert.match(source, /Distingue la actividad y los servicios que vende la empresa/);
  });
  test(label + ': real salon and insufficient/legal evidence retain conservative behavior', () => {
    const { bot } = fixture({ source });
    const salon = { ...clone(page), title: 'Peluquería y spa en Madrid', h1s: ['Peluquería'], metaDescription: 'Corte y coloración. Reserva tu cita.', textContent: 'Peluquería y spa en Madrid.' };
    const result = bot.ensureSeoKeywordSuggestions({ keywords: {} }, salon, {}, []);
    assert.ok(result.keywords.primary.some(term => /peluquería|spa/.test(term)));
    const legal = bot.ensureSeoKeywordSuggestions({ keywords: {} }, { url: 'https://example.test/privacy', title: 'Política de privacidad' }, {}, []);
    assert.equal(legal.keywordStatus, 'insufficient_evidence');
  });
  test(label + ': H1 findings, action plan and internal-link headings qualify observed coverage; scoring unchanged', () => {
    const { bot } = fixture({ source });
    const inner = { ...clone(page), url: page.url + 'planes', title: 'Planes', h1s: [], h1Count: 0, internalLinks: [], readStatus: 'complete' };
    const score = bot.buildAggregateTechnicalContext(page, [inner]).seoScoreAverage;
    const findings = bot.buildPageSpecificFindings(clone(page), [inner]);
    const missing = findings.find(f => /No se observó un H1/.test(f.issue));
    assert.ok(missing); assert.match(missing.recommendation, /solo si se confirma/);
    assert.doesNotMatch(missing.issue, /lo que dificulta/);
    const plan = bot.buildPrioritizedAuditPlan({ pageSpecificFindings: findings,
      recommendations: [{ action: 'Verificar el H1 de ' + inner.url, priority: 'alta' }] });
    assert.equal(plan[0].confidence, 'requiere validación');
    assert.equal(bot.buildAggregateTechnicalContext(page, [inner]).seoScoreAverage, score);
    const links = bot.buildInterlinkingInsights(page, [inner]);
    assert.doesNotMatch(JSON.stringify(links), /Páginas aisladas dentro del sitio/);
  });
  test(label + ': partial coverage, ALT intent and Schema caveats survive narrative normalization', () => {
    const { bot } = fixture({ source });
    const inner = { ...clone(page), url: page.url + 'precios', title: 'Precios', h1Count: 0, h1s: [], internalLinks: [], readStatus: 'complete' };
    const partial = { url: page.url + 'servicios', title: 'Servicios', readStatus: 'partial', content: 'Lectura sintética parcial' };
    const draft = bot.applyAuditEvidence(analysis(), page, [inner, partial]);
    draft.pageSpecificFindings = bot.buildPageSpecificFindings(page, [inner, partial]);
    draft.recommendations = [{ action: 'Agregar un H1 en ' + inner.url, priority: 'alta' }];
    draft.topIssues = ['Falta H1 en ' + inner.url];
    draft.summary = 'Falta H1 en ' + inner.url;
    const result = bot.normalizeSeoPdfQuality(draft, { pageData: page, auditScope: { plan: 'pro' }, aggregateTechnicalContext: draft.aggregateTechnicalContext });
    assert.match(result.summary, /revisión confirma su ausencia/);
    assert.match(result.recommendations[0].action, /revisión confirma su ausencia/);
    assert.match(result.actionPlan[0].action, /revisión confirma su ausencia/);
    assert.equal(result.actionPlan[0].confidence, 'requiere validación');
    assert.match(result.schemaInsights.disclaimer, /no certificación/);
    assert.equal(result.coverage.partial, 1);
    assert.equal(result.coverage.complete, 2);
  });
}
test('technical scoring method is byte-identical to approved checkpoints', () => {
  for (const [file, current, cwd] of [['claude-integration.js', frontend, fileURLToPath(extension)],
    ['trusted-audit-builders.js', authorized, fileURLToPath(new URL('../../', import.meta.url))]]) {
    const prior = execFileSync('git', ['show', 'HEAD:' + file], { cwd, encoding: 'utf8' });
    for (const method of ['buildAggregateTechnicalContext', 'calculateBasicSEOScore']) {
      const extract = text => { const start = text.indexOf('\n  ' + method + '('); const end = text.indexOf('\n  }', start) + 4; return text.slice(start, end); };
      assert.ok(extract(current)); assert.equal(extract(current), extract(prior));
    }
  }
});
test('frontend and authorized builder retain identical focal SEO methods and root instructions', () => {
  for (const [start, end] of [['ensureSeoKeywordSuggestions(', 'normalizeCompetitiveText('], ['buildPrioritizedAuditPlan(', 'async refineExecutivePdfBlocks(']]) {
    const section = code => code.slice(code.indexOf('\n  ' + start), code.indexOf('\n  ' + end, code.indexOf('\n  ' + start) + 1));
    assert.ok(section(frontend)); assert.equal(section(frontend), section(authorized));
  }
});
for (const plan of ['free', 'agency']) test(plan + ': existing mocked pipeline and authorized root remain compatible', async () => {
  const result = await auditFixture(fileURLToPath(extension), plan, { multiPage: true, emptySearch: true });
  assert.equal(result.result.success, true);
  const first = result.calls[0];
  const built = await buildAuditStep('seo_analysis', { body: first, context: first.zentra_audit_workflow });
  assert.deepEqual(built.messages, first.messages);
  assert.ok(result.result.analysis.schemaInsights);
  assert.ok(result.result.analysis.coverage);
  assert.ok(result.result.analysis.actionPlan);
});
