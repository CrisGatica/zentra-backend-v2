import { readFileSync } from "node:fs";
import vm from "node:vm";
import { requestFingerprint } from "./release-security.js";
import { chatPersonalization } from "./release-entitlements.js";
import { normalizeConversationContext, withConversationEvidence } from "./release-conversation-context.js";

// This is the pinned, trusted application code, never JavaScript supplied by a request.
const builders = new vm.Script(readFileSync(new URL("./trusted-chat-builders.js", import.meta.url), "utf8"));
const methods = Object.freeze({
  rewrite: "attemptSimpleRewriteRetry",
  organization: "attemptStructuredTaskOrganizationRecovery",
  ocr_cards: "attemptImageOcrCardsRecovery",
  incomplete: "attemptIncompleteVisibleResponseRecovery",
  strategic: "attemptStructuredStrategicRecovery",
  polish: "attemptSeniorResponsePolish",
  reasoning: "attemptPremiumReasoningRescue"
});

function normalizeConversationSnapshot(context) {
  const page = context.state?.webContext;
  if (!page || !Object.hasOwn(page, 'conversationContext')) return context;
  const conversationContext = normalizeConversationContext(page.conversationContext);
  if (!conversationContext) {
    const webContext = { ...page };
    delete webContext.conversationContext;
    return { ...context, state: { ...context.state, webContext } };
  }
  const field = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
  // Keep useful metadata, never the inbox/sidebar/environment or a cached unrelated site.
  return { ...context, environmentSummary: null, state: { ...context.state, siteContext: null,
    webContext: { url: field(page.url, 1000), domain: field(page.domain, 200), title: field(page.title, 300), conversationContext } } };
}

function createBuilder(context = {}) {
  context = normalizeConversationSnapshot(context);
  const sandbox = vm.createContext({
    window: {}, document: { addEventListener() {}, getElementById() { return null; } },
    URL, URLSearchParams, console: { log() {}, warn() {}, error() {}, info() {} }
  });
  builders.runInContext(sandbox, { timeout: 1000 });
  const bot = Object.create(sandbox.window.ClaudeChatbot.prototype);
  const state = context.state || {};
  for (const key of ["webContext", "conversation", "taskMemory", "model", "maxTokens", "lastInputModality", "documentContexts", "isContextLoaded"]) {
    if (Object.hasOwn(state, key)) bot[key] = JSON.parse(JSON.stringify(state[key]));
  }
  bot.webContext ||= {};
  bot.conversation ||= [];
  bot.taskMemory ||= {};
  bot.documentContexts ||= [];
  bot.isContextLoaded ??= Boolean(bot.webContext.url);
  bot.loadSiteContextForChat = async () => state.siteContext || null;
  bot.debugLog = () => {};
  bot.traceImageOcrStage = () => {};
  return bot;
}

function readLegacyProfile(messages) {
  const system = messages.find(message => message.role === "system" && typeof message.content === "string")?.content || "";
  const start = system.indexOf("PERSONALIZACION DEL ASISTENTE PARA ESTE USUARIO");
  if (start < 0) return {};
  const block = system.slice(start).split("\n\nREGLA PRINCIPAL DE INTENCION DEL CHAT")[0];
  const labels = { profile_name: "Marca o nombre profesional", profession: "Rol o actividad principal",
    client_type: "Tipo de clientes", specialty: "Especialidad o servicios", tone: "Estilo preferido",
    response_depth: "Nivel de detalle preferido", priorities: "Prioridades que debes respetar",
    advanced_instructions: "Instrucciones avanzadas de la agencia" };
  const profile = {};
  for (const [field, label] of Object.entries(labels)) {
    const value = block.match(new RegExp("(?:^|\\n)- " + label + ": ([\\s\\S]*?)(?=\\n- (?:"
      + Object.values(labels).join("|") + "): |(?![\\s\\S]))"))?.[1];
    if (value) profile[field] = value.trim();
  }
  const tones = { "Tono directo y profesional": "directo", "Tono cercano y claro": "cercano",
    "Tono consultivo y estrategico": "consultivo", "Tono comercial y persuasivo": "comercial" };
  const depths = { "Respuestas cortas y concretas salvo que pidan mas detalle": "corto",
    "Respuestas claras con contexto util, sin extenderse de mas": "equilibrado",
    "Respuestas mas desarrolladas cuando aporte valor real": "detallado" };
  profile.tone = tones[profile.tone] || profile.tone;
  profile.response_depth = depths[profile.response_depth] || profile.response_depth;
  return profile;
}

export async function buildAuthorizedChatRoot(body, context, user) {
  const messages = body.messages || [];
  const input = messages.filter(message => message.role === "user").at(-1)?.content;
  const text = typeof input === "string" ? input : (input || []).filter(part => part.type === "text").map(part => part.text).join("\n");
  const snapshot = normalizeConversationSnapshot(context || { version: 1, userMessage: text, state: {} });
  const bot = createBuilder(snapshot);
  const personalization = chatPersonalization(user, snapshot.personalization?.profile || readLegacyProfile(messages));
  bot.getPromptPersonalizationContext = async () => personalization;
  const images = Array.isArray(input)
    ? input.filter(part => part.type === "image_url").map(part => ({ base64: part.image_url?.url })) : [];
  const imageData = images.length ? { ...images[0], images } : null;
  const userMessage = snapshot.userMessage;
  const interactionMeta = snapshot.interactionMeta || bot.detectInteractionMode({ message: userMessage, imageData, source: "direct", modality: images.length ? "image" : "text" });
  const fastIntent = bot.detectFastChatIntent(userMessage, imageData, interactionMeta);
  const args = { userMessage, imageData, model: body.model, maxTokens: body.max_tokens, routingConfig: body.zentra_routing || {} };
  const shortBuilders = { simple_rewrite: "buildPlainTextRewriteRequestBody", case_resolution: "buildCaseResolutionRequestBody",
    image_copy: "buildImagePromotionCopyRequestBody", simple_extract: "buildPlainImageOcrRequestBody" };
  let system;
  if (fastIntent && Object.hasOwn(shortBuilders, fastIntent.type)) {
    system = bot[shortBuilders[fastIntent.type]](args).messages[0].content;
  } else {
    const responseContract = snapshot.responseContract || bot.detectResponseContract({ userMessage, imageData, interactionMeta,
      fastIntent, taskIntent: snapshot.taskIntent, environmentSummary: snapshot.environmentSummary });
    system = fastIntent
      ? bot.buildFastChatSystemPrompt(fastIntent) + bot.buildResponseContractPromptBlock(responseContract, userMessage, { hasImage: Boolean(imageData), interactionMeta })
      : await bot.buildSystemPrompt({ userMessage, imageData, interactionMeta, responseContract,
        environmentSummary: snapshot.environmentSummary, taskIntent: snapshot.taskIntent });
    if (fastIntent && ["file", "mixed"].includes(responseContract.contextDecision)) {
      system += bot.buildDocumentContextPromptBlock({ dominant: responseContract.contextDecision === "file" });
    }
    if (!images.length && bot.shouldCarryRecentImageIntoRequest(userMessage, imageData, 6)) {
      system += bot.buildRecentImageOcrPromptBlock(bot.getRecentImageOcrText(6));
    }
    system += bot.buildStructuredTaskOrganizationPromptBlock(userMessage);
  }
  // Only trusted application builders can produce privileged provider messages.
  const effective = [{ role: "system", content: system }, ...messages.filter(message => ["user", "assistant"].includes(message.role))];
  return { body: withConversationEvidence({ ...body, messages: effective }, bot.webContext.conversationContext),
    context: context ? { ...snapshot, personalization } : null };
}

function recoverLegacySources(root) {
  const context = JSON.parse(JSON.stringify(root.context || {}));
  const state = context.state ||= {};
  const system = (root.body.messages || []).find(message => message.role === "system" && typeof message.content === "string")?.content || "";
  // Older clients embedded sources in the prompt rather than in typed snapshots.
  // Recover only known data sections, never the surrounding client instructions.
  if (!state.documentContexts?.length) {
    const section = system.split("\n\nDOCUMENT CONTEXT\n")[1]?.split(/\n\n(?:CONTEXTO DE |DATOS INTERNOS DE CONTEXTO MULTIPAGINA|OCR COMPLETO GUARDADO|ORGANIZACION)/)[0];
    const documents = section?.match(/Documento \d+: [\s\S]*/)?.[0];
    if (documents) state.documentContexts = [{ id: "legacy-source", name: "Documentos originales", type: "document", text: documents }];
  }
  if (!state.siteContext && system.includes("\n\npagina_actual:\n")) {
    const lines = { url: "URL", title: "Título", metaDescription: "Meta descripción", h1: "H1", contentSummary: "Contenido resumido" };
    const siteSection = system.split("\n\nDATOS INTERNOS DE CONTEXTO MULTIPAGINA DEL SITIO")[1] || "";
    const pages = [...siteSection.matchAll(/(?:^|\n)(pagina_actual|pagina_relacionada_\d+):\n([\s\S]*?)(?=\n\n|$)/g)].map(match => {
      const page = {};
      for (const [field, label] of Object.entries(lines)) {
        const value = match[2].match(new RegExp("^" + label + ": ([^\\r\\n]*)$", "m"))?.[1];
        if (value) page[field] = value;
      }
      for (const [field, label] of Object.entries({ h2: "H2 principales", ctas: "CTAs visibles", imagesAlt: "ALT de imagenes visibles" })) {
        const value = match[2].match(new RegExp("^" + label + ": ([^\\r\\n]*)$", "m"))?.[1];
        if (value) page[field] = value.split(" | ");
      }
      const links = match[2].match(/^Enlaces internos visibles: ([^\r\n]*)$/m)?.[1];
      if (links) page.links = links.split(" | ").map(text => ({ text }));
      const h1Count = match[2].match(/^Cantidad de H1: (\d+)$/m)?.[1];
      if (h1Count !== undefined) page.h1Count = Number(h1Count);
      const score = match[2].match(/^Puntaje SEO visible: (\d+)\/100$/m)?.[1];
      if (score !== undefined) page.seoScore = Number(score);
      return page;
    });
    if (pages[0]?.url) state.siteContext = { pagina_actual: pages[0], paginas_relacionadas: pages.slice(1).filter(page => page.url) };
  }
  const ocr = system.match(/\n<ocr_text>\n([\s\S]*?)\n<\/ocr_text>/)?.[1];
  if (ocr && !state.conversation?.some(message => message.contextMeta?.imageOcrText)) {
    const conversation = [...(state.conversation || [])];
    if (!conversation.some(message => message.type === "user" && (message.imageAttachments?.length || message.imageBase64))) {
      // Same storage placeholder as the trusted builder: a reference, not image pixels.
      conversation.push({ type: "user", content: "", imageAttachments: [{ base64: "[imagen-guardada-en-storage]" }] });
    }
    state.conversation = [...conversation, { type: "assistant", content: ocr, contextMeta: { imageOcrText: ocr } }];
  }
  if (!context.version) {
    context.version = 1;
    const input = root.body.messages?.filter(message => message.role === "user").at(-1)?.content;
    context.userMessage = typeof input === "string" ? input : (input || []).filter(part => part.type === "text").map(part => part.text).join("\n");
  }
  return context;
}

export async function buildChatExecutionBody(prepared, user) {
  const execution = prepared.chatExecution;
  if (!execution) return prepared.body;
  const authorized = await buildAuthorizedChatRoot(execution.root.body, recoverLegacySources(execution.root), user);
  const body = execution.stage === "root" ? authorized.body
    : await buildChatRefinement(execution.stage, authorized, execution.previousResponse);
  for (const field of ["personalization", "advancedInstructions", "customInstructions", "systemInstructions", "zentra_workflow", "zentra_refinement", "zentra_operation"]) delete body[field];
  return body;
}

export function validateChatRoot(body, context) {
  if (!context) return true; // Legacy clients may retry exactly, but cannot request new repair prompts.
  if (context.version !== 1 || typeof context.userMessage !== "string") return false;
  const input = body.messages?.filter(message => message.role === "user").at(-1)?.content;
  const text = typeof input === "string" ? input : Array.isArray(input)
    ? input.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
  if (text === context.userMessage || text === context.userMessage.trim()) return true;
  // Short transforms deliberately wrap the original instruction and payload.
  const bot = createBuilder(context);
  for (const name of ["buildPlainTextRewriteRequestBody", "buildCaseResolutionRequestBody"]) {
    const candidate = bot[name]({ userMessage: context.userMessage });
    if (text === candidate.messages.at(-1).content && body.messages?.[0]?.content === candidate.messages[0].content) return true;
  }
  const images = Array.isArray(input) ? input.filter(part => part.type === "image_url")
    .map(part => ({ base64: part.image_url?.url })) : [];
  if (images.length) {
    for (const name of ["buildPlainImageOcrRequestBody", "buildImagePromotionCopyRequestBody"]) {
      const candidate = bot[name]({ userMessage: context.userMessage, imageData: images });
      if (JSON.stringify(body.messages) === JSON.stringify(candidate.messages)) return true;
    }
  }
  return false;
}

export async function buildChatRefinement(stage, root, previousResponse) {
  if (stage !== "visible" && !Object.hasOwn(methods, stage)) throw new Error("Unknown refinement");
  const context = normalizeConversationSnapshot(root.context || {});
  if (!root.context || !validateChatRoot(root.body, context)) throw new Error("Invalid original context");
  const bot = createBuilder(context);
  const requestBody = root.body;
  const userMessage = context.userMessage;
  const routingConfig = requestBody.zentra_routing || {};
  bot.model = requestBody.model || bot.model;
  bot.maxTokens = Number(requestBody.max_tokens || bot.maxTokens || 1800);
  bot.getRoutingConfig = async taskType => ({ ...routingConfig, taskType, selectedModel: bot.model });
  const images = (requestBody.messages || []).flatMap(message => Array.isArray(message.content)
    ? message.content.filter(part => part.type === "image_url").map(part => ({ base64: part.image_url?.url })) : []);
  const imageData = images.length ? { ...images[0], images } : null;
  const data = previousResponse?.body || { success: true, response: previousResponse?.text || "" };
  const assistantText = bot.resolveAssistantTextSafely(data, {
    userMessage, taskIntent: context.taskIntent, applyWeakRewriteFallback: false
  }) || bot.buildLastResortAssistantText(data);
  const args = {
    userMessage, assistantText, previousOutput: assistantText,
    requestBody, routingConfig, model: bot.model, maxTokens: bot.maxTokens,
    environmentSummary: context.environmentSummary,
    interactionMeta: context.interactionMeta, responseContract: context.responseContract,
    taskIntent: context.taskIntent, imageData,
    ocrText: bot.getRecentImageOcrText(6),
    resolvedUserEmail: requestBody.zentra_user_email || "",
    resolvedUserId: requestBody.zentra_user_id || ""
  };
  if (stage === "visible") return withConversationEvidence(bot.buildVisibleChatRecoveryRequestBody(args), bot.webContext.conversationContext);
  let captured;
  const stop = new Error("Request captured");
  bot.apiProvider = { sendMessages: async request => { captured = request.body; throw stop; } };
  try { await bot[methods[stage]](args); } catch (error) { if (error !== stop) throw error; }
  if (!captured) throw new Error("Refinement not applicable");
  return withConversationEvidence(captured, bot.webContext.conversationContext);
}

export async function prepareChatStep({ client, identity, product, operationId, body }) {
  const identityArgs = { p_auth_id: identity.userId, p_email: identity.email, p_product: product, p_operation: operationId };
  const read = await client.rpc("zentra_read_chat_steps", identityArgs);
  if (read.error) throw read.error;
  const workflow = read.data || {};
  const stage = body.zentra_refinement?.stage || "root";
  if (stage !== "root" && stage !== "visible" && !Object.hasOwn(methods, stage)) return { conflict: true };
  const root = workflow.root;
  if (stage === "root" && root && requestFingerprint(body) !== (root.context?.clientRequestHash || root.request_hash)) return { conflict: true };
  if (stage !== "root" && (!root || !root.context)) return { conflict: true };
  const existing = workflow.steps?.find(step => step.step_name === stage);
  if (existing) return { body: existing.body, sourceHash: root.request_hash,
    chatExecution: { root: { body: root.body, context: root.context }, stage, previousResponse: workflow.previous_response || null } };
  let canonical = body;
  let context = body.zentra_workflow || null;
  if (stage === "root") {
    if (!validateChatRoot(body, context)) return { conflict: true };
    const access = await client.rpc("zentra_access", { p_auth_id: identity.userId, p_email: identity.email, p_product: product });
    if (access.error || !access.data) throw access.error || new Error("Personalization entitlement unavailable");
    const authorized = await buildAuthorizedChatRoot(body, context, access.data);
    canonical = authorized.body;
    context = { ...(authorized.context || {}), clientRequestHash: requestFingerprint(body) };
  } else {
    try { canonical = await buildChatRefinement(stage, root, workflow.previous_response); }
    catch (_) { return { conflict: true }; }
    context = null;
  }
  // Metadata is persisted separately and never forwarded to the generation provider.
  canonical = { ...canonical };
  delete canonical.zentra_workflow;
  delete canonical.zentra_refinement;
  delete canonical.zentra_operation;
  delete canonical.personalization;
  delete canonical.advancedInstructions;
  delete canonical.customInstructions;
  delete canonical.systemInstructions;
  const saved = await client.rpc("zentra_register_chat_step", {
    ...identityArgs, p_step: stage, p_hash: requestFingerprint(canonical), p_body: canonical, p_context: context
  });
  if (saved.error) throw saved.error;
  if (!saved.data?.allowed) return { conflict: true };
  return { body: saved.data.body, sourceHash: saved.data.root_hash,
    chatExecution: { root: stage === "root" ? { body: saved.data.body, context } : { body: root.body, context: root.context },
      stage, previousResponse: workflow.previous_response || null } };
}
