import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const base=process.env.ZENTRA_BASE;
const backend=base+'/zentra-backend';
const clean=base+'/publicacion/chrome-store/zentra-ai-chrome-store-clean';
const {validateChatRoot,buildChatRefinement}=await import(pathToFileURL(backend+'/release-refinements.js'));
const source=await readFile(backend+'/trusted-chat-builders.js','utf8');
const context=vm.createContext({window:{},document:{addEventListener(){}},console,URL,URLSearchParams});
vm.runInContext(source,context);
const bot=Object.create(context.window.ClaudeChatbot.prototype);
bot.webContext={};bot.conversation=[];bot.model='gpt-5-mini';bot.maxTokens=2200;bot.taskMemory={};
bot.debugLog=()=>{};
const publicContext=vm.createContext({window:{},document:{addEventListener(){}},console,URL,URLSearchParams});
vm.runInContext(await readFile(clean+'/claude-chatbot.js','utf8'),publicContext);
const updated=publicContext.window.ClaudeChatbot.prototype;
// Only case resolution was intentionally changed in STAGING. Keep production
// parity checks for every other validated builder without changing clean files.
const stagingContext=vm.createContext({window:{},document:{addEventListener(){}},console,URL,URLSearchParams});
vm.runInContext(await readFile((process.env.ZENTRA_CHAT_ROOT || base+'/STAGING/ZENTRA_AI_CHROME_LAB_STAGING')+'/claude-chatbot.js','utf8'),stagingContext);
const stagingUpdated=stagingContext.window.ClaudeChatbot.prototype;
const repairMethods=['attemptSimpleRewriteRetry','attemptStructuredTaskOrganizationRecovery','attemptImageOcrCardsRecovery',
  'attemptIncompleteVisibleResponseRecovery','attemptStructuredStrategicRecovery','attemptSeniorResponsePolish','attemptPremiumReasoningRescue'];
function withoutStage(source) {
  return source.replace(/\{ \.\.\.(recoveryBody|polishBody), zentra_refinement: \{ stage: '[a-z_]+' \} \}/g,'$1')
    .replace(/^    (?:retryBody|rescueBody)\.zentra_refinement = \{ stage: '[a-z_]+' \};\n/gm,'');
}
for(const name of repairMethods) assert.equal(withoutStage(updated[name].toString()),bot[name].toString(),name);
for(const name of ['buildPlainTextRewriteRetryRequestBody','buildVisibleChatRecoveryRequestBody','buildPlainTextRewriteRequestBody',
  'buildCaseResolutionRequestBody','buildPlainImageOcrRequestBody','buildImagePromotionCopyRequestBody','buildStrategicRecoveryRequestSpec']) {
  assert.equal((name==='buildCaseResolutionRequestBody' ? stagingUpdated : updated)[name].toString(),bot[name].toString(),name);
}
console.log('PASS trusted builders retain validated prompts; STAGING resolution matches STAGING client');

const snapshot=userMessage=>({version:1,userMessage,taskIntent:{label:'simple_rewrite'},
  responseContract:{outputType:'response',renderType:'plain',contextDecision:'free'},
  state:{webContext:{},conversation:[],taskMemory:{},model:bot.model,maxTokens:2200}});
const rewriteMessage='Mejorá esta frase: se cambio el video y ahora se ve mejor';
const body=bot.buildPlainTextRewriteRequestBody({userMessage:rewriteMessage,model:bot.model,maxTokens:2200});
const root={body,context:snapshot(rewriteMessage)};
assert.equal(validateChatRoot(body,root.context),true);
assert.equal(validateChatRoot(body,{...root.context,userMessage:'Otra consulta'}),false);
const previous={body:{success:true,response:'Se cambio el video y ahora se ve mejor.'}};
const actual=await buildChatRefinement('rewrite',root,previous);
const expected=bot.buildPlainTextRewriteRetryRequestBody({userMessage:rewriteMessage,previousOutput:previous.body.response,
  model:bot.model,maxTokens:body.max_tokens,routingConfig:body.zentra_routing});
assert.equal(JSON.stringify(actual),JSON.stringify(expected));
console.log('PASS rewrite is reconstructed from original input and persisted output, same prompt');

const cases=[
  ['visible','Explicame cómo organizar mis servicios paso a paso.',null],
  ['organization','Organizá estas tareas del cliente Pausa Bonita: Página: https://pausabonitabeautynails.com. Referencia interna: https://crm.zoho.eu/test/123. Agregar popup de WhatsApp, mejorar SEO local y mapas de los dos centros.',{response:'Pagina'}],
  ['strategic','Analizá este perfil de Instagram con foco en posicionamiento, branding, consistencia visual, tipos de contenido y oportunidades reales de crecimiento.',{response:'Buena marca.'}],
  ['polish','Dame varias opciones de CTA para esta página y decime cuál usarías.',{response:'Reserva ahora.'}],
  ['incomplete','Explicame cómo organizar mis servicios paso a paso.',{response:'Pasos:'}],
  ['reasoning','Analizá este chat y todo lo recaudado. Qué reutilizarías y qué mejorarías.',{response:'Priorizar claridad.'}],
  ['ocr_cards','Ordená toda la información de esa imagen en cards',{response:'Producto'}]
];
for(const [stage,userMessage,result] of cases) {
  const ctx=snapshot(userMessage);
  ctx.taskIntent={label:'senior'};
  if(stage==='ocr_cards') {
    ctx.responseContract={outputType:'response',renderType:'cards',contextDecision:'thread'};
    ctx.state.conversation=[{type:'assistant',content:'PRODUCTO\nCrema facial hidratante\nPrecio: 19,95 euros\nIncluye asesoramiento personalizado y envio.',contextMeta:{imageOcrText:'PRODUCTO\nCrema facial hidratante\nPrecio: 19,95 euros\nIncluye asesoramiento personalizado y envio.'}}];
  }
  const body={model:bot.model,max_tokens:2200,messages:[{role:'user',content:userMessage}],zentra_routing:{taskType:'chat_basic'}};
  assert.ok(validateChatRoot(body,ctx));
  const built=await buildChatRefinement(stage,{body,context:ctx},result?{body:{success:true,response:result}}:null);
  assert.ok(built.messages.length>=2,stage);
  assert.ok(built.messages.some(message=>typeof message.content==='string'&&message.content.includes(userMessage)),stage);
  console.log('PASS authorized builder',stage);
}
await assert.rejects(buildChatRefinement('arbitrary',{body,context:root.context},previous),/Unknown refinement/);
console.log('PASS arbitrary builder selection rejected');
const images=[{base64:'data:image/png;base64,AA=='},{base64:'data:image/jpeg;base64,AQ=='}];
for(const userMessage of ['Dame los textos','']) {
  const body=bot.buildPlainImageOcrRequestBody({userMessage,imageData:images,model:bot.model});
  const ctx=snapshot(userMessage);
  ctx.interactionMeta={modality:'image'};
  ctx.responseContract={contextDecision:'file',renderType:'plain',outputType:'response'};
  assert.ok(validateChatRoot(body,ctx));
  const recovered=await buildChatRefinement('visible',{body,context:ctx},null);
  const preserved=recovered.messages.flatMap(message=>Array.isArray(message.content)?message.content.filter(part=>part.type==='image_url').map(part=>part.image_url.url):[]);
  assert.deepEqual(Array.from(preserved),images.map(image=>image.base64));
}
console.log('PASS multiple OCR images preserved, including an attachment without a written prompt');
