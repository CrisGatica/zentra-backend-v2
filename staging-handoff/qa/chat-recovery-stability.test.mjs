import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createChatStatusHandler } from '../../release-chat-status.js';
import { createApiSecurity, requestFingerprint } from '../../release-security.js';
import { createOperationGuard } from '../../release-operations.js';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const root = process.env.ZENTRA_CHAT_ROOT;
assert.ok(root, 'Set ZENTRA_CHAT_ROOT to the STAGING extension');
const source = readFileSync(root + '/claude-chatbot.js', 'utf8');
const baseline = execFileSync('git', ['show', '5bf5ce758c9795fa70889297a22df5cd1b64d68a:claude-chatbot.js'], {cwd:root,encoding:'utf8'});
const id = '4ce01421-778a-4569-9e10-1c343896ec22';
const owner = 'verified-user';
const message = 'Adaptá el SEO de las páginas indicadas en el documento.';
const answer = 'Página principal: título y descripción revisados.\nPágina de servicios: mejoras propuestas con la evidencia disponible.';
const envelope = {
  messages: [{ role: 'system', content: 'Snapshot original' }, { role: 'user', content: message }],
  max_tokens: 3200, zentra_routing: { taskType: 'chat_basic' },
  zentra_operation: { id, product: 'subscription', source: message },
  zentra_workflow: { version: 1, userMessage: message, responseContract: { renderType: 'plain' },
    state: { documentContexts: [{ name: 'test.txt', text: 'Documento sintético original' }] } }
};
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };

function fixture(shared = {}, code = source) {
  const dom = new JSDOM('<body><div id="messages"></div><textarea id="input"></textarea></body>', {
    url: 'https://fixture.test/popup.html', runScripts: 'outside-only'
  });
  const w = dom.window;
  w.AbortController = AbortController; w.AbortSignal = AbortSignal;
  w.Response = Response; w.Headers = Headers; w.TextDecoder = TextDecoder;
  w.console = {log(){},warn(){},error(){}};
  w.__zentraUserId = owner;
  w.confirm = () => true;
  w.supabaseClient = {auth:{getSession:async()=>({data:{session:{access_token:'test-only',user:{id:w.__zentraUserId}}}})}};
  w.chrome = {runtime:{getManifest:()=>({name:'Zentra AI - STAGING'})},storage:{local:{
    get(keys,cb){cb(Object.fromEntries(keys.filter(k=>k in shared).map(k=>[k,structuredClone(shared[k])])));},
    set(values,cb){Object.assign(shared,structuredClone(values));cb?.();},
    remove(keys,cb){keys.forEach(k=>delete shared[k]);cb?.();}
  }}};
  w.fetch = () => assert.fail('External network forbidden');
  w.eval(readFileSync(root+'/zentra-api-client.js','utf8'));
  w.eval(readFileSync(root+'/ai-provider.js','utf8'));
  w.eval(code.slice(0,code.lastIndexOf('// Inicializar chatbot'))+'\nwindow.TestChat=ClaudeChatbot;');
  const bot = Object.create(w.TestChat.prototype);
  Object.assign(bot,{conversation:[],documentContexts:[],maxDocumentContexts:3,maxDocumentContextChars:48000,
    taskMemory:bot.getDefaultTaskMemory(),pendingChatStorageKey:'zentra-chat-pending-request',
    elements:{messages:w.document.getElementById('messages'),input:w.document.getElementById('input')},
    webContext:{url:'https://example.test/case-a',title:'Caso A'},workCaseKey:'case-a',
    pendingImages:[],apiProvider:w.ZentraAIProvider,lastPromptBuildMeta:{userMessage:message},
    isDesktopShell:false,initialMessagesMarkup:'',activeSavedConversationId:''});
  for (const fn of ['scrollToBottom','restoreChatScrollPosition','wireMessageCopyButton','setMessageCopyPayload','stopAssistantDraftPulse']) bot[fn]=()=>{};
  bot.createAssistantDraftForRequest = () => bot.createAssistantDraftMessage();
  bot.getEnvironmentContextSummary = () => ({});
  bot.detectContextualSurface = () => ({key:'web_general'});
  bot.buildTurnContextMeta = () => ({contextLabel:'Caso A',url:bot.webContext.url});
  bot.buildSafeAccountAccessGuideFallback = () => '';
  bot.saveChatHistory = async () => {
    shared['zentra-chat-history'] = structuredClone({conversation:bot.conversation}); return true;
  };
  bot.getComposerDraftPayload = () => ({text:bot.elements.input.value});
  bot.addSystemMessage = text => {bot.lastError=text;};
  const counts={providers:0,status:0,usage:0,clearFiles:0};
  bot.clearPendingImage=()=>counts.clearFiles++;
  bot.clearPendingDocument=()=>counts.clearFiles++;
  w.zentraSubscription={consumeAction:async()=>counts.usage++};
  bot.sendToAPI = async () => {
    const data = await bot.apiProvider.sendMessages({body:structuredClone(envelope)});
    return {text:bot.resolveAssistantTextSafely(data,{userMessage:message}),data};
  };
  async function seed(extra={}) {
    bot.conversation=[{type:'user',content:message,timestamp:new Date().toISOString()}];
    await bot.savePendingChatRequest({message,operationId:id,ownerId:owner,...extra});
    return bot.loadPendingChatRequest();
  }
  function network(status='complete') {
    w.fetch=async(url,init={})=>{
      if(url.includes('/operation-status')) {counts.status++;return new Response(JSON.stringify({status,response:status==='complete'?answer:undefined}),{status:200});}
      counts.providers++;
      return new Response(JSON.stringify({success:true,response:answer}),{status:200});
    };
  }
  return {w,bot,shared,counts,seed,network,close:()=>dom.window.close()};
}

test('exact original envelope persists before POST and later progress cannot erase it',async()=>{
  const f=fixture();try{
    await f.seed();
    f.w.fetch=async(_url,init)=>{
      f.counts.providers++;
      const saved=await f.bot.loadPendingChatRequest();
      assert.equal(JSON.stringify(saved.originalRequest),init.body);
      assert.equal(saved.ownerId,owner);
      await f.bot.savePendingChatRequest({operationId:id,message,progressPhase:'reasoning'});
      assert.equal(requestFingerprint((await f.bot.loadPendingChatRequest()).originalRequest),requestFingerprint(envelope));
      return new Response(JSON.stringify({success:true,response:answer}),{status:200});
    };
    await f.bot.runChatRequest({message,assistantDraft:f.bot.createAssistantDraftForRequest()});
    assert.equal(f.counts.providers,1);assert.equal(f.bot.conversation.length,2);
    assert.equal(await f.bot.loadPendingChatRequest(),null);
  }finally{f.close();}
});

for(const theme of ['light','dark']) test('reopen '+theme+' retrieves finished operation with GET only, no new turn/debit',async()=>{
  const shared={};let f=fixture(shared);
  await f.seed({originalRequest:envelope,lastRequest:envelope,originalContext:{workCaseKey:'case-a',url:f.bot.webContext.url,contextMeta:{contextLabel:'Original'}}});
  f.close();f=fixture(shared);
  try{
    f.w.document.body.classList.toggle('dark-mode',theme==='dark');
    f.bot.conversation=[{type:'user',content:message}];f.network();
    await f.bot.resumePendingChatRequest();
    assert.equal(f.counts.status,1);assert.equal(f.counts.providers,0);assert.equal(f.counts.usage,0);
    assert.equal(f.bot.conversation.length,2);assert.equal(f.bot.conversation[1].contextMeta.contextLabel,'Original');
    await f.bot.resumePendingChatRequest();assert.equal(f.counts.status,1);
    assert.equal(f.bot.isLoading,false);
  }finally{f.close();}
});

for(const state of ['running','uncertain']) test(state+' retry/reopen never POSTs or leaves spinner running',async()=>{
  const f=fixture();try{
    const pending=await f.seed({originalRequest:envelope});f.network(state);
    await f.bot.resumePendingChatRequest();await f.bot.recoverChatOperation(pending,true);
    assert.equal(f.counts.providers,0);assert.equal(f.counts.usage,0);assert.equal(f.counts.status,2);
    assert.equal(f.bot.conversation.length,1);assert.equal(f.bot.isLoading,false);
    assert.ok(f.w.document.querySelector('.chat-operation-controls').textContent.includes('Reintentar'));
    assert.equal(f.w.document.querySelectorAll('.chat-operation-controls').length,1);
  }finally{f.close();}
});

test('cancel releases local UI, ignores late layer/final and preserves files/pending',async()=>{
  const f=fixture();try{
    await f.seed();const gate=deferred(),started=deferred();let onEvent;
    f.bot.sendToAPI=async(_m,_i,options)=>{onEvent=options.onEvent;started.resolve();return gate.promise;};
    const draft=f.bot.createAssistantDraftForRequest();
    const run=f.bot.runChatRequest({message,assistantDraft:draft});await started.promise;
    assert.match(draft.element.textContent,/Cancelar/);
    await f.bot.cancelChatWait(id);
    assert.equal(f.bot.isLoading,false);assert.equal((await f.bot.loadPendingChatRequest()).lifecycle,'cancelled');
    await onEvent({type:'layer',text:'LATE_PRIVATE_SENTINEL'});
    gate.resolve({text:answer});await run;
    assert.equal(f.bot.conversation.length,1);assert.equal(f.counts.usage,0);assert.equal(f.counts.clearFiles,0);
    assert.doesNotMatch(f.w.document.body.textContent,/LATE_PRIVATE_SENTINEL/);
    assert.match(f.w.document.body.textContent,/servidor puede seguir/);
    assert.equal(f.bot.chatPipelineInFlight,false);
  }finally{f.close();}
});

test('cancel aborts transport and does not fall through to a new POST',async()=>{
  const f=fixture();try{
    await f.seed();const started=deferred();
    f.w.fetch=async(_url,init)=>{f.counts.providers++;started.resolve();return new Promise((_r,reject)=>{
      init.signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError')),{once:true});
    });};
    const run=f.bot.runChatRequest({message,assistantDraft:f.bot.createAssistantDraftForRequest()});
    await started.promise;await f.bot.cancelChatWait(id);await run;
    assert.equal(f.counts.providers,1);assert.equal(f.counts.usage,0);
    assert.equal((await f.bot.loadPendingChatRequest()).lifecycle,'cancelled');
  }finally{f.close();}
});

test('persistence failure before transport never starts provider and retains pending material',async()=>{
  const f=fixture();try{
    await f.seed();f.network();
    f.w.chrome.storage.local.set=(_values,cb)=>{f.w.chrome.runtime.lastError={message:'fixture failure'};cb?.();delete f.w.chrome.runtime.lastError;};
    await f.bot.runChatRequest({message,assistantDraft:f.bot.createAssistantDraftForRequest()});
    assert.equal(f.counts.providers,0);assert.equal(f.counts.usage,0);assert.equal(f.counts.clearFiles,0);
    assert.ok(await f.bot.loadPendingChatRequest());assert.match(f.w.document.body.textContent,/No se inició el envío/);
  }finally{f.close();}
});

test('cancel during usage refresh does not publish a late final or erase attachments',async()=>{
  const f=fixture();try{
    await f.seed();const gate=deferred(),started=deferred();
    f.bot.sendToAPI=async()=>({text:answer});
    f.w.zentraSubscription.consumeAction=async()=>{started.resolve();await gate.promise;};
    const run=f.bot.runChatRequest({message,assistantDraft:f.bot.createAssistantDraftForRequest()});
    await started.promise;await f.bot.cancelChatWait(id);gate.resolve();await run;
    assert.equal(f.bot.conversation.length,1);assert.equal(f.counts.clearFiles,0);
    assert.equal((await f.bot.loadPendingChatRequest()).lifecycle,'cancelled');
  }finally{f.close();}
});

test('failed retry reuses exact ID/body/documents; double click sends once, not a new user message',async()=>{
  const f=fixture();try{
    const pending=await f.seed({originalRequest:envelope,lastRequest:envelope,originalContext:{workCaseKey:'case-a',url:f.bot.webContext.url}});
    const gate=deferred(),started=deferred();
    f.w.fetch=async(url,init)=>{
      if(url.includes('/operation-status')) {f.counts.status++;return new Response('{"status":"failed"}',{status:200});}
      f.counts.providers++;assert.equal(JSON.stringify(JSON.parse(init.body)),JSON.stringify(envelope));started.resolve();await gate.promise;
      return new Response(JSON.stringify({success:true,response:answer}),{status:200});
    };
    const retry=f.bot.recoverChatOperation(pending,true);await started.promise;
    await f.bot.recoverChatOperation(pending,true);gate.resolve();await retry;
    assert.equal(f.counts.providers,1);assert.equal(f.bot.conversation.length,2);
    assert.equal(f.bot.conversation[1].operationId,id);assert.equal(f.counts.usage,1);
  }finally{f.close();}
});

test('changed context needs confirmation, never injects new client evidence into replay',async()=>{
  const f=fixture();try{
    const pending=await f.seed({originalRequest:envelope,originalContext:{workCaseKey:'case-a',url:f.bot.webContext.url}});
    f.bot.workCaseKey='case-b';f.bot.webContext.url='https://example.test/case-b';f.network('failed');
    let confirmations=0;f.w.confirm=()=>{confirmations++;return false;};
    await f.bot.recoverChatOperation(pending,true);assert.equal(confirmations,1);assert.equal(f.counts.providers,0);
    assert.equal((await f.bot.loadPendingChatRequest()).originalRequest.zentra_workflow.state.documentContexts[0].text,'Documento sintético original');
  }finally{f.close();}
});

test('different authenticated user cannot inspect or replay local pending data',async()=>{
  const f=fixture();try{
    const pending=await f.seed({originalRequest:envelope});f.w.__zentraUserId='other-user';f.network();
    await f.bot.resumePendingChatRequest();await f.bot.recoverChatOperation(pending,true);
    assert.equal(f.counts.status,0);assert.equal(f.counts.providers,0);assert.equal(f.w.document.querySelector('.chat-operation-controls'),null);
  }finally{f.close();}
});

test('legacy pending without immutable root is retained, never rebuilt or auto-replayed',async()=>{
  const f=fixture();try{
    const pending=await f.seed();f.network('not_found');await f.bot.recoverChatOperation(pending,true);
    assert.equal(f.counts.providers,0);assert.match(f.w.document.body.textContent,/no conserva su petición original/);
    assert.ok(await f.bot.loadPendingChatRequest());
  }finally{f.close();}
});

test('errors have one understandable message; malformed completed response is not saved as success',async()=>{
  const f=fixture();try{
    await f.seed();f.bot.sendToAPI=async()=>{throw Object.assign(new Error('Error: Error: No se pudo continuar esta solicitud.'),{code:'operation_conflict'});};
    await f.bot.runChatRequest({message,assistantDraft:f.bot.createAssistantDraftForRequest()});
    assert.doesNotMatch(f.w.document.body.textContent,/Error:/);
    assert.match(f.w.document.body.textContent,/pedido anterior no coincide/);
    assert.equal((await f.bot.loadPendingChatRequest()).lifecycle,'failed');assert.equal(f.counts.clearFiles,0);
  }finally{f.close();}
});

test('technical public fallback does not suppress recoverable useful text',async()=>{
  const f=fixture(),old=fixture({},baseline);try{
    await f.seed();const data={success:true,response:'provider: backend_proxy',raw_content:answer};
    assert.equal(old.bot.resolveAssistantTextSafely(data,{userMessage:message}),old.bot.getPublicSystemFallbackMessage());
    assert.equal(f.bot.resolveAssistantTextSafely(data,{userMessage:message}),answer);
    f.bot.sendToAPI=async()=>({text:f.bot.resolveAssistantTextSafely(data,{userMessage:message}),data});
    await f.bot.runChatRequest({message,assistantDraft:f.bot.createAssistantDraftForRequest()});
    assert.equal(f.bot.conversation[1].content,answer);assert.doesNotMatch(f.w.document.body.textContent,/No pude mostrar la respuesta completa/);
  }finally{f.close();old.close();}
});

test('actual theme toggle while transport is pending preserves the immutable request and operation',async()=>{
  const f=fixture();try{
    await f.seed();const gate=deferred(),started=deferred();
    f.w.fetch=async()=>{started.resolve();await gate.promise;return new Response(JSON.stringify({success:true,response:answer}),{status:200});};
    const run=f.bot.runChatRequest({message,assistantDraft:f.bot.createAssistantDraftForRequest()});await started.promise;
    const before=await f.bot.loadPendingChatRequest();
    const popup=readFileSync(root+'/popup.js','utf8');
    f.w.eval('function renderThemeToggleIcon() {}\n'+popup.slice(popup.indexOf('function toggleTheme()'),popup.indexOf('function initializeTheme()')));
    f.w.toggleTheme();assert.equal(f.w.document.body.classList.contains('dark-mode'),true);
    f.w.toggleTheme();assert.equal(f.w.document.body.classList.contains('dark-mode'),false);
    const after=await f.bot.loadPendingChatRequest();
    assert.equal(after.operationId,before.operationId);assert.equal(requestFingerprint(after.originalRequest),requestFingerprint(before.originalRequest));
    gate.resolve();await run;assert.equal(f.bot.conversation.length,2);assert.equal(await f.bot.loadPendingChatRequest(),null);
  }finally{f.close();}
});

test('no recoverable content preserves diagnosis and retry, without publishing public fallback',async()=>{
  const f=fixture();try{
    await f.seed();f.bot.sendToAPI=async()=>({text:f.bot.getPublicSystemFallbackMessage(),data:{},diagnostic:{source:'stream',rawChars:0,selectedChars:0,outputLimit:true}});
    await f.bot.runChatRequest({message,assistantDraft:f.bot.createAssistantDraftForRequest()});
    const pending=await f.bot.loadPendingChatRequest();assert.equal(pending.failureCode,'response_incomplete');
    assert.equal(pending.diagnostic.outputLimit,true);assert.equal(f.bot.conversation.length,1);
    assert.doesNotMatch(f.w.document.body.textContent,/No pude mostrar la respuesta completa/);
    assert.match(f.w.document.body.textContent,/Reintentar/);
  }finally{f.close();}
});

test('provider preserves error code without adding Error prefix',async()=>{
  const f=fixture();try{
    f.w.fetch=async()=>new Response('{"error":"No se pudo continuar esta solicitud.","code":"operation_conflict"}',{status:409});
    await assert.rejects(f.w.ZentraAIProvider.sendMessages({body:envelope}),e=>e.code==='operation_conflict'&&!/^Error:/.test(e.message));
  }finally{f.close();}
});

test('state lookup cancellation ignores a late completion without creating a provider request',async()=>{
  const f=fixture();try{
    const pending=await f.seed({originalRequest:envelope});const gate=deferred(),started=deferred();
    f.w.fetch=async()=>{started.resolve();return gate.promise;};
    const recovery=f.bot.recoverChatOperation(pending,true);await started.promise;
    await f.bot.cancelChatWait(id);gate.resolve(new Response(JSON.stringify({status:'complete',response:answer}),{status:200}));
    await recovery;assert.equal(f.bot.conversation.length,1);assert.equal(f.bot.isLoading,false);
    assert.equal(f.counts.providers,0);assert.ok(await f.bot.loadPendingChatRequest());
  }finally{f.close();}
});

test('missing deployed endpoint remains recoverable, no incompatible root is sent',async()=>{
  const f=fixture();try{
    await f.seed({originalRequest:envelope});f.w.fetch=async()=>new Response('<html>Not found</html>',{status:404});
    await f.bot.resumePendingChatRequest();assert.match(f.w.document.body.textContent,/actualizar el backend STAGING/);
    assert.equal(f.bot.isLoading,false);assert.ok(await f.bot.loadPendingChatRequest());
  }finally{f.close();}
});

test('existing backend guard caches exact replay without provider/debit; rebuilt root conflicts',async()=>{
  const fingerprint=requestFingerprint(envelope);
  const root={step_name:'root',body:envelope,request_hash:fingerprint,context:{clientRequestHash:fingerprint}};
  let begins=0;
  const client={rpc:async(name,args)=>{
    assert.equal(args.p_auth_id,owner);
    if(name==='zentra_read_chat_steps')return {data:{root,steps:[root]}};
    if(name==='zentra_begin_request'){
      begins++;assert.equal(args.p_operation,id);assert.equal(args.p_hash,fingerprint);
      return {data:{allowed:true,cached:true,response:{body:{success:true,response:answer}},user:{id:'internal-user'}}};
    }
    assert.fail('No consume, provider, new root, or finish RPC during cached replay: '+name);
  }};
  const guard=createOperationGuard({client});
  function res(){return {code:200,set(){return this;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};}
  const request=body=>({path:'/api/chat',method:'POST',auth:{userId:owner,email:'fixture@test.invalid'},body});
  for(let i=0;i<2;i++){
    const response=res();await guard(request(structuredClone(envelope)),response,()=>assert.fail('Provider must not start'));
    assert.equal(response.body.response,answer);assert.equal(response.code,200);
  }
  const rebuilt=structuredClone(envelope);rebuilt.messages[0].content='New incompatible page';
  const response=res();await guard(request(rebuilt),response,()=>assert.fail('Provider must not start'));
  assert.equal(response.code,409);assert.equal(response.body.code,'operation_conflict');assert.equal(begins,2);
});

function backendFixture(rows=[],user={id:'internal-user'},failure=false) {
  const reads=[];
  const client={rpc(){assert.fail('No RPC/debit allowed in status handler');},from(table){
    const query={table,filters:[]};reads.push(query);
    const builder={select(columns){query.columns=columns;return builder;},eq(key,value){query.filters.push([key,value]);return builder;},
      order(){return builder;},limit(){return builder;},maybeSingle(){return Promise.resolve({data:user,error:failure?'db-error':null});},
      then(resolve,reject){return Promise.resolve({data:rows,error:failure?'db-error':null}).then(resolve,reject);}};
    return builder;
  }};
  const res={code:200,set(){return res;},status(code){res.code=code;return res;},json(body){res.body=body;return res;}};
  return {reads,client,res,handler:createChatStatusHandler({client,now:()=>2000})};
}
test('backend status only SELECTs verified auth owner, ignores spoof identity and returns no secrets',async()=>{
  const f=backendFixture([{state:'done',created_at:1,response:{body:{response:answer,raw_content:answer,secret:'not-returned'}}}]);
  await f.handler({auth:{userId:owner},query:{operationId:id,userId:'victim',email:'victim'}},f.res);
  assert.deepEqual(f.reads[0].filters,[['auth_user_id',owner],['plan_type','subscription']]);
  assert.deepEqual(f.reads[1].filters,[['user_id','internal-user'],['operation_key',id],['kind','chat']]);
  assert.equal(f.res.body.response,answer);assert.equal(f.res.body.status,'complete');
  assert.equal(f.res.body.result.raw_content,answer);
  assert.doesNotMatch(JSON.stringify(f.res.body),/secret|internal-user|lease_token|body/);
});
for(const [rows,state] of [
  [[], 'not_found'],[[{state:'failed'}],'failed'],
  [[{state:'running',lease_until:new Date(3000).toISOString()}],'running'],
  [[{state:'running',lease_until:new Date(1000).toISOString(),provider_started_at:'yes'}],'uncertain'],
  [[{state:'running',lease_until:new Date(1000).toISOString(),provider_started_at:null}],'failed'],
  [[{state:'failed'},{state:'done',response:{text:answer}}],'failed']
]) test('backend read-only lifecycle '+state+' '+rows.length,async()=>{
  const f=backendFixture(rows);await f.handler({auth:{userId:owner},query:{operationId:id}},f.res);
  assert.equal(f.res.body.status,state);assert.equal(f.res.code,200);
});
test('backend rejects unauthenticated/invalid operation and hides absent account or database errors',async()=>{
  for(const [auth,op,user,code] of [[null,id,{id:'x'},401],[{userId:owner},'bad',{id:'x'},400],[{userId:owner},id,null,200]]){
    const f=backendFixture([],user);await f.handler({auth,query:{operationId:op}},f.res);assert.equal(f.res.code,code);
  }
  const f=backendFixture([],{},true);await f.handler({auth:{userId:owner},query:{operationId:id}},f.res);
  assert.equal(f.res.code,503);assert.doesNotMatch(JSON.stringify(f.res.body),/db-error/);
});
test('new endpoint requires bearer confirmed-session verification and allowed origin',async()=>{
  const client={auth:{getUser:async()=>({data:{user:{id:owner,email:'test@fixture.test',email_confirmed_at:'confirmed'}}})}};
  const secure=createApiSecurity({client,origins:'https://fixture.test'});
  for(const [token,origin,expected] of [[null,'https://fixture.test',401],['Bearer test','https://evil.test',403],['Bearer test','https://fixture.test',200]]){
    const res={code:200,status(n){this.code=n;return this;},json(){return this;}};let next=false;
    await secure({path:'/api/chat/operation-status',method:'GET',ip:'test',get(name){return name==='Origin'?origin:token;}},res,()=>{next=true;});
    assert.equal(res.code,expected);assert.equal(next,expected===200);
  }
});
