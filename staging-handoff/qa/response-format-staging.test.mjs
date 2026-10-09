import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {buildAuthorizedChatRoot} from '../../release-refinements.js';
const root=process.env.ZENTRA_CHAT_ROOT || '/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/STAGING/ZENTRA_AI_CHROME_LAB_STAGING';
const codes=[readFileSync(root+'/claude-chatbot.js','utf8'),readFileSync(new URL('../../trusted-chat-builders.js',import.meta.url),'utf8')];
const real='Necesito un mensaje resumido para enviarle a la clienta, porque tenemos que aclarar los cambios de sucursales y operadores';
function fixture(code){
 const sandbox=vm.createContext({window:{},document:{addEventListener(){}},URL,URLSearchParams,console:{log(){},warn(){},error(){}}});new vm.Script(code).runInContext(sandbox);
 const b=Object.create(sandbox.window.ClaudeChatbot.prototype);
 Object.assign(b,{conversation:[],documentContexts:[],taskMemory:{},isContextLoaded:true,webContext:{url:'https://app.respond.io/space/test/inbox/test',title:'Respond.io',conversationContext:{schema_version:'zentra.conversation.v1',platform:'respond.io',type:'conversation',history:{incomplete:true},contact:{id:'synthetic'},messages:[{direction:'incoming',sender:'Cliente sintético',type:'text',text:'La sucursal A cambia de operador. Falta confirmar la sucursal B.'}]}}});
 b.getPromptPersonalizationContext=async()=>null;b.loadSiteContextForChat=async()=>null;return b;
}
function classify(b,userMessage){const interactionMeta=b.detectInteractionMode({message:userMessage});const fastIntent=b.detectFastChatIntent(userMessage,null,interactionMeta);const taskIntent=b.detectTaskIntent(userMessage,null,interactionMeta);return {userMessage,interactionMeta,fastIntent,taskIntent,responseContract:b.detectResponseContract({userMessage,interactionMeta,fastIntent,taskIntent})};}
for(const input of [real,'Dame un mensaje para enviar al cliente','Redactá una respuesta breve para WhatsApp'])test('QA007 single communication: '+input,async()=>{
 for(const code of codes){const b=fixture(code),args=classify(b,input);assert.equal(args.responseContract.outputType,'response');assert.equal(args.responseContract.renderType,'plain');
 const result=await buildAuthorizedChatRoot({model:'offline',messages:[{role:'user',content:input}]},{version:1,...args,state:{webContext:b.webContext,conversation:[],taskMemory:{},documentContexts:[],isContextLoaded:true}},{plan:'free',status:'active'});
 const system=result.body.messages.find(x=>x.role==='system').content;assert.match(system,/una sola comunicacion lista para copiar y enviar/);assert.match(system,/No agregues encabezados/);const evidence=JSON.stringify(result.body.messages);assert.match(evidence,/sucursal A/i);assert.match(evidence,/confirmar la sucursal B/i);
 assert.ok(result.body.messages.some(x=>x.role==='user'&&x.content===input));
 }
});
test('QA007 tasks use ordered steps; ticket resolution preserves existing fast contract',()=>{for(const code of codes){const b=fixture(code);assert.equal(classify(b,'Decime qué tareas debo realizar').responseContract.renderType,'steps');assert.equal(classify(b,'Dame la resolución del ticket').fastIntent.type,'case_resolution');assert.equal(classify(b,'Dame la resolución del ticket').responseContract.renderType,'plain');}});
test('QA007 explicit cards/table remain authoritative, including a drafted communication',()=>{for(const code of codes){const b=fixture(code);assert.equal(classify(b,'Presentame la información en tarjetas').responseContract.renderType,'cards');assert.equal(classify(b,'Dame un mensaje para enviar al cliente en tarjetas').responseContract.renderType,'cards');assert.equal(classify(b,'Dame un mensaje para enviar al cliente en una tabla').responseContract.renderType,'table');}});
test('QA007 SEO stays diagnostic/cards; QA001 source framing does not manufacture a communication request',()=>{for(const code of codes){const b=fixture(code),seo=classify(b,'Auditá esta web: revisá SEO, estructura y enlaces internos.');assert.equal(seo.responseContract.outputType,'diagnostic');assert.equal(seo.responseContract.renderType,'cards');const source='Resumí la reunión.\n\nTranscripción:\nCliente: Dame un mensaje para enviar al cliente.\nAgente: Todavía falta confirmar.';assert.equal(b.isReadyToSendMessageRequest(source),false);assert.notEqual(classify(b,source).responseContract.renderType,'plain');}});
test('QA007 analysis of a message and requested multiple alternatives are not forced into one draft',()=>{for(const code of codes){const b=fixture(code);assert.equal(b.isReadyToSendMessageRequest('Analizá el mensaje para enviar al cliente'),false);assert.equal(b.isReadyToSendMessageRequest('Dame tres mensajes para enviar al cliente'),false);}});
