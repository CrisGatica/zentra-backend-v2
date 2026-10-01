import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const base = process.env.ZENTRA_BASE;
const root = process.env.ZENTRA_CHAT_ROOT || `${base}/publicacion/chrome-store/zentra-ai-chrome-store-clean`;
const context = vm.createContext({ window: {}, document: { addEventListener() {} }, console, URL, URLSearchParams });
vm.runInContext(readFileSync(`${root}/claude-chatbot.js`, 'utf8'), context);
const bot = Object.create(context.window.ClaudeChatbot.prototype);
bot.webContext = { url: 'https://tryzentra.app/', title: 'Zentra AI', text: 'Chat contextual y auditorias SEO' };
bot.conversation = [];
bot.taskMemory = {};

// Reproduction fixture, not a recovered provider payload from the incident.
const ad = {
  title: 'Search - Anuncio de búsqueda',
  headlines: ['Descubre Zentra AI', 'Mejora tu web con evidencia'],
  description: 'Analiza tu web y prepara tus proximos pasos con Zentra.',
  cta: 'Probar Zentra'
};
const requests = [
  'Genial como prepararias un anuncio para esta web?',
  'Preparame un anuncio para esta web',
  '¿Cómo anunciarías esta página?',
  'Haceme un anuncio de búsqueda para esta web',
  'Dame headlines para Google Ads',
  '¿Qué campaña harías para esta página?',
  'Creame un copy para promocionar esta web'
];
for (const userMessage of requests) {
  bot.lastPromptBuildMeta = { userMessage };
  const fastIntent = bot.detectFastChatIntent(userMessage);
  assert.ok(!fastIntent?.skipFullPageContext, 'Ad request must retain page context');
  const taskIntent = bot.detectTaskIntent(userMessage);
  const contract = bot.detectResponseContract({ userMessage, fastIntent, taskIntent });
  if (userMessage === requests[0]) {
    assert.equal(contract.contextDecision, 'page');
    assert.equal(contract.outputType, 'copy');
    assert.equal(contract.renderType, 'cards');
  }
  for (const value of [ad, { cards: [ad, { title: 'Alternativa', text: 'Otra propuesta completa', cta: 'Conocer Zentra' }] }]) {
    for (const response of [value, JSON.stringify(value)]) {
      const result = bot.resolveAssistantTextFromData({ success: true, response }, { userMessage });
      for (const expected of [...ad.headlines, ad.description, ad.cta]) assert.ok(result.includes(expected), `${userMessage}: missing ${expected}; got ${result}`);
      if (value.cards) assert.ok(result.includes('Otra propuesta completa') && result.includes('Conocer Zentra'));
    }
  }
}
bot.lastPromptBuildMeta = { userMessage: requests[0] };
for (const payload of [
  { intent: { title: 'internal intent' }, routing: { text: 'internal route' }, response: ad },
  { intent: { title: 'internal intent' }, routing: { text: 'internal route' }, cards: [ad] }
]) {
  for (const response of [payload, JSON.stringify(payload)]) {
    const result = bot.resolveAssistantTextFromData({ success: true, response });
    assert.ok(result.includes(ad.cta));
    assert.ok(!result.includes('internal intent') && !result.includes('internal route'));
  }
}
const intermediate = { intent: { title: 'internal intent' }, routing: { text: 'internal route' } };
for (const response of [intermediate, JSON.stringify(intermediate)]) {
  assert.equal(bot.resolveAssistantTextSafely({ success: true, response }), '');
  assert.equal(bot.buildLastResortAssistantText({ success: true, response }), '');
  assert.equal(bot.resolveAssistantTextFromData({ success: true, response, output_text: 'Propuesta final completa.' }), 'Propuesta final completa.');
}
for (const [userMessage, response] of [
  ['¿Quién sos?', 'Soy Zentra AI.'],
  ['Analizá esta página', 'La propuesta de valor necesita mayor claridad.'],
  ['Mejorá este texto', 'Hola, Patricia. Ya informamos tu solicitud.'],
  ['¿Qué cambiarías de esta web?', 'Revisaría primero la navegación.']
]) {
  bot.lastPromptBuildMeta = { userMessage };
  assert.ok(bot.extractAssistantText(response).includes(response));
}
bot.lastPromptBuildMeta = { userMessage: 'Responde brevemente' };
assert.equal(bot.extractAssistantText({ reply: 'Hola. ¿En qué te ayudo?' }), 'Hola. ¿En qué te ayudo?');
assert.equal(bot.extractAssistantText({ response: 'Respuesta final.', provider: 'private', usage: { tokens: 34 }, needs_reasoning: true }), 'Respuesta final.');
assert.equal(bot.extractAssistantText({ texto_extraido: 'PROMOCION\nPrecio: 19,95 euros', language: 'es' }), 'PROMOCION\nPrecio: 19,95 euros');
assert.equal(bot.extractAssistantText('Reply: Hola.'), 'Hola.');
assert.equal(bot.extractAssistantText('La palabra Reply: es válida aquí.'), 'La palabra Reply: es válida aquí.');
assert.ok(bot.extractAssistantText({ steps: [{ title: 'Abrir', description: 'Configuración' }, { title: 'Revisar', description: 'El correo' }] }).includes('El correo'));
bot.lastPromptBuildMeta = { userMessage: 'Responde en formato JSON' };
assert.equal(bot.extractAssistantText('{"headlines":["Uno","Dos"]}'), '{"headlines":["Uno","Dos"]}');
console.log('PASS structured chat: ad variants, object/JSON payloads, all cards, metadata isolation, fallback candidates, normal replies, OCR, requested JSON');
