import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export async function auditFixture(clean, plan = 'pro', { multiPage = false, emptySearch = false, webResults = null, socialResults = [], onProgress = null, consultativeResponse, consultativeMetadata, pageOverride = {}, sourceOverride } = {}) {
  const sandbox = vm.createContext({ window: {}, URL, URLSearchParams,
    localStorage: { getItem() { return null; }, removeItem() {} }, console });
  vm.runInContext(sourceOverride ?? await readFile(clean + '/claude-integration.js', 'utf8'), sandbox);
  const bot = sandbox.window.claudeAI;
  bot.recordLabAuditSample = () => {};
  const pageData = {
    url: 'https://centro.example.test/', domain: 'centro.example.test', title: 'Centro de belleza local',
    metaDescription: 'Tratamientos faciales y manicura. Reserva una cita con el centro.',
    textContent: 'Centro de belleza. Tratamientos faciales y manicura en Madrid. Reserva tu cita.',
    h1s: ['Centro de belleza'], h1Count: 1, hasHttps: true, totalImages: 2, imagesWithoutAlt: 1,
    wordCount: 180, ctaData: [{ text: 'Reservar cita' }], contactInfo: { address: ['Madrid'], phone: ['123456789'] },
    viewport: 'width=device-width, initial-scale=1', lang: 'es', canonical: 'https://centro.example.test/', ...pageOverride
  };
  bot.resolveAuditScope = async () => ({ plan, ...bot.getAuditScope(plan) });
  const pages = count => Array.from({ length: multiPage ? count : 0 }, (_, index) => ({
    ...pageData, url: pageData.url + 'servicio-' + index, title: 'Tratamiento facial ' + index,
    content: 'Tratamiento facial profesional. Reserva tu cita en Madrid.'
  }));
  const counts = { crawl: 0, search: 0 };
  bot.fetchInternalPagesContext = async () => { counts.crawl++; return { pages: pages(bot.getAuditScope(plan).internalPages), errors: [] }; };
  bot.fetchFreePreviewPagesContext = async () => ({ pages: pages(plan === 'free' ? 2 : 0), errors: [] });
  const results = emptySearch ? [] : webResults || [{ url: 'https://otro.example.test/', domain: 'otro.example.test',
    title: 'Otro centro de belleza en Madrid', snippet: 'Tratamientos faciales y manicura. Citas disponibles.' }];
  bot.fetchExpandedCompetitiveResults = async (_queries, _site, _limit, _budget, scope = 'web') => { counts.search++; return ({
    results: scope === 'social' ? socialResults : results,
    error: emptySearch ? 'search_unavailable' : null
  }); };
  bot.enrichCompetitiveCandidates = async candidates => candidates.map(candidate => ({ ...candidate, pagePreview: null }));
  const outputs = {
    seo_analysis: JSON.stringify({ seoScore: 75, summary: 'El centro comunica sus tratamientos. Priorizar reservas.',
      topIssues: ['Reforzar las reservas'], recommendations: [{ action: 'Destacar el acceso a reservas', priority: 'alta', impact: 'Facilitar las citas' }],
      quickWins: 'Mejorar el acceso a reservas.', keywords: { primary: ['centro de belleza Madrid'], longTail: ['reservar tratamiento facial Madrid'], local: ['manicura Madrid'] } }),
    premium_reasoning_audit: JSON.stringify({ summary: 'El centro debe facilitar las reservas desde sus servicios.',
      topIssues: ['El acceso a reservas debe destacar'], recommendations: [{ action: 'Priorizar las reservas', priority: 'alta', impact: 'Facilitar citas' }], quickWins: 'Destacar reservas.' }),
    executive_refiner_pdf: JSON.stringify({ summary: 'Resumen ejecutivo final.', quickWins: 'Semana 1: Destacar reservas.' })
  };
  const calls = [];
  if (consultativeResponse !== undefined) outputs.seo_analysis = consultativeResponse;
  bot.callAPI = async (messages, options) => {
    const model = options.forceModel || bot.model;
    const body = {
      model, max_tokens: options.maxTokens, temperature: options.temperature,
      messages: [{ role: 'system', content: options.system }, ...messages],
      response_format: { type: 'json_object' }, task_type: options.taskType,
      zentra_routing: { taskType: options.taskType },
      ...(options.auditWorkflow ? { zentra_audit_workflow: options.auditWorkflow } : {}),
      ...(options.auditEvidence ? { zentra_audit_evidence: options.auditEvidence } : {})
    };
    calls.push(JSON.parse(JSON.stringify(body)));
    return { success: true, content: outputs[options.taskType], model, requestedModel: model, actualModel: model,
      ...(options.taskType === 'seo_analysis' ? { rawResponse: { audit_consultative: consultativeMetadata } } : {}) };
  };
  const result = await bot.analyzeSEO(pageData, onProgress);
  if (!result.success) throw new Error(result.error);
  return { calls, outputs, result, bot, counts };
}
