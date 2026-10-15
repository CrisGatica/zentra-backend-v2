import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {buildAuthorizedChatRoot,buildChatRefinement} from '../../release-refinements.js';
const extension=new URL('../../../STAGING/ZENTRA_AI_CHROME_LAB_STAGING/',import.meta.url);
const frontend=readFileSync(new URL('claude-chatbot.js',extension),'utf8');
const backend=readFileSync(new URL('../../trusted-chat-builders.js',import.meta.url),'utf8');
function bot(code){
 const sandbox=vm.createContext({window:{},document:{addEventListener(){},getElementById(){return null;}},URL,URLSearchParams,console:{log(){},warn(){},error(){}}});
 vm.runInContext(code,sandbox);const b=Object.create(sandbox.window.ClaudeChatbot.prototype);
 Object.assign(b,{conversation:[],documentContexts:[],taskMemory:{},isContextLoaded:true,webContext:{url:'https://example.test/',title:'Página sintética'}});return b;
}
const transcript=`Conversación sintética
Cliente [10:00]: Necesito cambiar la dirección de mi negocio y el enlace de reservas.
https://cdn.example.test/avatars/contact.png
Agente [10:05]: Confirmo que actualicé el enlace en móvil. La dirección sigue pendiente.
https://cdn.example.test/icons/whatsapp.svg
Cliente [10:08]: No tengo confirmado el método de verificación solicitado por Google.
https://media.example.test/avatar.jpg`;
const request='Dame la resolución final del caso, con trabajos realizados, pendientes y requisitos para actualizar la dirección en Google Business Profile.';
const answer='Según informó el agente, se actualizó el enlace de reservas en móvil. La dirección continúa pendiente; no consta una comprobación externa. Falta confirmar qué método de verificación solicita Google para este perfil.';
const cases=[request+'\n\n'+transcript,transcript+'\n\n'+request,transcript+'\n\nPrepará una resolución del caso lista para copiar.'];
for(const [name,code] of [['client',frontend],['authorized',backend]]){
 for(const [index,input] of cases.entries())test(`QA012 ${name} pasted conversation ${index}: resolution survives decorative URLs and final formatter`,()=>{
  const b=bot(code);b.lastPromptBuildMeta={userMessage:input};
  assert.equal(b.resolvePastedUrlTaskForMessage(input),null);assert.equal(b.isExplicitCaseResolutionRequest(input),true);
  assert.equal(b.normalizeFinalAssistantOutput(answer),answer);
  assert.equal(b.detectFastChatIntent(input,null,b.detectInteractionMode({message:input})).type,'case_resolution');
 });
 test(`QA012 ${name}: unrequested decorative URLs cannot start or seed page cleanup`,()=>{
  const b=bot(code);assert.equal(b.resolvePastedUrlTaskForMessage(transcript),null);b.conversation=[{type:'user',content:transcript}];assert.equal(b.findRecentPastedUrlTask(),null);
  const explicit='Organizá estos links con comentarios:\nhttps://example.test/a\nhttps://example.test/b';
  const task=b.resolvePastedUrlTaskForMessage(explicit);assert.equal(task.entries.length,2);assert.match(b.buildPastedUrlTaskFallback(task),/Páginas para revisar/);
  b.conversation=[{type:'user',content:explicit}];assert.equal(b.resolvePastedUrlTaskForMessage('Solo los links').linksOnly,true);
  assert.equal(b.resolvePastedUrlTaskForMessage(transcript),null);
 });
 test(`QA012 ${name}: quoted speaker request does not override an explicit link task`,()=>{
  const b=bot(code);const quoted='Organizá estos links:\nhttps://example.test/a\nhttps://example.test/b\n\nCliente: Dame la resolución del caso';
  assert.equal(b.isExplicitCaseResolutionRequest(quoted),false);assert.ok(b.resolvePastedUrlTaskForMessage(quoted));
 });
}
test('QA012 authorized root keeps pasted evidence and adds no invented Google verification',async()=>{
 const input=cases[1];const result=await root(input);
 const system=result.body.messages.find(m=>m.role==='system').content;
 assert.doesNotMatch(system,/ORGANIZACION DE URLS|Páginas para revisar/);
 assert.match(system,/afirma haber realizado/);assert.match(system,/metodo que Google solicite/);
 assert.match(system,/no inventes comprobaciones externas/);
 const evidence=result.body.messages.filter(m=>m.role==='user').map(m=>m.content).join('\n');
 assert.match(evidence,/actualicé el enlace en móvil/);assert.match(evidence,/dirección sigue pendiente/);
});
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=';
async function root(input,images=0,history=[]){
 const content=images?[{type:'text',text:input},...Array.from({length:images},()=>({type:'image_url',image_url:{url:png}}))]:input;
 return buildAuthorizedChatRoot({messages:[...history,{role:'user',content}]},{version:1,userMessage:input,state:{webContext:{url:'https://example.test/',title:'Página sintética'},conversation:[],documentContexts:[],taskMemory:{}}},{plan:'pro',status:'active'});
}
for(const input of [
 'Compará los horarios en estas capturas: lunes 09:00 AM–11:30 AM frente a 09:00 AM–11:30 PM.',
 '¿Son iguales los horarios de las dos imágenes?',
 'Identificá diferencias de disponibilidad, incluyendo bloques nuevos o eliminados.',
 'Compará los intervalos por día: 09:15–11:45 y 09:15–11:30.',
 'Compará los horarios, pero parte de la captura está ilegible.'
])test('schedule policy: '+input,async()=>{
 const result=await root(input,2);const system=result.body.messages.find(m=>m.role==='system').content;
 assert.equal(system.split('COMPARACION VISUAL DE HORARIOS').length-1,1);
 assert.match(system,/11:30 AM no equivale a 11:30 PM/);assert.match(system,/12 AM y 12 PM/);
 assert.match(system,/agregados, eliminados y modificados/);assert.match(system,/ilegible o ambiguo/);assert.match(system,/evidencia no confiable/);
 assert.equal(result.body.messages.filter(m=>m.role==='user').at(-1).content.filter(p=>p.type==='image_url').length,2);
});
test('schedule policy follows actual attached images in history and survives visible refinement once',async()=>{
 const result=await root('Compará los horarios con la imagen anterior.',0,[{role:'user',content:[{type:'text',text:'Disponibilidad sintética'},{type:'image_url',image_url:{url:png}}]}]);
 assert.match(result.body.messages[0].content,/COMPARACION VISUAL DE HORARIOS/);
 const refined=await buildChatRefinement('visible',result,{text:'Respuesta sintética incompleta.'});
 assert.equal(refined.messages[0].content.split('COMPARACION VISUAL DE HORARIOS').length-1,1);
});
for(const [query,count] of [['Compará estas dos imágenes de logotipos.',2],['Extraé los horarios de esta captura.',1],['Compará los horarios escritos: 11:30 AM y 11:30 PM.',0],['Redactá una respuesta para un cliente.',2]])test('unrelated visual/text task unchanged: '+query,async()=>{
 const result=await root(query,count);assert.doesNotMatch(result.body.messages[0].content,/COMPARACION VISUAL DE HORARIOS/);
});
