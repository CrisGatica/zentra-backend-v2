import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from './local-postgres.mjs';

const root = process.env.ZENTRA_CHAT_ROOT;
const chat = readFileSync(root + '/claude-chatbot.js', 'utf8');
const audit = readFileSync(root + '/claude-pdf-generator.js', 'utf8');
const popup = readFileSync(root + '/popup.js', 'utf8');

function fixture() {
  const dom = new JSDOM('<body><div id="messages"></div></body>', { url: 'https://fixture.test', runScripts: 'outside-only' });
  const w = dom.window, storage = {};
  w.console = { log() {}, warn() {}, error() {} };
  w.chrome = { runtime: {}, storage: { local: {
    set(data, callback) { Object.assign(storage, structuredClone(data)); callback?.(); },
    get(keys, callback) { callback(storage); },
    remove(key, callback) { delete storage[key]; callback?.(); }
  } } };
  w.matchMedia = () => ({ matches: true });
  w.eval(chat); w.eval(audit);
  const bot = Object.create(w.ClaudeChatbot.prototype);
  Object.assign(bot, { elements: { messages: w.document.querySelector('#messages') },
    pendingChatStorageKey: 'zentra-chat-pending-request', documentContexts: [], maxDocumentContexts: 3 });
  bot.scrollToBottom = () => {};
  bot.wireMessageCopyButton = () => {};
  bot.formatMessage = text => text;
  return { w, bot, storage, close() { w.claudePDFGenerator.hideProgressIndicator(); dom.window.close(); } };
}

test('Audit: real milestones only, no time-driven progress; saved stage/width survive reopen and replay', async () => {
  const f = fixture();
  try {
    const g = f.w.claudePDFGenerator;
    await g.savePendingAuditJob({ operationId: 'same-audit', status: 'running' });
    g.showProgressIndicator({ phase: 'competition', value: 58 });
    assert.equal(g.progressValue, 58);
    assert.equal(f.w.document.querySelector('#progress-text').textContent, 'Contrastando referencias externas...');
    g.updateAuditPhase('structure');
    assert.equal(g.progressPhase, 'competition');
    assert.equal(g.getProgressFrame(3600).value, 58);
    g.updateAuditPhase('recommendations');
    g.updateAuditPhase('pages');
    assert.equal(g.progressPhase, 'recommendations');
    assert.equal(g.getProgressFrame(3600).value, 66);
    await g.pendingAuditWrite;
    const saved = f.storage['zentra-audit-pending-job'];
    assert.equal(saved.operationId, 'same-audit');
    assert.equal(saved.progress.phase, 'recommendations');
    g.hideProgressIndicator();
    g.showProgressIndicator(saved.progress);
    assert.ok(g.progressValue >= 66);
    assert.equal(f.w.document.querySelector('#progress-text').textContent, 'Priorizando oportunidades...');
    for (const stage of g.getProgressTimeline()) assert.ok(stage.value < 100);
    assert.equal(f.w.document.querySelectorAll('#progress-text').length, 1);
  } finally { f.close(); }
});

test('Chat: event copy only, no fake pulse timers; visible content permanently hides preparation', async () => {
  const f = fixture();
  try {
    const { bot, w } = f;
    const draft = bot.createAssistantDraftMessage({ phase: 'context', note: bot.getAssistantProgressCopy('context') });
    let timers = 0;
    w.setInterval = () => { timers++; };
    w.setTimeout = () => { timers++; };
    bot.startAssistantDraftPulse(draft);
    bot.startCompactGuidePulse(draft);
    bot.startCompactIdentityPulse(draft);
    assert.equal(timers, 0);
    const note = draft.element.querySelector('.assistant-live-note');
    let fades = 0;
    note.animate = () => { fades++; };
    bot.updateAssistantDraftMessage(draft, { phase: 'reasoning', note: bot.getAssistantProgressCopy('reasoning') });
    assert.equal(fades, 0, 'Reduced motion disables the text fade');
    assert.equal(draft.element.querySelector('.assistant-live-note').textContent, 'Refinando criterio...');
    w.matchMedia = () => ({ matches: false });
    bot.updateAssistantDraftMessage(draft, { phase: 'executive', note: bot.getAssistantProgressCopy('executive') });
    assert.equal(fades, 1);
    note.animate = () => { throw new Error('Presentation failure'); };
    assert.doesNotThrow(() => bot.updateAssistantDraftMessage(draft, { note: bot.getAssistantProgressCopy('fast') }));
    bot.updateAssistantDraftMessage(draft, { text: 'Useful visible response' });
    bot.updateAssistantDraftMessage(draft, { phase: 'executive', note: bot.getAssistantProgressCopy('executive') });
    assert.equal(draft.element.querySelector('.assistant-live-note').style.display, 'none');
    assert.equal(draft.element.querySelector('.assistant-live-phases').style.display, 'none');
    assert.match(draft.element.querySelector('.assistant-live-body').textContent, /Useful visible response/);
    await bot.savePendingChatRequest({ operationId: 'same-chat', message: 'Request', progressPhase: 'reasoning' });
    const restored = await bot.loadPendingChatRequest();
    assert.equal(restored.operationId, 'same-chat');
    assert.equal(restored.progressPhase, 'reasoning');
    assert.equal(bot.getAssistantProgressCopy(restored.progressPhase), 'Refinando criterio...');
  } finally { f.close(); }
});

test('Capacity: all three unchanged offers open the website in a new Chrome tab, never Lemon/popup navigation', async () => {
  const f = fixture();
  try {
    const { w } = f;
    w.document.body.innerHTML = '<div id="plan-modal"><h2 id="plan-modal-title"></h2><p id="plan-modal-subtitle"></p><div id="plan-modal-options"></div></div>';
    const tabs = [];
    w.chrome.tabs = { create: async options => { tabs.push(options); } };
    w.getCapacityModalCopy = () => ({ title: 'Expand\u00ed capacidad', subtitle: 'Options' });
    w.closePlanModal = () => {};
    w.showSubscriptionMessage = message => { throw new Error(message); };
    w.openVerifiedLemonCheckout = () => { throw new Error('Must not invoke checkout'); };
    const start = popup.indexOf('function openCapacityModal(');
    const end = popup.indexOf('\nfunction setupPlanModal(', start);
    w.eval(popup.slice(start, end));
    w.openCapacityModal({ offers: [
      { extraAudits: 5, extraActions: 300 },
      { extraAudits: 15, extraActions: 700, checkoutUrl: 'obsolete' },
      { extraAudits: 30, extraActions: 1500 }
    ] });
    const buttons = [...w.document.querySelectorAll('.plan-option-btn')];
    assert.equal(buttons.length, 3);
    for (const button of buttons) {
      assert.equal(button.textContent.trim(), 'Ver opciones');
      button.click();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      assert.equal(button.disabled, false);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(tabs)), Array(3).fill(null).map(() => ({ url: 'https://tryzentra.app/#planes' })));
    assert.equal(w.location.href, 'https://fixture.test/');
    assert.doesNotMatch(w.document.body.textContent, /\$|Abrir checkout/);
    for (const count of [300, 700, 1500]) assert.match(w.document.body.textContent, new RegExp(String(count)));
  } finally { f.close(); }
});
