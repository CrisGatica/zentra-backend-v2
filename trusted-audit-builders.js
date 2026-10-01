// ===== ZENTRA AI - Integracion SEO =====

class ClaudeAI {
  constructor() {
    this.apiProvider = window.ZentraAIProvider || null;
    this.apiUrl = this.apiProvider?.API_URL || 'https://zentra-backend-v2.onrender.com/api/chat';
    this.model = 'gpt-6-luna';
    this.maxTokens = 4096;
    this.temperature = 0.7;
    this.debugSamplesStorageKey = 'zentra-chat-debug-samples';
    this.internalDebugEnabled = window.__ZENTRA_INTERNAL_DEBUG__ === true;
    this.maxDebugSamples = 50;
    const storedPremiumReasoning = localStorage.getItem('zentra-lab-premium-reasoning');
    this.labPremiumReasoningEnabled = storedPremiumReasoning === null
      ? true
      : storedPremiumReasoning === '1';
    const storedExecutiveRefiner = localStorage.getItem('zentra-lab-executive-refiner');
    this.labExecutiveRefinerEnabled = storedExecutiveRefiner === null
      ? true
      : storedExecutiveRefiner === '1';
    this.labReasoningModel = 'gpt-6-luna';
    this.labExecutiveRefinerModel = 'gpt-6.1-sol';
    this.labExecutiveRefinerMaxTokens = 900;
    this.labExecutiveRefinerTemperature = 0.2;
    this.modelPricingPer1M = {
      'gpt-6-luna': { input: 0.10, output: 0.50 },
      'gpt-6.1-sol': { input: 2.00, output: 10.00 }
    };
    this.exposeLabDebugHelpers();
  }

  exposeLabDebugHelpers() {
    if (!this.internalDebugEnabled) {
      try {
        localStorage.removeItem(this.debugSamplesStorageKey);
        delete window.__zentraLabExperiment;
        delete window.__zentraChatDebug;
      } catch (_) {
        window.__zentraLabExperiment = undefined;
        window.__zentraChatDebug = undefined;
      }
      return;
    }

    window.__zentraLabExperiment = window.__zentraLabExperiment || {};
    window.__zentraLabExperiment.premiumReasoning = Boolean(this.labPremiumReasoningEnabled);
    window.__zentraLabExperiment.reasoningModel = this.labReasoningModel;
    window.__zentraLabExperiment.executiveRefinerEnabled = Boolean(this.labExecutiveRefinerEnabled);
    window.__zentraLabExperiment.executiveRefinerModel = this.labExecutiveRefinerModel;

    window.__zentraChatDebug = window.__zentraChatDebug || {};
    window.__zentraChatDebug.getLastSample = () => {
      const samples = this.readDebugSamples();
      const last = samples.length ? samples[samples.length - 1] : null;
      if (!last) return null;
      return {
        model: last.actualModel || last.model || null,
        inputTokens: last.inputTokens ?? null,
        outputTokens: last.outputTokens ?? null,
        totalTokens: last.totalTokens ?? null,
        estimatedCost: last.estimatedCost ?? null,
        latencyMs: last.latencyMs ?? null,
        taskType: last.taskType || null,
        contextScope: last.contextScope || null,
        requestedModel: last.requestedModel || null,
        actualModel: last.actualModel || null,
        executiveRefinerRequestedModel: last.executiveRefiner?.requestedModel || last.executiveRefinerRequestedModel || null,
        executiveRefinerActualModel: last.executiveRefiner?.actualModel || last.executiveRefinerActualModel || null,
        executiveRefinerInputTokens: last.executiveRefinerInputTokens ?? last.executiveRefiner?.inputTokens ?? null,
        executiveRefinerOutputTokens: last.executiveRefinerOutputTokens ?? last.executiveRefiner?.outputTokens ?? null,
        executiveRefinerEstimatedCost: last.executiveRefinerEstimatedCost ?? last.executiveRefiner?.estimatedCost ?? null,
        executiveRefinerLatency: last.executiveRefinerLatency ?? last.executiveRefiner?.latencyMs ?? null,
        executiveRefinerSuccess: last.executiveRefiner?.success ?? last.executiveRefinerSuccess ?? null,
        modelMismatch: Boolean(last.modelMismatch),
        transportFallbackUsed: Boolean(last.transportFallbackUsed)
      };
    };
    window.__zentraChatDebug.enablePremiumAudit = () => {
      this.labPremiumReasoningEnabled = true;
      window.__zentraLabExperiment.premiumReasoning = true;
      localStorage.setItem('zentra-lab-premium-reasoning', '1');
      return true;
    };
    window.__zentraChatDebug.disablePremiumAudit = () => {
      this.labPremiumReasoningEnabled = false;
      window.__zentraLabExperiment.premiumReasoning = false;
      localStorage.setItem('zentra-lab-premium-reasoning', '0');
      return false;
    };
    window.__zentraChatDebug.enableExecutiveRefiner = () => {
      this.labExecutiveRefinerEnabled = true;
      window.__zentraLabExperiment.executiveRefinerEnabled = true;
      localStorage.setItem('zentra-lab-executive-refiner', '1');
      return true;
    };
    window.__zentraChatDebug.disableExecutiveRefiner = () => {
      this.labExecutiveRefinerEnabled = false;
      window.__zentraLabExperiment.executiveRefinerEnabled = false;
      localStorage.setItem('zentra-lab-executive-refiner', '0');
      return false;
    };
  }

  debugLog(level = 'log', ...args) {
    if (!this.internalDebugEnabled) return;
    const logger = console?.[level] || console?.log;
    if (typeof logger === 'function') logger.apply(console, args);
  }

  normalizeSeoSummaryText(summary = '', score = 0) {
    const normalizedScore = Number.isFinite(Number(score)) ? Math.max(0, Math.min(100, Math.round(Number(score)))) : 0;
    const baseText = String(summary || '').replace(/\s{2,}/g, ' ').trim();
    if (!baseText) return baseText;

    return this.normalizeVisibleSpanishText(baseText
      .replace(/Puntaje\s+estimado:\s*\d{1,3}\/100\.?/gi, `Lectura SEO técnica: ${normalizedScore}/100.`)
      .replace(/Puntaje\s+(?:SEO(?:\s+t[eé]cnico)?|t[eé]cnico):\s*\d{1,3}\/100\.?/gi, `Lectura SEO técnica: ${normalizedScore}/100.`));
  }

  normalizeVisibleSpanishText(text = '') {
    const raw = String(text || '');
    if (!raw) return '';

    const urlPattern = /https?:\/\/[^\s<>"']+/gi;
    const fitReplacementCase = (match = '', replacement = '') => {
      const value = String(replacement || '');
      const source = String(match || '');
      if (!value || !source) return value;
      if (source === source.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(source)) return value.toUpperCase();
      if (/^[a-záéíóúñ]/.test(source)) return value.charAt(0).toLowerCase() + value.slice(1);
      return value;
    };
    const replacements = [
      [/\bQue transmite\b/gi, 'Qué transmite'],
      [/\bA quien le habla\b/gi, 'A quién le habla'],
      [/\bDonde se confunde\b/gi, 'Dónde se confunde'],
      [/\bComo lo simplificaria\b/gi, 'Cómo lo simplificaría'],
      [/\bComo lo simplificarias\b/gi, 'Cómo lo simplificarías'],
      [/\bPagina\b/gi, 'Página'],
      [/\bPaginas\b/gi, 'Páginas'],
      [/\bAccion\b/gi, 'Acción'],
      [/\bAcciones\b/gi, 'Acciones'],
      [/\bJerarquia\b/gi, 'Jerarquía'],
      [/\bJerarquias\b/gi, 'Jerarquías'],
      [/\bIntencion\b/gi, 'Intención'],
      [/\bIntenciones\b/gi, 'Intenciones'],
      [/\bDecision\b/gi, 'Decisión'],
      [/\bDecisiones\b/gi, 'Decisiones'],
      [/\bMedicion\b/gi, 'Medición'],
      [/\bMediciones\b/gi, 'Mediciones'],
      [/\bEjecucion\b/gi, 'Ejecución'],
      [/\bEjecuciones\b/gi, 'Ejecuciones'],
      [/\bSenales\b/gi, 'Señales'],
      [/\bSenal\b/gi, 'Señal'],
      [/\bAnalisis\b/gi, 'Análisis'],
      [/\bDescripcion\b/gi, 'Descripción'],
      [/\bTitulo\b/gi, 'Título'],
      [/\bImagenes\b/gi, 'Imágenes'],
      [/\bImagen\b/gi, 'Imagen'],
      [/\bTecnica\b/gi, 'Técnica'],
      [/\bTecnicas\b/gi, 'Técnicas'],
      [/\bEnvia\b/gi, 'Envía'],
      [/\bDetecto\b/gi, 'Detectó'],
      [/\bDiferenciacion explicita\b/gi, 'Diferenciación explícita'],
      [/\bExplicita\b/gi, 'Explícita'],
      [/\bMas claros\b/gi, 'Más claros'],
      [/\bMas agresiva\b/gi, 'Más agresiva'],
      [/\bCategoria\b/gi, 'Categoría'],
      [/\bCategorias\b/gi, 'Categorías'],
      [/\bBusqueda\b/gi, 'Búsqueda'],
      [/\bBusquedas\b/gi, 'Búsquedas'],
      [/\bTerminos\b/gi, 'Términos'],
      [/\bAno\b/gi, 'Año'],
      [/\bAnos\b/gi, 'Años'],
      [/\bTrafico organico\b/gi, 'Tráfico orgánico'],
      [/\bTrafico\b/gi, 'Tráfico'],
      [/\bConversion\b/gi, 'Conversión'],
      [/\bConversiones\b/gi, 'Conversiones'],
      [/\bGenerico\b/gi, 'Genérico'],
      [/\bGenericos\b/gi, 'Genéricos'],
      [/\bUnico\b/gi, 'Único'],
      [/\bUnicos\b/gi, 'Únicos'],
      [/\bRecomendacion\b/gi, 'Recomendación'],
      [/\bRecomendaciones\b/gi, 'Recomendaciones'],
      [/\bAuditoria\b/gi, 'Auditoría'],
      [/\bAuditorias\b/gi, 'Auditorías'],
      [/beneficios?\s+evidencia\s+acci[oó]n(?:\s+concreta)?(?:,\s*evitando\s+copy\s+gen[eé]rico)?/gi, 'beneficio claro, prueba visible y siguiente paso'],
      [/reforzar\s+decisi[oó]n/gi, 'reforzar la decisión'],
      [/copy\s+generico/gi, 'copy genérico']
    ];

    const applyReplacements = (segment = '') => replacements.reduce((acc, [pattern, value]) => (
      acc.replace(pattern, (match) => fitReplacementCase(match, value))
    ), String(segment || ''));

    let output = '';
    let lastIndex = 0;
    for (const match of raw.matchAll(urlPattern)) {
      const index = Number(match.index || 0);
      output += applyReplacements(raw.slice(lastIndex, index));
      output += match[0];
      lastIndex = index + match[0].length;
    }
    output += applyReplacements(raw.slice(lastIndex));
    return output;
  }

  estimateTokenCount(text = '') {
    const normalized = String(text || '');
    return Math.max(1, Math.round(normalized.length / 4));
  }

  normalizeUsage(usage = null) {
    if (!usage || typeof usage !== 'object') {
      return { inputTokens: null, outputTokens: null, totalTokens: null };
    }
    const read = (...keys) => {
      for (const key of keys) {
        const value = Number(usage?.[key]);
        if (Number.isFinite(value) && value >= 0) return Math.round(value);
      }
      return null;
    };
    const inputTokens = read('prompt_tokens', 'input_tokens');
    const outputTokens = read('completion_tokens', 'output_tokens');
    const totalTokens = read('total_tokens') ?? (
      Number.isFinite(inputTokens) && Number.isFinite(outputTokens) ? inputTokens + outputTokens : null
    );
    return { inputTokens, outputTokens, totalTokens };
  }

  ensureArray(value, fallbackPath = null) {
    if (Array.isArray(value)) return value;
    if (fallbackPath && value && typeof value === 'object') {
      const nested = value[fallbackPath];
      if (Array.isArray(nested)) return nested;
    }
    return [];
  }

  estimateCostUsd({ model = '', inputTokens = null, outputTokens = null } = {}) {
    const pricing = this.modelPricingPer1M[model] || null;
    if (!pricing) return null;
    const inTok = Number.isFinite(inputTokens) ? inputTokens : 0;
    const outTok = Number.isFinite(outputTokens) ? outputTokens : 0;
    return Number((((inTok / 1000000) * pricing.input) + ((outTok / 1000000) * pricing.output)).toFixed(8));
  }

  readDebugSamples() {
    if (!this.internalDebugEnabled) return [];
    try {
      const raw = localStorage.getItem(this.debugSamplesStorageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  saveDebugSamples(samples = []) {
    if (!this.internalDebugEnabled) return;
    try {
      localStorage.setItem(this.debugSamplesStorageKey, JSON.stringify(samples.slice(-this.maxDebugSamples)));
    } catch (_) {}
  }

  recordLabAuditSample(sample = {}) {
    if (!this.internalDebugEnabled) return;
    const samples = this.readDebugSamples();
    samples.push({
      kind: 'audit_experiment',
      recordedAt: new Date().toISOString(),
      ...sample
    });
    this.saveDebugSamples(samples);
  }

  async getRoutingConfig(taskType = 'seo_analysis', options = {}) {
    if (window.ZentraModelRouter?.resolveRouting) {
      return window.ZentraModelRouter.resolveRouting(taskType, {
        ...options,
        maxTokens: options.maxTokens || this.maxTokens
      });
    }

    return {
      plan: String(options.plan || 'free').toLowerCase(),
      taskType,
      activeMode: 'safe-base',
      selectedModel: this.model,
      preferredModel: this.model,
      fallbackModel: this.model,
      premiumTask: false,
      premiumAllowed: false,
      premiumActive: false,
      maxTokens: options.maxTokens || this.maxTokens,
      budgets: {
        premiumChatActions: 0,
        premiumPdfRuns: 0
      }
    };
  }

  async isReady() {
    return true;
  }

  resolveRequestTimeoutMs(options = {}) {
    const explicitTimeout = Number(options.timeoutMs || 0);
    if (Number.isFinite(explicitTimeout) && explicitTimeout > 0) {
      return explicitTimeout;
    }

    const taskType = String(options.taskType || '');
    if (taskType === 'seo_analysis' || taskType === 'seo_audit') return 150000;
    if (taskType === 'pdf_polish') return 150000;
    if (taskType === 'pdf_summary') return 120000;
    if (taskType === 'premium_reasoning_audit') return 150000;
    if (taskType === 'executive_refiner_pdf') return 150000;
    return 90000;
  }

  async callAPI(messages, options = {}) {
    try {
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        throw new Error('Se requieren mensajes validos');
      }

      await this.isReady();

      const apiMessages = [];
      
      if (options.system) {
        apiMessages.push({ role: 'system', content: options.system });
      }
      
      for (const msg of messages) {
        apiMessages.push({
          role: msg.role || 'user',
          content: msg.content
        });
      }

      const routingConfig = await this.getRoutingConfig(options.taskType || 'seo_analysis', options);
      const requestedModel = options.forceModel || routingConfig.selectedModel || this.model;
      const transportFallbackUsed = !Boolean(this.apiProvider?.sendMessages);
      const timeoutMs = this.resolveRequestTimeoutMs(options);
      const taskType = options.taskType || routingConfig.taskType || 'seo_analysis';
      this.debugLog('log', '[MODEL ROUTE]', JSON.stringify({
        route: 'pdf_or_assistant',
        taskType,
        plan: routingConfig?.plan || null,
        requestedModel: options.forceModel || this.model,
        finalModel: requestedModel,
        provider: routingConfig?.activeProvider || 'backend_proxy',
        premiumTask: Boolean(routingConfig?.premiumTask),
        premiumAllowed: Boolean(routingConfig?.premiumAllowed),
        premiumActive: Boolean(routingConfig?.premiumActive),
        contextDecision: options.contextDecision || null,
        outputType: options.outputType || null,
        renderType: options.renderType || null,
        reasonForModelChoice: routingConfig?.reasonForModelChoice || routingConfig?.selectorReason || null
      }));
      this.debugLog('log', '[OPENAI REQUEST MODEL]', JSON.stringify({
        route: 'pdf_or_assistant',
        taskType,
        requestedModel,
        provider: routingConfig?.activeProvider || 'backend_proxy'
      }));
      this.debugLog('log', 'OPENAI REQUEST MODEL:', requestedModel);
      if (/seo|pdf|audit/i.test(taskType)) {
        this.debugLog('log', 'ZENTRA AUDIT REQUEST TIMEOUT:', { taskType, timeoutMs });
      }
      const resolvedUserEmail = window.zentraSubscription?.getResolvedUserEmail?.()
        || window.zentraSubscription?.getCurrentUserEmail?.()
        || window.__zentraUserEmail
        || '';
      const requestBody = {
        model: requestedModel,
        max_tokens: routingConfig.maxTokens || options.maxTokens || this.maxTokens,
        temperature: options.temperature || this.temperature,
        messages: apiMessages,
        task_type: taskType,
        zentra_routing: {
          ...routingConfig,
          taskType
        },
        zentra_user_email: resolvedUserEmail
      };

      if (options.jsonMode) {
        requestBody.response_format = { type: 'json_object' };
      }

      let response;
      if (this.apiProvider?.sendMessages) {
        response = await this.apiProvider.sendMessages({
          body: requestBody,
          timeoutMs
        });
      } else {
        this.debugLog('log', 'Zentra AI transport fallback activo: usando fetch directo al backend.');
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        const fallbackResponse = await window.zentraApiFetch(this.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody),
          signal: controller?.signal
        });
        if (timeoutId) clearTimeout(timeoutId);

        if (!fallbackResponse.ok) {
          const errorData = await fallbackResponse.json().catch(() => ({}));
          const errorMessage = errorData.error?.message || `HTTP ${fallbackResponse.status}: ${fallbackResponse.statusText}`;
          throw new Error(`Error: ${errorMessage}`);
        }

        response = await fallbackResponse.json();
      }

      const data = response;
      
      if (!data) {
        throw new Error('Respuesta vacia del backend');
      }

      const actualModel = data.model || requestedModel;
      this.debugLog('log', 'OPENAI RESPONSE MODEL:', actualModel);
      if (actualModel !== requestedModel) {
        this.debugLog('log', `OPENAI MODEL FALLBACK DETECTED: ${requestedModel} -> ${actualModel}`);
      }

      let textContent = '';

      if (data.success === true) {
        if (typeof data.response === 'string' && data.response.trim()) {
          textContent = data.response;
        } else if (data.response && typeof data.response === 'object') {
          textContent = JSON.stringify(data.response);
        } else if (typeof data.raw_content === 'string' && data.raw_content.trim()) {
          textContent = data.raw_content;
        } else {
          textContent = typeof data.analysis === 'string'
            ? data.analysis
            : JSON.stringify(data.analysis || {});
        }
      } else if (data.choices?.[0]?.message?.content) {
        textContent = data.choices[0].message.content;
      } else if (typeof data.analysis !== 'undefined') {
        textContent = typeof data.analysis === 'string'
          ? data.analysis
          : JSON.stringify(data.analysis || {});
      } else {
        throw new Error(data.error || 'Respuesta invalida del backend');
      }

      if (data.success === true && routingConfig?.premiumTask && window.zentraSubscription?.getUserState) {
        try {
          // Refresh the active product, not the separate SaaS plan when running Audit.
          await window.zentraSubscription.getUserState(true);
        } catch (usageError) {
          this.debugLog('warn', 'No se pudo sincronizar el consumo del informe SEO:', usageError);
        }
      }

      return {
        success: true,
        content: textContent,
        usage: data.usage,
        model: actualModel,
        requestedModel,
        actualModel,
        modelMismatch: Boolean(actualModel !== requestedModel),
        transportFallbackUsed,
        routing: routingConfig,
        rawResponse: data
      };

    } catch (error) {
      this.debugLog('warn', `Zentra AI request fallback. ${error?.message || error || ''}`.trim());
      if (['execution_uncertain', 'execution_pending'].includes(error.code)) throw error;
      return {
        success: false,
        error: error.message,
        details: error
      };
    }
  }

  // Mantener compatibilidad con nombre anterior
  async callClaude(messages, options = {}) {
    return this.callAPI(messages, options);
  }

  async enhanceAnalysisWithPremium(pageData, essentialData, analysis = {}, auditScope = {}) {
    const plan = String(auditScope.plan || essentialData.plan || 'free').toLowerCase();
    if (!['pro', 'agency'].includes(plan)) {
      return analysis;
    }

    const taskType = plan === 'agency' ? 'pdf_polish' : 'pdf_summary';
    const routing = await this.getRoutingConfig(taskType, {
      plan,
      maxTokens: plan === 'agency' ? 2200 : 1700
    });

    if (!routing.premiumActive) {
      return analysis;
    }

    const systemPrompt = `Eres un estratega SEO senior. Vas a refinar un análisis ya generado para que se vea más consultivo, claro, profesional y orientado a negocio.

REGLAS:
- Responde SOLO en JSON válido.
- No inventes datos nuevos.
- Mantén el puntaje y el contexto base.
- Mejora claridad, prioridad y criterio ejecutivo.
- Sé breve y accionable.
- Trabaja solo con evidencia incluida en los datos. Si no hay evidencia suficiente, no lo presentes como hallazgo confirmado; usa "conviene validar" solo como nota secundaria.
- No afirmes resultados, problemas, servicios, ubicaciones, CTA, errores tecnicos o intenciones de negocio que no aparezcan en el contenido o señales entregadas.
- El resumen debe explicar: que esta bien, que esta fallando y donde esta la mayor oportunidad.
- Cada problema debe traducirse a impacto real cuando aplique: visibilidad, trafico, conversiones o oportunidades perdidas.
- En cada recomendacion deja claro por que esa accion es prioritaria frente a otros problemas cuando la evidencia lo permita.
- Si un mismo patron aparece en varias paginas del conjunto auditado, sube el nivel de interpretacion: explica que la prioridad aumenta porque afecta una parte mas amplia del sitio.
- Evita frases neutras o debiles como "se recomienda", "se detecto", "puede" o "podria" en hallazgos confirmados.
- Escribe cada recomendacion como decision inmediata con este orden interno: Problema: que esta mal. Impacto: que se pierde en visibilidad, trafico o conversiones. Accion: que hacer exactamente.
- Usa lenguaje natural y contundente sin exagerar: "Esto reduce clics desde Google", "Esta friccion hace perder consultas", "La pagina gana claridad si...".

Responde con esta estructura:
{
  "summary": "Resumen ejecutivo refinado en 2-3 oraciones: que esta bien, que esta frenando visibilidad/trafico/conversiones y que accion exige prioridad.",
  "quickWins": "2-3 acciones rapidas ordenadas por impacto, con perdida actual y resultado esperado.",
  "topIssues": ["Problema: ... Impacto: ... Accion: ...", "Problema: ... Impacto: ... Accion: ...", "Problema: ... Impacto: ... Accion: ..."],
  "recommendations": [
    {"action": "Problema: ... Impacto: ... Accion: ...", "priority": "alta", "impact": "Perdida actual, resultado esperado y por que va antes que otros puntos"},
    {"action": "Problema: ... Impacto: ... Accion: ...", "priority": "alta", "impact": "Perdida actual, resultado esperado y por que va antes que otros puntos"},
    {"action": "Problema: ... Impacto: ... Accion: ...", "priority": "media", "impact": "Perdida actual, resultado esperado y prioridad relativa dentro del sitio"},
    {"action": "Problema: ... Impacto: ... Accion: ...", "priority": "media", "impact": "Perdida actual, resultado esperado y prioridad relativa dentro del sitio"},
    {"action": "Problema: ... Impacto: ... Accion: ...", "priority": "baja", "impact": "Perdida actual, resultado esperado y razon para ejecutarlo despues de los puntos criticos"}
  ]
}`;

    const userMessage = `Refina este análisis SEO sin cambiar los datos base.

PLAN: ${plan.toUpperCase()}
DOMINIO: ${essentialData.domain}
PUNTAJE SEO: ${analysis.seoScore || essentialData.seoScore || 0}/100

DATOS ESENCIALES:
${JSON.stringify(essentialData, null, 2)}

ANÁLISIS ACTUAL:
${JSON.stringify({
  summary: analysis.summary,
  quickWins: analysis.quickWins,
  topIssues: analysis.topIssues,
  recommendations: analysis.recommendations
}, null, 2)}`;

    try {
      const premiumResult = await this.callAPI([
        { role: 'user', content: userMessage }
      ], {
        system: systemPrompt,
        maxTokens: routing.maxTokens,
        temperature: 0.4,
        jsonMode: true,
        taskType,
        plan
      });

      if (!premiumResult.success) {
        return analysis;
      }

      let premiumAnalysis;
      try {
        premiumAnalysis = this.parseSEOAnalysis(premiumResult.content);
      } catch (_) {
        return analysis;
      }

      return {
        ...analysis,
        summary: premiumAnalysis.summary || analysis.summary,
        quickWins: premiumAnalysis.quickWins || analysis.quickWins,
        topIssues: Array.isArray(premiumAnalysis.topIssues) && premiumAnalysis.topIssues.length
          ? premiumAnalysis.topIssues
          : analysis.topIssues,
        recommendations: Array.isArray(premiumAnalysis.recommendations) && premiumAnalysis.recommendations.length
          ? premiumAnalysis.recommendations.map((r) => ({
              action: r?.action || '',
              impact: r?.impact || '',
              priority: r?.priority || 'media'
            }))
          : analysis.recommendations
      };
    } catch (error) {
      this.debugLog('warn', `No se pudo aplicar el pulido premium del informe SEO. ${error?.message || error || ''}`.trim());
      return analysis;
    }
  }

  normalizeSeoUrl(rawUrl, origin = '') {
    try {
      const url = new URL(rawUrl);

      if (origin && url.origin !== origin) return null;

      url.hash = '';
      url.search = '';
      url.pathname = url.pathname.replace(/\/+$/, '') || '/';

      return url.toString();
    } catch (_) {
      return null;
    }
  }

  scoreInternalCandidate(candidate) {
    const haystack = `${candidate.text || ''} ${candidate.pathname || ''}`.toLowerCase();
    let score = 0;

    const weightedPatterns = [
      { pattern: /(servicio|servicios|service|services)/, points: 12 },
      { pattern: /(contacto|contact|about|nosotros|empresa|quienes)/, points: 11 },
      { pattern: /(precio|precios|pricing|tarifa|tarifas|planes?|presupuesto|cotizacion|cotización)/, points: 10 },
      { pattern: /(blog|articulo|articulos|post|guia|guias|noticia|noticias)/, points: 9 },
      { pattern: /(categoria|categorias|coleccion|colecciones)/, points: 8 },
      { pattern: /(landing|landing-page|lp|pagina-principal|home|inicio)/, points: 7 },
      { pattern: /(producto|productos|product|shop|tienda|store|catalogo|catalog)/, points: 6 }
    ];

    weightedPatterns.forEach(({ pattern, points }) => {
      if (pattern.test(haystack)) score += points;
    });

    if ((candidate.text || '').trim().length > 8) score += 2;
    if ((candidate.pathname || '') === '/') score -= 50;
    if (!haystack) score -= 5;

    return score;
  }

  getCandidateBucket(candidate) {
    const pathname = String(candidate.pathname || '').toLowerCase();
    const text = String(candidate.text || '').toLowerCase();
    const haystack = `${pathname} ${text}`;
    const segments = pathname.split('/').filter(Boolean);

    if (/(login|sign[- ]?in|registro|register|password|cuenta|my-account|mi-cuenta|privacy|privacidad|terms|terminos|términos|conditions|cookies?|checkout|cart|carrito)/.test(haystack)) {
      return 'irrelevante';
    }
    if (/(contacto|contact)/.test(haystack)) return 'contacto';
    if (/(servicio|servicios|service|services)/.test(haystack)) return 'servicios';
    if (/(precio|precios|pricing|tarifa|tarifas|planes?|presupuesto|cotizacion|cotización)/.test(haystack)) return 'precios';
    if (/(blog|post|articulo|articulos|guia|guias|noticia|noticias)/.test(haystack)) {
      return segments.length > 1 ? 'blog_detalle' : 'blog';
    }
    if (/(categoria|categorias|coleccion|colecciones)/.test(haystack)) return 'categoria';
    if (/(landing|landing-page|lp|pagina-principal|home|inicio)/.test(haystack)) return 'landing';
    if (/(faq|preguntas|help|ayuda)/.test(haystack)) return 'faq';
    if (/(about|nosotros|empresa|quienes|compania|company)/.test(haystack)) return 'empresa';
    if (/(producto|productos|product|shop|store|tienda|catalogo|catalog)/.test(haystack)) {
      const isHubPath = /^\/(productos?|product|shop|store|tienda|catalogo|catalog)(\/)?$/.test(pathname);
      return isHubPath || segments.length <= 1 ? 'productos' : 'producto_detalle';
    }

    return 'otros';
  }

  getBucketPriority(bucket) {
    const priorities = {
      irrelevante: -999,
      contacto: 100,
      servicios: 96,
      precios: 94,
      productos: 92,
      blog: 88,
      categoria: 86,
      landing: 84,
      empresa: 82,
      faq: 78,
      blog_detalle: 58,
      producto_detalle: 54,
      otros: 40
    };

    return priorities[bucket] || priorities.otros;
  }

  getPriorityWeight(priority = 'media') {
    const weights = {
      alta: 3,
      media: 2,
      baja: 1
    };

    return weights[String(priority || 'media').toLowerCase()] || weights.media;
  }

  getPageLabel(url, title = '', fallbackText = '') {
    const isGenericHint = (value = '') => /^(pagina interna|pagina interna relacionada|pagina clave|internal page|related page)$/i.test(
      String(value || '').replace(/\s{2,}/g, ' ').trim()
    );

    const humanizePathSegment = (value = '') => String(value || '')
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase())
      .replace(/\s{2,}/g, ' ')
      .trim();

    try {
      const pathname = new URL(url).pathname || '/';
      if (this.isHomeLikePath(pathname)) {
        return 'Inicio';
      }
    } catch (_) {}

    const cleanTitle = String(title || '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    let urlFallback = '';
    try {
      const pathname = new URL(url).pathname || '/';
      if (pathname !== '/') {
        const segments = pathname.split('/').filter(Boolean);
        const meaningfulSegments = segments.filter((segment) => !/^[a-z]{2}(?:-[a-z]{2})?$/i.test(segment));
        const preferredSegment = meaningfulSegments.slice(-1)[0] || segments.slice(-1)[0] || '';
        urlFallback = humanizePathSegment(preferredSegment).slice(0, 50);
      }
    } catch (_) {}

    if (cleanTitle && !isGenericHint(cleanTitle)) {
      if (urlFallback && cleanTitle.toLowerCase().startsWith(urlFallback.toLowerCase())) {
        return urlFallback;
      }
      const conciseTitle = cleanTitle
        .split(/\s+[|:-]\s+/)
        .map((part) => part.trim())
        .filter(Boolean)
        .find((part) => part.length >= 4) || cleanTitle;
      if (conciseTitle.length <= 70) return conciseTitle;
      const truncated = conciseTitle.slice(0, 70).replace(/\s+\S*$/, '').trim();
      return `${truncated || conciseTitle.slice(0, 70).trim()}...`;
    }

    const hint = String(fallbackText || '').replace(/\s{2,}/g, ' ').trim();
    if (hint && !isGenericHint(hint)) {
      if (hint.length <= 50) return hint;
      const truncated = hint.slice(0, 50).replace(/\s+\S*$/, '').trim();
      return `${truncated || hint.slice(0, 50).trim()}...`;
    }

    try {
      const pathname = new URL(url).pathname || '/';
      if (pathname === '/') return 'Inicio';

      if (urlFallback) {
        return urlFallback;
      }

      return 'Pagina interna';
    } catch (_) {
      return 'Pagina interna';
    }
  }

  getPageTypeLabel(url, fallbackText = '') {
    const copyIntent = this.getAuditPageCopyRole({ url, title: fallbackText });
    const copyLabels = { stories: 'Casos de éxito', statistics: 'Estadísticas', registration: 'Registro',
      news: 'Noticia', help: 'FAQ', institutional: 'Empresa', blog: 'Blog', pricing: 'Precios', contact: 'Contacto',
      operational: 'Funcional', education: 'Formación', hotel: 'Hoteles / destinos', category: 'Categoría', legal: 'Legal' };
    if (copyLabels[copyIntent]) return copyLabels[copyIntent];
    const haystack = `${url} ${fallbackText}`.toLowerCase();

    try {
      if (this.isHomeLikePath(new URL(url).pathname || '/')) {
        return 'Inicio';
      }
    } catch (_) {}

    if (/(contacto|contact)/.test(haystack)) return 'Contacto';
    if (/(j[oó]venes|bolsa|inversi[oó]n|salud financiera|noticia|articulo|artículo|econom[ií]a|resultados|accionistas|inversores|informaci[oó]n corporativa)/.test(haystack)) {
      if (/(resultados|accionistas|inversores)/.test(haystack)) return 'Resultados / inversores';
      return 'Contenido financiero';
    }
    if (/(precio|precios|pricing|tarifa|tarifas|planes?|presupuesto|cotizacion|cotización)/.test(haystack)) return 'Precios';
    if (/(producto|productos|product|shop|store|tienda|catalog)/.test(haystack)) return 'Productos';
    if (/(servicio|servicios|service)/.test(haystack)) return 'Servicios';
    if (/(blog|post|articulo|articulos|guia|guias)/.test(haystack)) return 'Blog';
    if (/(faq|preguntas|\bhelp\b|ayuda)/.test(haystack)) return 'FAQ';
    if (/(landing|landing-page|lp|pagina-principal|home|inicio)/.test(haystack)) return 'Landing';
    if (/(about|nosotros|empresa|quienes)/.test(haystack)) return 'Empresa';

    try {
      return new URL(url).pathname === '/' ? 'Inicio' : 'Página clave';
    } catch (_) {
      return 'Página clave';
    }
  }

  isHomeLikePath(pathname) {
    const cleanPath = String(pathname || '/').replace(/\/+$/, '') || '/';
    if (cleanPath === '/') return true;

    const segments = cleanPath.split('/').filter(Boolean);
    if (segments.length !== 1) return false;

    return /^[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0]);
  }

  getAuditScope(plan) {
    const normalizedPlan = String(plan || 'free').trim().toLowerCase();
    const scopes = {
      free: { totalPages: 3, internalPages: 2, allowsManualSelection: true },
      starter: { totalPages: 5, internalPages: 4, allowsManualSelection: false },
      pro: { totalPages: 7, internalPages: 6, allowsManualSelection: true },
      agency: { totalPages: 11, internalPages: 10, allowsManualSelection: true }
    };

    return Object.hasOwn(scopes, normalizedPlan) ? scopes[normalizedPlan] : scopes.free;
  }

  async resolveAuditScope(pageData) {
    const entitlement = window.zentraOperations?.getAuditEntitlement?.();
    if (entitlement) {
      return {
        plan: entitlement.plan,
        totalPages: entitlement.totalPages,
        internalPages: entitlement.internalPages,
        allowsManualSelection: entitlement.allowsManualSelection
      };
    }
    const subscriptionManager = window.zentraSubscription;
    const fallbackPlan = 'free';

    if (!subscriptionManager || typeof subscriptionManager.getUserState !== 'function') {
      return {
        plan: fallbackPlan,
        ...this.getAuditScope(fallbackPlan)
      };
    }

    try {
      const user = await subscriptionManager.getUserState(true);
      const plan = String(user?.plan || fallbackPlan).toLowerCase();
      return {
        plan,
        ...this.getAuditScope(plan)
      };
    } catch (error) {
      this.debugLog('warn', 'No se pudo resolver el plan para la auditoria SEO:', error);
      return {
        plan: fallbackPlan,
        ...this.getAuditScope(fallbackPlan)
      };
    }
  }

  normalizeManualInternalSelection(pageData, maxUrls = 0) {
    if (!maxUrls) return [];

    const origin = new URL(pageData.url).origin;
    const currentUrl = this.normalizeSeoUrl(pageData.url, origin);
    const seen = new Set();

    return (pageData.selectedInternalUrls || pageData.manualSelectedInternalUrls || [])
      .map((rawUrl) => this.normalizeSeoUrl(rawUrl, origin))
      .filter((url) => {
        if (!url || url === currentUrl || seen.has(url)) {
          return false;
        }

        seen.add(url);
        return true;
      })
      .slice(0, maxUrls);
  }

  selectRelevantInternalUrls(pageData, maxUrls = 3) {
    const origin = new URL(pageData.url).origin;
    const currentUrl = this.normalizeSeoUrl(pageData.url, origin);
    const seen = new Set();

    const candidates = (pageData.internalLinkCandidates || [])
      .map((candidate) => {
        const normalizedUrl = this.normalizeSeoUrl(candidate.url, origin);
        if (!normalizedUrl || normalizedUrl === currentUrl || seen.has(normalizedUrl)) {
          return null;
        }

        seen.add(normalizedUrl);

        return {
          url: normalizedUrl,
          pathname: candidate.pathname || new URL(normalizedUrl).pathname,
          text: candidate.text || '',
          score: this.scoreInternalCandidate(candidate),
          bucket: this.getCandidateBucket(candidate)
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const priorityDiff = this.getBucketPriority(b.bucket) - this.getBucketPriority(a.bucket);
        if (priorityDiff !== 0) return priorityDiff;
        return b.score - a.score;
      });

    const selected = [];
    const selectedBuckets = new Set();
    let productDetailCount = 0;

    for (const candidate of candidates) {
      if (selected.length >= maxUrls) break;

      if (candidate.bucket === 'producto_detalle') continue;
      if (candidate.bucket === 'blog_detalle' && selectedBuckets.has('blog')) continue;
      if (selectedBuckets.has(candidate.bucket) && candidate.bucket !== 'otros') continue;

      selected.push(candidate);
      selectedBuckets.add(candidate.bucket);
    }

    if (selected.length < maxUrls) {
      const remaining = candidates.filter((candidate) => !selected.some((item) => item.url === candidate.url));
      const hasNonDetailRemaining = remaining.some(
        (candidate) => candidate.bucket !== 'producto_detalle' && candidate.bucket !== 'blog_detalle'
      );

      for (const candidate of remaining) {
        if (selected.length >= maxUrls) break;

        if (candidate.bucket === 'producto_detalle') {
          if (productDetailCount >= 1) continue;
          if (selectedBuckets.has('productos') && hasNonDetailRemaining) continue;
          productDetailCount += 1;
        }

        if (candidate.bucket === 'blog_detalle' && selectedBuckets.has('blog') && hasNonDetailRemaining) {
          continue;
        }

        selected.push(candidate);
        selectedBuckets.add(candidate.bucket);
      }
    }

    return selected.slice(0, maxUrls);
  }

  async fetchInternalPagesContext(pageData, auditScope = null) {
    const scope = auditScope || await this.resolveAuditScope(pageData);
    const manualSelection = scope.allowsManualSelection
      ? this.normalizeManualInternalSelection(pageData, scope.internalPages)
      : [];

    let selectedCandidates = [];

    if (manualSelection.length > 0) {
      const candidateMap = new Map(
        (pageData.internalLinkCandidates || []).map((candidate) => {
          const normalizedUrl = this.normalizeSeoUrl(candidate.url, new URL(pageData.url).origin);
          return [normalizedUrl, candidate];
        })
      );

      selectedCandidates = manualSelection.map((url) => {
        const candidate = candidateMap.get(url) || {};
        return {
          url,
          pathname: candidate.pathname || new URL(url).pathname,
          text: candidate.text || '',
          score: this.scoreInternalCandidate(candidate || {}),
          bucket: this.getCandidateBucket(candidate || {})
        };
      });
    } else {
      const autoTarget = Math.max(scope.internalPages || 0, 1);
      const autoCandidatePoolSize = Math.min(Math.max(autoTarget * 3, autoTarget + 4), 30);
      selectedCandidates = this.selectRelevantInternalUrls(pageData, autoCandidatePoolSize);
    }

    if (!selectedCandidates.length || scope.internalPages <= 0) {
      return { pages: [], errors: [] };
    }

    const labels = selectedCandidates.reduce((acc, candidate) => {
      acc[candidate.url] = this.getPageLabel(candidate.url, '', candidate.text);
      return acc;
    }, {});
    const fallbackPages = this.buildLightweightInternalPages(pageData, selectedCandidates, labels, scope.internalPages);

    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          action: 'fetchInternalPagesContent',
          origin: new URL(pageData.url).origin,
          urls: selectedCandidates.map((candidate) => candidate.url),
          labels,
          maxPages: scope.internalPages,
          maxCharsPerPage: 1800
        },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({
              pages: fallbackPages,
              errors: [{ error: chrome.runtime.lastError.message }]
            });
            return;
          }

          if (!response || !response.success) {
            resolve({
              pages: fallbackPages,
              errors: [{ error: response?.error || 'No se pudieron cargar paginas internas' }]
            });
            return;
          }

          const loadedPages = response.pages || [];
          resolve({
            pages: loadedPages.length ? loadedPages : fallbackPages,
            errors: response.errors || [],
            acquisition: response.acquisition || {}
          });
        }
      );
    });
  }

  buildLightweightInternalPages(pageData, selectedCandidates = [], labels = {}, maxPages = 0) {
    const origin = new URL(pageData.url).origin;
    const currentUrl = this.normalizeSeoUrl(pageData.url, origin);
    const seen = new Set();

    return selectedCandidates
      .map((candidate) => {
        const url = this.normalizeSeoUrl(candidate.url, origin);
        if (!url || url === currentUrl || seen.has(url)) return null;
        seen.add(url);

        const label = labels[url] || this.getPageLabel(url, '', candidate.text || candidate.title || '');
        const title = candidate.title || label || new URL(url).pathname;
        const content = [
          title,
          candidate.text,
          `Pagina interna detectada desde los enlaces de ${pageData.domain || origin}.`
        ].filter(Boolean).join('. ');

        return {
          url,
          pathname: new URL(url).pathname || '/',
          label,
          title,
          content,
          metaDescription: null,
          canonical: null,
          robots: '',
          h1s: [],
          h1Count: null,
          readStatus: 'insufficient',
          wordCount: String(content || '').split(/\s+/).filter(Boolean).length,
          imageData: {
            totalImages: null,
            imagesWithoutAlt: null,
            decorativeImages: 0,
            heavyImages: 0,
            heavyImagesList: []
          },
          internalLinks: [],
          ctaData: [],
          seoStructure: {
            title,
            metaDescription: '',
            headings: {
              h1: title,
              h2: [],
              h3: []
            },
            links: [],
            images: [],
            ctas: []
          },
          seoScore: null,
          seoIssues: [],
          technicalScoreReliable: false,
          contentSource: 'link_context_fallback',
          lightweightFallback: true
        };
      })
      .filter(Boolean)
      .slice(0, maxPages);
  }

  async fetchFreePreviewPagesContext(pageData, auditScope = {}) {
    if (auditScope.plan !== 'free') {
      return { pages: [], errors: [] };
    }

    const previewScope = {
      plan: 'pro_preview',
      totalPages: auditScope.totalPages,
      internalPages: auditScope.internalPages,
      allowsManualSelection: true
    };

    return this.fetchInternalPagesContext(pageData, previewScope);
  }

  buildSiteContext(pageData, internalPages) {
    const blocks = [];
    const currentContent = String(pageData.textContent || '').trim().slice(0, 3500);

    if (currentContent) {
      blocks.push(
        `PAGINA ACTUAL
URL: ${pageData.url}
TITULO: ${pageData.title || 'Sin titulo'}
CONTENIDO:
${currentContent}`
      );
    }

    (internalPages || []).forEach((page, index) => {
      if (!page.content) return;

      blocks.push(
        `PAGINA INTERNA ${index + 1}
URL: ${page.url}
TITULO: ${page.title || 'Sin titulo'}
CONTENIDO:
${String(page.content).trim().slice(0, 1800)}`
      );
    });

    return blocks.join('\n\n---\n\n').slice(0, 9000);
  }

  compactSeoStructure(pageData = {}) {
    const seoStructure = pageData.seoStructure || {};
    const headings = seoStructure.headings || {};

    return {
      title: String(seoStructure.title || pageData.title || '').slice(0, 200),
      metaDescription: String(seoStructure.metaDescription || pageData.metaDescription || '').slice(0, 320),
      headings: {
        h1: String(headings.h1 || '').slice(0, 200),
        h2: Array.isArray(headings.h2) ? headings.h2.slice(0, 8) : [],
        h3: Array.isArray(headings.h3) ? headings.h3.slice(0, 8) : []
      },
      links: Array.isArray(seoStructure.links) ? seoStructure.links.slice(0, 8) : [],
      images: Array.isArray(seoStructure.images) ? seoStructure.images.slice(0, 8) : [],
      ctas: Array.isArray(seoStructure.ctas) ? seoStructure.ctas.slice(0, 8) : []
    };
  }

  serializeAuditPromptData(data) {
    // Bound only the model's copy. Original URLs, readings and PDF evidence stay intact.
    const limit = 48000;
    const note = 'Muestra acotada para el analisis. Un valor omitido o abreviado no demuestra ausencia ni un problema del sitio. La evidencia original se conserva en el informe.';
    let limited = false;
    const strings = [];
    const project = (value, depth = 0) => {
      if (typeof value === 'string') {
        const clean = value.replace(/\b(?:https?:\/\/[^\s"<>]+|data:[^\s"<>]+|blob:[^\s"<>]+)/gi,
          resource => /^https?:/i.test(resource) ? resource : '[recurso incrustado omitido del contexto]');
        if (clean !== value) limited = true;
        if (clean.length <= (/^https?:\/\/\S+$/i.test(clean) ? 8192 : 2000)) return clean;
        limited = true;
        // Never turn a shortened URL into an apparently usable destination.
        if (/https?:\/\//i.test(clean)) return '[URL o texto con URL extenso omitido del contexto]';
        return clean.slice(0, 1900) + ' [texto abreviado en el contexto]';
      }
      if (!value || typeof value !== 'object') return value;
      if (depth > 10) { limited = true; return '[estructura extensa omitida del contexto]'; }
      const entries = Array.isArray(value) ? value.map((item, index) => [index, item]) : Object.entries(value);
      const result = Array.isArray(value) ? [] : {};
      if (entries.length > 48) limited = true;
      for (const [key, item] of entries.slice(0, 48)) {
        const projected = project(item, depth + 1);
        Object.defineProperty(result, key, { value: projected, enumerable: true, writable: true, configurable: true });
        if (typeof projected === 'string') strings.push({ parent: result, key, value: projected });
      }
      return result;
    };
    const projected = project(data);
    const encode = () => JSON.stringify(limited ? { ...projected, _auditContextNote: note } : projected, null, 2);
    let serialized = encode();
    if (serialized.length <= limit) return serialized;
    limited = true;
    // Reduce the largest fields first, retaining page rows, counts and unknown states.
    for (const entry of strings.sort((a, b) => b.value.length - a.value.length)) {
      if (entry.value.length <= 160) continue;
      entry.parent[entry.key] = /https?:\/\//i.test(entry.value)
        ? '[URL o texto con URL omitido por limite de contexto]'
        : entry.value.slice(0, 96) + ' [texto abreviado en el contexto]';
      serialized = encode();
      if (serialized.length <= limit) return serialized;
    }
    return serialized;
  }

  buildAnalyzedPages(pageData, internalPages, maxTotalPages = 4) {
    const pages = [
      {
        label: this.getPageLabel(pageData.url, pageData.title, 'Inicio'),
        type: this.getPageTypeLabel(pageData.url, pageData.title),
        url: pageData.url,
        title: pageData.title || '',
        metaDescription: pageData.metaDescription || '',
        h1: pageData.h1s?.[0] || pageData.seoStructure?.headings?.h1 || '',
        h1Count: pageData.h1Count ?? null,
        canonical: pageData.canonical ?? null,
        readStatus: this.getAuditReadStatus(pageData, true),
        isPrimary: true
      }
    ];

    (internalPages || []).forEach((page) => {
      pages.push({
        label: this.getPageLabel(page.url, page.title, page.label),
        type: this.getPageTypeLabel(page.url, page.label || page.title),
        url: page.url,
        title: page.title || '',
        metaDescription: page.metaDescription || '',
        h1: page.h1s?.[0] || page.seoStructure?.headings?.h1 || '',
        h1Count: page.h1Count ?? null,
        canonical: page.canonical ?? null,
        readStatus: this.getAuditReadStatus(page),
        isPrimary: false
      });
    });

    return pages.filter((page, index) => pages.findIndex(other => other.url === page.url) === index).slice(0, maxTotalPages);
  }

  getNormalizedInternalLinkSet(links, origin) {
    const normalized = new Set();

    (links || []).forEach((rawUrl) => {
      const cleanUrl = this.normalizeSeoUrl(rawUrl, origin);
      if (cleanUrl) {
        normalized.add(cleanUrl);
      }
    });

    return normalized;
  }

  buildInterlinkingInsights(pageData, internalPages, analyzedPages) {
    const getPageDescriptor = (page = {}) => {
      const type = String(page?.type || '').trim();
      const label = String(page?.label || '').trim();
      if (label && !/^(pagina clave|pagina interna|pagina interna relacionada)$/i.test(label)) {
        return label;
      }
      if (type && !/^(pagina clave|pagina interna|pagina interna relacionada)$/i.test(type)) {
        return type;
      }
      return this.getPageLabel(page?.url || '', page?.title || '', page?.label || '');
    };

    const insights = [];
    const origin = new URL(pageData.url).origin;
    const analyzed = (analyzedPages || []).filter(page => page.readStatus === 'complete');
    const siteText = [
      pageData.url,
      pageData.title,
      pageData.metaDescription,
      ...(analyzed || []).map((page) => `${page.label || ''} ${page.title || ''} ${page.url || ''}`)
    ].join(' ').toLowerCase();
    const anchorExamples = /bbva|banco|banca|financier|finanzas|inversi[oó]n|inversores|bolsa|acciones|accionistas|econom[ií]a|salud financiera/.test(siteText)
      ? '"Ver soluciones para empresas", "Consultar salud financiera" o "Ver resultados financieros"'
      : '"Ver solución relacionada", "Conocer información clave" o "Explorar recursos de apoyo"';

    if (analyzed.length <= 1) {
      return insights;
    }

    const landingLinks = this.getNormalizedInternalLinkSet(
      [...(pageData.internalLinks || []), ...(pageData.links || [])
        .filter((link) => link.isInternal)
        .map((link) => link.href)],
      origin
    );

    const fetchedPagesMap = new Map(
      (internalPages || []).map((page) => [page.url, page])
    );

    const keyInternalPages = analyzed.filter((page) => !page.isPrimary);
    const missingFromLanding = this.getAuditReadStatus(pageData, true) === 'complete' && (Array.isArray(pageData.links) || Array.isArray(pageData.internalLinks))
      ? keyInternalPages.filter((page) => !landingLinks.has(this.normalizeSeoUrl(page.url, origin))) : [];

    if (missingFromLanding.length > 0) {
      insights.push({
        title: 'Enlaces clave desde la landing',
        detail: `No se observaron enlaces directos desde la página principal hacia ${missingFromLanding.map((page) => getPageDescriptor(page)).join(', ')} en los enlaces recogidos. No acredita ausencia en menús dinámicos ni en otras partes del sitio.`,
        recommendation: 'Comprobar la navegación y los enlaces existentes. Añadir enlaces solo donde ayuden al recorrido del usuario; una noticia o formulario no necesita obligatoriamente un enlace desde la home.',
        priority: 'media'
      });
    }

    const poorlyConnected = keyInternalPages.filter((page) => {
      const pageDataItem = fetchedPagesMap.get(page.url);
      if (!pageDataItem || this.getAuditReadStatus(pageDataItem) !== 'complete' || !Array.isArray(pageDataItem.internalLinks)) return false;

      const internalLinkSet = this.getNormalizedInternalLinkSet(pageDataItem.internalLinks || [], origin);
      const connectionsToKeyPages = keyInternalPages.filter((candidate) => candidate.url !== page.url && internalLinkSet.has(candidate.url));
      const linksBackToLanding = internalLinkSet.has(pageData.url);

      return !linksBackToLanding && connectionsToKeyPages.length === 0;
    });

    if (poorlyConnected.length > 0) {
      insights.push({
        title: 'Páginas aisladas dentro del sitio',
        detail: `${poorlyConnected.map((page) => getPageDescriptor(page)).join(', ')} tiene poca conexion interna con el resto de paginas analizadas.`,
        recommendation: 'Cruzar enlaces contextuales entre secciones relacionadas y agregar retorno visible hacia la pagina principal.',
        priority: 'media'
      });
    }

    const weakAnchorTargets = keyInternalPages.filter((page) => {
      const matchingLink = (pageData.links || []).find((link) => this.normalizeSeoUrl(link.href, origin) === page.url);
      if (!matchingLink) return false;

      const anchorText = String(matchingLink.text || '').trim().toLowerCase();
      return !anchorText || /^(ver mas|leer mas|mas info|click aqui|aqui|mas|info)$/i.test(anchorText);
    });

    if (weakAnchorTargets.length > 0) {
      insights.push({
        title: 'Textos de enlace poco descriptivos',
        detail: `Los accesos hacia ${weakAnchorTargets.map((page) => getPageDescriptor(page)).join(', ')} pueden ser mas claros para usuarios y buscadores.`,
        recommendation: `Usar anchors descriptivos que anticipen el contenido destino, por ejemplo ${anchorExamples}.`,
        priority: 'media'
      });
    }

    if (insights.length === 0) {
      insights.push({
        title: 'Estructura interna consistente',
        detail: 'Las paginas clave analizadas muestran una conexion razonable entre home y secciones internas relevantes.',
        recommendation: 'Mantener esta arquitectura y seguir enlazando servicios, contacto y contenidos de apoyo desde bloques visibles.',
        priority: 'baja'
      });
    }

    return insights.slice(0, 3);
  }

  pickVariantBySeed(options = [], seed = '') {
    const list = Array.isArray(options) ? options.filter(Boolean) : [];
    if (list.length === 0) return null;
    const source = String(seed || 'zentra');
    let hash = 0;
    for (let i = 0; i < source.length; i += 1) {
      hash = ((hash * 31) + source.charCodeAt(i)) % 2147483647;
    }
    const index = Math.abs(hash) % list.length;
    return list[index];
  }

  getIncrementalOpportunityVariants(pageType = '', profile = 'default') {
    const type = String(pageType || '').toLowerCase();
    const isService = type.includes('servicios') || type.includes('productos');
    const isBlog = type.includes('blog') || type.includes('articulo') || type.includes('recurso');
    const isHome = type.includes('inicio');
    const isContact = type.includes('contacto');
    const isLegal = type.includes('legal') || type.includes('cookies') || type.includes('privacidad');

    if (isService) {
      return [
        {
          opportunity: 'subir claridad comercial por servicio y reducir friccion antes del contacto',
          action: 'Agregar una micro-comparativa de enfoques/paquetes con un CTA de decision directa para mejorar conversion en trafico caliente.'
        },
        {
          opportunity: 'reforzar autoridad para consultas de alta intencion',
          action: 'Sumar una prueba concreta (caso real, resultado o testimonio) cerca del CTA para elevar confianza y tasa de contacto.'
        },
        {
          opportunity: 'capturar mejor objeciones de compra en primer recorrido',
          action: 'Incluir un bloque corto de objeciones frecuentes + respuesta comercial para acelerar decisiones y filtrar mejor leads.'
        },
        {
          opportunity: 'diferenciar esta URL frente a alternativas similares',
          action: 'Destacar en un bloque breve que incluye, que no incluye y para quien aplica el servicio para reducir rebote y mejorar calidad de consulta.'
        },
        {
          opportunity: 'mejorar transicion entre interes y accion',
          action: 'Colocar un CTA contextual antes del segundo scroll con verbo de avance ("Agenda", "Solicita", "Recibe propuesta") y enlace interno a contacto.'
        }
      ];
    }

    if (isBlog) {
      return [
        {
          opportunity: 'capturar long tail adicional desde dudas reales del usuario',
          action: 'Agregar una FAQ breve de 3 preguntas con lenguaje de busqueda real para ampliar cobertura semantica sin perder foco.'
        },
        {
          opportunity: 'elevar retencion y continuidad hacia paginas de negocio',
          action: 'Cerrar el contenido con una accion sugerida y 2 enlaces internos contextuales hacia servicio y contacto.'
        },
        {
          opportunity: 'convertir trafico informacional en demanda calificada',
          action: 'Incluir un bloque "si te pasa esto, que hacer ahora" con CTA de bajo compromiso para mover usuarios al siguiente paso.'
        },
        {
          opportunity: 'aumentar valor percibido frente a contenido competidor',
          action: 'Agregar un mini-framework o checklist accionable para que la pagina gane utilidad practica y mejor potencial de enlace.'
        }
      ];
    }

    if (isHome) {
      return [
        {
          opportunity: 'subir claridad comercial en primer scroll',
          action: 'Ajustar headline + subtitulo con promesa concreta, segmento y resultado esperado para mejorar CTR interno y conversion.'
        },
        {
          opportunity: 'reforzar confianza temprana para usuarios nuevos',
          action: 'Ubicar prueba de autoridad (clientes, casos o metricas) por encima del primer CTA para reducir duda inicial.'
        },
        {
          opportunity: 'diferenciar propuesta frente a competidores de la misma categoria',
          action: 'Agregar un bloque de diferenciadores en formato breve (3 bullets) antes del segundo scroll para mejorar recordacion y decision.'
        }
      ];
    }

    if (isContact) {
      return [
        {
          opportunity: 'reducir friccion en el paso de contacto',
          action: 'Mostrar tiempos de respuesta, canal recomendado y expectativa de entrega para aumentar envios calificados.'
        },
        {
          opportunity: 'mejorar tasa de inicio de conversacion',
          action: 'Reemplazar textos genericos por CTA con intencion ("Quiero una propuesta", "Agendar llamada") y reforzar ubicacion del boton principal.'
        },
        {
          opportunity: 'elevar confianza justo antes del envio',
          action: 'Incluir una mini-prueba social o garantia de proceso cerca del formulario para reducir abandono.'
        }
      ];
    }

    if (isLegal) {
      return [
        {
          opportunity: 'mantener esta pagina como soporte de confianza sin competir por intencion comercial',
          action: 'Conservar claridad legal y agregar enlace visible de retorno a una pagina comercial clave para no cortar recorrido.'
        },
        {
          opportunity: 'mejorar navegabilidad sin sobrecargar contenido legal',
          action: 'Agregar enlaces internos al pie hacia contacto y servicios para recuperar sesiones que llegan por dudas de confianza.'
        }
      ];
    }

    const defaultOptions = [
      {
        opportunity: 'aumentar claridad y profundidad sin alargar en exceso la pagina',
        action: 'Incorporar un bloque de beneficio principal + prueba concreta + siguiente paso comercial para elevar conversion.'
      },
      {
        opportunity: 'reforzar diferenciacion frente a resultados similares',
        action: 'Agregar una comparativa breve de enfoque/resultado para explicar por que elegir esta opcion y no una alternativa generica.'
      },
      {
        opportunity: 'subir confianza antes del CTA principal',
        action: 'Integrar una evidencia de autoridad (caso, cliente, metricas o experiencia) junto al llamado a la accion.'
      },
      {
        opportunity: 'mejorar continuidad de navegacion y decision',
        action: 'Conectar esta URL con una pagina comercial complementaria y una accion de contacto para no perder trafico con intencion.'
      },
      {
        opportunity: 'capturar mejor usuarios indecisos',
        action: 'Sumar un bloque corto de objeciones comunes y respuesta directa para aumentar conversion sin cambiar estructura completa.'
      }
    ];

    if (profile === 'short_content') {
      return [
        ...defaultOptions,
        {
          opportunity: 'cerrar brecha de contenido frente a competidores mejor desarrollados',
          action: 'Ampliar la seccion principal con ejemplos, beneficios concretos y un mini-caso para sostener mejor intencion y conversion.'
        }
      ];
    }

    return defaultOptions;
  }

  buildNoCriticalPageFinding(page = {}, normalizeSentence = (v) => String(v || '').trim()) {
    const strengths = [];
    const metaDescription = String(page.metaDescription || '').trim();
    const wordCount = Number(page.wordCount || 0);
    const h1Count = Number(page.h1Count || 0);
    const canonical = String(page.canonical || '').trim();
    const ctaData = Array.isArray(page.ctaData) ? page.ctaData : [];
    const strongCta = ctaData.find((cta) => cta?.strength === 'strong' || cta?.strength === 'medium');
    const pageType = String(page.type || '').toLowerCase();

    if (metaDescription.length >= 120 && metaDescription.length <= 160) {
      strengths.push('la meta descripcion ya ocupa un rango competitivo para resultados de Google');
    }
    if (h1Count === 1) {
      strengths.push('la jerarquia principal es clara con un H1 unico');
    }
    if (canonical) {
      strengths.push('la URL ya envia una senal canonical definida');
    }
    if (wordCount >= 320) {
      strengths.push('el contenido visible ya tiene profundidad para sostener una intencion de busqueda');
    }
    if (strongCta && String(strongCta.text || '').trim().length > 5) {
      strengths.push(`el CTA principal ("${String(strongCta.text || '').trim()}") ya orienta a una accion concreta`);
    }

    if (strengths.length === 0) {
      strengths.push('la pagina mantiene una base ordenada en los elementos tecnicos revisados');
    }

    const shortContent = wordCount > 0 && wordCount < 500;
    const variantPool = this.getIncrementalOpportunityVariants(
      pageType,
      shortContent ? 'short_content' : 'default'
    );
    const variantSeed = `${page.url || page.pathname || page.title || 'page'}|${wordCount}|${h1Count}|${metaDescription.length}`;
    const selectedVariant = this.pickVariantBySeed(variantPool, variantSeed) || variantPool[0] || {
      opportunity: 'mejorar diferenciacion frente a resultados similares',
      action: 'Incluir una accion concreta de conversion y evidencia de confianza para elevar rendimiento organico.'
    };

    const opportunity = selectedVariant.opportunity;
    const action = selectedVariant.action;

    return {
      issue: this.normalizeVisibleSpanishText(normalizeSentence(`Fortaleza principal: ${strengths.slice(0, 2).join('; ')}. Oportunidad incremental: ${opportunity}.`)),
      recommendation: this.normalizeVisibleSpanishText(normalizeSentence(action)),
      priority: 'baja',
      strength: this.normalizeVisibleSpanishText(strengths[0]),
      opportunity: this.normalizeVisibleSpanishText(opportunity)
    };
  }

  getAuditPageCopyRole(page = {}) {
    const normalize = value => this.normalizeCompetitiveToken(String(value || ''));
    let path = '';
    try { path = decodeURIComponent(new URL(page.url).pathname); } catch (_) {}
    if (this.getAuditLegalTitle(page)) return 'legal';
    if (path && this.isHomeLikePath(path)) return 'homepage';
    const mainPath = path.replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/)/i, '');
    const headings = normalize([page.title, page.h1, ...(page.h1s || [])].filter(Boolean).join(' '));
    const utilityRoute = /^\/(?:webchat|chat|addresses|cart|checkout|carrito|login|signin|account|mi-cuenta)(?:\/|$)/i.test(mainPath);
    const productHeading = /\b(software|plataforma|platform|solucion|solution|integracion|integration)\b/.test(headings);
    if (utilityRoute && !productHeading) return 'operational';
    if (/^\/(?:company|empresa)\/?$/i.test(mainPath)) return 'institutional';
    if (/^\/(?:programas|courses|cursos|masters|grados)(?:\/|$)/i.test(mainPath)) return 'education';
    if (/^\/(?:hoteles|hotels)(?:\/|$)/i.test(mainPath)) return 'hotel';
    if (/^\/(?:c|categorias|categories)(?:\/|$)/i.test(mainPath)) return 'category';
    const classify = value => {
      const text = normalize(value);
      if (/\b(faq|preguntas frecuentes|help|ayuda|docs|documentation|documentacion)\b/.test(text)) return 'help';
      if (/\b(blog|articles?|articulos?|guides?|guias?)\b/.test(text)) return 'blog';
      if (/\b(news|noticias?|press|prensa)\b/.test(text)) return 'news';
      if (/\b(stories|success stories|case studies|casos de exito|testimonios)\b/.test(text)) return 'stories';
      if (/\b(stats|statistics|estadisticas)\b/.test(text)) return 'statistics';
      if (/\b(signup|sign up|register|registro|registrarse|crear cuenta)\b/.test(text)) return 'registration';
      if (/\b(contacts?|contacto|contactanos)\b/.test(text)) return 'contact';
      if (/\b(pricing|precios|tarifas|planes|plans)\b/.test(text)) return 'pricing';
      if (/\b(about|nosotros|quienes somos|sobre nosotros)\b/.test(text)) return 'institutional';
      return '';
    };
    // Page-local routes and headings outrank navigation or body mentions of other sections.
    return classify(path.replace(/[-_/]+/g, ' ')) || classify(page.title) ||
      classify((page.h1s || []).join(' ')) || classify(page.label) || '';
  }

  getAuditLegalTitle(page = {}) {
    let path = '';
    try { path = decodeURIComponent(new URL(page.url).pathname).replace(/[-_/]+/g, ' ').trim(); } catch (_) {}
    const fields = [path.replace(/^legal\s+/, ''), page.title, page.h1, ...(page.h1s || [])].filter(Boolean)
      .map(value => String(value).split(/\s*[|–—]\s*/)[0]);
    if (!page.title && !page.h1 && !(page.h1s || []).length) {
      fields.push(String(page.textContent || page.content || '').split(/\n/)[0].trim());
    }
    // Require a document label, not a footer mention or an article about privacy.
    const label = fields.map(value => this.normalizeCompetitiveToken(value).replace(/^(?:en|es)\s+/, ''))
      .find(value => /^(privacy(?: policy)?|politica de privacidad|privacidad|terms(?: and conditions| of service| of use)?|terminos(?: y condiciones| de uso| del servicio)?|condiciones(?: de uso| generales)?|cookies|politica de cookies|aviso legal|legal)(?:$|\s*[|:–—-])/.test(value));
    if (!label) return '';
    if (/privacy|privacidad/.test(label)) return 'Política de privacidad';
    if (/cookies/.test(label)) return 'Política de cookies';
    if (/terms|terminos|condiciones/.test(label)) return 'Términos y condiciones';
    return 'Aviso legal';
  }

  cleanAuditExampleSubject(value = '') {
    const text = String(value || '').replace(/\s+/g, ' ').trim()
      .split(/\b(?:skip to (?:main )?content|saltar al contenido|cookie preferences|preferencias de consentimiento)\b/i)[0]
      .split(/\s+[|–—]\s+/)[0].replace(/\s+Skip\s*$/i, '').trim();
    // Collapse repeated heading phrases, not individual words inside legitimate names.
    return text.replace(/^(.+?)\s+\1(?:\s+\1)*$/i, '$1').trim();
  }

  buildPageExampleSubject(page = {}) {
    const collapse = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();
    const rawUrl = String(page.url || '').trim();
    let pathname = '';
    try {
      pathname = new URL(rawUrl).pathname || '';
    } catch (_) {
      pathname = '';
    }
    const isHome = !pathname || pathname === '/' || pathname === '';
    const candidates = [page.title, ...(page.h1s || []), page.label]
      .map((value) => collapse(this.cleanAuditExampleSubject(value)))
      .filter(Boolean);

    if (isHome) {
      const brandFromTitle = candidates.find((candidate) =>
        !/^(inicio|home|homepage)$/i.test(candidate) &&
        !/\b(products?|services?|pricing|blog|contact|about)\b/i.test(candidate)
      );
      if (brandFromTitle) {
        return brandFromTitle
          .split(/\s+[|\-–—]\s+/)[0]
          .replace(/\b(home|homepage|inicio)\b/gi, '')
          .trim();
      }
      try {
        const hostname = new URL(rawUrl).hostname.replace(/^www\./i, '');
        const root = hostname.split('.')[0] || '';
        if (root) {
          return root.charAt(0).toUpperCase() + root.slice(1);
        }
      } catch (_) {}
    }

    for (const candidate of candidates) {
      const base = candidate
        .split(/\s+[|\-–—]\s+/)[0]
        .replace(/\b(home|homepage|inicio)\b/i, 'Inicio')
        .trim();
      if (base && base.length >= 3) {
        return base;
      }
    }

    return 'esta pagina';
  }

  getPageExampleSignals(page = {}, pageType = '', subject = 'esta pagina') {
    const safeDecode = (value = '') => {
      try {
        return decodeURIComponent(String(value || ''));
      } catch (_) {
        return String(value || '');
      }
    };
    const normalizeSpaces = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();
    const type = String(pageType || '').toLowerCase();
    const rawUrl = String(page.url || '').trim();
    const signalFields = [
      page.title,
      ...(page.h1s || []),
      page.label,
      page.metaDescription,
      safeDecode(rawUrl.split(/[?#]/)[0].replace(/^https?:\/\/[^/]+/i, '').replace(/[-_/]+/g, ' '))
    ].map(value => this.cleanAuditExampleSubject(value)).filter(Boolean);
    const rawText = signalFields.join(' | ');
    const lower = rawText.toLowerCase();
    let pathname = '';
    try {
      pathname = new URL(rawUrl).pathname || '';
    } catch (_) {
      pathname = '';
    }
    const pathTerms = pathname
      .split('/')
      .filter(Boolean)
      .map((chunk) => safeDecode(chunk).replace(/[-_]+/g, ' ').trim().toLowerCase())
      .filter(Boolean);

    const phraseCandidates = [];
    const seenPhrases = new Set();
    const genericPhraseStop = new Set([
      'home', 'inicio', 'services', 'service', 'blog', 'pricing', 'contact', 'about',
      'hubspot services', 'customer service', 'marketing hub', 'sales hub',
      'free', 'resolve', 'scale', 'support', 'premium', 'inicio hubspot', 'inicio metricool'
    ]);
    const phraseRegex = /\b(?:[A-Z][a-zA-Z0-9.+/-]+|[A-Z]{2,})(?:\s+(?:[A-Z][a-zA-Z0-9.+/-]+|[A-Z]{2,})){0,2}\b/g;
    signalFields.flatMap(field => field.match(phraseRegex) || []).forEach((match) => {
      const phrase = normalizeSpaces(match);
      const key = phrase.toLowerCase();
      if (phrase.length < 3 || seenPhrases.has(key) || genericPhraseStop.has(key)) return;
      seenPhrases.add(key);
      phraseCandidates.push(phrase);
    });

    const genericWords = new Set([
      'and', 'the', 'for', 'with', 'from', 'into', 'this', 'that', 'your', 'more', 'less',
      'para', 'como', 'con', 'sin', 'desde', 'hasta', 'sobre', 'entre', 'esta', 'este',
      'pagina', 'page', 'servicio', 'services', 'service', 'producto', 'productos', 'blog',
      'guia', 'guia', 'recursos', 'resource', 'pricing', 'contacto', 'contact', 'inicio',
      'home', 'software', 'platform', 'solucion', 'solution', 'herramienta', 'tool',
      'marketing', 'sales', 'customer', 'customer-service'
    ]);
    const keywordPool = lower.match(/[a-záéíóúñ0-9.+/-]{3,}/gi) || [];
    const keywords = [];
    const seenKeywords = new Set();
    keywordPool.forEach((token) => {
      const cleanToken = String(token || '')
        .replace(/^[^a-z0-9áéíóúñ]+|[^a-z0-9áéíóúñ]+$/gi, '')
        .toLowerCase();
      if (!cleanToken || cleanToken.length < 3 || genericWords.has(cleanToken) || seenKeywords.has(cleanToken)) return;
      seenKeywords.add(cleanToken);
      keywords.push(cleanToken);
    });

    const flags = {
      hubspot: /\bhubspot\b/.test(lower),
      migration: /\bmigrat|migration|migrate|migracion\b/.test(lower),
      onboarding: /\bonboarding\b/.test(lower),
      crm: /\bcrm\b/.test(lower),
      support: /\bsupport|soporte|tickets?\b/.test(lower),
      ai: /\bai\b|inteligencia artificial/.test(lower),
      analytics: /\banalytics|reportes|reporting|informes\b/.test(lower),
      dashboard: /\bdashboard|panel\b/.test(lower),
      competitors: /\bcompetidores|competitor\b/.test(lower),
      social: /\binstagram|linkedin|tiktok|youtube|facebook|x\.com|twitter\b/.test(lower),
      marketing: /\bmarketing\b/.test(lower),
      sales: /\bsales|ventas\b/.test(lower),
      automation: /\bautomat|automation\b/.test(lower),
      local: /\ben\s+[a-záéíóúñ\s-]{3,}|ubicacion|local\b/.test(lower),
      homepage: !pathname || pathname === '/' || /^\/[a-z]{2}(?:-[a-z]{2})?\/?$/i.test(pathname),
      pricing: /\bpricing|precios|premium|plan(es)?\b/.test(lower),
      googleBusiness: /\bgoogle my business|google business|perfil de empresa\b/.test(lower),
      campaigns: /\bcampaign|campana|campanas\b/.test(lower),
      hashtag: /\bhashtag\b/.test(lower),
      studio: /\bstudio\b/.test(lower),
      leadgen: /\blead gen|qualify leads|lead[s]?\b/.test(lower),
      training: /\btraining|capacit|formacion|classroom\b/.test(lower),
      finance: /\bbbva\b|\bbanco\b|\bbanca\b|\bfinancier|\bfinanzas\b|\binversi[oó]n|\binversores\b|\bbolsa\b|\bacciones\b|\baccionistas\b|\beconom[ií]a\b|\bsalud financiera\b/.test(lower)
    };

    const socialPlatforms = ['instagram', 'linkedin', 'tiktok', 'youtube', 'facebook', 'x', 'twitter']
      .filter((platform) => new RegExp(`\\b${platform.replace('.', '\\.') }\\b`, 'i').test(lower))
      .slice(0, 4)
      .map((platform) => platform === 'x' ? 'X' : platform.charAt(0).toUpperCase() + platform.slice(1));

    const primaryEntity = subject === 'esta pagina' ? '' : subject;

    const signals = {
      type,
      subject,
      primaryEntity,
      phrases: phraseCandidates.slice(0, 4),
      keywords: keywords.slice(0, 10),
      pathTerms: pathTerms.slice(0, 6),
      flags,
      socialPlatforms
    };
    signals.pageRole = this.getAuditPageCopyRole(page);
    signals.legalTitle = this.getAuditLegalTitle(page);
    signals.currentDescription = this.cleanAuditExampleSubject(page.metaDescription);
    signals.english = /^en\b/i.test(page.lang || page.language || '') ||
      /\b(success stories|statistics|sign up|contact us|plans and pricing|for customers|introducing|your|the|and)\b/i.test(page.title || '');
    signals.intentData = this.getPageCopyIntent(signals);
    return signals;
  }

  getPageCopyIntent(signals = {}) {
    if (signals.pageRole) return { intent: signals.pageRole, focus: '' };
    const type = String(signals.type || '').toLowerCase();
    const pathText = Array.isArray(signals.pathTerms) ? signals.pathTerms.join(' ') : '';
    const haystack = `${type} ${pathText} ${signals.subject || ''}`.toLowerCase();
    const flags = signals.flags || {};

    if (flags.homepage) return { intent: 'homepage', focus: '' };
    if (/contacto|contact/.test(haystack)) return { intent: 'contact', focus: '' };
    if (/blog|articulo|artículo|noticia|recurso|guia|guía|guías|post|salud financiera|economia|economía/.test(haystack)) return { intent: 'blog', focus: flags.finance ? 'finance-content' : '' };
    if (/faq|help|ayuda|docs|documentacion|documentación/.test(haystack)) return { intent: 'help', focus: '' };
    if (flags.finance && /\b(jovenes|jóvenes|bolsa|inversi[oó]n|salud financiera|econom[ií]a|noticia|articulo|artículo)\b/.test(haystack)) {
      return { intent: 'blog', focus: 'finance-content' };
    }
    if (/\b(pricing|precios|planes|plans)\b/.test(haystack)) {
      return { intent: 'pricing', focus: '' };
    }

    if (/\bconector|connector|integracion|integration|datastudio|data studio|looker studio|api|plugin|addon|app\b/.test(haystack)) {
      let focus = 'generic-integration';
      if (/looker studio|datastudio|data studio/.test(haystack)) focus = 'looker-studio';
      if (/google business|google my business|perfil de empresa/.test(haystack)) focus = 'google-business';
      return { intent: 'integration', focus };
    }

    if (flags.googleBusiness) return { intent: 'feature_tool', focus: 'google-business' };
    if (flags.hashtag) return { intent: 'feature_tool', focus: 'hashtag' };
    if (/\bplanificador|planner|calendar|calendario|schedule|scheduled\b/.test(haystack)) {
      return { intent: 'feature_tool', focus: 'planner' };
    }
    if (/\bgenerador|generator|contenido ia|content ai|content generator|copy ai|copywriter ai\b/.test(haystack) || (flags.ai && /\bcontenido|content|copy\b/.test(haystack))) {
      return { intent: 'feature_tool', focus: 'ai-content' };
    }
    if (flags.campaigns && (flags.analytics || flags.dashboard)) {
      return { intent: 'feature_tool', focus: 'campaign-dashboard' };
    }
    if (flags.studio && (flags.analytics || flags.dashboard)) {
      return { intent: 'feature_tool', focus: 'studio-reporting' };
    }
    if (flags.analytics || flags.dashboard) {
      return { intent: 'feature_tool', focus: 'analytics-reporting' };
    }
    if (/servicios|service/.test(haystack) && flags.local) {
      return { intent: 'local-service', focus: '' };
    }
    if (/servicios|service/.test(haystack)) return { intent: 'service', focus: '' };
    if (/productos|product|shop|store|tienda/.test(haystack)) return { intent: 'product', focus: '' };

    return { intent: 'generic', focus: '' };
  }

  buildAuditRoleExample(signals = {}, kind = 'meta') {
    const role = signals.intentData?.intent || 'generic';
    const subject = this.cleanAuditExampleSubject(signals.subject || '');
    const en = signals.english;
    if (role === 'legal') {
      const title = signals.legalTitle || subject || 'Información legal';
      if (kind === 'h1') return title;
      if (kind === 'meta') return 'Consulta ' + title.toLowerCase() + ' y el alcance indicado en este documento.';
      return 'Mantener la finalidad legal del documento y facilitar su lectura y navegación; no añadir un CTA comercial.';
    }
    const helpTopic = subject.replace(/^(?:FAQ(?: for customers)?|preguntas frecuentes)\s*[:–—-]\s*/i, '');
    const genericStoryTitle = /^(success stories|customer stories|casos de [eé]xito|testimonios)(?:\s*[-|].*)?$/i.test(subject);
    const genericStatsTitle = /^(statistics|stats|estad[ií]sticas)(?:\s*[-|].*)?$/i.test(subject);
    const titles = {
      stories: genericStoryTitle ? (en ? 'Customer success stories' : 'Casos de éxito de clientes') : subject,
      statistics: genericStatsTitle ? (en ? 'Statistics' : 'Estadísticas') : subject,
      registration: en ? 'Create your account' : 'Crea tu cuenta',
      contact: en ? 'Contact us' : 'Contacta con nosotros',
      pricing: en ? 'Plans and pricing' : 'Planes y precios'
    };
    const meta = {
      stories: genericStoryTitle
        ? (en ? 'Explore customer stories and learn about the challenges and approaches described in each case.' : 'Explora los casos de clientes y conoce los retos y enfoques descritos en cada experiencia.')
        : (en ? `Read the customer story: ${subject}. Explore the context and approach described in the case.` : `Lee el caso de cliente: ${subject}. Conoce el contexto y el enfoque descritos en esta experiencia.`),
      statistics: en ? `Consult ${genericStatsTitle ? 'the statistics presented on this page' : subject} and check the scope and sources of each figure.` : `Consulta ${genericStatsTitle ? 'las estadísticas de esta página' : subject} y revisa el alcance y las fuentes de cada cifra.`,
      registration: en ? 'Create your account using the registration form. Review the requirements and terms before continuing.' : 'Crea tu cuenta mediante el formulario de registro. Revisa los requisitos y las condiciones antes de continuar.',
      contact: en ? 'Find the available contact channels and choose the one that matches your enquiry.' : 'Consulta los canales de contacto disponibles y elige el adecuado para tu consulta.',
      pricing: en ? 'Compare the published plans, prices and conditions to choose the option that fits your needs.' : 'Compara los planes, precios y condiciones publicados para elegir la opción adecuada a tus necesidades.',
      education: en ? `Explore ${subject}. Review the published programme information and admission requirements.` : `Consulta ${subject}. Revisa la información publicada sobre el programa y sus requisitos de acceso.`,
      hotel: en ? `Explore ${subject}. Consult the listed accommodation and its details before choosing.` : `Explora ${subject}. Consulta los alojamientos publicados y sus características antes de elegir.`,
      category: en ? `Explore the listings in ${subject} and consult each offer's details and conditions.` : `Explora las opciones de ${subject} y consulta los detalles y condiciones de cada oferta.`,
      operational: en ? 'Review the purpose of this tool before proposing search-oriented copy.' : 'Comprobar la finalidad de esta herramienta antes de proponer textos orientados a búsquedas.',
      help: en ? `Find answers about ${helpTopic}. Consult the questions and explanations on this page.` : `Resuelve tus dudas sobre ${helpTopic}. Consulta las preguntas y explicaciones de esta página.`,
      news: en ? `Read the announcement: ${subject}. Consult the details in the published article.` : `Lee la noticia: ${subject}. Consulta los detalles en el artículo publicado.`,
      blog: en ? `Explore ${subject} and continue reading the content that interests you.` : `Explora ${subject} y continúa con la lectura del contenido que te interesa.`,
      institutional: en ? `Learn about ${subject} through the information presented on this page.` : `Conoce ${subject} a través de la información presentada en esta página.`
    };
    const ctas = {
      stories: en ? 'Read customer stories' : 'Ver casos de clientes', statistics: en ? 'View statistics' : 'Consultar estadísticas',
      registration: en ? 'Create account' : 'Crear cuenta', contact: en ? 'Send enquiry' : 'Enviar consulta',
      pricing: en ? 'Compare plans' : 'Comparar planes', help: en ? 'Read the answers' : 'Consultar respuestas',
      news: en ? 'Read the announcement' : 'Leer la noticia', blog: en ? 'Continue reading' : 'Seguir leyendo',
      institutional: en ? 'Learn about us' : 'Conocer la empresa',
      education: en ? 'View programme' : 'Ver programa', hotel: en ? 'View hotels' : 'Ver hoteles',
      category: en ? 'View options' : 'Ver opciones', operational: en ? 'Continue' : 'Continuar'
    };
    const blocks = {
      stories: 'Organizar cada caso por contexto, reto, intervención y resultados documentados. No inventar cifras ni testimonios.',
      statistics: 'Indicar qué mide cada cifra, fuente, fecha o periodo y metodología disponible.',
      registration: 'Explicar requisitos, condiciones y qué sucede tras el registro. No prometer gratuidad ni acceso inmediato sin comprobarlo.',
      contact: 'Distinguir canales y motivos de consulta. Indicar plazos de respuesta solo si están confirmados.',
      pricing: 'Comparar nombres, precios, límites y condiciones de los planes realmente publicados, sin inventar niveles ni prestaciones.',
      help: 'Ordenar preguntas y respuestas por tema y enlazar documentación relacionada; no sustituir las respuestas por argumentos comerciales.',
      news: 'Presentar el anuncio, fecha, alcance y fuente; separar hechos confirmados de implicaciones pendientes.',
      blog: 'Aclarar el tema, desarrollar la explicación y enlazar lecturas relacionadas. No añadir una venta si no responde a la intención.',
      institutional: 'Presentar identidad, actividad y trayectoria verificables; evitar beneficios y credenciales no documentados.',
      education: 'Presentar temario, modalidad y requisitos publicados; no inventar titulaciones, duración o salidas profesionales.',
      hotel: 'Distinguir destino, lista de hoteles y ficha de alojamiento; enlazar disponibilidad solo si existe ese recorrido.',
      category: 'Ordenar las ofertas según sus características y filtros disponibles; no asumir que se reservan citas.',
      operational: 'Identificar la tarea de la herramienta, sus controles y su política de indexación antes de recomendar cambios SEO.'
    };
    if (!Object.prototype.hasOwnProperty.call(meta, role)) return null;
    if (kind === 'meta') return meta[role];
    if (kind === 'h1') return titles[role] || subject;
    if (kind === 'cta') return `Ejemplo de CTA: "${ctas[role]}"`;
    return `Estructura sugerida: ${blocks[role]}`;
  }

  buildIntentMetaProposal(signals = {}, memory = null) {
    const roleExample = this.buildAuditRoleExample(signals, 'meta');
    if (roleExample !== null) return roleExample;
    if (signals.intentData?.intent === 'homepage' && signals.currentDescription?.length >= 30) {
      return signals.currentDescription;
    }
    const subject = signals.subject || 'esta pagina';
    const namedSubject = signals.primaryEntity || subject;
    const intentData = signals.intentData || this.getPageCopyIntent(signals);
    const intent = intentData.intent || 'generic';
    const focus = intentData.focus || '';
    const socialPlatforms = Array.isArray(signals.socialPlatforms) ? signals.socialPlatforms : [];

    if (intent === 'homepage' && signals.flags?.hubspot) {
      return 'Unifica marketing, ventas y soporte en una sola plataforma con CRM, automatizacion y herramientas para equipos en crecimiento.';
    }
    if (intent === 'homepage' && signals.flags?.social && signals.flags?.analytics) {
      return `Gestiona redes sociales, programa contenido y analiza rendimiento en ${namedSubject} desde un solo panel.`;
    }
    if (intent === 'pricing') {
      return `Compara los planes de ${namedSubject} y elige la opcion que mejor encaja con tu equipo, flujo de trabajo y nivel de gestion.`;
    }
    if (intent === 'integration') {
      if (focus === 'looker-studio') {
        return `Conecta ${namedSubject} con Looker Studio y transforma datos dispersos en informes claros, automaticos y faciles de compartir.`;
      }
      if (focus === 'google-business') {
        return 'Conecta Google Business con tu flujo de analisis para seguir visibilidad local, publicaciones y resultados sin depender de procesos manuales.';
      }
      return `Conecta ${namedSubject} con tus herramientas clave y centraliza datos sin friccion operativa ni pasos manuales repetitivos.`;
    }
    if (intent === 'feature_tool') {
      if (focus === 'google-business') {
        return 'Gestiona tu perfil de Google Business, publica novedades y mide visibilidad local desde un flujo mas claro y accionable.';
      }
      if (focus === 'hashtag') {
        return 'Monitorea hashtags y conversaciones en tiempo real para detectar alcance, tendencias y oportunidades de contenido con mas rapidez.';
      }
      if (focus === 'planner') {
        return 'Planifica, organiza y programa contenido desde un calendario claro para publicar con mas consistencia y menos friccion operativa.';
      }
      if (focus === 'ai-content') {
        return 'Genera ideas, copys y variaciones de contenido con IA para publicar mas rapido y mantener consistencia entre canales.';
      }
      if (focus === 'campaign-dashboard') {
        return 'Visualiza campanas y resultados en un dashboard claro para detectar que escalar, ajustar o cortar con menos friccion analitica.';
      }
      if (focus === 'studio-reporting') {
        return 'Genera informes visuales y comparte rendimiento entre canales sin horas extra de reporting manual ni exportaciones repetidas.';
      }
      if (focus === 'analytics-reporting') {
        if (socialPlatforms.length >= 2) {
          return `Conecta ${socialPlatforms.join(', ')} y otras fuentes para convertir datos dispersos en decisiones mas rapidas y reportes mas claros.`;
        }
        return `${namedSubject}: centraliza datos, automatiza reportes y gana claridad operativa en menos tiempo.`;
      }
    }
    if (intent === 'contact') {
      return `Habla con el equipo de ${subject} y recibe orientacion clara sobre alcance, tiempos y siguiente paso para avanzar con menos friccion.`;
    }
    if (intent === 'blog') {
      return `${subject}: guia practica con ejemplos claros, aprendizajes accionables y siguiente paso recomendado para profundizar.`;
    }
    if (intent === 'local-service') {
      return `${subject}: consulta la información del servicio y cómo contactar. Confirma disponibilidad y condiciones antes de reservar.`;
    }
    if (signals.flags?.migration && signals.flags?.hubspot) {
      return 'Migra a HubSpot sin perder datos ni interrumpir operaciones, con implementacion guiada y soporte experto.';
    }
    if (signals.flags?.onboarding && signals.flags?.hubspot) {
      return 'Activa HubSpot mas rapido con onboarding guiado para marketing, ventas y soporte.';
    }
    if (signals.flags?.training && signals.flags?.hubspot) {
      return 'Capacita a tu equipo en HubSpot con sesiones guiadas, mejor adopcion y una implementacion mas ordenada.';
    }
    if (signals.flags?.ai && signals.flags?.support && signals.flags?.leadgen) {
      return 'Captura leads, responde preguntas comerciales y resuelve tickets 24/7 con un agente IA conectado al CRM.';
    }
    if (signals.flags?.ai && signals.flags?.support) {
      return `Automatiza soporte con IA, reduce tickets repetitivos y mejora el contexto de cada conversacion en ${namedSubject}.`;
    }
    return '';
  }

  buildIntentH1Proposal(signals = {}, memory = null) {
    const roleExample = this.buildAuditRoleExample(signals, 'h1');
    if (roleExample !== null) return roleExample;
    const subject = signals.subject || 'esta pagina';
    const namedSubject = signals.primaryEntity || subject;
    const intentData = signals.intentData || this.getPageCopyIntent(signals);
    const intent = intentData.intent || 'generic';
    const focus = intentData.focus || '';

    if (intent === 'pricing') return `Planes de ${namedSubject} para elegir con claridad segun equipo y objetivos`;
    if (intent === 'integration') return `Conecta ${namedSubject} y automatiza mejor tus datos`;
    if (intent === 'feature_tool' && focus === 'google-business') return 'Gestiona Google Business y mide visibilidad local con mas claridad';
    if (intent === 'feature_tool' && focus === 'hashtag') return 'Monitorea hashtags y detecta oportunidades de contenido en tiempo real';
    if (intent === 'feature_tool' && focus === 'planner') return 'Planifica y programa contenido desde un calendario mas claro';
    if (intent === 'feature_tool' && focus === 'ai-content') return 'Genera ideas y copys con IA para publicar mas rapido';
    if (intent === 'feature_tool' && focus === 'campaign-dashboard') return 'Analiza campanas en un dashboard mas claro y accionable';
    if (intent === 'feature_tool' && focus === 'studio-reporting') return 'Crea informes visuales y comparte rendimiento sin friccion';
    if (intent === 'feature_tool' && focus === 'analytics-reporting') return `${namedSubject}: datos claros para decidir mejor y reportar mas rapido`;
    if (intent === 'contact') return `Habla con el equipo de ${subject} y recibe una respuesta clara para avanzar`;
    if (intent === 'blog' && signals.flags?.finance) return `${subject}: guía clara para entender la decisión financiera y avanzar con más contexto`;
    if (intent === 'blog') return `${subject}: guia practica para entender, comparar y aplicar mejor esta solucion`;
    return subject === 'esta pagina' ? '' : subject;
  }

  buildIntentCtaProposal(signals = {}) {
    const roleExample = this.buildAuditRoleExample(signals, 'cta');
    if (roleExample !== null) return roleExample;
    const subject = signals.subject || 'esta pagina';
    const namedSubject = signals.primaryEntity || subject;
    const intentData = signals.intentData || this.getPageCopyIntent(signals);
    const intent = intentData.intent || 'generic';
    const focus = intentData.focus || '';

    if (intent === 'pricing') return `Ejemplo de CTA: "Comparar planes de ${namedSubject}"`;
    if (intent === 'integration') return `Ejemplo de CTA: "Ver como conectar ${namedSubject}"`;
    if (intent === 'feature_tool' && focus === 'google-business') return 'Ejemplo de CTA: "Ver gestion de Google Business en accion"';
    if (intent === 'feature_tool' && focus === 'hashtag') return 'Ejemplo de CTA: "Empezar a monitorear hashtags"';
    if (intent === 'feature_tool' && focus === 'planner') return 'Ejemplo de CTA: "Probar el planificador"';
    if (intent === 'feature_tool' && focus === 'ai-content') return 'Ejemplo de CTA: "Generar ideas con IA"';
    if (intent === 'feature_tool' && (focus === 'campaign-dashboard' || focus === 'studio-reporting' || focus === 'analytics-reporting')) {
      return `Ejemplo de CTA: "Ver demo de ${namedSubject} en accion"`;
    }
    if (intent === 'contact') return `Ejemplo de CTA: "Solicitar propuesta para ${subject}"`;
    if (signals.flags?.migration) return `Ejemplo de CTA: "Planificar migracion de ${subject}"`;
    if (signals.flags?.onboarding) return `Ejemplo de CTA: "Ver plan de onboarding para ${subject}"`;
    if (intent === 'product') return 'Ejemplo de CTA: "Ver detalles del producto"';
    if (intent === 'service' || intent === 'local-service') return 'Ejemplo de CTA: "Consultar el servicio"';
    if (intent === 'blog' && signals.flags?.finance) return 'Ejemplo de CTA: "Consultar salud financiera"';
    if (intent === 'blog') return `Ejemplo de CTA: "Ver como aplicar ${subject} en tu caso"`;
    return 'Elegir el siguiente paso según la tarea de esta URL y el destino disponible; no asumir una consulta comercial.';
  }

  buildIntentContentExpansion(signals = {}) {
    const roleExample = this.buildAuditRoleExample(signals, 'content');
    if (roleExample !== null) return roleExample;
    const subject = signals.subject || 'esta pagina';
    const intentData = signals.intentData || this.getPageCopyIntent(signals);
    const intent = intentData.intent || 'generic';
    const focus = intentData.focus || '';

    if (intent === 'pricing') {
      return 'Ejemplo de bloque a sumar:\nPlan | Ideal para | Que incluye\nBasico | equipos chicos | funciones esenciales\nPro | equipos en crecimiento | mas automatizacion y analitica\nAvanzado | operaciones complejas | colaboracion, reportes y soporte ampliado';
    }
    if (intent === 'integration') {
      return 'Estructura sugerida: sistemas compatibles, datos intercambiados, requisitos y pasos de conexión comprobados. Indicar tiempos de configuración solo si fueron medidos.';
    }
    if (intent === 'feature_tool' && focus === 'google-business') {
      return 'Ejemplo de bloque a sumar:\nQue haces | Para que sirve\nPublicaciones | mantener el perfil activo\nResenas | reforzar confianza local\nVisibilidad | detectar si la ficha gana o pierde traccion';
    }
    if (intent === 'feature_tool' && focus === 'hashtag') {
      return 'Ejemplo de bloque a sumar:\nHashtag | Que detecta | Para que sirve\nMarca | menciones activas | medir conversacion\nCampana | volumen y picos | evaluar impacto\nCompetencia | temas repetidos | encontrar oportunidades';
    }
    if (intent === 'feature_tool' && focus === 'planner') {
      return 'Ejemplo de bloque a sumar:\nCanal | Formato | Fecha\nInstagram | reel | lunes\nLinkedIn | post | miercoles\nTikTok | video corto | viernes';
    }
    if (intent === 'feature_tool' && focus === 'ai-content') {
      return 'Ejemplo de bloque a sumar:\nObjetivo | Prompt base | Resultado\nIdea | tema + audiencia | lista inicial\nCopy | tono + CTA | texto listo\nVariacion | canal + formato | adaptaciones por red';
    }
    if (intent === 'feature_tool' && (focus === 'campaign-dashboard' || focus === 'studio-reporting' || focus === 'analytics-reporting')) {
      return 'Ejemplo de bloque a sumar:\nFuente | Que ves | Decision que habilita\nCampanas | picos y caidas | que escalar o cortar\nCanales | comparativa | donde poner presupuesto\nReporte | resumen compartible | siguiente accion clara';
    }
    if (signals.flags?.migration) {
      return `Ejemplo de bloque a sumar:\nPaso | Que resuelve | Resultado\nAuditoria previa | detecta riesgos y dependencias | menos friccion\nMigracion guiada | conserva datos clave | continuidad operativa\nValidacion final | revisa integraciones y equipo | salida mas segura`;
    }
    if (signals.flags?.onboarding) {
      return `Ejemplo de bloque a sumar:\nArea | Alcance | Resultado\nMarketing | configuracion inicial | activacion mas rapida\nVentas | pipeline y automatizaciones | mejor adopcion\nSoporte | tickets y vistas | operacion mas ordenada`;
    }
    if (/servicios|productos/.test(signals.type || '')) {
      return 'Estructura sugerida: alcance o características, condiciones y destinatarios según el servicio o producto publicado. No añadir plazos ni prestaciones sin confirmar.';
    }
    if (intent === 'contact') {
      return `Ejemplo de bloque a sumar:\n- Tiempo de respuesta: 24h\n- Canal recomendado: formulario o llamada\n- Siguiente paso: propuesta o reunion breve`;
    }
    if (intent === 'blog' && signals.flags?.finance) {
      return `Ejemplo de bloque a sumar:\n- Dato clave para entender la decisión\n- Riesgo o punto a revisar antes de avanzar\n- Recurso relacionado para profundizar`;
    }
    if (intent === 'blog') {
      return `Ejemplo de bloque a sumar:\n- Que cambia en la practica\n- Error comun a evitar\n- Siguiente paso recomendado relacionado con ${subject}`;
    }
    if (signals.flags?.finance) {
      return `Ejemplo: sumar datos clave, respaldo institucional y acceso claro a información financiera relacionada.`;
    }
    return `Ejemplo de bloque a sumar:\n- Beneficio principal de ${subject}\n- Prueba o resultado visible\n- Siguiente paso claro para avanzar`;
  }

  buildPageSpecificOfferCandidates(signals = {}, skipIntentFallback = false) {
    const subject = signals.subject || 'esta pagina';
    const primaryEntity = signals.primaryEntity || '';
    const socialPlatforms = Array.isArray(signals.socialPlatforms) ? signals.socialPlatforms : [];
    const pathTerms = Array.isArray(signals.pathTerms) ? signals.pathTerms : [];
    const flags = signals.flags || {};
    const namedSubject = primaryEntity || subject;
    const intentData = signals.intentData || this.getPageCopyIntent(signals);
    const intent = intentData.intent || 'generic';
    const focus = intentData.focus || '';
    const candidates = [];
    const pushCandidate = (text = '') => {
      const value = String(text || '').replace(/\s+/g, ' ').trim();
      if (value && !candidates.includes(value)) candidates.push(value);
    };

    if (!skipIntentFallback) {
      pushCandidate(this.buildIntentMetaProposal(signals, null));
    }
    if (intent === 'feature_tool' && focus === 'analytics-reporting' && socialPlatforms.length >= 2) {
      pushCandidate(`Conecta ${socialPlatforms.join(', ')} y otras fuentes en ${namedSubject} para crear informes automaticos desde un solo panel.`);
    }
    if (intent === 'feature_tool' && focus === 'studio-reporting') {
      pushCandidate('Cruza rendimiento entre canales, comparte informes mas claros y reduce horas de reporting manual con una vista mas ordenada.');
    }
    if (intent === 'feature_tool' && focus === 'campaign-dashboard') {
      pushCandidate('Compara campanas por canal, detecta cambios de performance y comparte resultados con una lectura mucho mas clara.');
    }
    if (intent === 'homepage' && flags.support && flags.ai) {
      pushCandidate(`Automatiza soporte con IA, reduce tickets repetitivos y mejora el contexto de cada conversacion en ${namedSubject}.`);
    }
    if (intent === 'service' && flags.support) {
      pushCandidate(`Escala soporte con procesos mas claros, menos friccion operativa y respuestas mas rapidas para el equipo.`);
    }
    if ((intent === 'service' || intent === 'product') && flags.crm && (flags.marketing || flags.sales)) {
      pushCandidate(`Integra CRM, marketing y ventas en ${namedSubject} con una propuesta mas clara y orientada a resultados.`);
    }
    if (primaryEntity && primaryEntity.toLowerCase() !== subject.toLowerCase()) {
      pushCandidate(`${subject}: refuerza ${primaryEntity} con una promesa mas concreta, beneficios visibles y un siguiente paso claro.`);
    }
    if (pathTerms.length >= 2 && !['pricing', 'integration', 'feature_tool'].includes(intent)) {
      pushCandidate(`${subject}: ${pathTerms.slice(0, 2).join(' y ')} con una propuesta más clara, beneficio visible y acción concreta.`);
    }
    if (flags.finance) {
      pushCandidate(`${subject}: contexto financiero claro, respaldo visible y acceso directo a un recurso relacionado.`);
    } else {
      pushCandidate(`${subject}: propuesta clara, beneficio especifico y una accion concreta para mover mejor al usuario.`);
    }
    return candidates.filter((candidate) => {
      if (intent !== 'pricing' && /^elige el plan/i.test(candidate)) return false;
      if (focus !== 'google-business' && /google business/i.test(candidate)) return false;
      if (intent !== 'feature_tool' && /monitoriza hashtags/i.test(candidate)) return false;
      if (intent !== 'feature_tool' && /dashboards para campanas/i.test(candidate)) return false;
      if (!['feature_tool', 'integration'].includes(intent) && /informe[s]? avanzados|reporting manual|informes automaticos/i.test(candidate)) return false;
      return true;
    });
  }

  normalizeExampleSignature(text = '') {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\b(hubspot|metricool|inicio|pagina|servicio|producto|solucion|plataforma|equipo|equipos)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter((token) => token.length > 3)
      .slice(0, 10)
      .join(' ');
  }

  pickDistinctOfferCandidate(candidates = [], memory = null) {
    const items = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (!items.length) return '';
    if (!memory || !(memory.signatures instanceof Set)) return items[0];

    for (const candidate of items) {
      const signature = this.normalizeExampleSignature(candidate);
      if (!signature || !memory.signatures.has(signature)) {
        memory.signatures.add(signature);
        return candidate;
      }
    }

    const fallback = items[0];
    const fallbackSignature = this.normalizeExampleSignature(fallback);
    if (fallbackSignature) memory.signatures.add(fallbackSignature);
    return fallback;
  }

  buildPageSpecificOfferLine(signals = {}, memory = null, skipIntentFallback = false) {
    return this.pickDistinctOfferCandidate(this.buildPageSpecificOfferCandidates(signals, skipIntentFallback), memory);
  }

  buildMetaDescriptionExample(page = {}, pageType = '', subject = 'esta pagina', memory = null) {
    const current = String(page.metaDescription || '').trim();
    const signals = this.getPageExampleSignals(page, pageType, subject);
    const proposal = this.buildIntentMetaProposal(signals, memory);
    if (proposal && this.normalizeCompetitiveToken(proposal) === this.normalizeCompetitiveToken(current)) {
      return `Base observada que puede conservarse: "${current}". Mantenerla si representa la actividad y alcance actuales. Ajustar únicamente los hechos que hayan cambiado o la información útil que falte; no alargarla por un objetivo de caracteres.`;
    }
    if (!proposal) return 'Criterio de redacción: resumir el contenido y la tarea real de esta URL. Conservar los hechos verificados; no añadir beneficios, planes ni servicios no observados. No hay evidencia suficiente para proponer un texto final específico.';

    return current
      ? `Actual: "${current}"\nBorrador orientativo, adaptar al contenido publicado: "${proposal}"`
      : `Borrador orientativo, adaptar al contenido publicado: "${proposal}"`;
  }

  buildH1Example(page = {}, pageType = '', subject = 'esta pagina', memory = null) {
    const contactTitle = String(page.title || '').match(/^Contacto\s+([^|]+?)(?:\s*\|\s*([^,|]+))?$/i) ||
      String(page.title || '').match(/^Contacto\s+([^|]+?)\s*\|\s*([^,|]+)/i);
    if (/contacto/i.test(pageType) && contactTitle?.[1]) {
      const business = contactTitle[1].trim();
      const locality = String(contactTitle[2] || '').trim();
      return `Ejemplo de H1: "Contacta con ${business}${locality ? ` en ${locality}` : ''}"`;
    }
    const signals = this.getPageExampleSignals(page, pageType, subject);
    return `Ejemplo de H1: "${this.buildIntentH1Proposal(signals, memory)}"`;
  }

  buildCtaExample(page = {}, pageType = '', subject = 'esta pagina') {
    const signals = this.getPageExampleSignals(page, pageType, subject);
    return this.buildIntentCtaProposal(signals);
  }

  buildContentExpansionExample(page = {}, pageType = '', subject = 'esta pagina') {
    const signals = this.getPageExampleSignals(page, pageType, subject);
    return this.buildIntentContentExpansion(signals);
  }

  buildLocalSeoExample(subject = 'esta pagina', localityHint = '') {
    const locality = String(localityHint || '').trim() || 'tu zona principal';
    return `Ejemplo visible: "${subject} en ${locality} con una propuesta clara, prueba social y llamada a la accion orientada a contacto o reserva."`;
  }

  buildPageFindingExecutionLayer(page = {}, context = {}) {
    const issue = String(context.issue || '').toLowerCase();
    const recommendation = String(context.recommendation || '').toLowerCase();
    const combined = `${issue} ${recommendation}`;
    const pageType = String(context.pageType || page.type || '').toLowerCase();
    const subject = this.buildPageExampleSubject(page);
    const localityHint = context.localityHint || '';
    const exampleMemory = context.exampleMemory || null;

    if (/meta descripci[oó]n/.test(combined)) {
      return {
        example: this.normalizeVisibleSpanishText([
          /\bh1\b/.test(combined) ? this.buildH1Example(page, pageType, subject, exampleMemory) : '',
          this.buildMetaDescriptionExample(page, pageType, subject, exampleMemory)
        ].filter(Boolean).join('\n')),
        impact: this.normalizeVisibleSpanishText('Aclara el tema y la tarea de esta URL. El efecto sobre clics debe comprobarse; la longitud de la descripción no demuestra por sí sola una pérdida de rendimiento.')
      };
    }

    if (/\bh1\b/.test(combined)) {
      return {
        example: this.normalizeVisibleSpanishText(this.buildH1Example(page, pageType, subject, exampleMemory)),
        impact: this.normalizeVisibleSpanishText('Aclara la intención principal de esta URL en su estructura visible.' +
          (/alt vac[ií]o|sin atributo alt/.test(combined) ? ' Revisar también si las imágenes con ALT vacío son decorativas o informativas.' : '') +
          ' No se midió un cambio en rankings o clics.')
      };
    }

    if (/alt vac[ií]o|sin atributo alt/.test(combined)) {
      return { example: '', impact: 'Revisión de accesibilidad por función de la imagen. Un ALT vacío no demuestra por sí solo un error; no se atribuye un impacto de posicionamiento sin comprobarlo.' };
    }

    if (/canonical/.test(combined)) {
      return {
        example: this.normalizeVisibleSpanishText(`Ejemplo técnico: <link rel="canonical" href="${String(page.url || '').trim()}" />`),
        impact: this.normalizeVisibleSpanishText('Reduce ambigüedad entre URLs similares y ayuda a concentrar autoridad en la versión correcta.')
      };
    }

    if (/contenido visible es breve|expandir esta url|expandir esta pagina|profundizar/.test(combined)) {
      return {
        example: this.normalizeVisibleSpanishText(this.buildContentExpansionExample(page, pageType, subject)),
        impact: this.normalizeVisibleSpanishText('Sube relevancia útil por URL, reduce rebote comercial y da más argumentos antes del CTA.')
      };
    }

    if (/cta principal|llamado a la accion|reserva|contactar|propuesta|asesoria|diagnostico/.test(combined)) {
      return {
        example: this.normalizeVisibleSpanishText(this.buildCtaExample(page, pageType, subject)),
        impact: this.normalizeVisibleSpanishText('Reduce ambigüedad y mueve al usuario a una acción medible más acorde a la intención de esa página.')
      };
    }

    if (/seo local|ubicaci[oó]n|geogr[aá]fico|b[uú]squedas locales|negocio local/.test(combined)) {
      return {
        example: this.normalizeVisibleSpanishText(this.buildLocalSeoExample(subject, localityHint)),
        impact: this.normalizeVisibleSpanishText('Refuerza relevancia local en home y URLs clave, aumentando opciones de aparecer en consultas geográficas de alta intención.')
      };
    }

    const signals = this.getPageExampleSignals(page, pageType, subject);
    const intent = signals.intentData?.intent || '';
    if (signals.flags?.finance) {
      if (/resultados|inversores|accionistas|informes?/.test(`${pageType} ${page.url || ''} ${page.title || ''}`.toLowerCase())) {
        return {
          example: this.normalizeVisibleSpanishText('Ejemplo: destacar datos clave, contexto de lectura y acceso directo al informe o sección relacionada.'),
          impact: this.normalizeVisibleSpanishText('Facilita la lectura institucional y reduce pasos para usuarios que buscan información financiera concreta.')
        };
      }
      if (intent === 'blog') {
        return {
          example: this.normalizeVisibleSpanishText('Ejemplo: cerrar el contenido con un enlace contextual hacia una guía financiera, herramienta o sección relacionada.'),
          impact: this.normalizeVisibleSpanishText('Mejora continuidad de lectura y ayuda a mover tráfico informativo hacia rutas útiles del sitio.')
        };
      }
      return {
        example: this.normalizeVisibleSpanishText('Ejemplo: explicar el beneficio principal, mostrar respaldo y guiar hacia una herramienta o recurso relacionado.'),
        impact: this.normalizeVisibleSpanishText('Aumenta claridad y ayuda al usuario a elegir el siguiente paso sin perder contexto.')
      };
    }

    if (intent === 'homepage') {
      return {
        example: this.normalizeVisibleSpanishText('Ejemplo: añadir una promesa más concreta, prueba visible y CTA principal para orientar al usuario desde el primer bloque.'),
        impact: this.normalizeVisibleSpanishText('Reduce dispersión inicial y mejora la probabilidad de que el usuario avance por la ruta principal.')
      };
    }

    return {
      example: this.normalizeVisibleSpanishText(this.buildAuditRoleExample(signals, 'content') || 'Contrastar la recomendación con el contenido y la tarea de esta URL antes de redactar un ejemplo específico.'),
      impact: this.normalizeVisibleSpanishText('Hace la recomendación más ejecutable y ayuda a convertir el hallazgo en una mejora visible dentro de la misma URL.')
    };
  }

  finalizePageSpecificExecution(findings = [], localityHint = '') {
    const exampleMemory = { signatures: new Set() };

    return (Array.isArray(findings) ? findings : []).map((finding) => {
      if (finding.contextOnly || finding.evidenceOnly) return { ...finding, example: '', expectedImpact: '' };
      const executionLayer = this.buildPageFindingExecutionLayer(finding, {
        issue: finding.issue,
        recommendation: finding.recommendation,
        pageType: finding.type,
        localityHint,
        exampleMemory
      });

      return {
        ...finding,
        label: this.normalizeVisibleSpanishText(finding.label || ''),
        title: this.normalizeVisibleSpanishText(finding.title || ''),
        issue: this.normalizeVisibleSpanishText(finding.issue || ''),
        recommendation: this.normalizeVisibleSpanishText(finding.recommendation || ''),
        strength: this.normalizeVisibleSpanishText(finding.strength || ''),
        opportunity: this.normalizeVisibleSpanishText(finding.opportunity || ''),
        example: this.normalizeVisibleSpanishText(executionLayer.example || ''),
        expectedImpact: this.normalizeVisibleSpanishText(executionLayer.impact || '')
      };
    });
  }

  extractLocalityFromSeoSignals(pageData = {}, keywords = {}) {
    const geoKeywords = Array.isArray(pageData?.contactInfo?.geolocationKeywords)
      ? pageData.contactInfo.geolocationKeywords
      : [];
    const brands = this.getCompetitiveBrandTerms(pageData);
    const validPlace = value => {
      const text = this.normalizeCompetitiveToken(value);
      return text.length >= 3 && text.split(' ').length <= 5 &&
        !/\b(negocios|tecnologia|marketing|envios|gratis|dia|mercado|online|internet|servicios|formacion|software|empresas|reservas)\b/.test(text) &&
        !brands.some(brand => text.includes(brand));
    };
    // Generated keywords cannot establish geography: that would feed a guess back as evidence.
    const visibleSources = [
      pageData?.title,
      pageData?.metaDescription,
      ...(Array.isArray(pageData?.h1s) ? pageData.h1s : [])
    ]
      .map((value) => this.normalizeCompetitiveText(value || ''))
      .filter(Boolean);

    for (const source of visibleSources) {
      const locationMatch = source.match(/\ben\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ-]+(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ-]+){0,2})(?=\s*(?:[|,.;]|$))/);
      const localDeclaration = /\b(peluqueria|salon|barberia|dentista|clinica|restaurante|hotel|hoteles|estudio juridico|abogados|inmobiliaria|gimnasio|ubicados?|sede|direccion)\b/.test(this.normalizeCompetitiveToken(source));
      if (localDeclaration && locationMatch?.[1] && validPlace(locationMatch[1])) return locationMatch[1].trim();
    }
    const candidates = [...new Set(geoKeywords.map(value => String(value).trim()).filter(validPlace))];
    return candidates.length === 1 ? candidates[0] : '';
  }

  ensureSeoKeywordSuggestions(analysis = {}, pageData = {}, auditScope = {}, analyzedPages = []) {
    if (!analysis || typeof analysis !== 'object') return analysis;
    const representative = this.buildAuditTopicEvidence(pageData, analyzedPages);
    if (!representative.pages.length && this.getAuditPageCopyRole(pageData) === 'legal') {
      analysis.keywords = { primary: [], longTail: [], local: [] };
      analysis.keywordEvidence = [];
      analysis.keywordStatus = 'insufficient_evidence';
      analysis.businessFocus = { primaryActivities: [], observedServices: [], evidenceUrl: pageData.url || '', confidence: 'documento legal, sin intención comercial' };
      return analysis;
    }
    if (representative.multiPage) {
      pageData = representative.pages.find(page => this.getAuditPageCopyRole(page) === 'homepage') || representative.pages[0] || pageData;
    }
    analyzedPages = analyzedPages.filter(page => !['operational', 'legal', 'contact', 'help', 'blog', 'news'].includes(this.getAuditPageCopyRole(page)));

    const current = analysis.keywords && typeof analysis.keywords === 'object'
      ? analysis.keywords
      : {};
    const unique = (values = [], limit = 6) => {
      const seen = new Set();
      return values
        .map((value) => this.normalizeVisibleSpanishText(String(value || '').trim()))
        .filter((value) => value.length >= 3)
        .filter((value) => {
          const key = this.normalizeCompetitiveToken(value);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, limit);
    };

    const existingPrimary = unique(Array.isArray(current.primary) ? current.primary : []);
    const existingLongTail = unique(Array.isArray(current.longTail) ? current.longTail : []);
    const existingLocal = unique(Array.isArray(current.local) ? current.local : []);
    const pageText = [
      pageData?.title,
      pageData?.metaDescription,
      pageData?.description,
      pageData?.textContent,
      ...(Array.isArray(pageData?.h1s) ? pageData.h1s : []),
      ...(Array.isArray(analyzedPages)
        ? analyzedPages.filter(page => page.readStatus === 'complete').flatMap((page) => [page?.label, page?.title, page?.h1, page?.metaDescription])
        : [])
    ].filter(Boolean).join(' ');
    const normalizedText = this.normalizeCompetitiveToken(pageText);
    const phraseCatalog = [
      'centro de belleza', 'salón de belleza', 'centro de estética', 'clínica estética',
      'peluquería', 'barbería', 'spa', 'dentista', 'clínica dental', 'restaurante',
      'hotel', 'tienda online', 'agencia de marketing', 'estudio jurídico',
      'inmobiliaria', 'gimnasio', 'academia', 'consultoría'
    ];
    const serviceCatalog = [
      'lifting de pestañas', 'cejas y pestañas', 'manicure y pedicure', 'manicure',
      'pedicure', 'limpieza facial', 'depilación', 'micropigmentación', 'maquillaje',
      'peluquería', 'coloración', 'tratamientos capilares', 'diseño web',
      'posicionamiento seo', 'publicidad digital', 'reservas online'
    ];
    const headline = this.normalizeCompetitiveToken([pageData.title, pageData.seoStructure?.headings?.h1, ...(pageData.h1s || [])].filter(Boolean).join(' '));
    const description = this.normalizeCompetitiveToken(pageData.metaDescription || '');
    const contains = (text, phrase) => (' ' + text + ' ').includes(' ' + this.normalizeCompetitiveToken(phrase) + ' ');
    const relevance = phrase => (contains(headline, phrase) ? 100 : 0) + (contains(description, phrase) ? 20 : 0) +
      analyzedPages.filter(page => page.readStatus === 'complete' && contains(this.normalizeCompetitiveToken([page.title, page.h1].join(' ')), phrase)).length;
    const matchesCatalog = catalog => catalog.filter(phrase => contains(normalizedText, phrase))
      .sort((a, b) => relevance(b) - relevance(a) || normalizedText.indexOf(this.normalizeCompetitiveToken(a)) - normalizedText.indexOf(this.normalizeCompetitiveToken(b)));
    const categories = matchesCatalog(phraseCatalog);
    const matchedServices = matchesCatalog(serviceCatalog);
    const services = matchedServices
      .filter((service) => !categories.some((category) => this.normalizeCompetitiveToken(category) === this.normalizeCompetitiveToken(service)))
      .filter((service) => !matchedServices.some((other) =>
        other !== service && this.normalizeCompetitiveToken(other).includes(this.normalizeCompetitiveToken(service))
      ));
    const scope = this.buildCompetitiveContext({ keywords: current }, pageData, auditScope, analyzedPages);
    const locality = scope.shouldUseLocality ? scope.locality : '';
    const category = categories[0] || '';
    const visibleExisting = existingPrimary.filter(phrase => contains(normalizedText, phrase));
    const observedTopics = this.extractObservedAuditTopics(pageData, analyzedPages);
    let supported = unique([...categories, ...services, ...visibleExisting,
      ...(!categories.length && !services.length ? observedTopics : []),
      ...(analysis.businessFocus?.observedServices || []).filter(phrase => contains(normalizedText, phrase))], 30)
      .sort((a, b) => relevance(b) - relevance(a));
    supported = supported.filter(term => this.isAuditTopicPhrase(term));
    if (representative.multiPage && !categories.length && !services.length) supported = representative.topics;

    const primary = unique([
      representative.multiPage ? '' : category,
      ...supported
    ], 5);
    const validIntent = phrase => primary.some(term => contains(this.normalizeCompetitiveToken(phrase), term)) &&
      contains(normalizedText, phrase);
    const destinationTopics = analyzedPages.filter(page => page.readStatus === 'complete' && this.getAuditPageCopyRole(page) === 'hotel')
      .map(page => {
        try {
          const path = decodeURIComponent(new URL(page.url).pathname).replace(/\/$/, '');
          const place = path.match(/\/(?:hoteles|hotels)\/(?:.*\/)?([^/]+)$/i)?.[1]?.replace(/-/g, ' ');
          const heading = this.normalizeCompetitiveToken([page.title, page.h1].join(' '));
          return place && contains(heading, place) ? 'hoteles en ' + place : '';
        } catch (_) { return ''; }
      })
      .filter(Boolean);
    const longTail = unique([
      ...destinationTopics,
      ...primary.map(service => locality ? `${service} en ${locality}` : ''),
      ...existingLongTail.filter(validIntent)
    ], 5);
    const local = unique([
      ...primary.slice(0, 3).map(service => locality ? `${service} ${locality}` : '')
    ], 4);

    analysis.businessFocus = {
      primaryActivities: representative.multiPage ? supported.slice(0, 3) : supported.filter(phrase => contains(headline, phrase)),
      observedServices: supported,
      evidenceUrl: pageData.url || '',
      confidence: supported.some(phrase => contains(headline, phrase)) ? 'actividad declarada en título o H1' : 'actividad pendiente de confirmar'
    };
    analysis.keywords = { primary, longTail, local };
    analysis.keywordEvidence = primary.map(term => ({ term, source: representative.multiPage ? 'contenido observado ponderado por función y recurrencia entre URLs' : 'contenido observado',
      urls: [pageData, ...analyzedPages.filter(page => page.readStatus === 'complete')]
        .filter(page => contains(this.normalizeCompetitiveToken([page.title, page.h1, ...(page.h1s || []), page.metaDescription].filter(Boolean).join(' ')), term))
        .map(page => page.url).filter((url, i, all) => url && all.indexOf(url) === i) }));
    analysis.keywordStatus = primary.length ? 'observed_topics' : 'insufficient_evidence';
    return analysis;
  }

  buildAuditTopicEvidence(pageData = {}, pages = []) {
    const all = [pageData, ...pages.filter(page => page.readStatus === 'complete')];
    const unique = all.filter((page, i) => !page.url || all.findIndex(other => other.url === page.url) === i);
    const multiPage = unique.length > 1;
    const eligible = unique.filter(page => !['legal', 'operational', 'contact', 'help', 'blog', 'news', 'registration'].includes(this.getAuditPageCopyRole(page)));
    const rows = eligible.map(page => ({
      page,
      weight: this.getAuditPageCopyRole(page) === 'homepage' ? 4 : /product|solution|servic|producto|solucion|download|descarg/i.test(page.url || '') ? 3 : 1,
      fields: [...new Set([page.title, page.h1, ...(page.h1s || []), page.metaDescription].filter(Boolean).map(value => this.normalizeCompetitiveToken(value)))]
    }));
    const candidates = new Set(eligible.flatMap(page => this.extractObservedAuditTopics(page)));
    for (const page of eligible) {
      const heading = [page.title, page.h1, ...(page.h1s || [])].filter(Boolean).join(' ');
      for (const term of heading.match(/\b(?:peluquer[ií]a|coloraci[oó]n|barber[ií]a|dentista|restaurante|hotel|spa|consultor[ií]a|inmobiliaria|academia|gimnasio)\b/gi) || []) candidates.add(term.toLowerCase());
    }
    const stop = new Set('the a an and or of for to with your our we you is are in on by de del la el los las un una y o en para con sin que tu su como'.split(' '));
    const contains = (row, phrase) => row.fields.some(field => (' ' + field + ' ').includes(' ' + phrase + ' '));
    const brands = this.getCompetitiveBrandTerms(pageData).map(value => this.normalizeCompetitiveToken(value));
    for (const row of rows) for (const field of row.fields) {
      const words = field.split(/\s+/);
      for (let size = 2; size <= 4; size++) for (let i = 0; i <= words.length - size; i++) {
        const chunk = words.slice(i, i + size);
        if (chunk.some(word => stop.has(word) || word.length < 2)) continue;
        const phrase = chunk.join(' ');
        if (rows.filter(other => contains(other, phrase)).length >= 2) candidates.add(phrase);
      }
    }
    const commercialTopic = /\b(software|management|marketing|ecosystem|gestion|auditorias?|audits?|seo|chat|plataforma|platform|servicios?|services?|consultoria|consulting|peluqueria|coloracion|barberia|salon|hotel|hoteles|tienda|store|formacion|cursos|dentista|clinica|restaurante|academia|inmobiliaria|gimnasio|spa)\b/;
    const locality = this.normalizeCompetitiveToken(this.extractLocalityFromSeoSignals(pageData));
    const primaryTopics = new Set(this.extractObservedAuditTopics({ ...pageData, metaDescription: '' }).map(term => this.normalizeCompetitiveToken(term))
      .filter(term => !term.split(' ').some(word => stop.has(word))));
    const scored = [...candidates].filter(term => this.isAuditTopicPhrase(term)).map(term => {
      const normalized = this.normalizeCompetitiveToken(term);
      const matches = rows.filter(row => contains(row, normalized));
      const primaryHeading = this.normalizeCompetitiveToken([pageData.title, pageData.h1, ...(pageData.h1s || [])].filter(Boolean).join(' '));
      return { term, normalized, matches, score: matches.reduce((sum, row) => sum + row.weight, 0) + matches.length * 2 + (commercialTopic.test(normalized) && (' ' + primaryHeading + ' ').includes(' ' + normalized + ' ') ? 10 : 0) };
    }).filter(item => item.matches.length && (item.matches.length >= 2 ||
      (commercialTopic.test(item.normalized) && item.matches.some(row => row.weight >= 3 || !multiPage)) ||
      (primaryTopics.has(item.normalized) && (!multiPage || item.matches.some(row => row.fields.filter(field => (' ' + field + ' ').includes(' ' + item.normalized + ' ')).length >= 2)))))
      .filter(item => item.normalized !== locality && !brands.some(brand => brand.length > 2 && (' ' + item.normalized + ' ').includes(' ' + brand + ' ')))
      .sort((a, b) => b.score - a.score || b.normalized.split(' ').length - a.normalized.split(' ').length);
    const selected = scored.filter(item => !scored.some(other => other !== item && other.score >= item.score && other.normalized.includes(item.normalized) && other.normalized !== item.normalized)).slice(0, 5);
    return { multiPage, pages: eligible, topics: selected.map(item => item.term),
      evidence: selected.map(item => ({ term: item.term, urls: item.matches.map(row => row.page.url), weight: item.score })) };
  }

  extractObservedAuditTopics(pageData = {}, pages = []) {
    const normalize = value => this.normalizeCompetitiveToken(value);
    const brand = this.getCompetitiveBrandTerms(pageData).map(normalize);
    const fields = [pageData.title, pageData.h1, ...(pageData.h1s || []), pageData.metaDescription,
      ...pages.filter(page => page.readStatus === 'complete').flatMap(page => [page.title, page.h1])].filter(Boolean);
    const topics = [];
    for (const field of fields) {
      const cleaned = String(field).replace(/\b(?:plans? and pricing|planes y precios|skip to content)\b/gi, '');
      for (const chunk of cleaned.split(/[|,:;&–—]|\s+-\s+/)) {
        const phrase = chunk.trim().replace(/^[.!?\s]+|[.!?\s]+$/g, '')
          .replace(/^(grow|measure|manage|discover|explore|improve|boost)\s+/i, '');
        const key = normalize(phrase), words = key.split(' ');
        if (!key || phrase.length < 3 || phrase.length > 65 || words.length > 6 || brand.includes(key)) continue;
        if (/\b(home|inicio|pricing|prices|plans|blog|contact|contacts|signup|sign up|register|statistics|stats|stories|success|faq|about|affiliate|copyright|cookies|your|our|we|you|the|and|more|tu|nuestro|bienvenido)\b/.test(key)) continue;
        if (brand.some(term => term.length > 2 && (' ' + key + ' ').includes(' ' + term + ' '))) continue;
        if (words.length === 1 && !/^[A-Z][A-Z0-9]{2,6}$/.test(phrase)) continue;
        if (this.isAuditTopicPhrase(phrase) && !topics.some(term => normalize(term) === key)) topics.push(phrase);
      }
    }
    return topics.slice(0, 8);
  }

  isAuditTopicPhrase(value = '') {
    const phrase = this.normalizeCompetitiveToken(value);
    const words = phrase.split(' ');
    if (!phrase || words.length > 7) return false;
    // Grammatical fragments cannot become business entities merely by repeating in headings.
    if (/\b(mientras|cuando|aunque|entonces|ahora|aqui|asi|porque|esto|eso|te|tus|tu|usted|ustedes|nos|nuestro|nuestra|estas|esta|estamos|somos|eres|puedes|puede|podras|quieres|quiero|dice|dices|viendo|trabajas|trabaja|trabajar|descubre|descubri|conoce|empieza|comienza|haz|hace|haces|when|while|where|your|you|our|we|they|this|that|can|will|does|get|start|discover|explore|learn|explained|answered|questions|preguntas|frecuentes)\b/.test(phrase)) return false;
    if (/\b(clearly|easily|simply|quickly)\b/.test(phrase) || /^(para|con|sin|en|de|for|with|without|to|how)\b/.test(phrase)) return false;
    const content = words.filter(word => !/^(de|del|la|el|los|las|y|e|en|para|con|and|of|for|with|in|a|an|the)$/.test(word));
    if (content.every(word => /^(mejor|mejores|facil|simple|rapido|nuevo|nueva|bien|mas|mejorar|trabajo|trabajos|common|clearly|better|best|easy|simple|work|working|together|today|help|helps|ayuda)$/.test(word))) return false;
    if (content.length < 2) return /^[A-Z][A-Z0-9]{1,6}$/.test(String(value).trim()) || /^(peluqueria|coloracion|barberia|dentista|restaurante|hotel|hoteles|spa|consultoria|inmobiliaria|academia|gimnasio|manicure|pedicure|depilacion|micropigmentacion|maquillaje)$/.test(phrase);
    return true;
  }

  normalizeCompetitiveText(value = '') {
    return String(value || '')
      .replace(/\u0000/g, '')
      .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
      .replace(/[\uD800-\uDFFF]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  normalizeCompetitiveToken(value = '') {
    return this.normalizeCompetitiveText(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s.+-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  extractHostnameFromUrl(url = '') {
    const value = String(url || '').trim();
    if (value && !/^https?:\/\//i.test(value) && /^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(value)) {
      return value
        .replace(/^www\./i, '')
        .split('/')[0]
        .toLowerCase();
    }

    try {
      const parsed = new URL(value);
      return parsed.hostname.replace(/^www\./i, '').toLowerCase();
    } catch (_) {
      return '';
    }
  }

  getCompetitiveBrandTerms(pageData = {}) {
    const domain = this.extractHostnameFromUrl(pageData?.url || pageData?.domain || '');
    const root = (domain.split('.')[0] || '')
      .replace(/^try[-_]?/i, '')
      .replace(/[-_]?app$/i, '')
      .trim();
    const title = this.normalizeCompetitiveText(pageData?.title || '');
    const titleParts = title.split(/\s+[|\-–—]\s+/).map((part) => part.trim()).filter(Boolean);
    const comparableRoot = this.normalizeCompetitiveToken(root).replace(/\s+/g, '');
    const matchedTitleBrand = titleParts.find((part) => {
      const comparablePart = this.normalizeCompetitiveToken(part).replace(/\s+/g, '');
      return comparablePart.length >= 3
        && comparableRoot
        && (comparableRoot.includes(comparablePart) || comparablePart.includes(comparableRoot));
    });
    const titleBrand = (matchedTitleBrand || (titleParts.length > 1 ? titleParts[0] : '') || '')
      .split(/\s+/)
      .slice(0, 3)
      .join(' ');
    const candidates = [
      domain.split('.')[0] || '',
      root,
      titleBrand,
      String(pageData?.domain || '').split('.')[0] || ''
    ];

    const genericBrandTerms = new Set(['inicio', 'home', 'pagina', 'web', 'servicios', 'contacto', 'blog']);
    const seen = new Set();
    return candidates
      .map((term) => this.normalizeCompetitiveToken(term))
      .filter((term) => term.length >= 3)
      .filter((term) => !genericBrandTerms.has(term))
      .filter((term) => {
        if (seen.has(term)) return false;
        seen.add(term);
        return true;
      })
      .slice(0, 5);
  }

  buildCompetitiveContext(analysis = {}, pageData = {}, auditScope = {}, analyzedPages = []) {
    const representative = this.buildAuditTopicEvidence(pageData, analyzedPages);
    if (representative.multiPage) {
      pageData = representative.pages.find(page => this.getAuditPageCopyRole(page) === 'homepage') || representative.pages[0] || pageData;
      analyzedPages = representative.pages.filter(page => page.url !== pageData.url);
    }
    analysis = { ...analysis, keywords: { primary: representative.topics, longTail: [], local: [] },
      businessFocus: { primaryActivities: representative.topics, observedServices: representative.topics } };
    const rawLocality = this.extractLocalityFromSeoSignals(pageData, analysis?.keywords || {});
    const brandTerms = this.getCompetitiveBrandTerms(pageData);
    const keywordGroups = analysis?.keywords || {};
    const keywords = this.normalizeKeywordIntentList(keywordGroups);
    const pagesText = (Array.isArray(analyzedPages) ? analyzedPages : [])
      .map((page) => `${page?.label || ''} ${page?.title || ''} ${page?.metaDescription || ''} ${page?.url || ''}`)
      .join(' ');
    const text = this.normalizeCompetitiveToken([
      pageData?.title,
      pageData?.metaDescription,
      pageData?.description,
      pageData?.content,
      auditScope?.category,
      pagesText,
      keywords.join(' ')
    ].filter(Boolean).join(' '));

    const saasSignal = /\b(saas|software|app|aplicacion|plataforma|platform|dashboard|extension|chrome|api|automatizacion|automatizar|ia|ai|inteligencia artificial|productividad|herramienta|tool|seo audit|auditoria seo)\b/i.test(text);
    const localBusinessSignal = /\b(a domicilio|service area|negocio local|localbusiness|peluquer|barber|salon|centro de belleza|centro de estetica|estetica|manicure|pedicure|pestanas|depilacion|spa|clinica|dentista|restaurante|hotel|tienda fisica|maps|google business profile|google my business|direccion|barrio|comuna|zona|cerca de mi|reserva|turno)\b/i.test(text);
    const ecommerceSignal = /\b(ecommerce|e-commerce|marketplace|tienda online|carrito|checkout|productos?|comprar|envios?|stock)\b/i.test(text);
    const localKeywordSignal = rawLocality && /\b(en|cerca|local|zona|barrio|ciudad|argentina|chile|mexico|colombia|espana|uruguay)\b/i.test(
      this.normalizeCompetitiveToken([rawLocality, ...(Array.isArray(analysis?.keywords?.local) ? analysis.keywords.local : [])].join(' '))
    );
    const declaredScope = this.normalizeCompetitiveToken([
      pageData?.title, pageData?.metaDescription, pageData?.description
    ].filter(Boolean).join(' '));
    const observedScope = this.normalizeCompetitiveToken([
      String(pageData?.content || pageData?.textContent || '').slice(0, 4000), pagesText
    ].join(' '));
    const broadReach = /\b(latam|latinoamerica|america latina|worldwide|todo el mundo|toda latinoamerica|toda latam|varios paises|a nivel nacional|en todo el pais|para toda la region)\b/;
    const educationOnline = /\b(formacion|cursos|escuela|universidad|education|business school)\b/.test(declaredScope) && /\b(online|a distancia|virtual)\b/.test(declaredScope);
    const destinationPaths = new Set((analyzedPages || []).filter(page => page.readStatus === 'complete').map(page => {
      try { return new URL(page.url).pathname.match(/\/(?:hoteles|hotels)\/([^/]+)/i)?.[1] || ''; } catch (_) { return ''; }
    }).filter(Boolean));
    const multiDestination = destinationPaths.size > 1 && /\b(hotels?|hoteles|alojamientos)\b/.test(declaredScope);
    const commerceScope = /\b(marketplace|tienda online|comprar y vender|compra y vende|envios gratis|online store)\b/.test(declaredScope);
    const isBroadServiceArea = educationOnline || multiDestination || broadReach.test(declaredScope) ||
      /\b(alcance|clientes|servicios|trabajamos|atendemos|operamos)\b.{0,55}\b(global|internacional|mundial)\b/.test(declaredScope) ||
      /\b(trabajamos|atendemos|servimos|clientes|servicios|operamos|presencia|alcance)\b.{0,75}\b(latam|latinoamerica|america latina|varios paises|todo el mundo|a nivel nacional|en todo el pais)\b/.test(observedScope);

    const isGlobalSaas = Boolean(saasSignal && !localBusinessSignal && !educationOnline);
    const shouldUseLocality = Boolean(rawLocality && !isGlobalSaas && !isBroadServiceArea && !commerceScope && (localBusinessSignal || localKeywordSignal));
    const businessScopeTopics = [...new Set(representative.topics.map(topic =>
      !shouldUseLocality && (isGlobalSaas || isBroadServiceArea)
        ? topic.replace(/\s+(?:en|in)\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ-]+(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ-]+){0,2}$/, '').trim()
        : topic).filter(topic => this.isAuditTopicPhrase(topic)))];
    const comparisonMode = shouldUseLocality
      ? 'local_business'
      : isGlobalSaas
        ? 'global_saas'
        : isBroadServiceArea
          ? 'niche_market'
        : ecommerceSignal
          ? 'ecommerce'
          : 'general';
    const categoryKeywords = this.normalizeKeywordIntentList({
      primary: [...(Array.isArray(keywordGroups.primary) ? keywordGroups.primary : []), ...(analysis.businessFocus?.observedServices || [])],
      longTail: Array.isArray(keywordGroups.longTail) ? keywordGroups.longTail : [],
      local: shouldUseLocality && Array.isArray(keywordGroups.local) ? keywordGroups.local : []
    });

    const genericTerms = new Set([
      'zentra', 'tryzentra', 'www', 'com', 'app', 'inicio', 'home', 'pagina', 'web',
      'servicio', 'servicios', 'producto', 'productos', 'contacto', 'contact',
      'precio', 'precios', 'pricing', 'blog', 'sobre', 'about',
      'mejorar', 'analisis', 'auditoria', 'herramienta', 'tool', 'facil', 'usar',
      'argentina', 'buenos', 'aires', 'como', 'con', 'para', 'por', 'que', 'una',
      'uno', 'las', 'los', 'del', 'tus', 'sus', 'tu', 'su', 'desde', 'hasta',
      'online', 'gratis', 'mejor', 'mejores', 'guia', 'lista'
    ]);
    const primaryKeywordTerms = new Set(
      (Array.isArray(keywordGroups.primary) ? keywordGroups.primary : [])
        .flatMap((keyword) => this.normalizeCompetitiveToken(keyword).split(/\s+/))
        .filter((term) => term.length >= 3)
    );
    const inferredLocalityTerms = primaryKeywordTerms.size
      ? (Array.isArray(keywordGroups.local) ? keywordGroups.local : [])
          .flatMap((keyword) => this.normalizeCompetitiveToken(keyword).split(/\s+/))
          .filter((term) => term.length >= 3 && !primaryKeywordTerms.has(term))
      : [];
    const localityTerms = new Set([
      ...this.normalizeCompetitiveToken(rawLocality).split(/\s+/).filter((term) => term.length >= 3),
      ...inferredLocalityTerms
    ]);
    const derivedCategoryTerms = [
      /\b(ia|ai|inteligencia artificial)\b/i.test(text) ? 'ia' : '',
      /\b(ia|ai|inteligencia artificial)\b/i.test(text) ? 'ai' : '',
      /\bseo\b/i.test(text) ? 'seo' : '',
      /\bmarketing\b/i.test(text) ? 'marketing' : '',
      /\b(chrome|extension|extensión)\b/i.test(text) ? 'extension' : '',
      /\bautomatiz/i.test(text) ? 'automatizacion' : '',
      /\bproductividad\b/i.test(text) ? 'productividad' : '',
      /\b(contenido|content)\b/i.test(text) ? 'contenido' : ''
    ].filter(Boolean);
    const categoryTerms = Array.from(new Set([...categoryKeywords, ...derivedCategoryTerms]
      .flatMap((keyword) => this.normalizeCompetitiveToken(keyword).split(/\s+/))
      .filter((term) => term.length >= 3 || ['ai', 'ia'].includes(term))
      .filter((term) => !genericTerms.has(term))
      .filter((term) => !localityTerms.has(term))
      .filter((term) => !brandTerms.some((brand) => brand.includes(term) || term.includes(brand)))))
      .slice(0, 24);

    // Only a declared, visible primary activity narrows direct competitors.
    const headline = this.normalizeCompetitiveToken([pageData.title, pageData.seoStructure?.headings?.h1].filter(Boolean).join(' '));
    const firstIntent = this.normalizeCompetitiveToken((analysis.businessFocus?.primaryActivities || []).join(' ') || keywordGroups.primary?.[0] || '');
    const primaryCategoryTerms = categoryTerms.filter(term =>
      firstIntent.split(/\W+/).includes(term) && headline.split(/\W+/).includes(term));
    return {
      primaryCategoryTerms: Array.from(new Set(primaryCategoryTerms)),
      businessScopeTopics,
      scopeConfidence: businessScopeTopics.length ? 'observed_topics' : 'insufficient_evidence',
      scopeTopics: representative.multiPage || this.getAuditPageCopyRole(pageData) === 'legal' ? representative.topics : null,
      rawLocality,
      locality: shouldUseLocality ? rawLocality : '',
      shouldUseLocality,
      comparisonMode,
      isGlobalSaas,
      isBroadServiceArea,
      localBusinessSignal,
      brandTerms,
      categoryTerms: Array.from(new Set(categoryTerms))
    };
  }

  sanitizeLocalKeywordsForGlobalContext(analysis = {}, pageData = {}, auditScope = {}, analyzedPages = []) {
    if (!analysis || typeof analysis !== 'object') return analysis;
    const context = this.buildCompetitiveContext(analysis, pageData, auditScope, analyzedPages);
    if ((!context.isGlobalSaas && !context.isBroadServiceArea) || context.shouldUseLocality) return analysis;

    analysis.keywords = analysis.keywords || { primary: [], longTail: [], local: [] };
    analysis.keywords.local = [];
    return analysis;
  }

  isBrandDominatedCompetitiveKeyword(keyword = '', brandTerms = []) {
    const normalized = this.normalizeCompetitiveToken(keyword);
    if (!normalized) return false;
    const terms = normalized.split(/\s+/).filter(Boolean);
    const hasBrand = brandTerms.some((brand) => normalized.includes(brand));
    if (!hasBrand) return false;

    const nonBrandTerms = terms.filter((term) =>
      !brandTerms.some((brand) => brand.includes(term) || term.includes(brand))
    );
    return nonBrandTerms.length <= 1;
  }

  buildCompetitiveSearchQuery(analysis = {}, pageData = {}, auditScope = {}, competitiveContext = null) {
    const context = competitiveContext || this.buildCompetitiveContext(analysis, pageData, auditScope);
    if (Array.isArray(context.businessScopeTopics || context.scopeTopics)) {
      const topics = context.businessScopeTopics || context.scopeTopics;
      return topics.length ? this.normalizeCompetitiveText([topics[0], context.locality].filter(Boolean).join(' ')) : '';
    }
    const keywordGroups = analysis?.keywords || {};
    const intentKeywords = this.normalizeKeywordIntentList({
      primary: Array.isArray(keywordGroups.primary) ? keywordGroups.primary : [],
      longTail: Array.isArray(keywordGroups.longTail) ? keywordGroups.longTail : [],
      local: context.shouldUseLocality && Array.isArray(keywordGroups.local) ? keywordGroups.local : []
    });
    const locality = context.shouldUseLocality ? context.locality : '';
    const filteredKeywords = intentKeywords.filter((keyword) =>
      !this.isBrandDominatedCompetitiveKeyword(keyword, context.brandTerms || [])
    );
    let baseKeyword = filteredKeywords.find((keyword) => {
      const lower = String(keyword || '').toLowerCase();
      return lower.length >= 3 && !/^\d+$/.test(lower);
    }) || '';
    if (!context.shouldUseLocality && context.rawLocality && baseKeyword) {
      const location = context.rawLocality.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      baseKeyword = baseKeyword.replace(new RegExp(location, 'ig'), '').replace(/\b(en|de)\s*$/i, '').trim();
    }

    if (context.isGlobalSaas && baseKeyword && !/\b(ai|ia|software|saas|app|seo|automat|herramienta|tool)\b/i.test(baseKeyword)) {
      baseKeyword = `${baseKeyword} IA`;
    }

    const titleHint = String(pageData?.title || '')
      .split(/\s*[|–—]\s*/)
      .map((part) => part.trim())
      .find((part) => part && !/^(inicio|home|pagina principal)$/i.test(part)) || '';
    const businessHints = [
      context.isGlobalSaas ? 'herramienta IA SEO marketing' : context.categoryTerms.slice(0, 4).join(' '),
      titleHint,
      String(auditScope?.category || '').trim()
    ]
      .filter(Boolean)
      .join(' ');

    const queryParts = [baseKeyword, locality]
      .map((part) => this.normalizeCompetitiveText(part))
      .filter((part, index, arr) => part && arr.indexOf(part) === index);

    if (!queryParts.length && businessHints) {
      queryParts.push(
        this.normalizeCompetitiveText(
          businessHints
            .split(' ')
            .slice(0, 6)
            .join(' ')
        )
      );
    }

    return this.normalizeCompetitiveText(queryParts.join(' '));
  }

  buildCompetitiveSearchQueries(analysis = {}, pageData = {}, auditScope = {}, competitiveContext = null) {
    const context = competitiveContext || this.buildCompetitiveContext(analysis, pageData, auditScope);
    if (Array.isArray(context.businessScopeTopics || context.scopeTopics)) {
      return (context.businessScopeTopics || context.scopeTopics).slice(0, 3).map(topic => this.normalizeCompetitiveText([topic, context.locality].filter(Boolean).join(' ')));
    }
    const queries = [];
    const add = value => {
      const query = this.normalizeCompetitiveText(value);
      if (query && !queries.some(item => this.normalizeCompetitiveToken(item) === this.normalizeCompetitiveToken(query))) queries.push(query);
    };
    if (context.shouldUseLocality && context.locality) {
      const locality = this.normalizeCompetitiveToken(context.locality);
      const keywords = this.normalizeKeywordIntentList(analysis.keywords || {})
        .filter(keyword => !this.isBrandDominatedCompetitiveKeyword(keyword, context.brandTerms || []));
      for (const keyword of keywords) {
        const normalized = this.normalizeCompetitiveToken(keyword);
        add(normalized.includes(locality) ? keyword : keyword + ' ' + context.locality);
        if (queries.length === 2) break;
      }
      if (!queries.length && context.categoryTerms.length) add(context.categoryTerms[0] + ' ' + context.locality);
      const domain = this.extractHostnameFromUrl(pageData.url || pageData.domain || '');
      if (queries.length && domain) add(queries[0] + ' -site:' + domain);
    } else {
      add(this.buildCompetitiveSearchQuery(analysis, pageData, auditScope, context));
      const core = context.categoryTerms.slice(0, 3).join(' ');
      if (context.isGlobalSaas) {
        add((core || 'seo marketing') + ' software IA');
        add((core || 'seo marketing') + ' herramienta SaaS');
      } else if (core) add(core + ' alternativas');
    }
    return queries.slice(0, 3);
  }

  resolveCompetitiveResultUrl(rawUrl = '') {
    try {
      const value = String(rawUrl || '').trim();
      const parsed = new URL(value.startsWith('//') ? 'https:' + value : value, 'https://html.duckduckgo.com');
      // URLSearchParams already decodes the redirect once; decoding again corrupts encoded paths.
      const target = new URL(parsed.searchParams.get('uddg') || parsed.href);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return '';
      if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[)/i.test(target.hostname)) return '';
      return target.href;
    } catch (_) { return ''; }
  }

  getCompetitiveCandidateKey(candidate = {}) {
    try {
      const url = new URL(candidate.url);
      const domain = url.hostname.replace(/^www\./, '').toLowerCase();
      if (this.getCompetitiveSocialPlatform(domain)) {
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts[0] === 'profile.php') return domain + '/profile.php?id=' + (url.searchParams.get('id') || '');
        const owner = parts[0] === 'pages' ? parts.slice(0, 3) : parts.slice(0, 1);
        return domain + '/' + owner.join('/').toLowerCase();
      }
      // Directory listings and branch pages must not collapse into a single business.
      const directory = /fresha|booksy|treatwell|yelp|tripadvisor|foursquare|paginasamarillas|cylex|hotfrog|tuugo|infobel|nicelocal|findglocal|beautynailhairsalons|lorealprofessionnel/.test(domain);
      return directory ? domain + url.pathname.replace(/\/$/, '').toLowerCase() : domain;
    } catch (_) { return ''; }
  }

  extractSearchResultsFromHtml(html = '', siteDomain = '', limit = 5) {
    const results = [];
    const seen = new Set();
    const site = this.extractHostnameFromUrl(siteDomain);
    try {
      const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      const nodes = Array.from(doc.querySelectorAll('.result'));
      const links = nodes.length ? nodes.map(node => ({ node, link: node.querySelector('a.result__a') }))
        : Array.from(doc.querySelectorAll('a.result-link')).map(link => ({ node: link.closest('tr')?.nextElementSibling || link.parentElement, link }));
      for (const { node, link } of links) {
        if (!link) continue;
        const url = this.resolveCompetitiveResultUrl(link.getAttribute('href'));
        const domain = this.extractHostnameFromUrl(url);
        if (!domain || domain === site || domain.endsWith('.' + site) ||
          /(^|\.)(duckduckgo\.com|bing\.com|google\.com)$/.test(domain)) continue;
        const title = this.normalizeCompetitiveText(link.textContent || '');
        const snippet = this.normalizeCompetitiveText(node?.querySelector('.result__snippet, .result-snippet')?.textContent || '');
        const candidate = { domain, title, snippet, url };
        const key = this.getCompetitiveCandidateKey(candidate);
        if (!key || seen.has(key) || (!title && !snippet)) continue;
        seen.add(key);
        results.push(candidate);
        if (results.length >= limit) break;
      }
    } catch (_) {}
    return results;
  }

  selectAuditCommercialCtas(values = []) {
    const seen = new Set();
    return (Array.isArray(values) ? values : []).map(item => typeof item === 'string' ? { text: item } : item || {})
      .filter(item => !/cookie|consent|privacy|privacidad|preferencias|cerrar|close|cerca|facebook|instagram|linkedin|youtube|iniciar sesi[oó]n/i.test([item.text, item.href].join(' ')))
      .map(item => this.normalizeCompetitiveText(item.text || ''))
      .filter(text => text.length >= 4 && text.length <= 100 &&
        /\b(contact\w*|agenda\w*|presupuesto|asesor\w*|consulta\w*|reserva\w*|cotiza\w*|demo|contrata\w*|solicita\w*|compr\w*|carrito|whatsapp|book|buy|shop|start|prueba|probar|ver planes)\b/i.test(this.normalizeCompetitiveToken(text)))
      .filter(text => { const key = this.normalizeCompetitiveToken(text); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 4);
  }

  getAuditComparisonRole(page = {}) {
    const label = this.normalizeCompetitiveToken([page.h1, page.title].filter(Boolean).join(' '));
    let path = '';
    try { path = new URL(page.url || page.sourceUrl).pathname; } catch (_) {}
    if (/\b(quienes somos|sobre nosotros|about us|nuestro equipo|our team)\b/.test(label) || /\/(about|quienes-somos|sobre-nosotros)(\/|$)/i.test(path)) return 'institutional';
    if (/\/(blog|noticias|news|articulos)(\/|$)/i.test(path)) return 'editorial';
    if (/^(contacto|contact us|reservar cita)(\s|$)/.test(label)) return 'contact';
    return 'commercial';
  }

  getAuditComparisonFunction(page = {}) {
    const role = this.getAuditPageCopyRole({ ...page, h1s: page.h1 ? [page.h1] : [] });
    if (role) return role;
    const broad = this.getAuditComparisonRole(page);
    if (broad !== 'commercial') return broad;
    return 'offering';
  }

  extractCompetitivePageSignalsFromHtml(html = '', pageUrl = '') {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(String(html || ''), 'text/html');
      const title = this.normalizeCompetitiveText(doc.querySelector('title')?.textContent || '');
      const metaDescription = this.normalizeCompetitiveText(
        doc.querySelector('meta[name="description"]')?.getAttribute('content') || ''
      );
      const h1 = this.normalizeCompetitiveText(doc.querySelector('h1')?.textContent || '');
      const ctaNodes = Array.from(doc.querySelectorAll('a, button')).slice(0, 60);
      const ctas = this.selectAuditCommercialCtas(ctaNodes
        .filter(node => !node.closest('[hidden], [aria-hidden="true"], [id*="cookie"], [class*="cookie"], [id*="consent"], [class*="consent"]'))
        .map(node => ({ text: node.textContent, href: node.getAttribute('href') })));
      const leadParagraph = this.normalizeCompetitiveText(
        Array.from(doc.querySelectorAll('main p, article p, section p, p'))
          .map((node) => this.normalizeCompetitiveText(node.textContent || ''))
          .find((text) => text.length >= 50) || ''
      ).slice(0, 260);

      const evidenceParts = [title, metaDescription, h1, leadParagraph].filter(Boolean);
      return {
        title,
        metaDescription,
        h1,
        ctas,
        leadParagraph,
        evidenceText: evidenceParts.join(' '),
        evidenceDepth: [title, metaDescription, h1, leadParagraph].filter(Boolean).length,
        sourceUrl: pageUrl || ''
      };
    } catch (_) {
      return null;
    }
  }

  async fetchCompetitivePagePreview(url = '') {
    const target = this.normalizeCompetitiveText(url);
    if (!target) return null;

    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 2500) : null;
      const response = await fetch(target, {
        method: 'GET',
        headers: {
          'Accept': 'text/html,application/xhtml+xml'
        },
        signal: controller?.signal
      });
      if (!response.ok) { if (timer) clearTimeout(timer); return null; }
      let html;
      try { html = await response.text(); } finally { if (timer) clearTimeout(timer); }
      if (/challenge-form|anomaly-modal|captcha|access denied/i.test(html)) return null;
      return this.extractCompetitivePageSignalsFromHtml(html, response.url || target);
    } catch (_) {
      return null;
    }
  }

  async enrichCompetitiveCandidates(candidates = []) {
    const base = Array.isArray(candidates) ? candidates.slice(0, 4) : [];
    const previews = await Promise.all(
      base.slice(0, 3).map((candidate) => this.fetchCompetitivePagePreview(candidate.url))
    );

    return base.map((candidate, index) => ({
      ...candidate,
      pagePreview: previews[index] || null
    }));
  }

  scoreCompetitiveCandidate(candidate = {}, siteScore = 0, keywords = [], locality = '') {
    const preview = candidate.pagePreview && typeof candidate.pagePreview === 'object'
      ? candidate.pagePreview
      : null;
    const text = `${candidate.title || ''} ${candidate.snippet || ''} ${preview?.title || ''} ${preview?.metaDescription || ''} ${preview?.h1 || ''} ${preview?.leadParagraph || ''}`.toLowerCase();
    const localLower = String(locality || '').toLowerCase();
    const keywordTerms = keywords
      .flatMap((keyword) => String(keyword || '').toLowerCase().split(/\s+/))
      .filter((term) => term.length > 2 || ['ai', 'ia'].includes(term));
    const uniqueKeywordTerms = Array.from(new Set(keywordTerms)).slice(0, 12);

    let score = 26;
    const signals = [];
    const semanticSignals = [];

    if (candidate.title) {
      score += 10;
      signals.push('propuesta visible en el resultado');
    }

    if (candidate.snippet) {
      score += 8;
      signals.push('contexto comercial visible');
    }

    const matchedKeywords = uniqueKeywordTerms.filter((term) => text.includes(term));
    if (matchedKeywords.length > 0) {
      score += Math.min(18, matchedKeywords.length * 4);
      signals.push(`alineacion con ${matchedKeywords.slice(0, 3).join(', ')}`);
      semanticSignals.push('cobertura de intención');
    }

    if (localLower && text.includes(localLower)) {
      score += 12;
      signals.push(`localidad ${locality}`);
      semanticSignals.push('foco local');
    }

    if (/(contact|agenda|presupuesto|asesor|consulta|llamada|reserva|cotiza|demo|hablemos|contrata|pricing|precio|ver mas|ver más)/i.test(text)) {
      score += 10;
      signals.push('cta comercial visible');
      semanticSignals.push('CTA visible');
    }

    if (/(casos|testimonio|resultados|clientes|portfolio|proyectos|experiencia|equipo|servicios|servicio)/i.test(text)) {
      score += 8;
      signals.push('prueba social o servicio visible');
      semanticSignals.push('prueba social');
      semanticSignals.push('autoridad percibida');
    }

    if (/(agencia|consultor|consultoría|soluciones|estrategia|especialistas|expertos|equipo|marca|empresa)/i.test(text)) {
      score += 6;
      semanticSignals.push('propuesta comercial clara');
    }

    if (preview?.h1) {
      score += 8;
      signals.push('H1 visible en la pagina');
      semanticSignals.push('jerarquia clara');
    }

    if (preview?.metaDescription) {
      score += 4;
      signals.push('meta descripcion visible');
    }

    if (Array.isArray(preview?.ctas) && preview.ctas.length > 0) {
      score += 8;
      signals.push('CTA visible en la pagina');
      semanticSignals.push('CTA visible');
    }

    if (preview?.leadParagraph && preview.leadParagraph.length >= 70) {
      score += 6;
      signals.push('primer bloque con contexto util');
      semanticSignals.push('profundidad inicial');
    }

    if (/(seo|marketing|ads|publicidad|web|contenido|posicionamiento|local|locales|barber|peluquer|salon|clinica)/i.test(text)) {
      semanticSignals.push('relevancia temática');
    }

    if ((candidate.title || '').length >= 20 && (candidate.title || '').length <= 70) {
      score += 4;
    }

    if ((candidate.snippet || '').length >= 70) {
      score += 4;
    }

    score = Math.max(0, Math.min(100, Math.round(score)));

    const relative = score >= (siteScore + 6)
      ? 'por encima'
      : score >= (siteScore - 6)
        ? 'similar'
        : 'por debajo';

    return {
      score,
      relative,
      signals: signals.length ? signals.slice(0, 4) : ['senal parcial'],
      semanticSignals: semanticSignals.length ? Array.from(new Set(semanticSignals)).slice(0, 4) : [],
      previewSummary: preview
        ? [preview.h1, preview.metaDescription, preview.leadParagraph].filter(Boolean).slice(0, 2).join(' | ')
        : '',
      strengthSummary: semanticSignals.length
        ? `Destaca por ${Array.from(new Set(semanticSignals)).slice(0, 2).join(' y ')}.`
        : signals.length
          ? `Destaca por ${signals.slice(0, 2).join(' y ')}.`
          : 'Se detectaron pocas senales fuertes en la vista ligera.',
      gapSummary: semanticSignals.length
        ? `Para superarlo, conviene igualar o superar ${Array.from(new Set(semanticSignals)).slice(0, 2).join(' y ')}.`
        : signals.length
          ? `Para superarlo, conviene igualar o superar ${signals.slice(0, 2).join(' y ')}.`
        : 'Conviene reforzar claridad comercial, prueba social y especificidad semantica.'
    };
  }

  getCompetitiveSocialPlatform(domain = '') {
    const hostname = this.extractHostnameFromUrl(domain) || this.normalizeCompetitiveToken(domain);
    const platforms = [
      ['instagram.com', 'Instagram'],
      ['facebook.com', 'Facebook'],
      ['linkedin.com', 'LinkedIn'],
      ['youtube.com', 'YouTube'],
      ['tiktok.com', 'TikTok'],
      ['twitter.com', 'X/Twitter'],
      ['x.com', 'X'],
      ['pinterest.com', 'Pinterest'],
      ['threads.net', 'Threads']
    ];
    const match = platforms.find(([platformDomain]) =>
      hostname === platformDomain || hostname.endsWith(`.${platformDomain}`)
    );
    return match ? match[1] : '';
  }

  isOwnWebsiteCompetitiveCandidate(candidate = {}) {
    const domain = this.extractHostnameFromUrl(candidate.url || candidate.domain || '');
    return Boolean(domain && !this.getCompetitiveSocialPlatform(domain) &&
      !/(^|\.)(fresha|booksy|treatwell|yelp|tripadvisor|foursquare|paginasamarillas|cylex|hotfrog|tuugo|infobel|nicelocal|findglocal|beautynailhairsalons)\./.test(domain) &&
      !/salones.*lorealprofessionnel/.test(domain));
  }

  buildCompetitiveResultDisplayName(candidate = {}) {
    const domain = candidate.domain || this.extractHostnameFromUrl(candidate.url || '');
    const platform = this.getCompetitiveSocialPlatform(domain);
    if (!platform) return this.normalizeCompetitiveText(candidate.title || '').slice(0, 120) || domain;

    const rawTitle = this.normalizeCompetitiveText(candidate.title || '');
    const cleanedTitle = rawTitle
      .replace(/\s*(?:[|–—-]\s*)?(?:Facebook|Instagram|LinkedIn|YouTube|TikTok|Pinterest|Threads|X(?:\/Twitter)?)(?:\s*[|–—-].*)?$/i, '')
      .trim();
    const genericTitle = /^(facebook|instagram|linkedin|youtube|tiktok|pinterest|threads|x|log in|iniciar sesi[oó]n|sign up|perfil|profile)$/i.test(cleanedTitle);
    if (cleanedTitle && !genericTitle) return `${platform} — ${cleanedTitle}`;

    try {
      const parsed = new URL(String(candidate.url || ''));
      const ignoredSegments = new Set(['pages', 'posts', 'reel', 'reels', 'watch', 'profile.php', 'company', 'in']);
      const segment = parsed.pathname
        .split('/')
        .map((part) => decodeURIComponent(part).trim())
        .find((part) => part && !ignoredSegments.has(part.toLowerCase()) && !/^\d+$/.test(part));
      if (segment) return `${platform} — ${segment.startsWith('@') ? segment : `@${segment}`}`;
    } catch (_) {}

    return `${platform} — perfil detectado`;
  }

  classifyCompetitiveCandidate(candidate = {}, scoring = {}, context = {}) {
    const domain = this.extractHostnameFromUrl(candidate.url || candidate.domain || '');
    const normalize = value => this.normalizeCompetitiveToken(value);
    const preview = candidate.pagePreview || {};
    const text = normalize([candidate.title, candidate.snippet, preview.title, preview.metaDescription, preview.h1, preview.leadParagraph].filter(Boolean).join(' '));
    const identity = normalize(domain + ' ' + (candidate.title || ''));
    const brands = (context.brandTerms || []).filter(Boolean);
    const ownBrand = brands.some(brand => identity.includes(brand));
    const tokens = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
    const matchesTerm = term => normalize(term).split(/[^a-z0-9]+/).filter(Boolean).every(token => tokens.has(token));
    const categories = (context.categoryTerms || []).filter(term => term && matchesTerm(term));
    const primaryMatches = (context.primaryCategoryTerms || []).filter(matchesTerm);
    const sharesPrimary = !context.primaryCategoryTerms?.length || primaryMatches.length > 0;
    const local = context.shouldUseLocality && context.locality ? text.includes(normalize(context.locality)) : false;
    const platform = this.getCompetitiveSocialPlatform(domain);
    const directory = /(^|\.)(fresha|booksy|treatwell|yelp|tripadvisor|foursquare|paginasamarillas|cylex|hotfrog|tuugo|infobel|nicelocal|findglocal|beautynailhairsalons)\./.test(domain) ||
      /salones.*lorealprofessionnel/.test(domain);
    const list = /\b(mejores|best|top|lista|alternativas|review|comparativa|directorio|salones de peluqueria en)\b/.test(normalize(candidate.title));
    const editorial = /(^|\.)(wikipedia|forbes|pcmag|capterra|g2|trustpilot|producthunt|medium|reddit|quora|geekflare)\./.test(domain);
    let specificIdentity = false;
    try {
      const url = new URL(candidate.url);
      const path = url.pathname.split('/').filter(Boolean);
      specificIdentity = path.length > 0 && !/^(login|signin|search|explore|watch|reel|reels|salones)$/i.test(path[0]) &&
        !!candidate.title && !/^(facebook|instagram|inicio|home|perfil|profile)$/i.test(candidate.title);
    } catch (_) {}
    const relevant = categories.length > 0;
    const businessIdentity = /\b(agencia|consultor|estudio|empresa|servicio|servicios|especialista|software|plataforma|herramienta|soluciones|centro|salon|peluqueria|clinica)\b/.test(text);
    const direct = sharesPrimary && !ownBrand && !list && !editorial && (context.shouldUseLocality ? (relevant && local) :
      (categories.length >= 2 || (relevant && businessIdentity))) &&
      (!(platform || directory) || specificIdentity);
    const type = ownBrand ? 'presencia_marca' : direct ? 'competidor_directo' :
      relevant && local && !sharesPrimary && !list && !editorial && (!(platform || directory) || specificIdentity) ? 'competidor_servicio' : relevant && platform ? 'referencia_social' : relevant && directory ? 'referencia_directorio' : relevant ? 'referencia_serp' : 'no_comparable';
    return {
      relevanceType: type, relevanceLevel: direct ? 'alta' : relevant ? 'media' : 'baja',
      displayLabel: direct ? 'Competidor potencial' : type === 'competidor_servicio' ? 'Competencia en un servicio compartido' : platform ? 'Perfil relacionado' : directory ? 'Ficha relacionada' : 'Referencia de busqueda',
      relevanceReason: ownBrand ? 'Corresponde a la marca auditada; se excluye de la comparacion.' :
        direct ? 'Coinciden servicio' + (local ? ' y localidad (' + context.locality + ')' : ' y categoria') +
          '. Fuente: ' + (platform || (directory ? 'ficha publica de negocio' : 'sitio web')) + '. No prueba rendimiento superior.' :
        type === 'competidor_servicio' ? 'Coincide en ' + categories.join(', ') + ' y en ' + context.locality + ', pero no se verifico la actividad principal (' + context.primaryCategoryTerms.join(', ') + '). Comparar solo ese servicio, no todo el negocio.' :
        relevant ? 'Comparte tema, pero falta confirmar identidad, ubicacion o servicio para tratarlo como competencia directa.' :
          'No hay coincidencia suficiente de servicio o categoria.',
      isComparable: direct, isDirectCompetitor: direct, matchedCategoryTerms: categories.slice(0, 5),
      displayRelative: 'rendimiento no medido'
    };
  }

  async fetchLightCompetitiveResults(query = '', siteDomain = '', limit = 5, timeoutMs = 4000) {
    return this.requestCompetitiveSearch([query], siteDomain, limit, timeoutMs);
  }

  async requestCompetitiveSearch(queries = [], siteDomain = '', limit = 6, timeoutMs = 45000, scope = 'web') {
    const searchQueries = queries.map(query => this.normalizeCompetitiveText(query)).filter(Boolean).slice(0, 3);
    if (!searchQueries.length) return { ok: false, error: 'query_vacia', results: [] };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const endpoint = new URL('/api/audit/competitive-search', this.apiUrl);
      const response = await window.zentraApiFetch(endpoint.href, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: searchQueries, siteDomain: this.extractHostnameFromUrl(siteDomain), scope }),
        signal: controller.signal
      });
      if (!response.ok) return { ok: false, error: 'search_unavailable', results: [] };
      const data = await response.json();
      const results = (Array.isArray(data.results) ? data.results : []).slice(0, limit);
      return { ok: !data.error, query: searchQueries[0], results, error: data.error || null };
    } catch (_) {
      return { ok: false, error: controller.signal.aborted ? 'search_timeout' : 'search_network_error', results: [] };
    } finally { clearTimeout(timer); }
  }

  async fetchExpandedCompetitiveResults(queries = [], siteDomain = '', limit = 6, budgetMs = 12000, scope = 'web') {
    const results = [];
    const seen = new Set();
    const searchQueries = (Array.isArray(queries) ? queries : []).map(query => this.normalizeCompetitiveText(query)).filter(Boolean).slice(0, 3);
    if (!searchQueries.length) return { ok: false, query: '', queries: [], results: [], error: 'insufficient_business_evidence' };
    const response = await this.requestCompetitiveSearch(searchQueries, siteDomain, limit, Math.max(budgetMs, 45000), scope);
    for (const candidate of response.results || []) {
      const url = this.resolveCompetitiveResultUrl(candidate.url);
      const domain = this.extractHostnameFromUrl(url);
      const site = this.extractHostnameFromUrl(siteDomain);
      const key = this.getCompetitiveCandidateKey({ ...candidate, url });
      if (!key || !domain || domain === site || domain.endsWith('.' + site) || seen.has(key)) continue;
      seen.add(key);
      results.push({ ...candidate, url, domain, sourceQuery: searchQueries[0] || '' });
    }
    return { ok: results.length > 0, query: searchQueries[0] || '', queries: searchQueries,
      results: results.slice(0, limit), error: response.error || null };
  }

  normalizeKeywordIntentList(keywords = {}) {
    const combined = [
      ...(Array.isArray(keywords.primary) ? keywords.primary : []),
      ...(Array.isArray(keywords.longTail) ? keywords.longTail : []),
      ...(Array.isArray(keywords.local) ? keywords.local : [])
    ];

    const seen = new Set();
    return combined
      .map((value) => String(value || '').trim())
      .filter((value) => value.length >= 3)
      .filter((value) => {
        const key = value.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8);
  }

  async buildCompetitiveSnapshot(analysis = {}, pageData = {}, auditScope = {}, analyzedPages = []) {
    const context = this.buildCompetitiveContext(analysis, pageData, auditScope, analyzedPages);
    const queries = this.buildCompetitiveSearchQueries(analysis, pageData, auditScope, context);
    let results = [], error = null;
    try {
      const response = await this.fetchExpandedCompetitiveResults(queries, pageData.domain || pageData.url || '', 6, 12000);
      results = Array.isArray(response.results) ? response.results : [];
      error = response.error || null;
    } catch (_) { error = 'search_network_error'; }
    // Read relevant businesses first, rather than spending the preview budget on unrelated hits.
    results = results.slice().sort((a, b) => {
      const rank = candidate => {
        const relevance = this.classifyCompetitiveCandidate(candidate, {}, context);
        return relevance.isDirectCompetitor ? 2 : relevance.relevanceType === 'competidor_servicio' || relevance.relevanceType.startsWith('referencia_') ? 1 : 0;
      };
      return rank(b) - rank(a);
    }).slice(0, 3);
    let enrichedResults = await this.enrichCompetitiveCandidates(results);
    const searchRuns = [{ scope: 'web', queries, results, enrichedResults, error }];
    const hasClearWebsite = enrichedResults.some(candidate =>
      this.isOwnWebsiteCompetitiveCandidate(candidate) &&
      this.classifyCompetitiveCandidate(candidate, {}, context).isDirectCompetitor
    );
    if (!hasClearWebsite && !error) {
      const socialQueries = queries.filter(query => !/-site:/i.test(query));
      let socialResults = [], socialEnriched = [], socialError = null;
      try {
        const social = await this.fetchExpandedCompetitiveResults(
          socialQueries.length ? socialQueries : queries.slice(0, 1),
          pageData.domain || pageData.url || '', 6, 12000, 'social'
        );
        socialResults = (Array.isArray(social.results) ? social.results : []).slice(0, 3);
        socialEnriched = await this.enrichCompetitiveCandidates(socialResults);
        socialError = social.error || null;
      } catch (_) { socialResults = []; socialEnriched = []; socialError = 'search_network_error'; }
      searchRuns.push({ scope: 'social', queries: socialQueries.length ? socialQueries : queries.slice(0, 1),
        results: socialResults, enrichedResults: socialEnriched, error: socialError });
      results = results.concat(socialResults);
      enrichedResults = enrichedResults.concat(socialEnriched);
      error = socialResults.length ? null : socialError || error;
    }
    // Frozen evidence is replayed by the server; do not replace failed searches with invented candidates.
    this.auditCompetitiveEvidence = JSON.parse(JSON.stringify({ queries, results, enrichedResults, searchRuns, error }));
    const candidates = enrichedResults.map(candidate => {
      const relevance = this.classifyCompetitiveCandidate(candidate, {}, context);
      const preview = candidate.pagePreview || null;
      const analyzed = Boolean(preview && preview.evidenceDepth >= 2);
      return {
        ...candidate, ...relevance,
        displayName: this.buildCompetitiveResultDisplayName(candidate),
        relative: 'rendimiento no medido', displayRelative: 'rendimiento no medido',
        evidenceStatus: analyzed ? 'pagina_leida' : 'resultado_busqueda',
        previewSummary: analyzed ? [preview.h1, preview.metaDescription].filter(Boolean).join(' | ') : '',
        strengthSummary: analyzed
          ? 'Elementos observados: ' + [
              preview.h1 ? 'encabezado "' + preview.h1.slice(0, 120) + '"' : '',
              preview.ctas?.length ? 'acciones "' + preview.ctas.slice(0, 2).join('" / "') + '"' : ''
            ].filter(Boolean).join('; ') + '.'
          : 'Identificado en resultados de busqueda; pagina no verificada en profundidad.'
      };
    });
    const competitorPriority = item => !item.isDirectCompetitor ? 0 :
      this.isOwnWebsiteCompetitiveCandidate(item) ? 3 :
        this.getCompetitiveSocialPlatform(item.domain || item.url) ? 2 : 1;
    const competitors = candidates.filter(item => item.relevanceType !== 'presencia_marca' && item.relevanceType !== 'no_comparable')
      .sort((a, b) => competitorPriority(b) - competitorPriority(a)).slice(0, 3);
    return this.enforceCompetitiveSnapshotGuardrails({
      siteDomain: this.extractHostnameFromUrl(pageData.domain || pageData.url || ''),
      searchQuery: queries[0] || null, searchQueries: queries, searchResultsCount: results.length,
      searchScopes: searchRuns.map(run => run.scope),
      searchStatus: results.length ? 'ok' : error ? 'no_disponible' : 'sin_resultados',
      searchError: error, deepCompetitorReads: candidates.filter(item => item.evidenceStatus === 'pagina_leida').length,
      locality: context.shouldUseLocality ? context.locality : null,
      ignoredLocality: !context.shouldUseLocality ? context.rawLocality || null : null,
      comparisonMode: context.comparisonMode, competitors,
      sitePages: analyzedPages.filter(page => page.readStatus === 'complete').map(page => ({
        url: page.url, title: page.title, metaDescription: page.metaDescription, h1: page.h1
      })),
      siteCtas: this.selectAuditCommercialCtas(pageData.ctaData),
      siteCtaPageUrl: pageData.url || '',
      intents: [], benchmarkStatus: 'parcial', signalLevel: 'parcial'
    });
  }

  enforceCompetitiveSnapshotGuardrails(snapshot = {}) {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    const next = { ...snapshot };
    const site = this.extractHostnameFromUrl(next.siteDomain || '');
    const seen = new Set();
    next.competitors = (Array.isArray(next.competitors) ? next.competitors : []).filter(item => {
      const url = this.resolveCompetitiveResultUrl(item.url);
      const domain = this.extractHostnameFromUrl(url);
      const key = this.getCompetitiveCandidateKey({ ...item, url });
      if (!url || !domain || (site && (domain === site || domain.endsWith('.' + site))) || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(item => {
      const preview = item.pagePreview ? { ...item.pagePreview, ctas: this.selectAuditCommercialCtas(item.pagePreview.ctas) } : null;
      return { ...item, pagePreview: preview, relative: 'rendimiento no medido', displayRelative: 'rendimiento no medido',
        strengthSummary: preview && item.evidenceStatus === 'pagina_leida'
          ? 'Elementos observados: ' + [preview.h1 ? 'encabezado "' + preview.h1.slice(0, 120) + '"' : '', preview.ctas.length ? 'acciones "' + preview.ctas.join(' / ') + '"' : 'sin llamada comercial identificada'].filter(Boolean).join('; ') + '.'
          : 'Identificado en resultados de búsqueda; contenido de página no comprobado.' };
    });
    next.siteCtas = this.selectAuditCommercialCtas(next.siteCtas);
    next.hasDirectCompetitors = next.competitors.some(item => item.isDirectCompetitor);
    next.benchmarkStatus = 'parcial';
    next.signalLevel = 'parcial';
    next.competitorsHeading = next.hasDirectCompetitors ? 'Negocios potencialmente competidores' : 'Referencias encontradas para verificar';
    if (next.competitors.length) {
      const businesses = next.competitors.filter(item => item.isDirectCompetitor);
      next.dominantProfile = businesses.length
        ? (businesses.length === 1 ? 'Se identificó 1 negocio' : 'Se identificaron ' + businesses.length + ' negocios') +
          ' con coincidencia de servicio y contexto. Esto no determina quién vende más ni quién posiciona mejor.'
        : 'Hay resultados relacionados, pero falta confirmar que correspondan a negocios competidores del mismo mercado.';
      next.gapToOutperform = 'Comparar oferta, especializacion, facilidad para reservar y prueba social usando las fuentes indicadas; no se midio una ventaja de rendimiento.';
      next.siteSpecificObservation = next.competitors.filter(item => item.evidenceStatus === 'pagina_leida').length +
        ' de ' + next.competitors.length + ' fuentes mostradas tienen lectura de página.';
      if (next.competitors.some(item => item.evidenceStatus !== 'pagina_leida')) {
        next.siteSpecificObservation += ' Las fuentes sin lectura se apoyan solo en el resultado de búsqueda.';
      }
      // Rebuild comparisons from retained evidence, not from unverified refinement claims.
      next.priorityActions = [];
      next.competitors = next.competitors.map(item => {
        const terms = item.matchedCategoryTerms || [];
        const otherFunction = this.getAuditComparisonFunction({ ...item.pagePreview, url: item.url });
        const matchingPages = (next.sitePages || []).map(page => {
          const text = this.normalizeCompetitiveToken([this.cleanAuditExampleSubject(page.title), page.h1,
            otherFunction === 'homepage' ? page.metaDescription : ''].join(' '));
          let isHome = true;
          try { isHome = new URL(page.url).pathname === '/'; } catch (_) {}
          return { page, isHome, score: terms.filter(term => (' ' + text + ' ').includes(' ' + this.normalizeCompetitiveToken(term) + ' ')).length };
        }).filter(row => row.score > 0 && (!row.page.readStatus || row.page.readStatus === 'complete') &&
          this.getAuditComparisonFunction(row.page) === otherFunction)
          .sort((a, b) => b.score - a.score);
        const own = matchingPages[0]?.page;
        const name = item.displayName || item.title || item.domain;
        const headline = item.evidenceStatus === 'pagina_leida' ? item.pagePreview?.h1 : '';
        const equivalent = Boolean(own && headline && ['homepage', 'pricing', 'offering', 'education', 'hotel', 'category'].includes(otherFunction));
        const comparison = own
          ? 'Pagina propia comparable: ' + own.url + '. Presenta "' + (own.h1 || own.title || '').slice(0, 180) + '".'
          : 'No se identifico una pagina equivalente entre las URLs leidas; esto no demuestra que el servicio no exista.';
        let action;
        if (equivalent) {
          action = 'En ' + own.url + ', contrastar el encabezado "' + (own.h1 || own.title || '').slice(0, 120) +
            '" con "' + headline.slice(0, 120) + '" de ' + name + '. Explicitar una diferencia real de servicio, proceso o especializacion que el negocio pueda respaldar; conservar lo que ya esta claro.';
        } else {
          action = 'Verificar la oferta de ' + name + ' en ' + item.url +
            ' y localizar una página propia del mismo servicio y función' +
            ' antes de proponer cambios: la evidencia disponible no permite comparar el contenido completo.';
        }
        next.priorityActions.push(action);
        return { ...item, comparablePageUrl: equivalent ? own.url : '', comparisonSummary: equivalent ? comparison :
          'Comparación pendiente: se necesita una página comercial del mismo servicio y función. No se deduce una ventaja de un título institucional o un resultado de búsqueda.' };
      });
      const comparable = next.competitors.find(item => item.comparablePageUrl && item.pagePreview?.h1);
      next.gapToOutperform = comparable
        ? (comparable.displayName || comparable.title) + ' comunica "' + comparable.pagePreview.h1.slice(0, 180) +
          '". La decision es como diferenciar el servicio propio con evidencia, no copiar el encabezado ni asumir que esa web posiciona mejor.'
        : 'Los candidatos permiten identificar con quien contrastar la oferta, pero no establecer una ventaja competitiva sin leer sus paginas o perfiles.';
      const socialOnlyDirect = businesses.some(item => this.getCompetitiveSocialPlatform(item.domain || item.url)) &&
        !businesses.some(item => this.isOwnWebsiteCompetitiveCandidate(item));
      if (socialOnlyDirect) {
        next.siteSpecificObservation += ' Se encontraron perfiles sociales comparables, pero no se verificó una web propia vinculada a esos negocios; esto no demuestra que carezcan de ella.';
        next.gapToOutperform = 'La marca auditada dispone de web propia y puede aprovecharla como canal indexable y de conversión frente a estos perfiles sociales. No se midió una ventaja de posicionamiento o ventas.';
      }
      const readCompetitor = next.competitors.find(item => item.comparablePageUrl && item.comparablePageUrl === next.siteCtaPageUrl && item.pagePreview?.ctas?.length);
      if (readCompetitor && next.siteCtas.length &&
          readCompetitor.pagePreview.ctas.map(text => this.normalizeCompetitiveToken(text)).sort().join('|') !==
          next.siteCtas.map(text => this.normalizeCompetitiveToken(text)).sort().join('|')) {
        const otherCtas = readCompetitor.pagePreview.ctas.slice(0, 2).join(' / ');
        const ownCtas = (next.siteCtas || []).join(' / ');
        next.priorityActions.push('Comparar la accion visible de ' + readCompetitor.displayName + ' ("' + otherCtas +
          '")' + (ownCtas ? ' con la propia ("' + ownCtas + '")' : ' con el recorrido de contacto propio') +
          '. Probar cual explica mejor el siguiente paso; verificar el resultado con consultas o reservas, no con este puntaje SEO.');
      }
    } else {
      next.dominantProfile = 'No se pudieron verificar competidores en esta ejecución. Esto no significa que no exista competencia.';
      const reason = next.searchError === 'search_blocked' ? 'La fuente de búsqueda limitó el acceso automatizado.' :
        next.searchError === 'search_timeout' ? 'La búsqueda excedió el tiempo disponible.' :
        next.searchError ? 'No se obtuvo una respuesta de búsqueda útil.' :
        next.searchResultsCount > 0 ? 'Los resultados recuperados no permitieron verificar negocios comparables distintos del sitio auditado.' :
        'La consulta no devolvio candidatos utilizables.';
      next.gapToOutperform = reason;
      next.siteSpecificObservation = 'No se atribuyen fortalezas ni debilidades a competidores que no pudieron verificarse.';
      next.priorityActions = ['Completar la verificación externa con las consultas indicadas antes de decidir una estrategia competitiva.'];
    }
    next.disclaimer = 'Lectura orientativa de fuentes públicas. Encontrar un negocio no equivale a auditarlo: no se midieron rankings, tráfico, ventas ni autoridad.';
    if (next.comparisonMode === 'global_saas' || next.comparisonMode === 'niche_market') {
      next.ignoredLocality = next.ignoredLocality || next.locality || null;
      next.locality = null;
    }
    for (const key of ['competitorsHeading', 'dominantProfile', 'gapToOutperform', 'siteSpecificObservation', 'disclaimer']) {
      next[key] = this.normalizeVisibleSpanishText(next[key]);
    }
    next.priorityActions = next.priorityActions.map(value => this.normalizeVisibleSpanishText(value));
    return next;
  }

  buildOpportunityDetected(analysis = {}) {
    const findings = Array.isArray(analysis.pageSpecificFindings)
      ? analysis.pageSpecificFindings.filter(item => !item.contextOnly && !item.evidenceOnly) : [];
    const recommendations = Array.isArray(analysis.recommendations) ? analysis.recommendations : [];
    const finding = findings.find(item => item.priority === 'alta' && item.issue && item.recommendation) ||
      findings.find(item => item.issue && item.recommendation);
    if (finding) {
      return {
        hallazgo: this.normalizeVisibleSpanishText((finding.url ? finding.url + ': ' : '') + finding.issue),
        accion: this.normalizeVisibleSpanishText(finding.recommendation)
      };
    }

    const firstRecommendation = recommendations[0]?.action
      ? String(recommendations[0].action)
      : '';

    if (firstRecommendation) {
      return {
        hallazgo: this.normalizeVisibleSpanishText('Prioridad derivada de las recomendaciones del conjunto auditado; resultado comercial no medido.'),
        accion: this.normalizeVisibleSpanishText(firstRecommendation)
      };
    }

    return null;
  }

  buildWeeklyActionPlan(rawQuickWins = '', recommendations = []) {
    // Keep the legacy API name, but do not manufacture a delivery schedule.
    return this.buildPrioritizedAuditPlan({ recommendations })
      .map((item, index) => `Paso ${index + 1}: ${item.action}`).join('\n');
  }

  qualifyAuditConclusion(text = '') {
    const replacement = 'Las comprobaciones disponibles no permiten establecer un techo SEO ni estimar el retorno comercial.';
    const sentences = String(text || '').split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ])/);
    return [...new Set(sentences.map(sentence => /techo\s+(?:seo|t[eé]cnico)|(?:mayor|m[aá]ximo|mejor)\s+(?:retorno|roi)|garantiza\w*[^.!?]{0,70}(?:ranking|posicionamiento|conversiones|ventas)/i.test(sentence) ? replacement : sentence))].join(' ');
  }

  buildPrioritizedAuditPlan(analysis = {}) {
    const findings = (analysis.pageSpecificFindings || []).filter(item => !item.contextOnly && !item.evidenceOnly);
    const seen = new Set();
    const normalize = value => this.normalizeCompetitiveToken(value);
    const family = value => /^completar la lectura/.test(normalize(value)) ? 'coverage'
      : /\bh1\b|encabezado/.test(normalize(value)) ? 'h1'
      : /\balt\b/.test(normalize(value)) ? 'alt' : /canonical/.test(normalize(value)) ? 'canonical'
      : /meta.*descrip/.test(normalize(value)) ? 'description' : '';
    return (analysis.recommendations || []).filter(rec => rec?.action).map(rec => {
      const action = this.qualifyAuditConclusion(rec.action);
      const kind = family(action);
      const urls = action.match(/https?:\/\/[^\s"<>]+/g) || [];
      const pageHints = ['inicio', 'contacto', 'portfolio', 'blog'].filter(term => normalize(action).split(' ').includes(term));
      const matched = findings.filter(item => urls.length ? urls.some(url => url.replace(/[.,;:]+$/, '') === item.url)
        : kind && family(item.issue) === kind && (!pageHints.length || pageHints.some(term => normalize([item.label, item.url].join(' ')).includes(term))));
      const uncertain = !matched.length || matched.some(item => /no se ha confirmado|no se confirm[oó]|validar|sin comprobar|n[uú]mero por s[ií] solo/i.test(String(item.issue).split(/Adem[aá]s/i)[0])) || kind === 'alt' || kind === 'canonical' ||
        (kind === 'description' && !matched.some(item => /no se detect[oó] meta|meta descripci[oó]n ausente/i.test(item.issue)));
      const scope = [...new Set(matched.map(item => item.url).filter(Boolean))];
      const verification = kind === 'coverage' ? 'Repetir la lectura autorizada, registrar el resultado y distinguir un fallo de adquisición de un problema confirmado del sitio.'
        : kind === 'h1' ? 'Volver a leer las URLs afectadas y comprobar el encabezado en el contenido visible y en el DOM.'
        : kind === 'alt' ? 'Comprobar cada imagen informativa con texto alternativo pertinente; conservar ALT vacío en las decorativas.'
        : kind === 'canonical' ? 'Revisar el destino de la canonical y su coherencia con la URL que debe indexarse.'
        : kind === 'description' ? 'Comprobar la descripción publicada y su correspondencia con el contenido de cada URL.'
        : 'Confirmar la observación en la página afectada y probar el cambio contra su objetivo antes de extenderlo al sitio.';
      const actionablePart = action.match(/^https?:\/\/\S+\s[\s\S]*?\bAcci[oó]n:\s*([\s\S]+)$/i);
      const planAction = actionablePart && scope.length === 1 ? scope[0] + ': ' + actionablePart[1] : action;
      return { action: planAction, priority: rec.priority || 'media', scope, kind,
        evidence: matched.length ? matched.map(item => item.issue).join(' ') : 'Recomendación propuesta; falta vincularla a una comprobación específica.',
        confidence: uncertain ? 'requiere validación' : 'hallazgo observado',
        reason: kind === 'coverage' ? 'Completar evidencia antes de proponer una intervención sobre el sitio.' : uncertain ? 'Primero validar la necesidad; no se ha demostrado un perjuicio comercial.' : 'Corrige una carencia documentada en las URLs revisadas; no implica un aumento medido de ventas.',
        impact: this.qualifyAuditConclusion(rec.impact || 'Resultado comercial no medido.'),
        effort: kind === 'coverage' ? 'Nueva comprobación de lectura; sin editar la web.' : kind === 'h1' || kind === 'description' ? 'Edición acotada; depende del acceso al editor.' : kind === 'alt' ? 'Revisión por imagen; depende de la cantidad y función.' : 'Estimar después de confirmar alcance y acceso técnico.',
        dependency: kind === 'coverage' ? 'Acceso de lectura autorizado y registro del error de adquisición.' : uncertain ? 'Confirmar la evidencia y disponer de acceso a la página.' : 'Acceso al editor de las URLs afectadas.',
        verification };
    }).filter(item => {
      const key = item.kind === 'alt' ? 'alt-review' : normalize(item.action);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => Number(a.confidence !== 'hallazgo observado') - Number(b.confidence !== 'hallazgo observado') ||
      this.getPriorityWeight(b.priority) - this.getPriorityWeight(a.priority)).slice(0, 4);
  }

  async refineExecutivePdfBlocks({
    analysis = {},
    reasoningLayer = null,
    auditScope = {},
    essentialData = {},
    pageData = {}
  } = {}) {
    if (!this.labExecutiveRefinerEnabled) {
      return { success: false, skipped: true, reason: 'executive_refiner_disabled' };
    }

    const executiveRefinerSystem = `Eres un refinador ejecutivo de PDFs SEO. Solo editas tono, claridad y prioridad de estos 4 bloques. No inventes datos, no cambies score, no agregues hallazgos nuevos y no reanalices URLs. Si competitiveSnapshot indica global_saas, no conviertas ubicaciones en recomendacion local. Si un resultado es conflicto_marca, presencia_marca o no_comparable, no lo llames competidor directo. Devuelve SOLO JSON valido con las mismas claves.`;
    const executiveRefinerUser = `Refina estos bloques sin cambiar los hechos.

CONTEXTO MINIMO:
${this.serializeAuditPromptData({
  domain: essentialData.domain || null,
  plan: auditScope.plan || null,
  seoScore: analysis.seoScore || null,
  pageCount: analysis.aggregateTechnicalContext?.pageCount ?? null,
  coverage: analysis.coverage || essentialData.aggregateTechnicalContext?.coverage || null,
  technicalEvidence: analysis.technicalStatus || null,
  reasoningSummary: reasoningLayer ? {
    success: Boolean(reasoningLayer.success),
    model: reasoningLayer.model || null,
    requestedModel: reasoningLayer.requestedModel || null,
    actualModel: reasoningLayer.actualModel || null
  } : null
})}

TEXTO A REFINAR:
${this.serializeAuditPromptData({
  summary: analysis.summary || '',
  opportunityDetected: analysis.opportunityDetected || null,
  competitiveSnapshot: analysis.competitiveSnapshot || null,
  quickWins: analysis.quickWins || ''
})}

DEVUELVE JSON CON:
{
  "summary": "Resumen ejecutivo mas claro y premium",
  "opportunityDetected": {"hallazgo":"...","accion":"..."},
	  "competitiveSnapshot": {"signalLevel":"...","benchmarkStatus":"...","locality":"...","ignoredLocality":"...","comparisonMode":"...","hasDirectCompetitors":true,"competitorsHeading":"...","dominantProfile":"...","gapToOutperform":"...","siteSpecificObservation":"...","intents":[...],"competitors":[...],"priorityActions":[...],"disclaimer":"..."},
	  "quickWins": "Acciones justificadas en orden de prioridad, sin calendario inventado"
}`;

    const startedAt = Date.now();
    const refinerResult = await this.callAPI([
      { role: 'user', content: executiveRefinerUser }
    ], {
      system: executiveRefinerSystem,
      maxTokens: this.labExecutiveRefinerMaxTokens,
      temperature: this.labExecutiveRefinerTemperature,
      jsonMode: true,
      taskType: 'executive_refiner_pdf',
      forceModel: this.labExecutiveRefinerModel,
      plan: auditScope.plan || 'free',
      timeoutMs: 150000
    });

    const refinerUsage = this.normalizeUsage(refinerResult?.usage || null);
    const refinerSuccess = Boolean(refinerResult?.success);
    const refinerLayer = {
      success: refinerSuccess,
      error: refinerSuccess ? null : (refinerResult?.error || 'unknown_executive_refiner_error'),
      routingReason: refinerResult?.routing?.reason || null,
      routingFallbackError: refinerResult?.routing?.premiumFallbackError || null,
      routingTaskType: refinerResult?.routing?.taskType || null,
      routingModel: refinerResult?.routing?.model || null,
      routingPremiumActive: Boolean(refinerResult?.routing?.premiumActive),
      model: refinerResult?.actualModel || refinerResult?.model || this.labExecutiveRefinerModel,
      requestedModel: refinerResult?.requestedModel || this.labExecutiveRefinerModel,
      actualModel: refinerResult?.actualModel || refinerResult?.model || this.labExecutiveRefinerModel,
      modelMismatch: Boolean(refinerResult?.modelMismatch),
      transportFallbackUsed: Boolean(refinerResult?.transportFallbackUsed),
      inputTokens: refinerUsage.inputTokens,
      outputTokens: refinerUsage.outputTokens,
      totalTokens: refinerUsage.totalTokens,
      latencyMs: Date.now() - startedAt,
      estimatedCost: this.estimateCostUsd({
        model: refinerResult?.model || this.labExecutiveRefinerModel,
        inputTokens: refinerUsage.inputTokens,
        outputTokens: refinerUsage.outputTokens
      }),
      promptChars: String(executiveRefinerSystem || '').length + String(executiveRefinerUser || '').length
    };

    if (!refinerSuccess) {
      return {
        success: false,
        error: refinerLayer.error,
        layer: refinerLayer
      };
    }

    try {
      const refined = this.parseSEOAnalysis(refinerResult.content);
      return {
        success: true,
        layer: refinerLayer,
        refined: {
          summary: refined.summary || '',
          opportunityDetected: refined.opportunityDetected || null,
          competitiveSnapshot: refined.competitiveSnapshot || null,
          quickWins: this.normalizeQuickWinsField(refined.quickWins) || ''
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        layer: refinerLayer
      };
    }
  }

  normalizeQuickWinsField(rawQuickWins) {
    if (Array.isArray(rawQuickWins)) {
      const flat = rawQuickWins
        .map((item) => (typeof item === 'string' ? item : (item?.action || item?.text || '')))
        .map((item) => String(item || '').trim())
        .filter(Boolean);
      return this.normalizeVisibleSpanishText(flat.join('. '));
    }

    if (rawQuickWins && typeof rawQuickWins === 'object') {
      const values = Object.values(rawQuickWins)
        .map((value) => String(value || '').trim())
        .filter(Boolean);
      return this.normalizeVisibleSpanishText(values.join('. '));
    }

    return this.normalizeVisibleSpanishText(String(rawQuickWins || '').trim());
  }

  alignNarrativeWithScore(analysis = {}) {
    // An observed technical score cannot downgrade an independently evidenced issue.
    return analysis;
  }

  reconcileAuditNarrative(analysis = {}) {
    const next = { ...analysis };
    const findings = next.pageSpecificFindings || [];
    const unread = (next.analyzedPages || []).filter(page => page.readStatus && page.readStatus !== 'complete');
    const mentions = (text, page) => {
      let path = '';
      try { path = new URL(page.url).pathname.replace(/\/$/, ''); } catch (_) {}
      return [String(page.url || '').replace(/\/$/, ''), path].filter(value => value.length > 1).some(value => {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(escaped + '(?:/)?(?=$|[\\s?#.,;:)"<>])', 'i').test(String(text));
      });
    };
    const failedReferences = text => unread.filter(page => mentions(text, page));
    const coverageAction = rows => `Completar la lectura de ${rows.map(page => page.url).join(', ')} y comprobar el motivo del fallo antes de recomendar cambios. La lectura fallida no demuestra que la página esté caída ni que necesite una redirección.`;
    const readPages = (next.analyzedPages || []).filter(page => page.readStatus === 'complete');
    const operational = readPages.filter(page => this.getAuditPageCopyRole(page) === 'operational');
    const operationalAdvice = rows => 'Validar la función y las directivas de indexación de ' + rows.map(page => page.url).join(', ') +
      ' antes de recomendar cambios SEO. Una URL operativa no equivale automáticamente a una landing indexable.';
    const structuralAdvice = text => {
      const refs = readPages.filter(page => mentions(text, page));
      const scope = (refs.length ? refs : readPages).filter(page => !operational.includes(page));
      const parts = [];
      if (/\bh1\b/i.test(text) && /a[nñ]adir|agregar|ausen|falta|sin\s+(?:un\s+)?h1|no\s+(?:hay|tienen|se observ[oó])|varios|m[uú]ltiples|detectaron|mantener un solo|eliminar/i.test(text)) {
        const known = scope.filter(page => Number.isInteger(page.h1Count));
        if (known.length) {
          const missing = known.filter(page => page.h1Count === 0);
          const multiple = known.filter(page => page.h1Count > 1);
          if (missing.length) parts.push('No se observó H1 en ' + missing.map(page => page.url).join(', ') + '. Añadir un encabezado acorde al contenido si la revisión confirma su ausencia.');
          if (multiple.length) parts.push('Se observaron varios H1 en ' + multiple.map(page => page.url).join(', ') + '. Revisar su jerarquía antes de cambiarla; no añadir otro H1 ni asumir una penalización por el número.');
          if (!missing.length && !multiple.length) parts.push('Los encabezados comprobados en ' + known.map(page => page.url).join(', ') + ' no justifican añadir o eliminar H1. Verificar la estructura antes de modificarla.');
        }
      } else if (/canonical/i.test(text)) {
        const known = scope.filter(page => typeof page.canonical === 'string');
        if (known.length) {
          const missing = known.filter(page => !page.canonical);
          parts.push(missing.length ? 'No se observó canonical en ' + missing.map(page => page.url).join(', ') +
            '. Comprobar indexabilidad, duplicados y URL preferida antes de añadirla; su ausencia no demuestra duplicación.' :
            'Comprobar el destino y la coherencia de las canonical observadas antes de recomendar cambios.');
        }
      }
      if (/\bh1\b|canonical|meta\s*descrip/i.test(text)) {
        const ops = refs.filter(page => operational.includes(page));
        if (ops.length) parts.push(operationalAdvice(ops));
      }
      return parts.length ? parts.join(' ') : '';
    };
    const measured = (next.heavyImagesInsights?.pages || []).flatMap(page => (page.topImages || [])
      .filter(image => Number.isFinite(image.measuredBytes) && image.measuredBytes > 0)
      .map(image => ({ ...image, pageUrl: page.url })));
    const weightClaim = text => /measuredBytes|im[aá]genes (?:muy )?pesadas|peso (?:medido )?(?:elevado|alto)|bytes elevados|mayor peso|mayor.*(?:bytes|peso)/i.test(text);
    const weightAdvice = measured.length
      ? 'Revisar el peso descargado de los recursos medidos: ' + measured.slice(0, 3).map(image => `${image.src} (${image.measuredBytes} bytes; página ${image.pageUrl})`).join('; ') + '. Compararlo con su función y tamaño servido antes de optimizar. No se midió su impacto en la velocidad.'
      : 'Medir el peso descargado de las imágenes seleccionadas antes de decidir su optimización. Las dimensiones no prueban peso elevado ni lentitud; no hay bytes medidos que respalden esa conclusión en el detalle disponible.';
    const metadata = /meta\s*descrip|metadatos/i;
    const descriptionFindings = findings.filter(row => !row.contextOnly && !row.evidenceOnly && metadata.test(row.issue));
    const descriptionAction = 'Revisar las meta descripciones según el contenido y la función de cada URL. Agregar las ausentes; conservar las breves que ya expliquen su propósito y ampliar solo si falta información útil. No imponer una llamada comercial en páginas informativas.';
    const descriptionImpact = 'Mejora editorial propuesta; la longitud no demuestra pérdida de rendimiento y no se midió un cambio de CTR.';
    const descriptionObservation = descriptionFindings.length
      ? `${descriptionFindings.length} URL(s) con meta descripción ausente o breve para revisar. Una descripción breve no prueba un problema: contrastar su contenido antes de modificarla.`
      : 'Revisar las descripciones con evidencia de cada URL; no deducir un problema por la longitud.';
    let metadataAdded = false;
    next.recommendations = (next.recommendations || []).flatMap(rec => {
      const failed = failedReferences(rec.action);
      if (failed.length) return [{ ...rec, action: coverageAction(failed), impact: 'Completa la cobertura de esta auditoría; no acredita un problema del sitio.', priority: 'media' }];
      if (weightClaim([rec.action, rec.impact].join(' '))) return [{ ...rec, action: weightAdvice,
        impact: 'Validación de recursos; no se ha demostrado una mejora de rendimiento.', priority: 'media' }];
      const structural = structuralAdvice(rec.action);
      if (structural && !metadata.test(rec.action)) return [{ ...rec, action: structural,
        impact: 'Ajustar solo lo respaldado por la lectura y la función de cada URL.', priority: 'media' }];
      if (metadata.test(rec.action) && !/\bh1\b|canonical|\bALT\b/i.test(rec.action)) {
        if (metadataAdded) return [];
        metadataAdded = true;
        const scope = descriptionFindings.map(row => row.url).filter(Boolean);
        const missing = descriptionFindings.some(row => /no se detect[oó] meta|meta descripci[oó]n ausente/i.test(row.issue));
        return [{ ...rec, action: descriptionAction + (scope.length ? ' URLs: ' + [...new Set(scope)].join(', ') : ''), impact: descriptionImpact,
          priority: missing ? rec.priority || 'media' : 'media' }];
      }
      return [rec];
    });
    next.topIssues = [...new Set((next.topIssues || []).map(text => {
      const failed = failedReferences(text);
      if (failed.length) return `Cobertura pendiente: ${failed.map(page => page.url).join(', ')}. No se pudo completar su lectura; estado del sitio no confirmado.`;
      if (weightClaim(text)) return weightAdvice;
      const structural = structuralAdvice(text);
      if (structural) return structural;
      return metadata.test(text) ? descriptionObservation : text;
    }))];
    // Keep the provider's useful interpretation, but repair claims that contradict retained evidence.
    const splitSentences = text => String(text || '').split(/(?<=[.!?])\s+(?=[\p{L}\p{N}¿])/u);
    const sentences = splitSentences(next.summary);
    next.summary = [...new Set(sentences.map(sentence => {
      const failed = failedReferences(sentence);
      if (failed.length) return `Queda por completar la lectura de ${failed.map(page => page.url).join(', ')}; no se ha confirmado un fallo del sitio.`;
      if (weightClaim(sentence)) return weightAdvice;
      const structural = structuralAdvice(sentence);
      if (structural) return structural;
      if (metadata.test(sentence)) return descriptionObservation;
      return sentence.replace(/el rendimiento SEO est[aá] limitado por/gi, 'la revisión identifica')
        .replace(/estas incidencias afectan/gi, 'estas observaciones requieren verificar');
    }).flatMap(splitSentences))].join(' ');
    next.pagePatternSummary = (next.pagePatternSummary || []).map(pattern => {
      if (!metadata.test([pattern.issue, pattern.recommendation].join(' '))) return pattern;
      const rule = this.getPageFindingPatternDefinition({ issue: 'meta descripción' });
      return { ...pattern, issue: rule.issue, recommendation: rule.recommendation };
    });
    return next;
  }

  normalizeSeoPdfQuality(analysis = {}, context = {}) {
    const next = { ...analysis };
    const aggregate = context.aggregateTechnicalContext || {};
    next.summary = this.normalizeVisibleSpanishText(this.qualifyAuditConclusion(this.removeUnsupportedSeoPercentages(next.summary)));
    next.quickWins = this.normalizeVisibleSpanishText(this.removeUnsupportedSeoPercentages(next.quickWins));
    next.topIssues = (Array.isArray(next.topIssues) ? next.topIssues : [])
      .map((issue) => this.normalizeVisibleSpanishText(this.removeUnsupportedSeoPercentages(issue)));
    next.recommendations = this.rebalanceSeoRecommendations(
      (Array.isArray(next.recommendations) ? next.recommendations : []).map((rec) => ({
        ...rec,
        action: this.normalizeVisibleSpanishText(this.removeUnsupportedSeoPercentages(rec?.action || '')),
        impact: this.normalizeVisibleSpanishText(this.qualifyAuditConclusion(this.qualifySeoImpactText(rec?.impact || '', rec?.priority || 'media')))
      })),
      next
    );
    next.pageSpecificFindings = (Array.isArray(next.pageSpecificFindings) ? next.pageSpecificFindings : [])
      .map((finding) => ({
        ...finding,
        issue: this.normalizeVisibleSpanishText(this.removeUnsupportedSeoPercentages(finding?.issue || '')),
        recommendation: this.normalizeVisibleSpanishText(this.removeUnsupportedSeoPercentages(finding?.recommendation || '')),
        expectedImpact: finding.contextOnly || finding.evidenceOnly ? '' : this.normalizeVisibleSpanishText(this.qualifySeoImpactText(finding?.expectedImpact || '', finding?.priority || 'media'))
      }));

    Object.assign(next, this.reconcileAuditNarrative(next));
    if (context.pageData?.url && next.consultativeStatus !== 'consultative-degraded') {
      this.ensureSeoKeywordSuggestions(next, context.pageData, context.auditScope || {}, next.analyzedPages || []);
    }

    next.actionPlan = this.buildPrioritizedAuditPlan(next);
    next.quickWins = next.actionPlan.map((item, index) => `Paso ${index + 1}: ${item.action}\nMotivo: ${item.reason}\nConfianza: ${item.confidence}. Esfuerzo: ${item.effort}\nDependencia: ${item.dependency}\nVerificación: ${item.verification}`).join('\n');
    next.opportunityDetected = this.buildOpportunityDetected(next);
    next.executiveSnapshot = this.buildPdfExecutiveSnapshot({ ...next, recommendations: next.actionPlan }, {
      aggregateTechnicalContext: aggregate,
      pageData: context.pageData || {},
      auditScope: context.auditScope || {}
    });

    return next;
  }

  removeUnsupportedSeoPercentages(text = '') {
    const raw = String(text || '').trim();
    if (!raw) return raw;
    return this.normalizeVisibleSpanishText(raw
      .replace(/(?:aumentar|incrementar|mejorar|reducir|disminuir|subir|bajar)[^.!?]{0,90}\b\d{1,3}\s*%[^.!?]*[.!?]?/gi, 'Impacto esperado: mejora cualitativa medible si la página recibe tráfico orgánico o comercial. ')
      .replace(/\b\d{1,3}\s*%\b/g, 'mejora medible')
      .replace(/\s{2,}/g, ' ')
      .trim());
  }

  qualifySeoImpactText(text = '', priority = 'media') {
    const original = String(text || '');
    const cleaned = this.removeUnsupportedSeoPercentages(original);
    return this.normalizeVisibleSpanishText(cleaned || 'Resultado por validar despues del cambio; la prioridad no representa una mejora comercial medida.');
  }

  isMetadataSeoRecommendation(text = '') {
    return /\b(meta\s*descrip|h1|encabezad|title|t[ií]tulo)\b/i.test(String(text || ''));
  }

  buildSeoRecommendationAlternatives(analysis = {}) {
    const alternatives = [];
    const push = (action, priority = 'media', impact = 'Impacto esperado: Medio. Confianza: media, basada en señales visibles.') => {
      const cleanAction = String(action || '').replace(/\s+/g, ' ').trim();
      if (!cleanAction) return;
      alternatives.push({
        action: this.normalizeVisibleSpanishText(cleanAction),
        priority,
        impact: this.normalizeVisibleSpanishText(impact)
      });
    };

    const heavyImages = Number(analysis.heavyImagesInsights?.totalHeavyImages || 0);
    if (heavyImages > 0) {
      push(
        `Validar ${heavyImages} imagen(es) seleccionadas por peso medido o dimensiones. Medir los bytes transferidos antes de atribuirles lentitud; optimizar solo los recursos que lo necesiten.`,
        'media',
        'El efecto sobre la carga requiere medir bytes y tiempos antes y despues; las dimensiones no prueban lentitud.'
      );
    }

    (Array.isArray(analysis.interlinkingInsights) ? analysis.interlinkingInsights : [])
      .filter((item) => String(item?.priority || '').toLowerCase() !== 'baja')
      .slice(0, 2)
      .forEach((item) => {
        push(
          `Problema: ${item.detail || item.title}. Impacto: menor transferencia de contexto entre páginas clave. Acción: ${item.recommendation || 'reforzar enlaces internos entre secciones relacionadas.'}`,
          item.priority || 'media',
          'Impacto esperado: Medio. Mejora la arquitectura interna y el recorrido hacia páginas comerciales.'
        );
      });

    const findingGroups = new Map();
    (Array.isArray(analysis.pageSpecificFindings) ? analysis.pageSpecificFindings : [])
      .filter(finding => finding.issue && finding.recommendation)
      .forEach(finding => {
        const altOnly = /ALT vac[ií]o/i.test(finding.issue) && !/\b(H1|canonical|meta descripci[oó]n)\b/i.test(finding.issue);
        const key = (altOnly ? 'alt_vacio' : finding.recommendation) + '|' + finding.priority;
        if (!findingGroups.has(key)) findingGroups.set(key, []);
        findingGroups.get(key).push(finding);
      });
    for (const group of findingGroups.values()) {
        const finding = group[0];
        const location = group.length > 1
          ? `${group.length} paginas con la misma accion (URLs detalladas en Correcciones por pagina)`
          : finding.url || finding.label || 'Pagina revisada';
        push(
          `${location}: ${group.length > 1 ? '' : finding.issue.replace(/[.]+$/, '') + '. '}Acción: ${finding.recommendation}`,
          finding.priority || 'media',
          finding.expectedImpact || 'Comprobar el resultado del ajuste en las paginas indicadas; impacto comercial no medido.'
        );
    }

    const rank = { alta: 0, media: 1, baja: 2 };
    return alternatives.sort((a, b) => (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1));
  }

  rebalanceSeoRecommendations(recommendations = [], analysis = {}) {
    const source = Array.isArray(recommendations) ? recommendations : [];
    const alternatives = this.buildSeoRecommendationAlternatives(analysis);
    const balanced = [];
    const seen = new Set();

    const add = (rec) => {
      const action = String(rec?.action || '').replace(/\s+/g, ' ').trim();
      if (!action) return false;
      const key = action.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      balanced.push({
        action: this.normalizeVisibleSpanishText(action),
        priority: rec?.priority || 'media',
        impact: this.normalizeVisibleSpanishText(this.qualifySeoImpactText(rec?.impact || '', rec?.priority || 'media'))
      });
      return true;
    };

    source.forEach(add);
    if (!balanced.length) alternatives.forEach(add);

    return balanced.length ? balanced : source;
  }

  estimateSeoFixTime(action = '') {
    const text = String(action || '').toLowerCase();
    if (/schema|structured data|javascript|desarrollo|canonical|velocidad|imagen|comprimir|core web|redirect|sitemap|robots/.test(text)) {
      return 'requiere desarrollo';
    }
    if (/contenido|bloque|landing|comparativa|faq|interlink|enlaces internos|prueba social/.test(text)) {
      return '30 min';
    }
    if (/meta|h1|cta|title|titulo|encabezado/.test(text)) {
      return '15 min';
    }
    return '15 min';
  }

  buildPdfExecutiveSnapshot(analysis = {}, context = {}) {
    const pagesCount = Array.isArray(analysis.analyzedPages) ? analysis.analyzedPages.length : 0;
    const aggregate = context.aggregateTechnicalContext || {};
    const pageSignalsCount = [
      Number(aggregate.titlesCoverageCount || 0),
      Number(aggregate.missingMetaCount || 0),
      Number(aggregate.shortMetaCount || 0),
      Number(aggregate.longMetaCount || 0),
      Number(aggregate.missingH1Count || 0),
      Number(aggregate.multipleH1Count || 0),
      Number(aggregate.totalImagesWithoutAlt || 0),
      Number(analysis.heavyImagesInsights?.totalHeavyImages || 0),
      (Array.isArray(analysis.interlinkingInsights) ? analysis.interlinkingInsights.length : 0),
      (Array.isArray(analysis.pagePatternSummary) ? analysis.pagePatternSummary.length : 0)
    ].reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);

    const firstActions = (Array.isArray(analysis.recommendations) ? analysis.recommendations : [])
      .slice(0, 4)
      .map((rec) => {
        const action = String(rec?.action || '')
          .replace(/^problema:\s*/i, '')
          .replace(/\s+/g, ' ')
          .trim();
        return {
          action,
          priority: rec?.priority || 'media',
          time: this.estimateSeoFixTime(action)
        };
      })
      .filter((item) => item.action);

    return {
      analyzedPages: pagesCount,
      analyzedSignals: Math.max(pageSignalsCount, pagesCount),
      repeatedPatterns: Array.isArray(analysis.pagePatternSummary) ? analysis.pagePatternSummary.length : 0,
      heavyImages: Number(analysis.heavyImagesInsights?.totalHeavyImages || 0),
      firstActions
    };
  }

  enrichBusinessImpactLanguage(analysis = {}) {
    // Formatting must not fabricate causal claims from keywords such as H1, ALT or CTA.
    return {
      ...analysis,
      topIssues: (Array.isArray(analysis.topIssues) ? analysis.topIssues : [])
        .map(item => this.normalizeVisibleSpanishText(String(item || '').trim())),
      recommendations: (Array.isArray(analysis.recommendations) ? analysis.recommendations : []).map(rec => ({
        ...rec, impact: this.normalizeVisibleSpanishText(String(rec?.impact || '').trim()),
        action: this.normalizeVisibleSpanishText(String(rec?.action || '').trim())
      }))
    };
  }

  diversifyPageSpecificFindings(findings = []) {
    const normalized = Array.isArray(findings) ? findings : [];
    const seenRecommendations = new Map();
    const issueOpeners = [
      'Pagina estable dentro del alcance auditado.',
      'Base tecnica estable en esta URL.',
      'Sin alertas criticas en esta pagina dentro del alcance auditado.'
    ];

    return normalized.map((finding, index) => {
      if (finding.contextOnly || finding.evidenceOnly) return finding;
      const next = { ...finding };
      const recommendation = String(next.recommendation || '').trim();
      const issue = String(next.issue || '').trim();
      const pageType = String(next.type || '').toLowerCase();
      const seedBase = `${next.url || next.label || `page-${index}`}|${pageType}|${index}`;
      const isService = pageType.includes('servicios') || pageType.includes('productos');
      const isHome = pageType.includes('inicio');
      const isContact = pageType.includes('contacto');
      const isBlog = pageType.includes('blog') || pageType.includes('articulo') || pageType.includes('recurso');

      if (/no se detectaron problemas prioritarios/i.test(issue)) {
        const opener = this.pickVariantBySeed(issueOpeners, `${seedBase}|issue-opener`) || issueOpeners[0];
        next.issue = `${opener} Hay oportunidad incremental de elevar claridad comercial y conversion.`;
      } else if (/^fortaleza principal:/i.test(issue) && index % 2 === 1) {
        next.issue = issue
          .replace(/^fortaleza principal:\s*/i, `${this.pickVariantBySeed(['Pagina estable: ', 'Fortaleza valida: ', 'Base solida: '], `${seedBase}|fortaleza-prefix`) || 'Pagina estable: '}`)
          .replace(/oportunidad incremental:/i, 'Mejora incremental:');
      }

      if (!recommendation) return next;

      const key = recommendation.toLowerCase().replace(/\s+/g, ' ').trim();
      const repeatedTimes = seenRecommendations.get(key) || 0;
      seenRecommendations.set(key, repeatedTimes + 1);

      if (repeatedTimes === 0) return next;

      const genericRotation = isService
        ? [
            'Priorizar autoridad en esta URL con un caso breve, resultado medible y CTA de contacto directo para convertir mejor trafico comercial.',
            'Incluir una mini-tabla de diferenciadores (alcance, tiempos, enfoque) para bajar friccion y elevar calidad de consulta.',
            'Agregar un bloque de objeciones frecuentes + respuesta clara para acelerar decision y mejorar conversion en sesiones de alta intencion.',
            'Reforzar propuesta con prueba de confianza (cliente, testimonio o resultado) antes del CTA principal para subir tasa de avance.',
            'Conectar esta pagina con una comparativa breve de alternativas para diferenciar oferta y evitar fuga a competidores similares.'
          ]
        : isHome
          ? [
              'Reforzar primer scroll con promesa mas concreta, diferenciador principal y CTA comercial visible para elevar conversion inicial.',
              'Sumar evidencia de autoridad (logos, casos, metricas) por encima del primer CTA para reducir duda y mejorar accion.',
              'Ajustar secuencia de bloques para mostrar primero beneficio, luego prueba y finalmente llamada a la accion de alta intencion.'
            ]
          : isContact
            ? [
                'Reducir friccion de contacto detallando tiempo de respuesta, canal recomendado y siguiente paso para mejorar tasa de envio.',
                'Cambiar copy de CTA a lenguaje de avance ("Solicitar propuesta", "Agendar llamada") para captar mejor demanda activa.',
                'Sumar una garantia de proceso o expectativa clara de entrega para elevar confianza justo antes del envio.'
              ]
            : isBlog
              ? [
                  'Cerrar la pagina con una accion concreta y enlace a servicio para transformar trafico informacional en oportunidad comercial.',
                  'Agregar una comparativa corta o checklist para aumentar utilidad practica y mejorar retencion frente a contenido similar.',
                  'Incluir una seccion de objeciones/respuestas para sostener interes y mover al lector hacia contacto o propuesta.'
                ]
              : [
                  'Incluir una prueba concreta de autoridad y un CTA de siguiente paso para mejorar conversion sin rehacer toda la estructura.',
                  'Agregar diferenciacion explicita frente a alternativas similares para elevar valor percibido y reducir rebote comercial.',
                  'Sumar un bloque breve de beneficios + evidencia + accion para reforzar decision en usuarios indecisos.'
                ];

      if (/faq|preguntas frecuentes/i.test(recommendation)) {
        const faqVariants = isService
          ? [
              'Priorizar un bloque de diferenciadores + caso real para convertir mejor esta URL de servicio.',
              'Convertir FAQ en bloque de objeciones comerciales con CTA de avance para mejorar conversion.',
              'Agregar respuestas de decision (precio orientativo, tiempos, alcance) para filtrar mejor consultas.'
            ]
          : isHome
            ? [
                'Reforzar primer scroll con propuesta concreta y CTA de alta intencion para capturar mas demanda activa.',
                'Usar FAQ como puente a servicios clave con enlaces internos para mejorar recorrido y conversion.',
                'Priorizar preguntas de compra temprana para reducir dudas antes del contacto.'
              ]
            : [
                'Profundizar la pagina con ejemplos aplicados y una seccion breve de objeciones para ganar relevancia sin repetir plantilla.',
                'Enfocar FAQ en preguntas de decision y siguiente paso para elevar utilidad y conversion.',
                'Combinar FAQ corta con una accion recomendada para mover al usuario hacia una URL comercial.'
              ];
        next.recommendation = this.pickVariantBySeed(
          faqVariants,
          `${seedBase}|faq|${repeatedTimes}|${recommendation}`
        ) || faqVariants[0];
        return next;
      }

      if (/cta principal|llamado a la accion|accion concreta/i.test(recommendation)) {
        const ctaVariants = isContact
          ? [
              'En esta URL conviene priorizar un CTA de contacto inmediato, por ejemplo "Agendar llamada" o "Solicitar propuesta hoy".',
              'Usar CTA de cierre con expectativa de respuesta ("Te respondemos en 24h") para mejorar conversion del formulario.',
              'Priorizar un CTA unico y visible con verbo de accion comercial para reducir dispersion de clics.'
            ]
          : isService
            ? [
                'En esta pagina de servicio conviene mover el CTA a una accion de compra o consulta directa con lenguaje mas especifico.',
                'Cambiar CTA generico por una accion de alto compromiso ("Pedir propuesta", "Agendar diagnostico") y ubicarlo antes del segundo scroll.',
                'Alinear CTA con intencion de la URL y sumar una micro-prueba de confianza para mejorar tasa de contacto.'
              ]
            : [
                `${recommendation.replace(/[.]+$/, '')}. En esta URL, priorizar que el CTA aparezca antes del segundo scroll.`,
                'Ajustar CTA a beneficio concreto y agregar una evidencia breve para aumentar probabilidad de accion.',
                'Reducir ambiguedad del CTA con un siguiente paso claro y medible para mejorar conversion.'
              ];
        next.recommendation = this.pickVariantBySeed(
          ctaVariants,
          `${seedBase}|cta|${repeatedTimes}|${recommendation}`
        ) || ctaVariants[0];
        return next;
      }

      next.recommendation = this.pickVariantBySeed(
        genericRotation,
        `${seedBase}|generic|${repeatedTimes}|${recommendation}`
      ) || genericRotation[0];

      return next;
    });
  }

  buildAuditCtaRecommendation(page = {}, cta = {}) {
    const role = this.getAuditPageCopyRole(page);
    const signals = this.getPageExampleSignals(page, this.getPageTypeLabel(page.url, page.title), this.buildPageExampleSubject(page));
    let example = this.buildIntentCtaProposal(signals);
    if (role === 'hotel') example = 'Si abre un listado, usar "Ver hoteles"; si consulta fechas y plazas, "Consultar disponibilidad". No prometer una reserva si el botón solo muestra información.';
    const destination = cta.href || cta.url;
    return 'Comprobar primero qué hace el control' + (destination && /^https?:\/\//i.test(destination) ? ' y su destino ' + destination : '') +
      '. Conservarlo si ya describe la tarea; cambiarlo solo si resulta ambiguo en su contexto. ' + example;
  }

  buildPageSpecificFindings(pageData, internalPages) {
    const normalizeSentence = (value = '') => String(value || '').replace(/\s{2,}/g, ' ').trim();
    const stripTrailingPeriod = (value = '') => normalizeSentence(value).replace(/[.。]+$/, '');
    const lowerFirst = (value = '') => {
      const cleanValue = normalizeSentence(value);
      if (!cleanValue) return '';
      return cleanValue.charAt(0).toLowerCase() + cleanValue.slice(1);
    };

    const contactInfo = pageData.contactInfo || {};
    const geolocationKeywords = Array.isArray(contactInfo.geolocationKeywords) ? contactInfo.geolocationKeywords : [];
    const hasAddress = Array.isArray(contactInfo.address) && contactInfo.address.length > 0;
    const hasPhone = Array.isArray(contactInfo.phone) && contactInfo.phone.length > 0;
    const localSchemaText = JSON.stringify(pageData.schemaData || []).toLowerCase();
    const localText = `${pageData.title || ''} ${pageData.metaDescription || ''} ${pageData.textContent || ''}`.toLowerCase();
    const localBusinessPatterns = [
      'barbería',
      'barberia',
      'barber shop',
      'peluquería',
      'peluqueria',
      'salon de belleza',
      'salón de belleza',
      'centro de estética',
      'centro de estetica',
      'spa',
      'beauty salon',
      'hair salon'
    ];
    const localSchemaPatterns = /(localbusiness|barbershop|beautysalon|hairsalon|healthandbeautybusiness|store|organization)/i;
    const looksLikeLocalBusiness =
      hasAddress ||
      hasPhone ||
      geolocationKeywords.length > 0 ||
      localSchemaPatterns.test(localSchemaText) ||
      localBusinessPatterns.some((pattern) => localText.includes(pattern));

    const homepageHasStrongLocationSignals =
      geolocationKeywords.length > 0 ||
      hasAddress ||
      /\ben\s+[A-ZÁÉÍÓÚÑ][\p{L}]+/u.test([pageData.title, pageData.metaDescription].filter(Boolean).join(' ')) ||
      /\b(cerca de|ubicad[oa] en|direcci[oó]n|avenida|calle|barrio|zona|ciudad)\b/i.test(localText);

    const pages = [
      {
        readStatus: this.getAuditReadStatus(pageData, true),
        url: pageData.url,
        title: pageData.title || '',
        label: 'Inicio',
        metaDescription: pageData.metaDescription ?? null,
        content: String(pageData.textContent || '').trim().slice(0, 1200),
        h1s: pageData.h1s || [],
        h1Count: pageData.h1Count ?? null,
        canonical: pageData.canonical ?? null,
        wordCount: pageData.wordCount || 0,
        imageData: pageData.imageData || pageData,
        ctaData: Array.isArray(pageData.ctaData) ? pageData.ctaData : [],
        ctaDataKnown: Array.isArray(pageData.ctaData),
        isPrimary: true
      },
      ...(internalPages || []).map((page) => ({
        readStatus: this.getAuditReadStatus(page),
        url: page.url,
        title: page.title || '',
        label: page.label || '',
        metaDescription: page.metaDescription ?? null,
        content: String(page.content || '').trim().slice(0, 1200),
        h1s: page.h1s || [],
        h1Count: page.h1Count ?? null,
        canonical: page.canonical ?? null,
        wordCount: page.wordCount || 0,
        imageData: page.imageData || {},
        ctaData: Array.isArray(page.ctaData) ? page.ctaData : [],
        ctaDataKnown: Array.isArray(page.ctaData),
        technicalScoreReliable: page.technicalScoreReliable === true,
        contentSource: page.contentSource || '',
        isPrimary: false
      }))
    ];

    const findings = pages.filter((page, index) => pages.findIndex(other => other.url === page.url) === index).map((page) => {
      const pageLabel = this.getPageLabel(page.url, page.title, page.label);
      const pageType = this.getAuditPageCopyRole(page) === 'legal' ? 'Legal' : this.getPageTypeLabel(page.url, page.label || page.title);
      const candidates = [];
      const addCandidate = (issue, recommendation, priority = 'media') => {
        if (!issue || !recommendation) return;
        candidates.push({
          issue: normalizeSentence(issue),
          recommendation: normalizeSentence(recommendation),
          priority
        });
      };
      const reliableTechnicalSignals = page.readStatus === 'complete';
      if (!reliableTechnicalSignals) {
        return { url: page.url, title: page.title, label: pageLabel, type: pageType,
          readStatus: page.readStatus, contextOnly: true, priority: 'baja',
          issue: 'Información insuficiente para una recomendación específica. Estado de lectura: ' + page.readStatus + '.',
          recommendation: 'Completar la lectura de esta URL antes de proponer cambios técnicos o de contenido.' };
      }
      if (this.getAuditPageCopyRole(page) === 'operational') {
        return { url: page.url, title: page.title, label: pageLabel, type: pageType, readStatus: page.readStatus,
          evidenceOnly: true, priority: 'baja',
          issue: 'URL de función operativa. No se ha confirmado que deba captar tráfico orgánico ni su estado de indexación.',
          recommendation: 'Verificar su tarea y las directivas de indexación antes de recomendar H1, metadatos o canonical. No tratarla automáticamente como una landing comercial.' };
      }

      if (reliableTechnicalSignals) {
        const copyRole = this.getAuditPageCopyRole(page);
        const descriptionFocus = {
          stories: 'el caso o conjunto de casos y el contexto documentado, sin inventar resultados',
          statistics: 'el tema de los datos y su alcance; mencionar periodo y fuente solo si están disponibles',
          registration: 'la finalidad del registro y las condiciones verificadas, sin prometer acceso gratuito',
          contact: 'los canales y motivos de contacto realmente disponibles',
          help: 'las dudas que responde esta página y el tema de sus explicaciones',
          news: 'el anuncio y sus hechos principales, sin transformarlo en una oferta comercial',
          blog: 'el tema del contenido y qué puede aprender el lector',
          institutional: 'la identidad y actividad verificables de la organización',
          pricing: 'los planes y condiciones publicados, sin añadir prestaciones no observadas'
        }[copyRole] || 'el contenido y la tarea principal de esta URL, sin añadir beneficios no documentados';
        if (page.metaDescription === '') {
          addCandidate(
            'No se detectó meta descripción en esta página. No se comprobó qué fragmento muestra el buscador ni su rendimiento.',
            `Agregar una meta descripción específica que resuma ${descriptionFocus}.`,
            'alta'
          );
        } else if (typeof page.metaDescription === 'string' && page.metaDescription.length < 120) {
          addCandidate(
            'La meta descripción tiene menos de 120 caracteres. Es una señal de revisión editorial, no una pérdida de rendimiento demostrada.',
            `Revisar si comunica ${descriptionFocus}. Conservarla si ya lo hace; ampliarla solo si falta información útil, no para alcanzar una longitud fija.`,
            'media'
          );
        }

        if (page.h1Count === 0) {
          addCandidate(
            'No se encontró un H1 visible, lo que dificulta comunicar a Google y al usuario cuál es el foco principal de la página.',
            'Agregar un H1 único que resuma la intención principal de esta URL con lenguaje claro y orientado a búsqueda.',
            'alta'
          );
        } else if (page.h1Count > 1) {
          addCandidate(
            `Se detectaron ${page.h1Count} H1. Revisar su función y jerarquía; el número por sí solo no demuestra un perjuicio SEO.`,
            'Comprobar si los H1 representan títulos principales o encabezados de secciones. Ajustar los niveles solo si la jerarquía no refleja la estructura real.',
            'media'
          );
        }

        if (page.canonical === '') {
          addCandidate(
            'No se detectó etiqueta canonical en esta URL. Su ausencia no demuestra que existan páginas duplicadas.',
            'Comprobar las variantes de URL, su indexabilidad y el destino preferido antes de decidir si corresponde añadir una canonical.',
            'media'
          );
        }

        if (page.imageData.imagesWithoutAlt > 0) {
          const count = page.imageData.imagesWithoutAlt;
          addCandidate(
            count === 1 ? 'Se observó 1 imagen sin atributo ALT en esta URL.' : `Se observaron ${count} imágenes sin atributo ALT en esta URL.`,
            'Añadir texto alternativo descriptivo a las imágenes informativas; declarar como decorativas las que no transmiten información.',
            'media'
          );
        } else if (page.imageData.emptyAlt > 0) {
          const count = page.imageData.emptyAlt;
          addCandidate(
            count === 1 ? 'Se observó 1 imagen con ALT vacío. No se ha confirmado si es decorativa.' :
              `Se observaron ${count} imágenes con ALT vacío. No se ha confirmado si son decorativas.`,
            count === 1
              ? 'Comprobar la función de esa imagen. Mantener ALT vacío si es decorativa; describirla si comunica un trabajo, producto o información.'
              : 'Comprobar la función de esas imágenes. Mantener ALT vacío en las decorativas y describir las que comunican trabajos, productos o información.',
            'baja'
          );
        }
      }

      const ctaData = (Array.isArray(page.ctaData) ? page.ctaData : []).map(cta => ({
        ...cta, strength: cta.strength || (/reserv|agenda|compr|solicit|contact/i.test(cta.text || '') ? 'strong' : 'medium')
      }));
      const visibleCtas = ctaData.filter((cta) => ['strong', 'medium', 'generic'].includes(cta.strength));
      const genericCtas = ctaData.filter((cta) => cta.strength === 'generic');

      if (reliableTechnicalSignals && page.ctaDataKnown && this.getAuditPageCopyRole(page) !== 'legal') {
        if (visibleCtas.length === 0) {
          addCandidate(
            'No se identificó una acción siguiente en los controles recogidos. Esto no demuestra que falte ni que toda página necesite un CTA comercial.',
            this.buildAuditCtaRecommendation(page),
            'media'
          );
        } else if (genericCtas.length > 0 && !ctaData.some(cta => cta.strength === 'strong')) {
          const mainGenericCta = genericCtas[0];
          addCandidate(
            `Se encontró el CTA genérico "${mainGenericCta.text}", sin detectar otro CTA de acción específica en la lectura disponible.`,
            this.buildAuditCtaRecommendation(page, mainGenericCta),
            'media'
          );
        }
      }

      const marketScope = this.buildCompetitiveContext({}, pageData, {}, internalPages);
      if (page.isPrimary && looksLikeLocalBusiness && !homepageHasStrongLocationSignals &&
          !marketScope.isBroadServiceArea && !marketScope.isGlobalSaas && marketScope.comparisonMode !== 'ecommerce') {
        addCandidate(
          'La página principal da señales de negocio local, pero no refuerza con claridad la ubicación o el alcance geográfico, lo que puede limitar búsquedas locales.',
          'Incorporar referencias visibles a ciudad, zona o ubicación de servicio en títulos, textos clave y meta descripción para ganar relevancia en SEO local.',
          'alta'
        );
      }

      if (candidates.length === 0) {
        if (!page.isPrimary && !reliableTechnicalSignals) {
          return {
            label: pageLabel,
            title: page.title || '',
            type: pageType,
            url: page.url,
            metaDescription: page.metaDescription || '',
            content: page.content || '',
            issue: 'Lectura parcial disponible: se toma como contexto de apoyo y conviene validar esta URL con una revisión renderizada antes de aplicar cambios técnicos.',
            recommendation: 'Usar esta URL para entender estructura, intención y enlaces internos; validar señales técnicas con lectura renderizada si se necesita una revisión puntual.',
            priority: 'baja',
            contextOnly: true
          };
        }

        const noCriticalFinding = {
          issue: 'Sin problemas prioritarios confirmados en estas comprobaciones. Título observado: "' + page.title + '".',
          recommendation: 'Conservar las señales comprobadas y contrastar oportunidades adicionales con datos de búsquedas y conversiones.',
          priority: 'baja'
        };
        return {
          label: pageLabel,
          title: page.title || '',
          type: pageType,
          url: page.url,
          metaDescription: page.metaDescription || '',
          content: page.content || '',
          issue: noCriticalFinding.issue,
          recommendation: noCriticalFinding.recommendation,
          priority: noCriticalFinding.priority || 'baja',
          strength: noCriticalFinding.strength || '',
          opportunity: noCriticalFinding.opportunity || '',
          evidenceOnly: true
        };
      }

      candidates.sort((a, b) => this.getPriorityWeight(b.priority) - this.getPriorityWeight(a.priority));
      const primaryCandidate = candidates[0];
      const secondaryCandidate = candidates[1];

      const issue = secondaryCandidate
        ? `${stripTrailingPeriod(primaryCandidate.issue)}. Además, ${lowerFirst(secondaryCandidate.issue)}`
        : primaryCandidate.issue;

      const recommendation = secondaryCandidate
        ? `${stripTrailingPeriod(primaryCandidate.recommendation)}. También conviene ${lowerFirst(stripTrailingPeriod(secondaryCandidate.recommendation))}.`
        : primaryCandidate.recommendation;

      return {
        label: pageLabel,
        title: page.title || '',
        type: pageType,
        url: page.url,
        metaDescription: page.metaDescription || '',
        content: page.content || '',
        issue,
        h1s: page.h1s || [],
        recommendation,
        priority: primaryCandidate.priority
      };
    });

    const diversifiedFindings = findings;
    const visibleFindings = diversifiedFindings.map((finding) => ({
      ...finding,
      label: this.normalizeVisibleSpanishText(finding.label || ''),
      title: this.normalizeVisibleSpanishText(finding.title || ''),
      issue: this.normalizeVisibleSpanishText(finding.issue || ''),
      recommendation: this.normalizeVisibleSpanishText(finding.recommendation || ''),
      strength: this.normalizeVisibleSpanishText(finding.strength || ''),
      opportunity: this.normalizeVisibleSpanishText(finding.opportunity || '')
    }));
    return this.finalizePageSpecificExecution(visibleFindings, geolocationKeywords[0] || '');
  }

  getPageFindingPatternDefinition(finding = {}) {
    if (finding.contextOnly || finding.evidenceOnly) return null;
    const issue = String(finding?.issue || '').toLowerCase();
    const recommendation = String(finding?.recommendation || '').toLowerCase();
    const combined = `${issue} ${recommendation}`;

    if (/meta descripci[oó]n/.test(combined)) {
      return {
        key: 'meta_description',
        label: 'descripciones para revisión editorial',
        issue: 'Varias URLs tienen meta descripción breve o ausente. La longitud por sí sola no demuestra una pérdida de rendimiento; distinguir descripción ausente de contenido breve pero suficiente.',
        recommendation: 'Revisar cada descripción según la función de su URL. Añadir las ausentes; conservar las breves que ya sean claras y ampliar únicamente si falta información útil. No imponer ofertas ni llamadas comerciales a páginas informativas.'
      };
    }

    if (/h1/.test(combined)) {
      return {
        key: 'heading_h1',
        label: 'encabezados para revisión',
        issue: 'varias URLs requieren revisar sus encabezados; distinguir H1 ausente de múltiples H1 antes de intervenir',
        recommendation: 'Añadir el encabezado principal donde se confirme su ausencia. Si hay varios, comprobar su función y la estructura de secciones antes de cambiar los niveles; el número no demuestra por sí solo un perjuicio SEO.'
      };
    }

    if (/canonical/.test(combined)) {
      return {
        key: 'canonical',
        label: 'canonicals faltantes',
        issue: 'no se observó canonical en varias URLs; todavía debe comprobarse si hay versiones duplicadas o una URL preferida',
        recommendation: 'Revisar indexabilidad, variantes y destino preferido antes de decidir si corresponde añadir o ajustar canonical. Su ausencia no demuestra duplicación.'
      };
    }

    if (/contenido visible es breve|contenido breve|corto para competir|expandir esta url|expandir esta p[aá]gina/.test(combined)) {
      return {
        key: 'thin_content',
        label: 'contenido demasiado corto',
        issue: 'varias paginas clave quedan cortas para sostener la intencion de busqueda y responder mejor al usuario',
        recommendation: 'Ampliar las URLs repetidas con beneficios concretos, diferenciadores, objeciones y una prueba real, en lugar de sumar texto generico pagina por pagina.'
      };
    }

    if (/cta principal|llamado a la acci[oó]n|accion concreta|solicitar asesor[íi]a|pedir una propuesta|habla con un especialista/.test(combined)) {
      return {
        key: 'cta_specificity',
        label: 'CTA genericos o ausentes',
        issue: 'las paginas clave no siempre convierten la intencion visible en un CTA especifico y orientado a accion',
        recommendation: 'Normalizar CTAs por tipo de pagina para que cada URL empuje una accion concreta con copy mas especifico antes del segundo scroll.'
      };
    }

    if (/negocio local|b[uú]squedas locales|ubicaci[oó]n|alcance geogr[aá]fico/.test(combined)) {
      return {
        key: 'local_signal',
        label: 'senal local insuficiente',
        issue: 'las señales de ubicacion o alcance geografico no se repiten con suficiente claridad en las URLs que mas podrian capturar demanda local',
        recommendation: 'Reforzar ciudad, zona y alcance de servicio en titulos, metadatos y bloques visibles de las paginas con mas potencial local.'
      };
    }

    return null;
  }

  compressRepeatedPageFindings(findings = [], totalPages = 0) {
    const safeFindings = Array.isArray(findings) ? findings : [];
    if (safeFindings.length <= 2) return safeFindings;

    const grouped = new Map();
    safeFindings.forEach((finding, index) => {
      const definition = this.getPageFindingPatternDefinition(finding);
      if (!definition) return;

      if (!grouped.has(definition.key)) {
        grouped.set(definition.key, { definition, entries: [] });
      }

      grouped.get(definition.key).entries.push({ finding, index });
    });

    const usedIndexes = new Set();
    const compressed = [];

    safeFindings.forEach((finding, index) => {
      if (usedIndexes.has(index)) return;

      const definition = this.getPageFindingPatternDefinition(finding);
      const group = definition ? grouped.get(definition.key) : null;

      if (!group || group.entries.length < 2) {
        compressed.push(finding);
        return;
      }

      group.entries.forEach((entry) => usedIndexes.add(entry.index));
      const impactedPages = group.entries.map((entry) => entry.finding?.label).filter(Boolean);
      const impactedCount = impactedPages.length;
      const pageBase = Math.max(Number(totalPages) || 0, impactedCount);
      const labelsPreview = impactedPages.slice(0, 4).join(', ');
      const remaining = impactedPages.length - Math.min(impactedPages.length, 4);
      const affectedLabel = remaining > 0 ? `${labelsPreview} y ${remaining} mas` : labelsPreview;
      const topPriority = group.entries
        .map((entry) => entry.finding?.priority || 'media')
        .sort((a, b) => this.getPriorityWeight(b) - this.getPriorityWeight(a))[0] || 'media';

      compressed.push({
        label: `Patron repetido en ${impactedCount}/${pageBase} paginas`,
        type: 'Patron multipagina',
        url: '',
        issue: `Se repite ${group.definition.issue}. Aparece en ${affectedLabel}.`,
        recommendation: group.definition.recommendation,
        priority: topPriority,
        affectedPages: impactedPages,
        repeatedPattern: group.definition.label
      });
    });

    return compressed;
  }

  buildHeavyImagesInsights(pageData, internalPages) {
    const pages = [
      {
        label: this.getPageLabel(pageData.url, pageData.title, 'Inicio'),
        type: this.getPageTypeLabel(pageData.url, pageData.title),
        url: pageData.url,
        totalImages: pageData.totalImages || 0,
        heavyImages: pageData.heavyImages || 0,
        heavyImagesList: Array.isArray(pageData.heavyImagesList) ? pageData.heavyImagesList : []
      },
      ...(internalPages || []).map((page) => ({
        label: this.getPageLabel(page.url, page.title, page.label),
        type: this.getPageTypeLabel(page.url, page.label || page.title),
        url: page.url,
        totalImages: page.imageData?.totalImages || 0,
        heavyImages: page.imageData?.heavyImages || 0,
        heavyImagesList: Array.isArray(page.imageData?.heavyImagesList) ? page.imageData.heavyImagesList : []
      }))
    ];

    const affectedPages = pages
      .filter((page, index) => pages.findIndex(other => other.url === page.url) === index)
      .filter((page) => page.heavyImages > 0)
      .map((page) => ({
        label: page.label,
        type: page.type,
        url: page.url,
        totalImages: page.totalImages,
        heavyImages: page.heavyImages,
        topImages: page.heavyImagesList
          .slice()
          .sort((a, b) => (Number(b.measuredBytes > 0) - Number(a.measuredBytes > 0)) ||
            (b.measuredBytes || 0) - (a.measuredBytes || 0) || (b.estimatedSize || 0) - (a.estimatedSize || 0))
          .slice(0, 3)
          .map((image) => ({
            src: image.src,
            alt: image.alt || '',
            altStatus: image.altStatus || (image.alt && image.alt !== 'Sin texto alternativo' ? 'present' : 'unknown'),
            measuredBytes: Number.isFinite(image.measuredBytes) && image.measuredBytes > 0 ? image.measuredBytes : null,
            width: image.width || 0,
            height: image.height || 0,
            estimatedSize: image.estimatedSize || 0
          }))
      }));

    const totalHeavyImages = affectedPages.reduce((sum, page) => sum + page.heavyImages, 0);
    const totalPagesWithHeavyImages = affectedPages.length;

    return {
      totalHeavyImages,
      totalPagesWithHeavyImages,
      measurementNote: 'Selección por bytes medidos o dimensiones; una estimación RGB no representa el peso descargado.',
      pages: affectedPages
    };
  }

  getAuditReadStatus(page = {}, primary = false) {
    if (['complete', 'partial', 'insufficient', 'failed'].includes(page.readStatus)) return page.readStatus;
    if (page.lightweightFallback) return 'insufficient';
    if (page.technicalScoreReliable === true) return 'complete';
    if (primary && page.technicalScoreReliable !== false && typeof page.h1Count === 'number'
      && typeof page.title === 'string') return 'complete';
    return page.content || page.textContent ? 'partial' : 'insufficient';
  }

  buildAggregateTechnicalContext(pageData, internalPages = []) {
    const rows = [{ ...pageData, isPrimary: true }, ...internalPages];
    const unique = rows.filter((page, index) => rows.findIndex(other => other.url === page.url) === index);
    const metrics = Object.fromEntries(['title', 'metaDescription', 'h1', 'alt', 'canonical', 'viewport', 'https']
      .map(key => [key, { passed: 0, problem: 0, unknown: 0, affectedUrls: [] }]));
    const weights = { title: 20, metaDescription: 20, h1: 20, alt: 20, canonical: 10, viewport: 5, https: 5 };
    let earned = 0, checked = 0;
    const images = { total: 0, missing: 0, empty: 0, decorative: 0, unknown: 0, knownPages: 0, unknownPages: 0, affectedUrls: [] };
    const pages = unique.map(page => {
      const readStatus = this.getAuditReadStatus(page, page.isPrimary);
      const reliable = readStatus === 'complete';
      const imageData = page.imageData || page;
      const present = key => reliable && Object.hasOwn(page, key) && page[key] !== null && page[key] !== undefined;
      const imageKnown = reliable && Number.isInteger(imageData.totalImages) && imageData.totalImages >= 0
        && Number.isInteger(imageData.imagesWithoutAlt) && imageData.imagesWithoutAlt >= 0;
      if (imageKnown) {
        images.knownPages++;
        images.total += imageData.totalImages;
        images.missing += imageData.imagesWithoutAlt;
        images.empty += Number(imageData.emptyAlt || 0);
        images.decorative += Number(imageData.decorativeImages || 0);
        images.unknown += Number(imageData.unknownAlt || 0);
        if (imageData.imagesWithoutAlt > 0) images.affectedUrls.push(page.url);
      } else images.unknownPages++;
      const values = {
        title: present('title') ? Boolean(page.title.trim()) && (page.titleCount === undefined || page.titleCount === 1) : null,
        metaDescription: present('metaDescription') ? page.metaDescription.trim().length >= 120 && page.metaDescription.trim().length <= 160 : null,
        h1: present('h1Count') ? page.h1Count === 1 : null,
        alt: imageKnown ? (imageData.imagesWithoutAlt > 0 ? false : imageData.emptyAlt > 0 || imageData.unknownAlt > 0 ? null : true) : null,
        canonical: present('canonical') ? /^https?:\/\//i.test(page.canonical) : null,
        viewport: present('viewport') ? Boolean(page.viewport.trim()) : null,
        https: present('hasHttps') ? page.hasHttps === true : null
      };
      const operational = this.getAuditPageCopyRole(page) === 'operational';
      // Keep the URL and coverage visible, but do not score a utility as an SEO landing.
      if (operational) for (const key of ['title', 'metaDescription', 'h1', 'canonical']) values[key] = null;
      let pageEarned = 0, pageChecked = 0;
      for (const [key, value] of Object.entries(values)) {
        const status = value === null ? 'unknown' : value ? 'passed' : 'problem';
        metrics[key][status]++;
        if (status === 'problem') metrics[key].affectedUrls.push(page.url);
        if (value !== null) { checked += weights[key]; pageChecked += weights[key]; }
        if (value === true) { earned += weights[key]; pageEarned += weights[key]; }
      }
      return { url: page.url, title: page.title || '', readStatus, operational, contentSource: page.contentSource || 'legacy_dom',
        metrics: values, seoScore: pageChecked ? Math.round(pageEarned / pageChecked * 100) : null,
        checkedWeight: pageChecked, imageData: {
          totalImages: imageKnown ? imageData.totalImages : null,
          imagesWithoutAlt: imageKnown ? imageData.imagesWithoutAlt : null,
          emptyAlt: imageKnown ? Number(imageData.emptyAlt || 0) : null,
          decorativeImages: imageKnown ? Number(imageData.decorativeImages || 0) : null,
          unknownAlt: imageKnown ? Number(imageData.unknownAlt || 0) : null
        } };
    });
    const complete = pages.filter(page => page.readStatus === 'complete').length;
    return {
      pageCount: pages.length, pages, metrics, images, technicalScorePages: pages.filter(page => page.checkedWeight).length,
      contextOnlyPages: pages.length - complete,
      coverage: { reviewed: pages.length, complete, partial: pages.filter(page => page.readStatus === 'partial').length,
        insufficient: pages.filter(page => page.readStatus === 'insufficient').length, failed: pages.filter(page => page.readStatus === 'failed').length },
      checkedWeight: checked, possibleWeight: pages.length * 100,
      evidenceCoverage: pages.length ? Math.round(checked / pages.length) : 0,
      seoScoreAverage: checked ? Math.round(earned / checked * 100) : null,
      titlesCoverageCount: metrics.title.passed, missingMetaCount: pages.filter((p,i) => p.readStatus === 'complete' && !p.operational && unique[i].metaDescription === '').length,
      shortMetaCount: pages.filter((p,i) => p.readStatus === 'complete' && !p.operational && unique[i].metaDescription?.length > 0 && unique[i].metaDescription.length < 120).length,
      longMetaCount: pages.filter((p,i) => p.readStatus === 'complete' && !p.operational && unique[i].metaDescription?.length > 160).length,
      missingCanonicalCount: metrics.canonical.problem, missingH1Count: pages.filter((p,i) => p.readStatus === 'complete' && !p.operational && unique[i].h1Count === 0).length,
      multipleH1Count: pages.filter((p,i) => p.readStatus === 'complete' && !p.operational && unique[i].h1Count > 1).length,
      pagesWithImagesWithoutAlt: images.affectedUrls.length, totalImagesWithoutAlt: images.missing
    };
  }

  buildAuditTechnicalStatus(aggregate) {
    const label = (key, check) => {
      const item = aggregate.metrics[key];
      return check + ': ' + item.passed + ' cumplen, ' + item.problem + ' requieren revision, ' + item.unknown + ' sin comprobar, de ' + aggregate.pageCount + ' URL(s).'
        + (item.affectedUrls.length ? ' Revisar: ' + item.affectedUrls.join(', ') + '.' : '');
    };
    const images = aggregate.images;
    return {
      title: label('title', 'Titulo presente y unico'),
      metaDescription: label('metaDescription', 'Descripcion presente de 120-160 caracteres (referencia editorial, no requisito de Google)'),
      headings: label('h1', 'Un H1 por pagina'),
      images: images.total + ' imagenes en ' + images.knownPages + ' pagina(s) comprobadas: ' + images.missing + ' sin atributo ALT, '
        + images.empty + ' con ALT vacio (validar intencion decorativa), ' + images.decorative + ' decorativas declaradas, '
        + images.unknown + ' con ALT desconocido. ' + images.unknownPages + ' pagina(s) sin inventario comprobado.'
        + (images.affectedUrls.length ? ' Sin ALT: ' + images.affectedUrls.join(', ') + '.' : ''),
      technical: label('canonical', 'Canonical HTTP(S) detectada') + ' ' + label('viewport', 'Viewport detectado') + ' ' + label('https', 'HTTPS') +
        (aggregate.pages.some(page => page.operational) ? ' URLs operativas: ' + aggregate.pages.filter(page => page.operational).map(page => page.url).join(', ') +
          '. Título, meta, H1 y canonical quedan sin evaluar como landing SEO; reducen la cobertura, no cuentan como correctos. Verificar su finalidad y directivas antes de decidir su indexabilidad.' : '')
    };
  }

  buildAuditSchemaInsights(pageData = {}, internalPages = []) {
    const seen = new Set();
    const pages = [pageData, ...internalPages].filter(page => {
      if (!page.url || seen.has(page.url)) return false;
      seen.add(page.url); return true;
    }).map((page, index) => {
      const evidence = page.schemaEvidence;
      const complete = this.getAuditReadStatus(page, index === 0) === 'complete';
      if (!complete || !evidence) return { url: page.url, status: 'unknown', types: [], findings: [] };
      const entities = Array.isArray(evidence.entities) ? evidence.entities : [];
      const types = [...new Set(entities.flatMap(entity => entity.types || []))];
      const findings = (evidence.errors || []).map(error => ({ kind: evidence.limited ? 'check' : 'error', text: `JSON-LD, bloque ${error.block}: ${error.reason}` }));
      const visible = this.normalizeCompetitiveToken([page.title, page.metaDescription, page.fullText || page.textContent || page.content].filter(Boolean).join(' '));
      for (const entity of entities) {
        if (!entity.schemaContext) {
          findings.push({ kind: 'check', text: `${entity.types.join(', ')}: contexto Schema.org no confirmado; revisar @context antes de aplicar requisitos.` });
          continue;
        }
        const properties = entity.properties || [];
        const local = entity.types.some(type => /^(LocalBusiness|BeautySalon|HairSalon|BarberShop|HealthAndBeautyBusiness|Restaurant|Dentist|Store|Hotel)$/.test(type));
        const required = local ? ['name', 'address'] : entity.types.includes('Product') ? ['name'] : [];
        const missing = required.filter(key => !properties.includes(key));
        if (entity.types.includes('Product') && !['offers', 'review', 'aggregateRating'].some(key => properties.includes(key))) missing.push('offers o review o aggregateRating');
        if (missing.length) findings.push({ kind: 'check', text: `${entity.types.join(', ')}: no se observaron en este nodo propiedades básicas (${missing.join(', ')}) para la función enriquecida correspondiente. Resolver referencias y comprobar los requisitos completos.` });
        if (entity.types.includes('Organization') && !properties.includes('url')) findings.push({ kind: 'opportunity', text: 'Organization: valorar la propiedad recomendada url. Su ausencia no es un error de sintaxis ni un fallo SEO automático.' });
        if (entity.name && !visible.includes(this.normalizeCompetitiveToken(entity.name))) findings.push({ kind: 'check', text: `El nombre declarado "${entity.name}" no se encontró en la muestra de texto revisada. Validar su relación con el contenido; no demuestra una contradicción.` });
        if (entity.types.includes('LocalBusiness') && /peluqueria|barberia/.test(visible)) findings.push({ kind: 'opportunity', text: 'Si describe realmente un salón de peluquería, valorar el subtipo HairSalon en lugar de LocalBusiness genérico. Confirmar actividad antes de cambiarlo.' });
      }
      const otherFormats = [...(evidence.microdataTypes || []), ...(evidence.rdfaTypes || [])];
      if (otherFormats.length) findings.push({ kind: 'check', text: 'Hay Microdata o RDFa: tipos observados ' + [...new Set(otherFormats)].join(', ').slice(0, 180) + '. Se detectó su presencia; no se validaron sus propiedades.' });
      const status = evidence.limited ? 'limited' : evidence.scriptCount || otherFormats.length ? 'detected' : 'not_detected';
      return { url: page.url, status, types, parsed: evidence.parsed || 0, scriptCount: evidence.scriptCount || 0,
        source: evidence.source, findings: [...new Map(findings.map(item => [item.text, item])).values()].slice(0, 4) };
    });
    return { checked: pages.filter(page => page.status !== 'unknown').length, total: pages.length,
      unknown: pages.filter(page => page.status === 'unknown').length, pages,
      disclaimer: 'Revisión básica del marcado observado, no certificación de elegibilidad. Microdata/RDFa: solo detección. HTML sin marcado no descarta inserción posterior por JavaScript. No garantiza rankings, resultados enriquecidos ni aparición en respuestas de IA.' };
  }

  applyAuditEvidence(analysis, pageData, internalPages, acquisition = {}) {
    const aggregate = this.buildAggregateTechnicalContext(pageData, internalPages);
    analysis.aggregateTechnicalContext = aggregate;
    analysis.coverage = { ...aggregate.coverage, discovered: Number(acquisition.discovered ?? Math.max(0, aggregate.pageCount - 1)) + 1,
      attempted: Number(acquisition.attempted ?? Math.max(0, aggregate.pageCount - 1)) + 1 };
    analysis.coverage.repeatedDestinations = Math.max(0, analysis.coverage.attempted - aggregate.pageCount);
    analysis.technicalStatus = this.buildAuditTechnicalStatus(aggregate);
    analysis.seoScore = aggregate.seoScoreAverage;
    analysis.scoreCoverage = aggregate.evidenceCoverage;
    analysis.analyzedPages = this.buildAnalyzedPages(pageData, internalPages, aggregate.pageCount);
    analysis.schemaInsights = this.buildAuditSchemaInsights(pageData, internalPages);
    return analysis;
  }

  async analyzeSEO(pageData, onProgress = null) {
    // A UI observer must never interrupt or change the audit result.
    const notifyProgress = (phase) => {
      try { if (typeof onProgress === 'function') onProgress(phase); } catch (_) {}
    };
    const systemPrompt = `Eres un auditor SEO profesional y estratega de crecimiento. Analiza los datos de la pagina web y genera un informe claro, accionable, facil de entender y orientado a negocio.

REGLAS:
- Responde SOLO en JSON valido, sin texto adicional
- La salida completa debe caber en 1600 tokens: cierra todos los objetos y listas. Prioriza evidencia, URL y accion sobre explicaciones repetidas.
- Se breve, concreto y profesional: una oracion por campo, salvo el resumen ejecutivo (dos).
- Enfocate en problemas reales, impacto real y acciones concretas
- Explica la evidencia, la URL afectada, la accion y por que merece esa prioridad. Separa hechos observados de beneficios esperados y pruebas propuestas.
- Si el mismo problema aparece en varias paginas del conjunto auditado, interpretalo como patron y reflejalo en la prioridad.
- USA el puntaje SEO que se te proporciona, NO calcules uno nuevo
- No concentres todo en H1 y meta descripciones: mezcla SEO tecnico, claridad del hero, confianza, CTA, arquitectura, contenido, velocidad y conversion cuando existan señales.
- No uses porcentajes exactos de mejora o perdida (ej: 20%, 15%) salvo que el dato venga medido en el contexto. Usa "Impacto esperado: alto/medio/bajo" y "Confianza: alta/media/exploratoria".
- Analiza SOLO contenido visible de la pagina
- Trabaja SOLO con datos reales entregados en el contexto, contenido visible y señales por pagina
- Los estados partial/insufficient/failed no prueban ausencia de elementos. No los cuentes como comprobados. Usa las métricas agregadas y su cobertura.
- estimatedSize es memoria RGB estimada, NO peso descargado. Solo measuredBytes permite afirmar un peso. No deduzcas lentitud de dimensiones.
- No inventes problemas, CTAs, paginas, servicios, ubicaciones, errores tecnicos ni oportunidades no respaldadas por los datos
- Si falta evidencia, no lo conviertas en hallazgo fuerte; dejalo fuera o formula una nota secundaria como "conviene validar"
- Ignora HTML, scripts, codigo JavaScript, atributos y nombres tecnicos del DOM
- NO uses como keywords palabras como: this, function, return, params, const, let, var
- El informe debe ser entendible para una persona no tecnica y util para un profesional SEO
- Si usas un termino tecnico, explicalo de forma breve y natural
- Evita frases vacias como "mejorar SEO", "optimizar contenido" o "revisar estrategia"
- Evita frases neutras o debiles como "se recomienda", "se detecto", "puede" o "podria" en hallazgos confirmados
- No afirmes perdida de CTR, ventas, trafico o conversiones sin metricas. Explica efectos verificables sobre estructura, accesibilidad o claridad; presenta el resultado comercial como una hipotesis a medir.
- No impongas recomendaciones de CTA, ubicacion o enlaces si los datos ya muestran esos elementos. Identifica el elemento concreto que cambiarias, o conservalo.
- Una palabra clave sugerida no tiene volumen ni dificultad medidos. Relacionala con el servicio y la pagina observados; no prometas demanda.
- El resumen ejecutivo debe responder en 2-3 oraciones: que esta bien, que problema esta comprobado y cual es la accion prioritaria. Si no hay un bloqueo demostrado, no lo inventes.
- Cada recomendacion debe dejar claro:
  1. Problema: que esta mal de forma clara
  2. Impacto: efecto verificable sobre estructura, accesibilidad o claridad; separar hipotesis comerciales de resultados medidos
  3. Accion: que hacer exactamente, sin ambiguedad

Responde con esta estructura JSON:
{
  "seoScore": <numero proporcionado>,
  "domain": "dominio del sitio",
  "summary": "Dos oraciones: fortaleza observada, problema comprobado y acción prioritaria.",
  "technicalStatus": {
    "title": "Estado general de los títulos en el conjunto auditado: qué funciona, qué limita clics y acción concreta",
    "metaDescription": "Estado general de las meta descripciones en el conjunto auditado: impacto en clics desde Google y acción concreta",
    "headings": "Estado general de los encabezados H1/H2 en el conjunto auditado: impacto en comprensión de Google y acción concreta",
    "images": "Estado general de imágenes y alt text en el conjunto auditado: impacto en accesibilidad, contexto SEO o velocidad y acción concreta",
    "technical": "Estado técnico general del conjunto auditado (HTTPS, viewport, canonical y consistencia técnica): impacto real y acción concreta"
  },
  "topIssues": [
    "Problema: ... Impacto: ... Acción: ...",
    "Problema: ... Impacto: ... Acción: ..."
  ],
  "recommendations": [
    {"action": "URL o evidencia y cambio concreto", "priority": "alta", "impact": "Efecto comprobable y motivo de prioridad"},
    {"action": "URL o evidencia y cambio concreto", "priority": "media", "impact": "Efecto comprobable y motivo de prioridad"},
    {"action": "URL o evidencia y cambio concreto", "priority": "baja", "impact": "Efecto comprobable y motivo de prioridad"}
  ],
  "keywords": {
    "primary": ["palabra clave 1", "palabra clave 2"],
    "longTail": ["frase larga 1", "frase larga 2"],
    "local": ["termino local 1"]
  },
  "quickWins": "Acciones justificadas en orden de prioridad, sin calendario inventado"
}`;

    notifyProgress('pages');
    const auditScope = await this.resolveAuditScope(pageData);
    const internalPagesResult = await this.fetchInternalPagesContext(pageData, auditScope);
    const freePreviewPagesResult = await this.fetchFreePreviewPagesContext(pageData, auditScope);
    const contextualPagesForSignals = auditScope.plan === 'free'
      ? (freePreviewPagesResult.pages || [])
      : (internalPagesResult.pages || []);
    const combinedContext = this.buildSiteContext(pageData, internalPagesResult.pages || []);

    const aggregateTechnicalContext = this.buildAggregateTechnicalContext(pageData, internalPagesResult.pages || []);
    const expandedTechnicalContext = auditScope.plan === 'free'
      ? this.buildAggregateTechnicalContext(pageData, contextualPagesForSignals)
      : aggregateTechnicalContext;

    const essentialData = {
      seoScore: aggregateTechnicalContext.seoScoreAverage,
      url: pageData.url,
      domain: pageData.domain || (pageData.url ? new URL(pageData.url).hostname : 'desconocido'),
      title: pageData.title,
      titleLength: typeof pageData.title === 'string' ? pageData.title.length : null,
      metaDescription: pageData.metaDescription,
      metaDescriptionLength: typeof pageData.metaDescription === 'string' ? pageData.metaDescription.length : null,
      h1Count: pageData.h1Count ?? null,
      h1s: (pageData.h1s || []).slice(0, 3),
      totalImages: pageData.totalImages ?? null,
      imagesWithoutAlt: pageData.imagesWithoutAlt ?? null,
      wordCount: pageData.wordCount ?? null,
      hasHttps: pageData.hasHttps ?? null,
      viewport: pageData.viewport ?? null,
      lang: pageData.lang || '',
      canonical: pageData.canonical ?? null,
      seoStructure: this.compactSeoStructure(pageData),
      analyzedPages: aggregateTechnicalContext.pages.filter(page => page.readStatus === 'complete').map(page => page.url),
      reviewedPages: aggregateTechnicalContext.pages.map(page => ({ url: page.url, readStatus: page.readStatus })),
      plan: auditScope.plan,
      totalPagesTarget: auditScope.totalPages,
      internalPagesTarget: auditScope.internalPages,
      manualSelectionEnabled: auditScope.allowsManualSelection,
      manualSelectionUsed: this.normalizeManualInternalSelection(pageData, auditScope.internalPages).length > 0,
      internalPagesLoaded: (internalPagesResult.pages || []).filter(page => this.getAuditReadStatus(page) === 'complete').length,
      previewPagesLoaded: (freePreviewPagesResult.pages || []).length,
      internalPagesErrors: (internalPagesResult.errors || []).length,
      aggregateTechnicalContext,
      expandedTechnicalContext
    };

    const pageSignals = {
      currentPageCtas: this.selectAuditCommercialCtas(pageData.ctaData),
      currentPageSeoStructure: this.compactSeoStructure(pageData),
      internalPageCtas: contextualPagesForSignals.map((page) => ({
        url: page.url,
        ctas: this.selectAuditCommercialCtas(page.ctaData)
      })),
      internalPageSeoStructures: contextualPagesForSignals.slice(0, 5).map((page) => ({
        url: page.url,
        title: page.title || '',
        seoStructure: this.compactSeoStructure(page)
      })),
      localSeoContext: {
        hasAddress: Array.isArray(pageData.contactInfo?.address) && pageData.contactInfo.address.length > 0,
        hasPhone: Array.isArray(pageData.contactInfo?.phone) && pageData.contactInfo.phone.length > 0,
        geolocationKeywords: Array.isArray(pageData.contactInfo?.geolocationKeywords) ? pageData.contactInfo.geolocationKeywords.slice(0, 6) : [],
        schemaTypes: Array.isArray(pageData.schemaData)
          ? JSON.stringify(pageData.schemaData).match(/LocalBusiness|Barbershop|BeautySalon|HairSalon|HealthAndBeautyBusiness|Store/gi) || []
          : []
      },
      pageSpecificFindingsPreview: this.buildPageSpecificFindings(pageData, contextualPagesForSignals)
        .slice(0, 7)
        .map((finding) => ({
          page: finding.label || finding.type,
          url: finding.url,
          issue: finding.issue,
          recommendation: finding.recommendation
        }))
    };

    const scopeRule = auditScope.internalPages > 0
      ? `- Analiza la landing principal y hasta ${auditScope.internalPages} paginas internas relevantes del mismo dominio.`
      : '- Analiza solo la landing principal con el contenido visible disponible.';

    const freeSaasConversionRule = auditScope.plan === 'free'
      ? `- Este es el PDF gratuito del SaaS: entrega valor real sobre la pagina actual y, solo cuando sea natural, menciona que analizar mas paginas puede revelar patrones del sitio con mayor claridad.
- No lo presentes como bloqueo ni como informacion oculta. El usuario debe sentir que el analisis gratuito ya es util, pero que Zentra AI puede dar una vision mas completa con uso continuo.
- Si mencionas oportunidades adicionales, hazlo como posibilidad basada en el contexto disponible, nunca como hecho no confirmado.`
      : '';

    const userMessage = `Analiza esta pagina web para SEO.

URL PRINCIPAL: ${pageData.url}
PUNTAJE SEO PRINCIPAL CON SEÑALES TÉCNICAS CONFIABLES: ${aggregateTechnicalContext.seoScoreAverage}/100 (usa este puntaje exacto)

REGLA:
${scopeRule}
- Si alguna pagina interna falla, continua con las disponibles.
- Las paginas internas con contexto parcial sirven para detectar patrones, contenido y competencia, pero no deben bajar el puntaje tecnico si no hay lectura DOM confiable.
- Basa keywords y recomendaciones SOLO en el contenido visible consolidado.
- Ignora codigo, scripts y terminos tecnicos.
- No cambies la estructura del JSON.
- No inventes nada. Si una observacion no esta respaldada por CONTEXTO CONSOLIDADO, DATOS o SENALES POR PAGINA, no la afirmes como hecho.
- Si algo no esta confirmado, no lo conviertas en recomendacion principal; dejalo como "conviene validar" solo si aporta contexto.
- Haz que las recomendaciones tengan valor de informe profesional premium: claras, utiles, listas para ejecutar y conectadas a impacto de negocio.
- En cada recomendacion explica tambien por que esa accion es prioritaria frente a otras cuando el contexto lo permita.
- Si un problema se repite en varias paginas, reflejalo como patron del sitio y eleva su prioridad interpretativa.
- Mantiene una experiencia util y completa para el usuario, sin sonar a venta agresiva.
${freeSaasConversionRule}
- Evita sonar generico. Cada hallazgo confirmado debe explicar que se esta perdiendo: clics, visibilidad, confianza, clientes o conversiones.
- Escribe directo y orientado a accion. Evita "puede", "podria", "se recomienda" y "se detecto" en recomendaciones confirmadas.
- Cada recomendacion debe seguir esta logica: Problema: que esta mal. Impacto: que se pierde. Accion: que hacer exactamente.
- El resumen inicial debe decir que esta bien, que esta frenando resultados y cual es la accion mas urgente.
- En quickWins ordena solo acciones justificadas, sin semanas ni plazos inventados. Indica motivo, evidencia, dependencia y como verificar cada cambio; no rellenes hasta una cantidad minima.
- Identifica primero actividad principal, servicios secundarios, alcance y objetivo observable. Si no se puede confirmar, declara la hipotesis. No sustituyas el rubro principal por servicios secundarios.
- Compara elementos equivalentes. Controles de cookies, navegacion auxiliar y enlaces sociales no son por si solos CTAs comerciales. Un titulo institucional no es una propuesta de valor.
- Distingue observacion, interpretacion y resultado pendiente de medir. No deduzcas techo SEO, mayor retorno, ranking, ventas o rendimiento comercial de un puntaje tecnico ni de la presencia de etiquetas.
- No afirmes que una pagina no tiene llamado a la accion si se detectan CTA visibles en las senales entregadas.
- Si el CTA existe pero es generico, explica que puede ser mas especifico o visible en lugar de decir que no existe.
- Si hablas de meta descripciones o CTA, intenta anclar la observacion a paginas concretas cuando las senales por pagina lo permitan.
	- Si detectas señales claras de negocio local, fisico o service-area, incorpora recomendaciones de SEO local de forma explicita.
	- Si el sitio parece SaaS, software, app, plataforma digital, extension o producto vendible globalmente, NO generes keywords locales ni recomendaciones de ubicacion salvo que el contenido visible lo pida claramente.
- No conviertas "pricing", "plan" o "precios" en propuesta de copy para la home salvo que la URL analizada sea realmente una pagina de precios.
- Antes de proponer ejemplos de copy, usa el tipo real de pagina, URL, entidades visibles y CTA detectados. Prohibido reutilizar una propuesta generica si no encaja con esa URL.
- No uses porcentajes estimados de mejora. Usa impacto esperado y confianza.
- En "technicalStatus" habla del conjunto auditado, no de una sola URL.
- Si varias paginas comparten un problema tecnico, expresalo en plural y como patron general.
- Si una observacion afecta a una URL concreta, puedes mencionarla como ejemplo dentro del panorama general.

CONTEXTO CONSOLIDADO DEL SITIO:
${combinedContext}

DATOS:
${this.serializeAuditPromptData(essentialData)}

SENALES POR PAGINA:
${this.serializeAuditPromptData(pageSignals)}

Genera el informe SEO en JSON.`;

    try {
      notifyProgress('structure');
      const extractionStartedAt = Date.now();
      const result = await this.callAPI([
        { role: 'user', content: userMessage }
      ], {
        system: systemPrompt,
        maxTokens: 2048,
        temperature: 0.3,
        jsonMode: true,
        taskType: 'seo_analysis',
        timeoutMs: Math.min(180000, 90000 + (Number(auditScope.totalPages || 1) * 8000))
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      const extractionUsage = this.normalizeUsage(result.usage);
      const extractionModel = result.actualModel || result.model || this.model;
      const extractionPromptChars = String(systemPrompt || '').length + String(userMessage || '').length;
      const extractionLatency = Date.now() - extractionStartedAt;

      const inspected = this.inspectSEOConsultative(result.content);
      const consultativeMeta = result.rawResponse?.audit_consultative;
      const consultativeDegraded = !inspected.analysis || consultativeMeta?.status === 'consultative-degraded';
      this.recordSEOConsultativeDiagnostic(this.createSEOConsultativeDiagnostic(
        result.content, inspected, consultativeMeta?.finishReason, consultativeMeta
      ));
      let analysis = consultativeDegraded
        ? this.generateFallbackAnalysis(pageData, internalPagesResult.pages || [])
        : inspected.analysis;
      analysis.consultativeStatus = consultativeDegraded ? 'consultative-degraded'
        : (consultativeMeta?.status === 'recovered' || inspected.attempts.length > 1 ? 'recovered' : 'complete');
      if (consultativeDegraded) {
        analysis.keywords = { primary: [], longTail: [], local: [] };
        analysis.keywordEvidence = [];
        analysis.keywordStatus = 'insufficient_evidence';
      }

      const calculatedScore = aggregateTechnicalContext.seoScoreAverage;
      analysis = analysis || {};
      analysis = this.applyAuditEvidence(analysis, pageData, internalPagesResult.pages || [], internalPagesResult.acquisition);

      analysis.summary = this.normalizeSeoSummaryText(
        analysis.summary || `El sitio ${essentialData.domain} ya cuenta con una base SEO medible, pero la lectura SEO técnica se ubica en ${calculatedScore}/100 y todavía muestra oportunidades para ganar visibilidad y convertir mejor. La mayor oportunidad está en corregir primero los elementos que pueden limitar clics desde Google y claridad para el usuario.`,
        calculatedScore
      );
      analysis.quickWins = this.normalizeQuickWinsField(analysis.quickWins) || '';
      analysis.topIssues = Array.isArray(analysis.topIssues) ? analysis.topIssues : [];
      analysis.technicalStatus = analysis.technicalStatus || {};
      analysis.keywords = analysis.keywords || { primary: [], longTail: [], local: [] };
      analysis.keywords.primary = Array.isArray(analysis.keywords.primary) ? analysis.keywords.primary : [];
      analysis.keywords.longTail = Array.isArray(analysis.keywords.longTail) ? analysis.keywords.longTail : [];
      analysis.keywords.local = Array.isArray(analysis.keywords.local) ? analysis.keywords.local : [];
      analysis.recommendations = (analysis.recommendations || []).map((r) => {
        if (typeof r === 'string') {
          return {
            action: this.normalizeVisibleSpanishText(r),
            impact: this.normalizeVisibleSpanishText('Corregir este punto aumenta claridad, visibilidad y oportunidades de conversión frente a usuarios que ya llegaron al sitio.'),
            priority: 'media'
          };
        }
        return {
          action: this.normalizeVisibleSpanishText(r?.action || ''),
          impact: this.normalizeVisibleSpanishText(r?.impact || 'Corregir este punto aumenta claridad, visibilidad y oportunidades de conversión frente a usuarios que ya llegaron al sitio.'),
          priority: r?.priority || 'media'
        };
      });
      analysis.analyzedPages = this.buildAnalyzedPages(pageData, internalPagesResult.pages || [], auditScope.totalPages);
      analysis.pageSpecificFindingsRaw = this.buildPageSpecificFindings(pageData, internalPagesResult.pages || []);
      analysis.pagePatternSummary = this.compressRepeatedPageFindings(
        analysis.pageSpecificFindingsRaw,
        analysis.analyzedPages.length
      ).filter((finding) => finding?.type === 'Patron multipagina');
      analysis.pageSpecificFindings = analysis.pageSpecificFindingsRaw;
      analysis.heavyImagesInsights = this.buildHeavyImagesInsights(pageData, internalPagesResult.pages || []);
	      if (!consultativeDegraded) analysis = this.ensureSeoKeywordSuggestions(
	        analysis,
	        pageData,
	        auditScope,
	        analysis.analyzedPages
	      );
		      analysis.interlinkingInsights = this.buildInterlinkingInsights(
	        pageData,
	        internalPagesResult.pages || [],
	        analysis.analyzedPages
	      );
	      analysis = this.sanitizeLocalKeywordsForGlobalContext(
	        analysis,
	        pageData,
	        auditScope,
	        analysis.analyzedPages
	      );
	      notifyProgress('competition');
	      analysis.competitiveSnapshot = consultativeDegraded ? {
            searchStatus: 'no_disponible', searchError: 'consultative_degraded', competitors: []
          } : await this.buildCompetitiveSnapshot(
	        analysis,
	        pageData,
	        auditScope,
	        analysis.analyzedPages
	      );
	      analysis.competitiveSnapshot = this.enforceCompetitiveSnapshotGuardrails(analysis.competitiveSnapshot);
	      analysis.opportunityDetected = this.buildOpportunityDetected(analysis);
      analysis.quickWins = this.buildWeeklyActionPlan(analysis.quickWins, analysis.recommendations);
      analysis = this.enrichBusinessImpactLanguage(analysis);
      analysis = this.alignNarrativeWithScore(analysis);

      if (auditScope.plan === 'free') {
        const previewAnalyzedPages = this.buildAnalyzedPages(pageData, contextualPagesForSignals, 5);
        analysis.freeExpandedContext = {
          seoScoreAverage: expandedTechnicalContext.seoScoreAverage,
          pagesObserved: previewAnalyzedPages.length,
          pageLabels: previewAnalyzedPages.map((page) => page.label || page.type || 'Página clave'),
          technicalSignals: expandedTechnicalContext,
          interlinkingInsights: this.buildInterlinkingInsights(pageData, contextualPagesForSignals, previewAnalyzedPages).slice(0, 2),
          pageSpecificFindings: this.buildPageSpecificFindings(pageData, contextualPagesForSignals).slice(0, 3),
          heavyImagesInsights: this.buildHeavyImagesInsights(pageData, contextualPagesForSignals)
        };
      }

      const extractionLayer = {
        model: extractionModel,
        requestedModel: result.requestedModel || extractionModel,
        actualModel: result.actualModel || extractionModel,
        modelMismatch: Boolean(result.modelMismatch),
        transportFallbackUsed: Boolean(result.transportFallbackUsed),
        inputTokens: extractionUsage.inputTokens,
        outputTokens: extractionUsage.outputTokens,
        totalTokens: extractionUsage.totalTokens,
        latencyMs: extractionLatency,
        estimatedCost: this.estimateCostUsd({
          model: extractionModel,
          inputTokens: extractionUsage.inputTokens,
          outputTokens: extractionUsage.outputTokens
        }),
        promptChars: extractionPromptChars,
        contextChars: String(JSON.stringify({
          essentialData,
          pageSignals
        })).length
      };

      var reasoningLayer = null;
      const premiumReasoning = !consultativeDegraded;
      if (premiumReasoning) {
        notifyProgress('recommendations');
        const reasoningStartedAt = Date.now();
        const safeTopIssues = this.ensureArray(analysis.topIssues);
        const safeRecommendations = this.ensureArray(analysis.recommendations);
        const safePageSpecificFindings = this.ensureArray(analysis.pageSpecificFindings);
        const safeInterlinkingInsights = this.ensureArray(analysis.interlinkingInsights);
        const safeHeavyImagesInsights = this.ensureArray(analysis.heavyImagesInsights, 'pages');

        const reducedContext = {
          seoScore: analysis.seoScore,
          domain: essentialData.domain,
          plan: auditScope.plan,
          topIssues: safeTopIssues.slice(0, 5),
          recommendations: safeRecommendations.slice(0, 6),
          quickWins: analysis.quickWins || '',
          summary: analysis.summary || '',
          pageSpecificFindings: safePageSpecificFindings.slice(0, 8),
          interlinkingInsights: safeInterlinkingInsights.slice(0, 5),
          heavyImagesInsights: safeHeavyImagesInsights.slice(0, 5),
          heavyImagesSummary: analysis.heavyImagesInsights && typeof analysis.heavyImagesInsights === 'object'
            ? {
                totalHeavyImages: Number(analysis.heavyImagesInsights.totalHeavyImages || 0),
                totalPagesWithHeavyImages: Number(analysis.heavyImagesInsights.totalPagesWithHeavyImages || 0)
              }
            : null,
          aggregateTechnicalContext: aggregateTechnicalContext
        };

        const reasoningSystem = `Eres un estratega SEO ejecutivo. Recibes contexto reducido estructurado (sin HTML/DOM). Priorizas por impacto de negocio y evidencia. No conviertas unknown o lectura parcial en comprobaciones positivas ni en problemas confirmados. estimatedSize es memoria RGB, no peso descargado: solo measuredBytes mide bytes. No deduzcas lentitud ni ausencia de elementos sin evidencia. Responde SOLO en JSON.`;
        const reasoningUser = `Refina estrategicamente este analisis SEO con razonamiento premium.

CONTEXTO REDUCIDO:
${this.serializeAuditPromptData(reducedContext)}

Devuelve:
{
  "summary": "Resumen ejecutivo mas fuerte y accionable",
  "quickWins": "2-4 acciones ordenadas por impacto",
  "topIssues": ["..."],
  "recommendations": [{"action":"...","priority":"alta|media|baja","impact":"..."}]
}`;

        const reasoningResult = await this.callAPI(
          [{ role: 'user', content: reasoningUser }],
          {
            system: reasoningSystem,
            maxTokens: 1700,
            temperature: 0.3,
            jsonMode: true,
            taskType: 'premium_reasoning_audit',
            forceModel: this.labReasoningModel,
            timeoutMs: 150000
          }
        );

        const reasoningUsage = this.normalizeUsage(reasoningResult?.usage || null);
        const reasoningSuccess = Boolean(reasoningResult?.success);
        reasoningLayer = {
          success: reasoningSuccess,
          error: reasoningSuccess ? null : (reasoningResult?.error || 'unknown_reasoning_error'),
          routingReason: reasoningResult?.routing?.reason || null,
          routingFallbackError: reasoningResult?.routing?.premiumFallbackError || null,
          routingTaskType: reasoningResult?.routing?.taskType || null,
          routingModel: reasoningResult?.routing?.model || null,
          routingPremiumActive: Boolean(reasoningResult?.routing?.premiumActive),
          model: reasoningResult?.actualModel || reasoningResult?.model || this.labReasoningModel,
          requestedModel: reasoningResult?.requestedModel || this.labReasoningModel,
          actualModel: reasoningResult?.actualModel || reasoningResult?.model || this.labReasoningModel,
          modelMismatch: Boolean(reasoningResult?.modelMismatch),
          transportFallbackUsed: Boolean(reasoningResult?.transportFallbackUsed),
          inputTokens: reasoningUsage.inputTokens,
          outputTokens: reasoningUsage.outputTokens,
          totalTokens: reasoningUsage.totalTokens,
          latencyMs: Date.now() - reasoningStartedAt,
          estimatedCost: this.estimateCostUsd({
            model: reasoningResult?.model || this.labReasoningModel,
            inputTokens: reasoningUsage.inputTokens,
            outputTokens: reasoningUsage.outputTokens
          }),
          promptChars: String(reasoningSystem || '').length + String(reasoningUser || '').length
        };

        if (reasoningSuccess) {
          try {
            const refined = this.parseSEOAnalysis(reasoningResult.content);
            analysis.summary = refined.summary || analysis.summary;
            analysis.quickWins = this.normalizeQuickWinsField(refined.quickWins) || analysis.quickWins;
            analysis.topIssues = Array.isArray(refined.topIssues) && refined.topIssues.length ? refined.topIssues : analysis.topIssues;
            analysis.recommendations = Array.isArray(refined.recommendations) && refined.recommendations.length ? refined.recommendations : analysis.recommendations;
          } catch (_) {}
        } else {
          this.debugLog('log',
            `Premium reasoning layer no aplicada. Se mantiene analisis base. ` +
            `error=${reasoningLayer.error || 'unknown'} ` +
            `routingReason=${reasoningLayer.routingReason || 'none'} ` +
            `routingTaskType=${reasoningLayer.routingTaskType || 'none'} ` +
            `routingModel=${reasoningLayer.routingModel || 'none'} ` +
            `premium=${reasoningLayer.routingPremiumActive ? 'true' : 'false'}`
          );
        }
      }

      analysis.quickWins = this.buildWeeklyActionPlan(this.normalizeQuickWinsField(analysis.quickWins), analysis.recommendations);
      analysis = this.enrichBusinessImpactLanguage(analysis);
      analysis = this.alignNarrativeWithScore(analysis);

      let executiveRefinerLayer = null;
      const executiveRefinerEligible = !consultativeDegraded && this.labExecutiveRefinerEnabled && ['pro', 'agency'].includes(String(auditScope.plan || '').toLowerCase());
      if (executiveRefinerEligible && (reasoningLayer?.success ?? true)) {
        notifyProgress('refinement');
        const executiveRefinerResult = await this.refineExecutivePdfBlocks({
          analysis,
          reasoningLayer,
          auditScope,
          essentialData,
          pageData
        });
        executiveRefinerLayer = executiveRefinerResult?.layer || null;

        if (executiveRefinerResult?.success && executiveRefinerResult?.refined) {
          analysis.summary = executiveRefinerResult.refined.summary || analysis.summary;
          if (executiveRefinerResult.refined.opportunityDetected && typeof executiveRefinerResult.refined.opportunityDetected === 'object') {
            analysis.opportunityDetected = {
              ...analysis.opportunityDetected,
              ...executiveRefinerResult.refined.opportunityDetected
            };
          }
	          if (executiveRefinerResult.refined.competitiveSnapshot && typeof executiveRefinerResult.refined.competitiveSnapshot === 'object') {
	            const refinedCompetitive = executiveRefinerResult.refined.competitiveSnapshot;
	            analysis.competitiveSnapshot = {
	              ...analysis.competitiveSnapshot,
	              signalLevel: refinedCompetitive.signalLevel || analysis.competitiveSnapshot?.signalLevel,
	              benchmarkStatus: refinedCompetitive.benchmarkStatus || analysis.competitiveSnapshot?.benchmarkStatus,
	              dominantProfile: refinedCompetitive.dominantProfile || analysis.competitiveSnapshot?.dominantProfile,
	              gapToOutperform: refinedCompetitive.gapToOutperform || analysis.competitiveSnapshot?.gapToOutperform,
	              siteSpecificObservation: refinedCompetitive.siteSpecificObservation || analysis.competitiveSnapshot?.siteSpecificObservation,
	              priorityActions: Array.isArray(refinedCompetitive.priorityActions)
	                ? refinedCompetitive.priorityActions
	                : analysis.competitiveSnapshot?.priorityActions,
	              disclaimer: refinedCompetitive.disclaimer || analysis.competitiveSnapshot?.disclaimer
	            };
	            analysis.competitiveSnapshot = this.enforceCompetitiveSnapshotGuardrails(analysis.competitiveSnapshot);
	          }
          analysis.quickWins = executiveRefinerResult.refined.quickWins || analysis.quickWins;
        } else if (executiveRefinerLayer) {
          this.debugLog('log',
            `Executive refiner PDF no aplicada. Se mantiene analisis actual. ` +
            `error=${executiveRefinerLayer.error || 'unknown'} ` +
            `routingReason=${executiveRefinerLayer.routingReason || 'none'} ` +
            `routingTaskType=${executiveRefinerLayer.routingTaskType || 'none'} ` +
            `routingModel=${executiveRefinerLayer.routingModel || 'none'} ` +
            `premium=${executiveRefinerLayer.routingPremiumActive ? 'true' : 'false'}`
          );
        }
      }

      analysis = this.normalizeSeoPdfQuality(analysis, {
        aggregateTechnicalContext,
        pageData,
        auditScope
      });
      analysis = this.applyAuditEvidence(analysis, pageData, internalPagesResult.pages || [], internalPagesResult.acquisition);

      const sample = {
        taskType: 'seo_audit',
        contextScope: 'seo',
        compareMode: false,
        snapshotCount: 0,
        memoryInjected: false,
        premiumReasoning,
        requestedModel: extractionLayer.requestedModel,
        actualModel: extractionLayer.actualModel,
        modelMismatch: extractionLayer.modelMismatch,
        transportFallbackUsed: extractionLayer.transportFallbackUsed,
        extraction: extractionLayer,
        reasoning: reasoningLayer,
        model: extractionLayer.model,
        inputTokens: extractionLayer.inputTokens,
        outputTokens: extractionLayer.outputTokens,
        totalTokens: extractionLayer.totalTokens,
        latencyMs: extractionLayer.latencyMs,
        estimatedCost: extractionLayer.estimatedCost,
        promptChars: extractionLayer.promptChars,
        contextChars: extractionLayer.contextChars,
        reasoningModel: reasoningLayer?.model || null,
        reasoningSuccess: reasoningLayer?.success ?? null,
        reasoningError: reasoningLayer?.error ?? null,
        reasoningRouteReason: reasoningLayer?.routingReason ?? null,
        reasoningRouteFallbackError: reasoningLayer?.routingFallbackError ?? null,
        reasoningInputTokens: reasoningLayer?.inputTokens ?? null,
        reasoningOutputTokens: reasoningLayer?.outputTokens ?? null,
        reasoningLatency: reasoningLayer?.latencyMs ?? null,
        reasoningEstimatedCost: reasoningLayer?.estimatedCost ?? null,
        reasoningPromptChars: reasoningLayer?.promptChars ?? null,
        executiveRefiner: executiveRefinerLayer,
        executiveRefinerEnabled: Boolean(this.labExecutiveRefinerEnabled),
        executiveRefinerRequestedModel: executiveRefinerLayer?.requestedModel || null,
        executiveRefinerActualModel: executiveRefinerLayer?.actualModel || null,
        executiveRefinerInputTokens: executiveRefinerLayer?.inputTokens ?? null,
        executiveRefinerOutputTokens: executiveRefinerLayer?.outputTokens ?? null,
        executiveRefinerEstimatedCost: executiveRefinerLayer?.estimatedCost ?? null,
        executiveRefinerLatency: executiveRefinerLayer?.latencyMs ?? null,
        executiveRefinerSuccess: executiveRefinerLayer?.success ?? null,
        executiveRefinerError: executiveRefinerLayer?.error || null,
        executiveRefinerRoutingReason: executiveRefinerLayer?.routingReason || null,
        executiveRefinerRoutingFallbackError: executiveRefinerLayer?.routingFallbackError || null,
        executiveRefinerRoutingTaskType: executiveRefinerLayer?.routingTaskType || null,
        executiveRefinerRoutingModel: executiveRefinerLayer?.routingModel || null,
        executiveRefinerRoutingPremiumActive: executiveRefinerLayer?.routingPremiumActive ?? null
      };
      this.recordLabAuditSample(sample);

      return {
        success: true,
        analysis: analysis,
        usage: result.usage,
        experiment: sample
      };

    } catch (error) {
      this.debugLog('warn', `Error en analisis SEO. Se devuelve fallback. ${error?.message || error || ''}`.trim());
      if (['execution_uncertain', 'execution_pending'].includes(error.code)) throw error;
      return {
        success: false,
        error: error.message,
        fallback: this.applyAuditEvidence(this.generateFallbackAnalysis(pageData, internalPagesResult.pages || []), pageData, internalPagesResult.pages || [], internalPagesResult.acquisition)
      };
    }
  }

  inspectSEOConsultative(content) {
    const attempts = [];
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    const missingFields = value => {
      if (!object(value)) return ['object'];
      const missing = [];
      if (typeof value.summary !== 'string' || !value.summary.trim()) missing.push('summary');
      if (!Array.isArray(value.topIssues) || value.topIssues.some(item => typeof item !== 'string')) missing.push('topIssues');
      if (!Array.isArray(value.recommendations) || value.recommendations.some(item =>
        !object(item) || typeof item.action !== 'string' || !item.action.trim())) missing.push('recommendations');
      if (!object(value.keywords) || ['primary', 'longTail', 'local'].some(key =>
        !Array.isArray(value.keywords[key]) || value.keywords[key].some(item => typeof item !== 'string'))) missing.push('keywords');
      return missing;
    };
    let lastMissing = ['object'];
    const accept = (value, stage) => {
      if (object(value) && !value.summary) {
        for (const key of ['analysis', 'response', 'result']) {
          if (object(value[key]) && value[key].summary) { value = value[key]; stage += ':envelope'; break; }
        }
      }
      lastMissing = missingFields(value);
      attempts.push({ stage, valid: !lastMissing.length, missingFields: lastMissing });
      return !lastMissing.length ? value : null;
    };
    if (object(content)) {
      const analysis = accept(content, 'object');
      return { analysis, attempts, missingFields: lastMissing, truncated: false };
    }
    if (Array.isArray(content)) content = content.filter(item => ['text', 'output_text'].includes(item?.type))
      .map(item => typeof item.text === 'string' ? item.text : '').join('\n');
    const raw = typeof content === 'string' ? content.trim() : '';
    if (raw.length > 1048576) return { analysis: null, attempts: [{ stage: 'size', valid: false, error: 'response_too_large' }], missingFields: lastMissing, truncated: false };
    const parse = (text, stage) => {
      try { return accept(JSON.parse(text), stage); }
      catch (error) {
        const message = String(error.message);
        const position = message.match(/position (\d+)/)?.[1];
        // Native errors can quote response values. Store a safe category and position.
        const category = /unterminated/i.test(message) ? 'unterminated_string'
          : /end of JSON/i.test(message) ? 'unexpected_end'
          : /control character/i.test(message) ? 'control_character'
          : /property name/i.test(message) ? 'expected_property_name'
          : /after property value/i.test(message) ? 'expected_comma_or_close' : 'invalid_json';
        attempts.push({ stage, valid: false, error: category, ...(position ? { position: Number(position) } : {}) });
        return null;
      }
    };
    let analysis = parse(raw, 'parse');
    if (analysis) return { analysis, attempts, missingFields: [], truncated: false };
    const cleaned = raw.replace(/^\s*\x60{3}(?:json)?\s*/i, '').replace(/\s*\x60{3}\s*$/, '').trim();
    if (cleaned !== raw) {
      analysis = parse(cleaned, 'fences');
      if (analysis) return { analysis, attempts, missingFields: [], truncated: false };
    }
    // Scan containers without treating braces inside strings as delimiters.
    const start = cleaned.indexOf('{');
    let quoted = false, escaped = false, mismatch = false, end = -1;
    const stack = [];
    let repaired = '';
    if (start >= 0) for (let i = start; i < cleaned.length; i++) {
      const char = cleaned[i];
      if (quoted) {
        if (!escaped && char.charCodeAt(0) < 32) repaired += JSON.stringify(char).slice(1, -1);
        else repaired += char;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else {
        repaired += char;
        if (char === '"') quoted = true;
        else if (char === '{' || char === '[') stack.push(char === '{' ? '}' : ']');
        else if (char === '}' || char === ']') {
          if (stack.pop() !== char) { mismatch = true; break; }
          if (!stack.length) { end = i; break; }
        }
      }
    }
    if (end >= 0) {
      analysis = parse(repaired, 'balanced_object');
      if (analysis) return { analysis, attempts, missingFields: [], truncated: false };
    }
    const truncated = start >= 0 && (quoted || stack.length > 0);
    // Append container closers only; never invent a value or finish a sentence.
    if (!mismatch && !quoted && stack.length) {
      analysis = parse(repaired + stack.slice().reverse().join(''), 'container_closures');
      if (analysis) return { analysis, attempts, missingFields: [], truncated: true };
    }
    const partial = this.recoverPartialSEOAnalysis(cleaned);
    if (partial) {
      analysis = accept(partial, 'complete_prefix');
      if (analysis) return { analysis, attempts, missingFields: [], truncated: true };
    }
    return { analysis: null, attempts, missingFields: lastMissing, truncated };
  }

  createSEOConsultativeDiagnostic(content, inspected, finishReason = null, recoveryMetadata = null) {
    const raw = typeof content === 'string' ? content : JSON.stringify(content ?? null);
    // Mask ALL content, including keys, names and credentials, in structural previews.
    const structural = raw.replace(/[^\s{}\[\],:"\\]/g, 'x');
    const reason = ['stop', 'length', 'max_output_tokens', 'max_tokens', 'completed', 'incomplete', 'end_turn', 'content_filter'].includes(finishReason) ? finishReason : null;
    return { length: raw.length, finishReason: reason, truncated: Boolean(inspected.truncated || ['length', 'max_output_tokens', 'max_tokens'].includes(reason)),
      head: structural.slice(0, 120), tail: structural.slice(-120),
      attempts: inspected.attempts, missingFields: inspected.missingFields,
      recoveryMetadataPresent: Boolean(recoveryMetadata && typeof recoveryMetadata === 'object' && !Array.isArray(recoveryMetadata)),
      providerAttempts: [1, 2].includes(recoveryMetadata?.attempts) ? recoveryMetadata.attempts : null,
      recoveryStatus: ['complete', 'recovered', 'consultative-degraded'].includes(recoveryMetadata?.status) ? recoveryMetadata.status : null,
      stage: inspected.analysis ? 'validated' : 'consultative_validation' };
  }

  recordSEOConsultativeDiagnostic(diagnostic) {
    if (!this.internalDebugEnabled) return;
    try {
      const key = 'zentra-audit-json-diagnostics';
      const saved = JSON.parse(localStorage.getItem(key) || '[]');
      const entries = Array.isArray(saved) ? saved.slice(-9) : [];
      entries.push({ timestamp: new Date().toISOString(), ...diagnostic });
      localStorage.setItem(key, JSON.stringify(entries));
      this.debugLog('log', 'Audit JSON diagnostic', diagnostic);
    } catch (_) {}
  }

  recoverPartialSEOAnalysis(content) {
    const raw = String(content || '');
    const start = raw.indexOf('{');
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let recovered = null;
    for (let index = start; index < raw.length; index++) {
      const char = raw[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') depth--;
      else if (char === ',' && depth === 1) {
        try {
          const candidate = JSON.parse(raw.slice(start, index) + '}');
          if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) &&
              (candidate.summary || candidate.technicalStatus || candidate.recommendations?.length)) {
            recovered = candidate;
          }
        } catch (_) {}
      }
      if (depth < 0) break;
    }
    return recovered;
  }

  parseSEOAnalysis(content) {
    if (!content) {
      throw new Error('Respuesta vacia');
    }

    const attempts = [];
    attempts.push(String(content).trim());

    const cleaned = String(content)
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();
    attempts.push(cleaned);

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      attempts.push(jsonMatch[0]);
    }

    for (const candidate of attempts) {
      try {
        return JSON.parse(candidate);
      } catch (_) {}
    }

    throw new Error('No se pudo obtener JSON valido de la respuesta');
  }

  async getStatus() {
    try {
      const isReady = await this.isReady();

      return {
        isReady: isReady,
        isConfigured: true,
        managedByBackend: true,
        model: this.model,
        apiUrl: this.apiUrl
      };
    } catch (error) {
      return {
        isReady: false,
        error: error.message
      };
    }
  }

  generateFallbackAnalysis(pageData, internalPages = []) {
    const aggregate = this.buildAggregateTechnicalContext(pageData, internalPages);
    const score = aggregate.seoScoreAverage;
    const domain = pageData.url ? new URL(pageData.url).hostname : 'desconocido';
    
    const fallbackAnalysis = {
      consultativeStatus: 'consultative-degraded',
      seoScore: score,
      domain: domain,
      summary: `Lectura técnica de ${domain}: ${aggregate.coverage.complete} URL(s) completas de ${aggregate.pageCount} revisadas. El análisis consultivo no estuvo disponible; este informe conserva únicamente comprobaciones y hallazgos recuperables. No confirma rendimiento ni resultados comerciales.`,
      technicalStatus: this.buildAuditTechnicalStatus(aggregate),
      topIssues: [],
      recommendations: [],
      keywords: { primary: [], longTail: [], local: [] },
      quickWins: 'Validar las comprobaciones pendientes antes de definir un plan de cambios.'
    };

    fallbackAnalysis.competitiveSnapshot = null;
    fallbackAnalysis.opportunityDetected = null;
    fallbackAnalysis.pageSpecificFindings = this.buildPageSpecificFindings(pageData, internalPages);
    fallbackAnalysis.heavyImagesInsights = this.buildHeavyImagesInsights(pageData, internalPages);

    return this.applyAuditEvidence(fallbackAnalysis, pageData, internalPages);
  }

  calculateBasicSEOScore(pageData) {
    let score = 0;
    if (pageData.title) {
      score += 20;
      if (pageData.title.length >= 30 && pageData.title.length <= 60) score += 5;
    }
    if (pageData.metaDescription) {
      score += 15;
      if (pageData.metaDescription.length >= 120 && pageData.metaDescription.length <= 160) score += 5;
    }
    if (pageData.headings?.h1?.length === 1) score += 15;
    else if (pageData.headings?.h1?.length > 1) score += 5;
    if (pageData.images?.withAlt && pageData.images?.total) {
      const altRatio = pageData.images.withAlt / pageData.images.total;
      score += Math.round(15 * altRatio);
    }
    if (pageData.wordCount > 300) score += 10;
    else if (pageData.wordCount > 100) score += 5;
    if (pageData.links?.internal > 0) score += 5;
    if (pageData.links?.external > 0) score += 5;
    if (pageData.technicalSEO?.httpsEnabled) score += 3;
    if (pageData.technicalSEO?.hasViewport) score += 3;
    if (pageData.technicalSEO?.hasCharset) score += 2;
    if (pageData.technicalSEO?.hasCanonical) score += 2;
    return Math.min(score, 100);
  }
}

window.claudeAI = new ClaudeAI();
