import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {prepareChatStep, buildChatExecutionBody} from './release-refinements.js';

const extension = new URL('../STAGING/ZENTRA_AI_CHROME_LAB_STAGING/claude-chatbot.js', import.meta.url);
const trusted = new URL('./trusted-chat-builders.js', import.meta.url);
const origin = 'https://example.test/origin?case=a#current';
const other = 'https://example.test/other?case=b#current';
const request = 'Armá el enlace de WhatsApp para consultar por las promociones que hablamos';
const phone = '34900000000'; // Synthetic fixture; no links are opened or sent.
const text = 'MARCADOR_HILO_A. Promociones de Halloween del 28 al 31 de octubre: A 10 EUR, B 20 EUR, C 30 EUR. Mencionar Halloween en el enlace. '
  + 'Enlace anterior: https://api.whatsapp.com/send/?phone=' + phone + '&text=Consulta%20de%20mayo';
const clone = value => JSON.parse(JSON.stringify(value));
function makeBot(path = extension, mode = 'work') {
  const storage = new Map();
  const box = vm.createContext({window:{ZentraDisplay:{isWork:mode === 'work',sync:async()=>{}}},
    document:{addEventListener(){},getElementById(){return null;}}, URL,URLSearchParams,Blob,
    chrome:{storage:{local:{set(data, cb){for(const [k,v] of Object.entries(data))storage.set(k,clone(v));cb?.();},
      get(keys,cb){cb(Object.fromEntries(keys.filter(k=>storage.has(k)).map(k=>[k,storage.get(k)])));},
      remove(keys,cb){for(const k of keys)storage.delete(k);cb?.();}}},runtime:{}},
    localStorage:{getItem:k=>storage.get('fallback:'+k) || null,setItem:(k,v)=>storage.set('fallback:'+k,v),removeItem:k=>storage.delete('fallback:'+k)},
    fetch(){assert.fail('Network forbidden');},console:{log(){},info(){},warn(){},error(){}}});
  new vm.Script(fs.readFileSync(path,'utf8')).runInContext(box);
  const bot=Object.create(box.window.ClaudeChatbot.prototype);
  Object.assign(bot,{conversation:[],documentContexts:[],taskMemory:{},siteContextCache:new Map(),elements:{},
    webContext:{url:other,title:'Página sintética'},isContextLoaded:true,model:'synthetic',maxTokens:800,
    lastInputModality:'text',maxSavedConversations:11,savedConversationsStorageKey:'zentra-saved-conversations',
    activeSavedConversationId:'',restoredConversationId:'',saveTaskMemory(){},restoreChatMessages(){},
    closeSavedConversationsModal(){},traceImageOcrStage(){},debugLog(){},createMessageElement(){return {};},
    updateChatInputPlaceholder(){},clearChatScrollState(){},clearDraft(){},renderInitialState(){}});
  return {bot,box,storage};
}
function saved(id='saved-a',page=origin,content=text) {
  return {id,title:'Caso sintético',conversation:[
    {type:'user',content,contextMeta:{pageUrl:page,conversationContactId:id}},
    {type:'assistant',content:'Borradores de las promociones de Halloween disponibles.',contextMeta:{pageUrl:page,conversationContactId:id}}
  ]};
}
async function restore(bot,items=[saved()],id=items[0].id) {
  bot.getSavedConversations=async()=>bot.normalizeSavedConversations(items);
  await bot.continueSavedConversation(id);
}

for(const mode of ['quick','work']) for(const url of [origin,other]) {
  test(mode+': explicit restoration retains source and retrieves reference from '+(url===origin?'original':'different')+' URL',async()=>{
    const {bot}=makeBot(extension,mode);bot.webContext.url=url;
    const items=Array.from({length:11},(_,i)=>saved('saved-'+i,origin,text));const before=JSON.stringify(items);
    await restore(bot,items,'saved-0');
    const entries=bot.selectConversationHistoryForRequest(request,bot.conversation);
    assert.ok(entries.some(entry=>entry.content===text));assert.ok(entries.length<=7);
    assert.ok(entries.every(entry=>entry.contextMeta.pageUrl===origin));
    assert.equal(bot.activeSavedConversationId,bot.restoredConversationId);
    assert.equal(JSON.stringify(items),before,'11 stored records must not be mutated');
  });
}
for(const path of [extension,trusted]) test(path===extension?'extension: no restoration keeps URL isolation':'trusted: no restoration keeps URL isolation',()=>{
  const {bot}=makeBot(path);bot.conversation=saved().conversation;
  bot.activeSavedConversationId='saved-a'; // Saving is not explicit restoration.
  assert.equal(bot.selectConversationHistoryForRequest(request,bot.conversation,true).length,0);
  bot.webContext.url=origin;
  assert.ok(bot.selectConversationHistoryForRequest(request,bot.conversation).some(entry=>entry.content===text));
});

test('switching saved threads, foreign membership, and ambiguous multi-client workflows do not mix evidence',async()=>{
  const {bot}=makeBot();const b=saved('saved-b','https://example.test/b','MARCADOR_HILO_B. Promociones de Halloween: otro cliente, condiciones diferentes y teléfono ficticio independiente.');
  await restore(bot,[saved(),b]);const old=clone(bot.conversation);
  await restore(bot,[saved(),b],'saved-b');
  const selected=bot.selectConversationHistoryForRequest(request,bot.conversation.concat(old));
  assert.ok(selected.some(entry=>entry.content.includes('MARCADOR_HILO_B')));
  assert.ok(!selected.some(entry=>entry.content.includes('MARCADOR_HILO_A')));
  await restore(bot,[{...saved(),conversation:[...saved().conversation,...b.conversation]}]);
  assert.equal(bot.getRestoredConversationSelection(request,bot.conversation).ambiguous,true);
  assert.equal(bot.selectConversationHistoryForRequest(request,bot.conversation).length,0);
  assert.equal(bot.findRecentWhatsAppUrl(request),'');
});

test('legacy turns need no migration; explicit page requests do not use restored history',async()=>{
  const {bot}=makeBot();const item=saved();item.conversation.forEach(entry=>delete entry.contextMeta);
  await restore(bot,[item]);
  assert.ok(bot.selectConversationHistoryForRequest(request,bot.conversation).some(entry=>entry.content===text));
  assert.equal(bot.usesRestoredConversation('Analizá esta página usando las promociones que hablamos'),false);
});

test('active-history persistence survives reopen and clear does not delete saved conversations',async()=>{
  const {bot,storage,box}=makeBot();storage.set('zentra-saved-conversations',[saved()]);
  await restore(bot);await bot.saveChatHistory();
  const active=storage.get('zentra-chat-history');
  // Exercise the actual chrome.storage hydration against the same active record.
  box.chrome.storage.local.get=(keys,cb)=>cb({'zentra-chat-history':active});
  bot.conversation=[];bot.activeSavedConversationId='';bot.restoredConversationId='';
  await bot.loadChatHistory();
  assert.ok(bot.selectConversationHistoryForRequest(request,bot.conversation).some(entry=>entry.content===text));
  bot.clearChatHistory();
  assert.equal(bot.restoredConversationId,'');assert.equal(bot.activeSavedConversationId,'');
  assert.equal(bot.selectConversationHistoryForRequest(request,bot.conversation).length,0);
  assert.equal(storage.get('zentra-saved-conversations').length,1);
  await restore(bot);storage.set('fallback:zentra-chat-history',JSON.stringify(storage.get('zentra-chat-history')));
  bot.restoredConversationId='';bot._loadFromLocalStorage();
  assert.equal(bot.restoredConversationId,'saved-a');
  storage.set('fallback:zentra-chat-history',JSON.stringify({...active,restoredConversationId:'stale-id'}));
  bot._loadFromLocalStorage();assert.equal(bot.restoredConversationId,'');
});

test('retrospective metadata labels recovered conversation, without changing page provenance or current CRM identity',async()=>{
  const {bot}=makeBot();await restore(bot);
  bot.webContext={url:other,conversationContext:{contact:{id:'current-b'}}};
  bot.lastPromptBuildMeta={userMessage:request};
  const contract=bot.detectResponseContract({userMessage:request,interactionMeta:{source:'direct',mode:'direct_conversation'}});
  const meta=bot.buildTurnContextMeta(null,contract);
  assert.equal(meta.contextLabel,'Conversación recuperada');assert.equal(meta.pageUrl,other);
  assert.equal(meta.pageEvidenceUsed,false);assert.equal(meta.conversationContactId,undefined);
  bot.webContext=null;assert.equal(bot.buildTurnContextMeta(null,contract).contextLabel,'Conversación recuperada');
  bot.webContext={url:other};bot.addUserMessage('La promoción que hablamos B ahora cuesta 25 EUR.',null,{pageUrl:other});
  assert.ok(bot.selectConversationHistoryForRequest(request,bot.conversation).some(entry=>entry.content.includes('25 EUR')));
});

test('WhatsApp uses original user recipient and Halloween across URL change; Self-Check still rejects wrong month/phone',async()=>{
  const {bot}=makeBot();await restore(bot);
  for(let i=0;i<8;i++)bot.conversation.push({type:i%2?'assistant':'user',content:'Turno neutro sintético.',contextMeta:clone(bot.conversation[0].contextMeta)});
  const edit='Incluí las promociones que hablamos en el enlace de WhatsApp';
  const spec=bot.getUrlTransformationSpec(edit);
  assert.ok(spec);assert.equal(spec.phone,phone);assert.equal(spec.promotionName,'Halloween');
  assert.equal(bot.buildWhatsAppLinkTransformationFallback(spec),'','Complex requests stay on the model path');
  const simple=bot.getUrlTransformationSpec('Debes nombrar la promoción de Halloween en el link de WhatsApp');
  const result=bot.buildWhatsAppLinkTransformationFallback(simple);
  assert.ok(bot.evaluateUrlTransformationResponse(spec,result).valid);
  assert.equal(bot.parseWhatsAppLink(bot.extractExactHttpUrls(result)[0]).phone,phone);
  assert.equal(bot.evaluateUrlTransformationResponse(spec,result.replace(phone,'34911111111')).valid,false);
  assert.equal(bot.evaluateUrlTransformationResponse(spec,result.replaceAll('Halloween','Mayo')).valid,false);
  // Pin validator and fallback logic, not the ownership lookup intentionally corrected here.
  for(const path of [extension,trusted]) {
    const cwd=path===extension?new URL('../STAGING/ZENTRA_AI_CHROME_LAB_STAGING/',import.meta.url):new URL('./',import.meta.url);
    const old=execFileSync('git',['show','HEAD:'+path.pathname.split('/').at(-1)],{cwd,encoding:'utf8'});
    const current=fs.readFileSync(path,'utf8');
    const part=s=>s.slice(s.indexOf('  evaluateUrlTransformationResponse('),s.indexOf('  isInvalidDirectTextOrganizationResponse('));
    assert.equal(part(current),part(old));
  }
});

test('retrieval remains forty observed turns and at most seven transmitted turns',async()=>{
  const {bot}=makeBot();await restore(bot);
  for(let i=0;i<10;i++)bot.conversation.push({type:'user',content:'Turno neutro.',contextMeta:clone(bot.conversation[0].contextMeta)});
  assert.ok(bot.selectConversationHistoryForRequest(request,bot.conversation).length<=7);
  for(let i=0;i<40;i++)bot.conversation.push({type:'user',content:'Turno neutro.',contextMeta:clone(bot.conversation[0].contextMeta)});
  assert.ok(!bot.selectConversationHistoryForRequest(request,bot.conversation).some(entry=>entry.content===text));
});

test('recipient supplied separately from promotions survives the same seven-turn selection',async()=>{
  const {bot}=makeBot();const item=saved();
  const meta=clone(item.conversation[0].contextMeta);
  const promotionsOnly=text.split('Enlace anterior:')[0];
  item.conversation=[{type:'user',content:'WhatsApp: '+phone+'. https://api.whatsapp.com/send/?phone='+phone+'&text=mayo',contextMeta:meta}];
  for(let i=0;i<4;i++)item.conversation.push({type:i%2?'assistant':'user',content:'Turno neutro.',contextMeta:clone(meta)});
  item.conversation.push({type:'user',content:promotionsOnly,contextMeta:clone(meta)});
  for(let i=0;i<8;i++)item.conversation.push({type:i%2?'user':'assistant',content:'Turno neutro.',contextMeta:clone(meta)});
  await restore(bot,[item]);
  const selection=bot.selectConversationHistoryForRequest(request,bot.conversation);
  assert.ok(selection.length<=7);assert.ok(selection.some(entry=>entry.content.includes(phone)));
  assert.ok(selection.some(entry=>entry.content===promotionsOnly));
  assert.equal(bot.getUrlTransformationSpec('Incluí las promociones que hablamos en el enlace de WhatsApp').phone,phone);
});

for(const [mode,input] of [['quick',request],['work',request],['work','¿Qué teléfono y fechas definimos en esta conversación?'],['work','Incluí Halloween en el enlace de WhatsApp']]) test(mode+': restored history reaches actual request, snapshot and authorized execution; '+(input===request?'promotions':input.includes('Incluí')?'link edit':'generic retrospective'),async()=>{
  const {bot,box}=makeBot(extension,mode);await restore(bot);
  bot.webContext={url:other,title:'MARCADOR_CLIENTE_ACTUAL',conversationContext:{schema_version:'zentra.conversation.v1',platform:'respond.io',type:'conversation',contact:{id:'b'},messages:[{id:'1',type:'text',direction:'incoming',text:'MARCADOR_CLIENTE_ACTUAL'}]}};
  bot.addUserMessage(input,null,{pageUrl:other});
  const captured={};const stop=Object.assign(new Error('STOP_MOCK_TRANSPORT'),{code:'chat_cancelled'});
  Object.assign(bot,{refreshWebContext:async()=>{},getEnvironmentContextSummary:()=>null,upsertTaskMemoryFromTurn(){},
    getRoutingConfig:async()=>({selectedModel:'synthetic',maxTokens:800}),recordDebugSample(){},
    shouldUseLayeredStrategicStream:()=>false,apiProvider:{sendMessages:async({body})=>{captured.body=body;throw stop;}}});
  box.window.zentraOperations={setChatContext:snapshot=>{captured.snapshot=clone(snapshot);}};
  await assert.rejects(()=>bot.sendToAPI(input,null,{interactionMeta:{source:'direct',mode:'direct_conversation',modality:'text'}}),error=>error===stop);
  assert.ok(JSON.stringify(captured.body.messages).includes('MARCADOR_HILO_A'));
  assert.ok(!JSON.stringify(captured.body.messages).includes('MARCADOR_CLIENTE_ACTUAL'));
  assert.equal(captured.snapshot.state.restoredConversationId,'saved-a');
  assert.equal(captured.snapshot.state.activeSavedConversationId,'saved-a');
  assert.ok(captured.snapshot.state.conversation.length<=8);
  assert.ok(captured.snapshot.state.conversation.some(entry=>entry.content===text&&entry.contextMeta.pageUrl===origin));
  const calls=[];
  const client={async rpc(name,args){calls.push(name);
    if(name==='zentra_read_chat_steps')return {data:{}};
    if(name==='zentra_access')return {data:{plan:'free',status:'active'}};
    if(name==='zentra_register_chat_step')return {data:{allowed:true,body:args.p_body,root_hash:'synthetic'}};
    assert.fail('Unexpected RPC');}};
  const prepared=await prepareChatStep({client,identity:{userId:'synthetic',email:'fixture@example.test'},product:'subscription',operationId:'synthetic',body:clone({...captured.body,zentra_workflow:captured.snapshot})});
  assert.ok(!prepared.conflict);
  const executed=await buildChatExecutionBody(prepared,{plan:'free',status:'active'});
  assert.ok(JSON.stringify(executed.messages).includes('MARCADOR_HILO_A'));
  assert.ok(!JSON.stringify(executed.messages).includes('MARCADOR_CLIENTE_ACTUAL'));
  assert.ok(!executed.messages[0].content.includes('MARCADOR_HILO_A'),'History must remain data, never privileged instructions');
  assert.deepEqual(calls,['zentra_read_chat_steps','zentra_access','zentra_register_chat_step']);
});
