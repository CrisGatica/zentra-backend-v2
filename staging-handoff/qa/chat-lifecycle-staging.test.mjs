import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from './local-postgres.mjs';

const root = process.env.ZENTRA_CHAT_ROOT;
const source = readFileSync(root + '/claude-chatbot.js', 'utf8');
const prompt = 'Analiza este video de YouTube usando solo lo visible en pantalla y teniendo en cuenta el contexto del canal actual. Quiero: claridad del tema, hook, valor percibido, fricciones y mejoras prioritarias.';
const answer = 'Hechos visibles:\nEl tema se entiende rapido.\nHook:\nEl t\u00edtulo es amplio.\nAcciones:\n- Concretar la promesa.';
const operationId = 'same-operation';
function fixture() {
  const storage = {}, windows = [], queued = [], ids = [], logs = [];
  const state = { requests: 0, providers: 0, debits: 0, cached: false, holdHistory: false,
    failHistory: false, failPending: false, failUsage: false, failRefresh: false, mode: 'complete' };
  function popup() {
    const dom = new JSDOM('<body><div id="messages"></div></body>', { url: 'https://fixture.test', runScripts: 'outside-only' });
    const w = dom.window;
    w.console = { log() {}, warn(...v) { logs.push(v); }, error(...v) { logs.push(v); } };
    let activeId;
    w.chrome = { runtime: {}, storage: { local: {
      get(keys, cb) { cb(Object.fromEntries(keys.filter(k => k in storage).map(k => [k, structuredClone(storage[k])]))); },
      set(data, cb) {
        const snapshot = structuredClone(data);
        const history = 'zentra-chat-history' in snapshot;
        const commit = () => {
          const failed = history ? state.failHistory : state.failPending;
          if (failed) w.chrome.runtime.lastError = { message: 'sensitive fixture content must not enter logs' };
          else Object.assign(storage, snapshot);
          cb?.();
          delete w.chrome.runtime.lastError;
        };
        if (history && state.holdHistory) queued.push(commit); else commit();
      },
      remove(keys, cb) { keys.forEach(k => delete storage[k]); cb?.(); }
    } } };
    w.eval(source);
    const bot = Object.create(w.ClaudeChatbot.prototype);
    Object.assign(bot, { conversation: [], documentContexts: [], taskMemory: bot.getDefaultTaskMemory(),
      pendingChatStorageKey: 'zentra-chat-pending-request', elements: { messages: w.document.querySelector('#messages') },
      internalDebugEnabled: true, isLoading: false, isDesktopShell: false, activeSavedConversationId: '',
      maxDocumentContexts: 3, maxDocumentContextChars: 48000, pendingImage: null, pendingImages: [],
      documentAttachmentPreviews: new Map(), initialMessagesMarkup: '', latestChatHistorySignature: '' });
    for (const name of ['scrollToBottom', 'restoreChatScrollPosition', 'updateChatInputPlaceholder',
      'stopAssistantDraftPulse', 'clearPendingImage', 'clearPendingDocument']) bot[name] = () => {};
    bot.getEnvironmentContextSummary = () => '';
    bot.detectContextualSurface = () => ({ key: 'youtube' });
    bot.createAssistantDraftForRequest = () => ({ lastLiveText: '' });
    const restoredStages = [];
    bot.updateAssistantDraftMessage = (draft, data) => {
      if (draft && data.text) draft.lastLiveText = data.text;
      if (data.note) restoredStages.push(data.note);
    };
    bot.restoredStages = restoredStages;
    bot.removeAssistantDraftMessage = () => { bot.removed = true; };
    bot.addSystemMessage = message => { bot.systemError = message; };
    bot.buildSafeAccountAccessGuideFallback = () => null;
    w.zentraOperations = { begin(_kind, _source, id) { activeId = id; ids.push(id); }, end() {} };
    w.zentraSubscription = {
      getUserState: async () => { if (state.failUsage) throw new Error('HTTP 429'); return {}; },
      canUseAction: () => ({ allowed: true }),
      consumeAction: async () => { if (state.failRefresh) throw new Error('HTTP 429'); },
      consumePremiumRoutingUsage: async () => {}
    };
    bot.sendToAPI = async (_message, _image, { onEvent }) => {
      state.requests++;
      if (!state.cached) { state.providers++; state.debits++; state.cached = true; }
      assert.equal(activeId, operationId);
      if (state.mode === 'generating') return new Promise(() => {});
      if (state.mode === 'status-wait') {
        await onEvent({ type: 'status', phase: 'reasoning', message: 'Internal wording must not leak' });
        await onEvent({ type: 'status', phase: 'fast' });
        return new Promise(() => {});
      }
      if (state.mode === 'layer-error') {
        await onEvent({ type: 'layer', phase: 'reasoning', text: answer });
        throw new Error('Simulated transport failure');
      }
      return { text: answer, turnContextMeta: { platform: 'youtube' } };
    };
    const item = { w, bot, close: () => dom.window.close() };
    windows.push(item);
    return item;
  }
  async function start(p) {
    p.bot.addUserMessage(prompt);
    await p.bot.savePendingChatRequest({ message: prompt, operationId, startedAt: new Date(Date.now() - 1000).toISOString(), interactionMeta: { mode: 'strategic' } });
    return p.bot.runChatRequest({ message: prompt, assistantDraft: { lastLiveText: '' }, subscriptionManager: p.w.zentraSubscription });
  }
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  const hydrate = async p => { await p.bot.loadChatHistory(); p.bot.restoreChatMessages(); await p.bot.resumePendingChatRequest(); };
  return { storage, state, ids, logs, queued, popup, start, flush, hydrate,
    release() { state.holdHistory = false; while (queued.length) queued.shift()(); },
    close() { windows.forEach(p => p.close()); } };
}

test('send -> close generating -> resume -> complete -> close -> hydrate: one operation/provider/debit', async () => {
  const f = fixture();
  try {
    f.state.mode = 'generating'; const first = f.popup(); void f.start(first); await f.flush(); first.close();
    f.state.mode = 'complete'; const second = f.popup(); await f.hydrate(second); second.close();
    const before = f.state.requests, third = f.popup(); await f.hydrate(third);
    assert.equal(third.bot.conversation.at(-1).content, answer);
    assert.equal(third.bot.conversation.at(-1).lifecycle, 'complete');
    assert.equal(third.bot.conversation.at(-1).operationId, operationId);
    assert.equal(f.state.requests, before); assert.equal(f.state.providers, 1); assert.equal(f.state.debits, 1);
    assert.deepEqual(f.ids, [operationId, operationId]);
  } finally { f.close(); }
});

test('real Chat status persists, replay cannot regress stage, resume restores copy without new provider/debit', async () => {
  const f = fixture();
  try {
    f.state.mode = 'status-wait';
    const first = f.popup();
    void f.start(first); await f.flush();
    assert.equal(f.storage['zentra-chat-pending-request'].progressPhase, 'reasoning');
    assert.deepEqual(first.bot.restoredStages, ['Refinando criterio...']);
    first.close();
    f.state.mode = 'complete';
    const second = f.popup();
    await f.hydrate(second);
    assert.ok(second.bot.restoredStages.includes('Refinando criterio...'));
    assert.equal(f.state.providers, 1);
    assert.equal(f.state.debits, 1);
    assert.equal(second.bot.conversation.at(-1).lifecycle, 'complete');
  } finally { f.close(); }
});
test('close immediately before delayed history callback: final pending restores without API or consumption', async () => {
  const f = fixture();
  try {
    const first = f.popup(); f.state.holdHistory = true; void f.start(first); await f.flush();
    assert.equal(f.storage['zentra-chat-pending-request'].lifecycle, 'finalizing');
    assert.equal(f.storage['zentra-chat-pending-request'].finalResponse.text, answer);
    assert.equal(f.storage['zentra-chat-history'], undefined);
    first.close(); const before = f.state.requests;
    // Reopen before any history acknowledgement; recover solely from durable pending.
    f.queued.length = 0; f.state.holdHistory = false;
    const second = f.popup(); await f.hydrate(second);
    assert.equal(second.bot.conversation.at(-1).content, answer); assert.equal(f.state.requests, before);
    assert.equal(second.bot.conversation[0].type, 'user');
    assert.equal(second.bot.conversation[0].content, prompt);
  } finally { f.close(); }
});
test('delayed history write keeps pending until confirmation and finalization is idempotent', async () => {
  const f = fixture();
  try {
    const p = f.popup(); f.state.holdHistory = true; const run = f.start(p); await f.flush();
    assert.ok(f.storage['zentra-chat-pending-request']); f.release(); await run;
    assert.equal(f.storage['zentra-chat-pending-request'], undefined);
    await p.bot.finalizeAssistantDraftMessage(null, answer, { operationId });
    assert.equal(p.bot.conversation.filter(e => e.type === 'assistant').length, 1);
  } finally { f.close(); }
});
test('history write error preserves final pending; reopen finishes persistence without regeneration', async () => {
  const f = fixture();
  try {
    const first = f.popup(); f.state.failHistory = true; await f.start(first);
    assert.equal(f.storage['zentra-chat-pending-request'].lifecycle, 'finalizing'); first.close();
    const before = f.state.requests; f.state.failHistory = false; f.state.failUsage = true;
    const second = f.popup(); await f.hydrate(second);
    assert.equal(second.bot.conversation.at(-1).content, answer);
    assert.equal(f.storage['zentra-chat-pending-request'], undefined); assert.equal(f.state.requests, before);
    assert.ok(f.logs.some(row => String(row).includes('History storage write failed')));
    assert.ok(!JSON.stringify(f.logs).includes('sensitive fixture'));
  } finally { f.close(); }
});
test('useful layer followed by error remains provisional and pending, same operation on retry', async () => {
  const f = fixture();
  try {
    f.state.mode = 'layer-error'; const first = f.popup(); await f.start(first);
    const pending = f.storage['zentra-chat-pending-request'];
    assert.equal(pending.operationId, operationId); assert.equal(pending.lifecycle, 'pending');
    assert.equal(pending.recoverableDraft.text, answer); assert.equal(first.bot.removed, undefined);
    assert.equal(f.storage['zentra-chat-history'].conversation.some(e => e.type === 'assistant'), false);
    first.close(); f.state.mode = 'complete'; const second = f.popup(); await f.hydrate(second);
    assert.equal(second.bot.conversation.at(-1).lifecycle, 'complete');
    assert.equal(f.state.providers, 1); assert.equal(f.state.debits, 1); assert.deepEqual(f.ids, [operationId, operationId]);
  } finally { f.close(); }
});
test('usage 429 cannot erase recoverable layer on reopen or final response after delivery', async () => {
  const f = fixture();
  try {
    f.state.mode = 'layer-error'; const first = f.popup(); await f.start(first); first.close();
    f.state.failUsage = true; const before = f.state.requests; const second = f.popup(); await f.hydrate(second);
    assert.ok(f.storage['zentra-chat-pending-request'].recoverableDraft); assert.equal(f.state.requests, before);
    assert.equal(second.bot.isLoading, false);
    f.state.failUsage = false; f.state.failRefresh = true; f.state.mode = 'complete'; await second.bot.resumePendingChatRequest();
    assert.equal(second.bot.conversation.at(-1).content, answer); assert.equal(f.state.debits, 1);
  } finally { f.close(); }
});
test('completed history plus stale pending clears pending without usage or generation', async () => {
  const f = fixture();
  try {
    const first = f.popup(); await f.start(first);
    await first.bot.savePendingChatRequest({ message: prompt, operationId }); first.close();
    f.state.failUsage = true; const before = f.state.requests; const second = f.popup(); await f.hydrate(second);
    assert.equal(f.state.requests, before); assert.equal(f.storage['zentra-chat-pending-request'], undefined);
    assert.equal(second.bot.conversation.filter(e => e.type === 'assistant').length, 1);
  } finally { f.close(); }
});
test('pending checkpoint error retains original operation and failed history never clears it', async () => {
  const f = fixture();
  try {
    const p = f.popup(); p.bot.addUserMessage(prompt);
    await p.bot.savePendingChatRequest({ message: prompt, operationId });
    f.state.failPending = true; f.state.failHistory = true;
    await p.bot.runChatRequest({ message: prompt, subscriptionManager: p.w.zentraSubscription });
    assert.equal(f.storage['zentra-chat-pending-request'].operationId, operationId);
  } finally { f.close(); }
});
test('empty final output never promotes a provisional layer to completed history', async () => {
  const f = fixture();
  try {
    const p = f.popup();
    const result = await p.bot.finalizeAssistantDraftMessage({ lastLiveText: answer }, '', { operationId });
    assert.equal(result, false); assert.equal(p.bot.conversation.length, 0);
  } finally { f.close(); }
});
