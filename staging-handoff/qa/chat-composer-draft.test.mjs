import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {JSDOM}=require('jsdom');
// QA-only dependency: use an isolated npm runtime via ZENTRA_DRAFT_QA_RUNTIME,
// or install fake-indexeddb in the existing QA dependency directory.
const {IDBFactory}=(process.env.ZENTRA_DRAFT_QA_RUNTIME ? createRequire(process.env.ZENTRA_DRAFT_QA_RUNTIME) : require)('fake-indexeddb');
const root=process.env.ZENTRA_CHAT_ROOT || '/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/STAGING/ZENTRA_AI_CHROME_LAB_STAGING';
const createStore=require(root+'/chat-draft-store.js');
const source=readFileSync(root+'/claude-chatbot.js','utf8');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=';
const image=n=>({name:`image-${n}.png`,type:'image/png',size:68,base64:'data:image/png;base64,'+png});
function environment() {
 const indexedDB=new IDBFactory(),sessionValues={},storage={};let tick=0,clock=Date.now();
 const session={get:async key=>({[key]:sessionValues[key]}),set:async values=>Object.assign(sessionValues,values)};
 const store=()=>createStore({indexedDB,session,randomId:()=>`id-${++tick}`,now:()=>clock});
 const chrome={runtime:{},storage:{local:{get:(keys,cb)=>cb(Object.fromEntries(keys.map(k=>[k,storage[k]]))),set:(v,cb)=>{Object.assign(storage,structuredClone(v));cb?.();},remove:(keys,cb)=>{for(const k of Array.isArray(keys)?keys:[keys])delete storage[k];cb?.();}}}};
 function popup(user='account-a',thread='',contact='') {
  const dom=new JSDOM('<textarea></textarea><div id="images"></div><div id="document"></div>',{url:'https://extension.test'});
  const window={ZentraChatDraftStore:store(),__zentraUserId:user,URL,zentraSubscription:{getCurrentUserId:()=>window.__zentraUserId}};
  const sandbox=vm.createContext({window,document:dom.window.document,chrome,localStorage:dom.window.localStorage,URL,URLSearchParams,Blob,crypto:globalThis.crypto,console:{log(){},warn(){},error(){}}});
  new vm.Script(source).runInContext(sandbox);
  const bot=Object.create(sandbox.window.ClaudeChatbot.prototype);
  Object.assign(bot,{elements:{input:dom.window.document.querySelector('textarea'),imagePreview:dom.window.document.getElementById('images'),documentPreview:dom.window.document.getElementById('document')},pendingImages:[],pendingDocument:null,documentAttachmentPreviews:new Map(),conversation:[],documentContexts:[],taskMemory:{},maxPendingImages:10,maxDocumentBytes:10*1024*1024,maxDocumentContexts:3,maxDocumentContextChars:48000,activeSavedConversationId:thread,webContext:contact?{conversationContext:{platform:'respond.io',contact:{id:contact}}}:null,pendingChatStorageKey:'pending',draftStorageKey:'legacy-draft',isLoading:false,isSubmitting:false});
  bot.updateChatInputPlaceholder=()=>{};bot.addSystemMessage=()=>{};
  const close=()=>{bot.clearDocumentAttachmentPreviews();dom.window.close();};
  return {bot,window,close};
 }
 return {popup,store,sessionValues,storage,setClock:value=>{clock=value;},getClock:()=>clock};
}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function sending(env,p){
 const gate=deferred(),started=deferred();let calls=0;
 p.window.zentraOperations={begin(){},end(){}};
 p.window.zentraSubscription.getUserState=async()=>({});
 p.window.zentraSubscription.canUseAction=()=>({allowed:true});
 p.window.zentraSubscription.consumeAction=async()=>{};
 Object.assign(p.bot,{
  addUserMessage(message){this.conversation.push({type:'user',content:message});},
  detectInteractionMode:()=>({}),createAssistantDraftForRequest:()=>({}),
  getEnvironmentContextSummary:()=>'',detectContextualSurface:()=>({key:'generic'}),
  isGuideStyleRequest:()=>false,removeAssistantDraftMessage:()=>{},
  buildSafeAccountAccessGuideFallback:()=>null,debugLog:()=>{},
  sendToAPI:async()=>{calls++;started.resolve();return gate.promise;},
  finalizeAssistantDraftMessage:async()=>{const pending=await p.bot.loadPendingChatRequest();env.storage['zentra-chat-history']={completedOperationId:pending.operationId};return true;}
 });
 return {gate,started,calls:()=>calls};
}
const longTranscript='Resumime qué se resolvió durante esta llamada, qué quedó pendiente y redactame un mensaje para cerrar temporalmente el caso con el cliente hasta que nos envíe el material faltante.\n\n'+Array.from({length:772},(_,n)=>`${Math.floor(n/60)}:${String(n%60).padStart(2,'0')} ${n%2?'Cliente':'Agente'}: Mensaje sintético de seguimiento, material pendiente y tarea confirmada número ${n}.`).join('\n');
for(const [label,text] of [['short','Consulta sintética'],['13-minute transcript',longTranscript]])test(`QA008 accepted ${label}: empty editor while real async lifecycle is processing`,async()=>{
 const env=environment(),p=env.popup();await p.bot.restoreDraft();p.bot.elements.input.value=text;await p.bot.saveDraft();
 const f=sending(env,p),request=p.bot.handleSendMessage();await f.started.promise;
 const visible=p.bot.elements.input.value;f.gate.resolve({text:'Respuesta sintética'});await request;
 assert.equal(visible,'');assert.equal(p.bot.conversation.filter(m=>m.type==='user').length,1);p.close();
});
test('QA008 duplicate click before acceptance and during processing: one request',async()=>{
 const env=environment(),p=env.popup();await p.bot.restoreDraft();p.bot.elements.input.value=longTranscript;
 const f=sending(env,p),access=deferred();p.window.zentraSubscription.getUserState=()=>access.promise;
 const first=p.bot.handleSendMessage();await p.bot.handleSendMessage();access.resolve({});await f.started.promise;
 await p.bot.handleSendMessage();f.gate.resolve({text:'Respuesta sintética'});await first;assert.equal(f.calls(),1);p.close();
});
test('QA008 accepted draft stays hidden on reopen during processing and gone after completion',async()=>{
 const env=environment(),p=env.popup();await p.bot.restoreDraft();p.bot.elements.input.value=longTranscript;await p.bot.saveDraft();
 const f=sending(env,p),request=p.bot.handleSendMessage();await f.started.promise;
 let reopened=env.popup();await reopened.bot.restoreDraft();const during=reopened.bot.elements.input.value;reopened.close();
 f.gate.resolve({text:'Respuesta sintética'});await request;p.close();reopened=env.popup();await reopened.bot.restoreDraft();
 assert.equal(during,'');assert.equal(reopened.bot.elements.input.value,'');reopened.close();
});
test('QA008 pre-acceptance persistence failure keeps text, image and original document',async()=>{
 const env=environment(),p=env.popup();await p.bot.restoreDraft();await p.bot.addPendingImageAttachment(image('A'));
 await p.bot.handleDocumentSelect({target:{files:[new File(['Contenido sintético'],'test.txt',{type:'text/plain'})]}});
 p.bot.elements.input.value=longTranscript;await p.bot.saveDraft();const f=sending(env,p);
 p.bot.savePendingChatRequest=async()=>false;f.gate.resolve({text:'Respuesta sintética'});await p.bot.handleSendMessage();assert.equal(f.calls(),0);
 p.close();const reopened=env.popup();await reopened.bot.restoreDraft();assert.equal(reopened.bot.elements.input.value,longTranscript);
 assert.equal(reopened.bot.pendingImages.length,1);assert.equal(await reopened.bot.pendingDocumentBlob.text(),'Contenido sintético');reopened.close();
});
test('QA008 accepted attachments detach during processing; failure restores recoverable revision',async()=>{
 const env=environment(),p=env.popup();await p.bot.restoreDraft();await p.bot.addPendingImageAttachment(image('A'));p.bot.elements.input.value='Adjunto sintético';await p.bot.saveDraft();
 const f=sending(env,p),request=p.bot.handleSendMessage();await f.started.promise;const during=p.bot.pendingImages.length;
 f.gate.reject(new Error('Fallo sintético'));await request;
 assert.equal(during,0);assert.equal(p.bot.elements.input.value,'Adjunto sintético');assert.equal(p.bot.pendingImages.length,1);
 p.close();const reopened=env.popup();await reopened.bot.restoreDraft();assert.equal(reopened.bot.pendingImages.length,1);reopened.close();
});
test('QA008 new draft during processing survives late successful completion and reopen',async()=>{
 const env=environment(),p=env.popup();await p.bot.restoreDraft();p.bot.elements.input.value=longTranscript;await p.bot.saveDraft();
 const f=sending(env,p),request=p.bot.handleSendMessage();await f.started.promise;
 p.bot.elements.input.value='Nueva consulta';await p.bot.saveDraft();f.gate.resolve({text:'Respuesta sintética'});await request;
 assert.equal(p.bot.elements.input.value,'Nueva consulta');p.close();const reopened=env.popup();await reopened.bot.restoreDraft();assert.equal(reopened.bot.elements.input.value,'Nueva consulta');reopened.close();
});
test('QA008 editing during async access check preserves the newer draft, not the submitted snapshot',async()=>{
 const env=environment(),p=env.popup();await p.bot.restoreDraft();p.bot.elements.input.value=longTranscript;await p.bot.saveDraft();
 const f=sending(env,p),access=deferred(),checking=deferred();p.window.zentraSubscription.getUserState=()=>{checking.resolve();return access.promise;};
 const request=p.bot.handleSendMessage();await checking.promise;p.bot.elements.input.value='Nuevo borrador durante aceptación';await p.bot.saveDraft();
 access.resolve({});await f.started.promise;assert.equal(p.bot.elements.input.value,'Nuevo borrador durante aceptación');
 f.gate.resolve({text:'Respuesta sintética'});await request;p.close();const reopened=env.popup();await reopened.bot.restoreDraft();
 assert.equal(reopened.bot.elements.input.value,'Nuevo borrador durante aceptación');reopened.close();
});
test('QA008 late IndexedDB hydration cannot resurrect accepted text or erase unsaved new edits',async()=>{
 const env=environment(),p=env.popup();await p.bot.restoreDraft();p.bot.elements.input.value=longTranscript;await p.bot.saveDraft();
 const oldLoad=p.window.ZentraChatDraftStore.load,loaded=deferred(),release=deferred();
 p.window.ZentraChatDraftStore.load=async scope=>{const row=await oldLoad(scope);loaded.resolve();await release.promise;return row;};
 const hydration=p.bot.restoreDraft();await loaded.promise;
 const f=sending(env,p),request=p.bot.handleSendMessage();await f.started.promise;
 p.bot.elements.input.value='Nueva edición sin guardar';release.resolve();await hydration;const visible=p.bot.elements.input.value;
 f.gate.resolve({text:'Respuesta sintética'});await request;assert.equal(visible,'Nueva edición sin guardar');assert.equal(p.bot.elements.input.value,visible);p.close();
});
test('paste A, destroy popup VM/DOM, recreate: recover A; paste B and repeat without duplicates',async()=>{
 const env=environment();let p=env.popup();await p.bot.restoreDraft();
 p.bot.compressImage=async()=>image('A');
 await p.bot.handlePaste({preventDefault(){},clipboardData:{items:[{type:'image/png',getAsFile:()=>({size:30})}]}});
 p.close();p=env.popup();await p.bot.restoreDraft();
 assert.equal(p.bot.pendingImages.length,1);assert.equal(p.bot.pendingImages[0].base64,image('A').base64);
 assert.equal(p.bot.elements.imagePreview.querySelectorAll('img').length,1);
 p.bot.compressImage=async()=>image('B');
 await p.bot.handlePaste({preventDefault(){},clipboardData:{items:[{type:'image/png',getAsFile:()=>({size:30})}]}});
 p.close();
 for(let i=0;i<3;i++){p=env.popup();await p.bot.restoreDraft();assert.deepEqual(Array.from(p.bot.pendingImages,m=>m.base64),[image('A').base64,image('B').base64]);p.close();}
});
test('image selector and text survive actual recreation; removing one persists order and payload',async()=>{
 const env=environment();let p=env.popup();await p.bot.restoreDraft();
 p.bot.compressImage=async file=>image(file.name);
 await p.bot.handleImageSelect({target:{files:[{name:'A',type:'image/png',size:30},{name:'B',type:'image/png',size:30}]}});
 p.bot.elements.input.value='Synthetic draft question';await p.bot.saveDraft();p.close();
 p=env.popup();await p.bot.restoreDraft();assert.equal(p.bot.elements.input.value,'Synthetic draft question');
 p.bot.removePendingImageAt(0);await p.bot.composerDraftWrites;p.close();
 p=env.popup();await p.bot.restoreDraft();const payload=p.bot.buildImagePayloadFromAttachments(p.bot.pendingImages);
 assert.equal(payload.images.length,1);assert.equal(payload.images[0].base64,image('B').base64);p.close();
});
test('document selector preserves extracted context and original Blob; preview is recreated not reused',async()=>{
 const env=environment();let p=env.popup();await p.bot.restoreDraft();
 const file=new File(['Synthetic document text'],'test.txt',{type:'text/plain'});
 await p.bot.handleDocumentSelect({target:{files:[file]}});
 const oldURL=p.bot.pendingDocument.previewUrl;p.close();p=env.popup();await p.bot.restoreDraft();
 assert.equal(p.bot.pendingDocument.name,'test.txt');assert.equal(p.bot.pendingDocument.text,'Synthetic document text');
 assert.equal(await p.bot.pendingDocumentBlob.text(),'Synthetic document text');
 assert.ok(p.bot.pendingDocument.previewUrl.startsWith('blob:'));assert.notEqual(p.bot.pendingDocument.previewUrl,oldURL);
 p.bot.clearPendingDocument();await p.bot.composerDraftWrites;p.close();p=env.popup();await p.bot.restoreDraft();assert.equal(p.bot.pendingDocument,null);p.close();
});
test('confirmed completion cleans only its revision; newer edits are not erased',async()=>{
 const env=environment();let p=env.popup();await p.bot.restoreDraft();await p.bot.addPendingImageAttachment(image('A'));
 p.bot.elements.input.value='Request';const original=await p.bot.saveDraft();
 p.close();p=env.popup();await p.bot.restoreDraft();assert.equal(p.bot.pendingImages.length,1);assert.equal(p.bot.elements.input.value,'Request');
 await p.bot.completeComposerDraft(original);assert.equal(p.bot.pendingImages.length,0);p.close();
 p=env.popup();await p.bot.restoreDraft();assert.equal(p.bot.elements.input.value,'');
 p.bot.elements.input.value='First';const first=await p.bot.saveDraft();p.bot.elements.input.value='New edit';await p.bot.saveDraft();
 await p.bot.completeComposerDraft(first);assert.equal(p.bot.elements.input.value,'New edit');p.close();p=env.popup();await p.bot.restoreDraft();assert.equal(p.bot.elements.input.value,'New edit');p.close();
});

for (const result of ['failure','blocked','unconfirmed','success']) test(`real request lifecycle ${result}: draft cleanup follows durable completion only`,async()=>{
 const env=environment();let p=env.popup();const bot=p.bot;
 await bot.restoreDraft();await bot.addPendingImageAttachment(image('A'));
 bot.elements.input.value='Synthetic request';const reference=await bot.saveDraft();
 await bot.savePendingChatRequest({operationId:'synthetic-op',message:'Synthetic request',composerDraft:reference});
 p.window.zentraOperations={begin(){},end(){}};
 bot.sendToAPI=async()=>{
  if(result==='failure')throw new Error('Synthetic offline failure');
  if(result==='blocked')throw Object.assign(new Error('Synthetic blocked'),{code:'free_access_blocked',commercial:{}});
  return {text:'Synthetic completed answer'};
 };
 bot.getEnvironmentContextSummary=()=>'';bot.detectContextualSurface=()=>({key:'generic'});
 bot.isGuideStyleRequest=()=>false;bot.removeAssistantDraftMessage=()=>{};
 bot.buildSafeAccountAccessGuideFallback=()=>null;bot.debugLog=()=>{};
 bot.finalizeAssistantDraftMessage=async()=>{
  if(result==='unconfirmed')return false;
  env.storage['zentra-chat-history']={completedOperationId:'synthetic-op'};return true;
 };
 await bot.runChatRequest({message:'Synthetic request',assistantDraft:{lastLiveText:''},subscriptionManager:null});
 assert.equal(bot.pendingImages.length,result==='success'?0:1);p.close();
 p=env.popup();await p.bot.restoreDraft();
 assert.equal(p.bot.pendingImages.length,result==='success'?0:1);
 assert.equal(p.bot.elements.input.value,result==='success'?'':'Synthetic request');p.close();
});

test('send captures restored text and images in order without sending to a real provider',async()=>{
 const env=environment();let p=env.popup();await p.bot.restoreDraft();
 await p.bot.addPendingImageAttachment(image('A'));await p.bot.addPendingImageAttachment(image('B'));
 p.bot.elements.input.value='Synthetic question';await p.bot.saveDraft();p.close();
 p=env.popup();await p.bot.restoreDraft();
 p.window.zentraSubscription.getUserState=async()=>({});
 p.window.zentraSubscription.canUseAction=()=>({allowed:true});
 p.bot.addUserMessage=()=>{};p.bot.detectInteractionMode=()=>({});
 p.bot.createAssistantDraftForRequest=()=>({});
 let sent;p.bot.runChatRequest=async payload=>{sent=payload;};
 await p.bot.handleSendMessage();
 assert.equal(sent.message,'Synthetic question');
 assert.deepEqual(Array.from(sent.imageData.images,i=>i.name),['image-A.png','image-B.png']);
 for(const i of sent.imageData.images)assert.equal(Buffer.from(i.base64.split(',')[1],'base64').subarray(1,4).toString(),'PNG');
 p.close();
});

test('local storage is bounded, rejects oversized documents and never persists guest drafts',async()=>{
 const env=environment(),store=env.store();assert.equal(await store.scope(''),null);
 const scope=await store.scope('a');
 await assert.rejects(store.save(scope,{documentBlob:new Blob([new Uint8Array(10*1024*1024+1)]),document:{name:'oversize.txt'}}));
 for(let n=0;n<store.limits.maxDrafts;n++)await store.save(await store.scope('a',`thread-${n}`),{text:'Small synthetic draft'});
 await assert.rejects(store.save(await store.scope('a','overflow'),{text:'Another draft'}));
 await assert.rejects(store.save(scope,{text:'a'.repeat(store.limits.maxBytes/2+1)}));
 assert.equal((await store.load(await store.scope('a','thread-0'))).text,'Small synthetic draft');
});
test('account, saved chat and browser session isolate drafts; voluntary attachments follow active chat across contacts',async()=>{
 const env=environment();let p=env.popup('account-a','chat-a','contact-a');await p.bot.restoreDraft();await p.bot.addPendingImageAttachment(image('A'));p.close();
 for(const args of [['account-b','chat-a','contact-a'],['account-a','chat-b','contact-a']]){p=env.popup(...args);await p.bot.restoreDraft();assert.equal(p.bot.pendingImages.length,0);p.close();}
 p=env.popup('account-a','chat-a','contact-b');await p.bot.restoreDraft();assert.equal(p.bot.pendingImages.length,1);assert.equal(p.bot.webContext.conversationContext.contact.id,'contact-b');p.close();
 p=env.popup('account-a','chat-a','contact-a');await p.bot.restoreDraft();assert.equal(p.bot.pendingImages.length,1);p.close();
 delete env.sessionValues['zentra-composer-session'];p=env.popup('account-a','chat-a','contact-a');await p.bot.restoreDraft();assert.equal(p.bot.pendingImages.length,0);p.close();
});
test('explicit discard is serialized after writes and temporary drafts expire',async()=>{
 const env=environment();let p=env.popup();await p.bot.restoreDraft();await p.bot.addPendingImageAttachment(image('A'));
 p.bot.elements.input.value='Discard';p.bot.saveDraft();p.bot.clearDraft();await p.bot.composerDraftWrites;p.close();
 p=env.popup();await p.bot.restoreDraft();assert.equal(p.bot.pendingImages.length,0);assert.equal(p.bot.elements.input.value,'');
 await p.bot.addPendingImageAttachment(image('B'));p.close();env.setClock(env.getClock()+25*60*60*1000);
 p=env.popup();await p.bot.restoreDraft();assert.equal(p.bot.pendingImages.length,0);p.close();
});
