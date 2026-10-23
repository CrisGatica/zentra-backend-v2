import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {buildAuthorizedChatRoot,prepareChatStep,buildChatExecutionBody} from './release-refinements.js';

const extension=new URL('../zentra-context-calibration-extension/claude-chatbot.js',import.meta.url);
const trusted=new URL('./trusted-chat-builders.js',import.meta.url);
const page='https://example.test/caso/a?cliente=1#actual';
const request='Necesito la promoción que hablamos';
const promotions='Datos sintéticos, no tarifas reales. Tres promociones de Halloween: A: servicio Uno, 10 EUR; B: servicio Dos, 20 EUR; C: servicio Tres, 30 EUR. Son propuestas redactadas, no gestiones ejecutadas.';
const clone=value=>JSON.parse(JSON.stringify(value));
function botFrom(path,code=fs.readFileSync(path,'utf8'),mode='work') {
  const box=vm.createContext({window:{ZentraDisplay:{isWork:mode==='work',sync:async()=>{}}},
    document:{addEventListener(){},getElementById(){return null;}},URL,URLSearchParams,Blob,
    fetch(){assert.fail('Provider/network forbidden');},console:{log(){},warn(){},error(){},info(){}}});
  new vm.Script(code).runInContext(box);
  const bot=Object.create(box.window.ClaudeChatbot.prototype);
  Object.assign(bot,{conversation:[],webContext:{url:page,title:'Página de prueba'},taskMemory:{},documentContexts:[],siteContextCache:new Map(),model:'synthetic',maxTokens:800,isContextLoaded:true,lastInputModality:'text'});
  return {bot,box};
}
function history(bot) {
  const meta={pageUrl:page};
  bot.conversation=[{type:'user',content:promotions,contextMeta:meta},
    {type:'assistant',content:promotions+' Borradores disponibles para revisar.',contextMeta:meta}];
  for(let i=0;i<8;i++)bot.conversation.push({type:i%2?'assistant':'user',content:'Turno neutro sin información comercial.',contextMeta:meta});
}
function baseline(path) {
  return execFileSync('git',['show',path===extension?'42913da:claude-chatbot.js':'a307dce:trusted-chat-builders.js'],
    {cwd:new URL(path===extension?'../zentra-context-calibration-extension/':'./',import.meta.url),encoding:'utf8'});
}

test('baseline proves source is outside seven-turn window and reference is unrecognized',()=>{
  const {bot}=botFrom(extension,baseline(extension));history(bot);
  assert.equal(bot.referencesChatThreadContext(request),false);
  assert.equal(bot.filterConversationHistoryForCurrentContext(bot.conversation.slice(-7),page,false).some(m=>m.content.includes('10 EUR')),false);
});

for(const [label,path] of [['extension',extension],['trusted',trusted]]) {
  test(label+': older literal promotions recovered without raising seven-turn budget',()=>{
    const {bot}=botFrom(path);history(bot);
    assert.equal(bot.referencesChatThreadContext(request),true);
    assert.equal(bot.shouldCarryCrossPageHistory(request),false);
    const turns=bot.selectConversationHistoryForRequest(request,bot.conversation,true);
    assert.ok(turns.length<=7);assert.ok(turns.some(m=>m.content===promotions));
    for(const marker of ['10 EUR','20 EUR','30 EUR'])assert.ok(turns.some(m=>m.content.includes(marker)));
    assert.deepEqual(clone(turns).map(m=>m.content),bot.conversation.filter(m=>turns.includes(m)).map(m=>m.content));
  });
  test(label+': later corrections preserved and ambiguity is not resolved by invention',()=>{
    const {bot}=botFrom(path);history(bot);
    bot.conversation.push({type:'user',content:'Corrección: la promoción B ahora vale 25 EUR.',contextMeta:{pageUrl:page}});
    const turns=bot.selectConversationHistoryForRequest(request,bot.conversation);
    assert.ok(turns.some(m=>m.content.includes('25 EUR')));assert.ok(turns.some(m=>m.content===promotions));
    const contract=bot.detectResponseContract({userMessage:request,interactionMeta:{source:'direct',mode:'direct_conversation'}});
    const rules=bot.buildResponseContractPromptBlock(contract,request);
    assert.match(rules,/preguntá sólo cuál/);assert.match(rules,/no vuelvas a pedir información que ya está escrita/);
  });
  test(label+': no other page, query/hash record, contact, missing ownership or absent evidence',()=>{
    const {bot}=botFrom(path);history(bot);
    for(const url of ['https://example.test/caso/b',page.replace('cliente=1','cliente=2'),page.replace('#actual','#otro')]) {
      bot.webContext.url=url;assert.equal(bot.selectConversationHistoryForRequest(request,bot.conversation,true).length,0);
    }
    bot.webContext.url=page;bot.webContext.conversationContext={contact:{id:'2'}};
    bot.conversation.forEach(m=>m.contextMeta={pageUrl:page,conversationContactId:'1'});
    assert.equal(bot.selectConversationHistoryForRequest(request,bot.conversation,true).length,0);
    bot.conversation.forEach(m=>delete m.contextMeta);
    assert.equal(bot.selectConversationHistoryForRequest(request,bot.conversation,true).length,0);
    bot.conversation=[];assert.equal(bot.selectConversationHistoryForRequest(request,[]).length,0);
  });
  test(label+': retrieval limited to forty observed turns, normal history unchanged',()=>{
    const {bot}=botFrom(path);history(bot);
    for(let i=0;i<40;i++)bot.conversation.push({type:'user',content:'Mensaje neutro.',contextMeta:{pageUrl:page}});
    assert.equal(bot.selectConversationHistoryForRequest(request,bot.conversation).some(m=>m.content.includes('10 EUR')),false);
    assert.deepEqual(clone(bot.selectConversationHistoryForRequest('Explicame una idea nueva',bot.conversation)),
      clone(bot.filterConversationHistoryForCurrentContext(bot.conversation.slice(-7),page,false)));
    assert.equal(bot.getScopedHistoryReference('Compará la promoción anterior con otra página'),null);
    assert.equal(bot.getScopedHistoryReference('Explicá https://example.test/?text=la-promocion-anterior'),null);
  });
}

async function captureSend(mode) {
  const {bot,box}=botFrom(extension,undefined,mode);history(bot);
  bot.conversation.push({type:'user',content:request,contextMeta:{pageUrl:page}});
  const captured={};const stop=Object.assign(new Error('STOP_SYNTHETIC_TRANSPORT'),{code:'chat_cancelled'});
  Object.assign(bot,{refreshWebContext:async()=>{},getEnvironmentContextSummary:()=>null,
    upsertTaskMemoryFromTurn(){},getRoutingConfig:async()=>({selectedModel:'synthetic',maxTokens:800}),
    debugLog(){},recordDebugSample(){},shouldUseLayeredStrategicStream:()=>false,
    buildSystemPrompt:async args=>'Fixture. '+bot.buildResponseContractPromptBlock(args.responseContract,request),
    apiProvider:{sendMessages:async({body})=>{captured.body=body;throw stop;}}});
  box.window.zentraOperations={setChatContext:snapshot=>{captured.snapshot=snapshot;}};
  await assert.rejects(()=>bot.sendToAPI(request,null,{interactionMeta:{source:'direct',mode:'direct_conversation',modality:'text'}}),error=>error===stop);
  return captured;
}
for(const mode of ['quick','work'])test(mode+': actual send payload, operation snapshot and authorized backend preserve promotions',async()=>{
  const captured=await captureSend(mode);assert.ok(captured.body);assert.ok(captured.snapshot);
  assert.ok(captured.snapshot.state.conversation.length<=8);
  assert.ok(captured.snapshot.state.conversation.some(m=>m.content===promotions));
  // JSON transport drops undefined optional fields, just like the real client.
  const wire=clone({...captured.body,zentra_workflow:captured.snapshot});
  const calls=[];
  const client={async rpc(name,args){
    calls.push(name);
    if(name==='zentra_read_chat_steps')return {data:{}};
    if(name==='zentra_access')return {data:{plan:'free',status:'active'}};
    if(name==='zentra_register_chat_step')return {data:{allowed:true,body:args.p_body,root_hash:'fixture'}};
    assert.fail('Unexpected RPC');
  }};
  const prepared=await prepareChatStep({client,identity:{userId:'fixture',email:'fixture@example.test'},
    product:'subscription',operationId:'fixture',body:wire});
  assert.ok(!prepared.conflict);
  const body=await buildChatExecutionBody(prepared,{plan:'free',status:'active'});
  const root={body};
  const evidence=root.body.messages.filter(m=>m.role!=='system').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
  for(const marker of ['10 EUR','20 EUR','30 EUR'])assert.ok(evidence.includes(marker));
  assert.equal(root.body.messages.at(-1).content,request);
  assert.ok(!root.body.messages[0].content.includes('10 EUR'),'private evidence is data, not privileged instructions');
  assert.deepEqual(calls,['zentra_read_chat_steps','zentra_access','zentra_register_chat_step']);
});

const ticketPage={url:'https://desk.zoho.eu/agent/demo/support/tickets/details/200',ticketContext:{
  schema_version:'zentra.ticket.v1',platform:'zoho_desk',id:'200',loaded_only:true,partial:true,
  blocks:[{kind:'thread',text:'Cliente: cambiar el botón. Agente: botón actualizado y comprobado. Cliente: quedó correcto, gracias.'}]}};
async function rootFor(page,userMessage='Dame la resolución del ticket.') {
  return buildAuthorizedChatRoot({messages:[{role:'user',content:userMessage}]},
    {version:1,userMessage,state:{webContext:page,conversation:[]}}, {plan:'free',status:'active'});
}
test('confirmed resolution instructions calibrate warnings at source without inventing an unknown status',async()=>{
  const root=await rootFor(ticketPage);const system=root.body.messages[0].content;
  assert.match(system,/No agregues salvedades por defecto/);assert.match(system,/si el usuario pregunta por el estado operativo/);
  assert.doesNotMatch(system,/Si status no está disponible, indicá que no consta el estado actual/);
  assert.match(JSON.stringify(root.body.messages),/botón actualizado y comprobado/);
  assert.match(system,/no deduzcas el estado actual de notas históricas/);
});
test('genuine uncertainty: support closure does not confirm external bank payment',async()=>{
  const current={url:'https://app.respond.io/space/1/inbox/300',conversationContext:{
    schema_version:'zentra.conversation.v1',platform:'respond.io',type:'conversation',contact:{id:'300'},
    support:{status:'closed',source:'current_ui_control'},history:{loaded_only:true,incomplete:true},messages:[
      {id:'1',type:'text',direction:'incoming',text:'Todavía no veo la acreditación bancaria.'},
      {id:'2',type:'text',direction:'outgoing',text:'Se explicó el plazo. No tenemos confirmación bancaria.'}]}};
  const root=await rootFor(current,'Dame la resolución de este caso.');const system=root.body.messages[0].content;
  assert.match(system,/No declares acreditaciones/);assert.match(system,/incertidumbre concreta que afecte la conclusión/);
  const data=JSON.stringify(root.body.messages.filter(m=>m.role==='user'));
  assert.ok(data.includes('closed'));assert.ok(data.includes('No tenemos confirmación bancaria'));
});
test('explicit status question still has an actionable uncertainty rule',async()=>{
  const root=await rootFor(ticketPage,'¿Cuál es el estado actual del ticket?');
  assert.match(root.body.messages[0].content,/Indicá esa falta sólo si el usuario pregunta por el estado operativo/);
  assert.match(root.body.messages[0].content,/no deduzcas el estado actual/);
});
test('Self-Check code and response renderer unchanged; genuine caveat is not filtered',()=>{
  for(const path of [extension,trusted]) {
    const current=fs.readFileSync(path,'utf8'),old=baseline(path);
    const part=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
    assert.equal(part(current,'  getWhatsAppTransformationHistory(','  isInvalidDirectTextOrganizationResponse('),
      part(old,'  getWhatsAppTransformationHistory(','  isInvalidDirectTextOrganizationResponse('));
    const {bot}=botFrom(path);const text='La atención está cerrada; la acreditación bancaria sigue sin confirmarse.';
    assert.equal(bot.normalizeFinalAssistantOutput(text),text);
    assert.equal(part(current,'  normalizeFinalAssistantOutput(','  buildLastResortAssistantText('),
      part(old,'  normalizeFinalAssistantOutput(','  buildLastResortAssistantText('));
  }
});
