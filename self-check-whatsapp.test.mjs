import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {buildAuthorizedChatRoot} from './release-refinements.js';
import {requestFingerprint} from './release-security.js';

const extension=new URL('../zentra-self-check-staging-extension/claude-chatbot.js',import.meta.url);
const source='https://api.whatsapp.com/send/?phone=34911000222&text=Hola,+vengo+de+la+web+quisiera+mas+info+acerca+de+la+promo+de+mayo+(Masaje+Relajante+o+Descontracturante)&app_absent=0';
const first='Adaptá este enlace para las promociones de Halloween: '+source;
const correction='Debes nombrar la promoción en el link de WhatsApp. Está interesado en las promociones de Halloween';
const insistence='No agregaste la promoción... debes nombrar la promoción en el link';
const page='https://example.test/case/1';
const contextMeta={pageUrl:page};
const read=path=>fs.readFileSync(path,'utf8');
function createBot(path) {
  const forbidden=()=>assert.fail('Provider/network prohibited');
  const sandbox=vm.createContext({window:{},document:{addEventListener(){},dispatchEvent(){}},
    URL,URLSearchParams,fetch:forbidden,console:{warn(){},error(){},log(){},info(){}}});
  new vm.Script(read(path)).runInContext(sandbox,{timeout:1000});
  const bot=Object.create(sandbox.window.ClaudeChatbot.prototype);
  bot.conversation=[];bot.webContext={url:page};bot.documentContexts=[];bot.taskMemory={};
  bot.__testSandbox=sandbox;
  return bot;
}
function append(bot,request,response) {
  bot.conversation.push({type:'user',content:request,contextMeta},{type:'assistant',content:response,contextMeta});
}
function assertLink(bot,request,required) {
  const spec=bot.getUrlTransformationSpec(request);
  assert.ok(spec);assert.equal(spec.promotionName,required);
  const output=bot.buildWhatsAppLinkTransformationFallback(spec);
  assert.ok(output);const parsed=new URL(output);
  assert.equal(parsed.searchParams.get('phone'),'34911000222');
  assert.ok(parsed.searchParams.get('text').includes(required));
  assert.equal(parsed.searchParams.get('app_absent'),'0');
  assert.equal(bot.evaluateUrlTransformationResponse(spec,output).valid,true);
  return output;
}

for(const [name,path] of [['extension',extension],['trusted builder',new URL('./trusted-chat-builders.js',import.meta.url)]]) {
  test(name+': Halloween, explicit correction and insistence all preserve named requirement',()=>{
    const bot=createBot(path);
    for(const request of [first,correction,insistence]) append(bot,request,assertLink(bot,request,'Halloween'));
  });
  test(name+': exact reported follow-up repairs an older generic assistant answer',()=>{
    const bot=createBot(path);const generic=new URL(source);generic.searchParams.set('text','Hola, esta promoción');
    const oldGeneric=generic.toString();
    append(bot,first,oldGeneric);
    const fixed=assertLink(bot,correction,'Halloween');assert.notEqual(fixed,oldGeneric);
    append(bot,correction,oldGeneric);assertLink(bot,insistence,'Halloween');
    assert.equal(bot.isInvalidUrlTransformationResponse({userMessage:correction,assistantText:oldGeneric}),true);
  });
  test(name+': newest promotion beats earlier promotion and assistant guesses',()=>{
    const bot=createBot(path);append(bot,first,'Promoción de Navidad');
    const request=correction.replace('Halloween','Black Friday');
    assertLink(bot,request,'Black Friday');
  });
  test(name+': no cross-case, unknown ownership or expired history fallback',()=>{
    const bot=createBot(path);append(bot,first,source);bot.webContext.url='https://example.test/case/2';
    assert.equal(bot.getUrlTransformationSpec(insistence),null);
    bot.webContext.url=page;bot.conversation.forEach(entry=>delete entry.contextMeta);
    assert.equal(bot.getUrlTransformationSpec(insistence),null);
    bot.conversation=[];append(bot,first,source);
    for(let i=0;i<12;i++)bot.conversation.push({type:'user',content:'Otra consulta',contextMeta});
    assert.equal(bot.getUrlTransformationSpec(insistence),null);
  });
  test(name+': recipient comes from user, not changed assistant URL',()=>{
    const bot=createBot(path);append(bot,first,source.replace('34911000222','34911000333'));
    assertLink(bot,correction,'Halloween');
  });
  test(name+': query and hash record changes do not share link history',()=>{
    const bot=createBot(path);append(bot,first,source);
    for(const url of [page+'?contact=2',page+'#record-2']) {
      bot.webContext.url=url;assert.equal(bot.getUrlTransformationSpec(insistence),null);
    }
  });
  test(name+': strict scheme, host, path, phone and ambiguity validation',()=>{
    const bot=createBot(path);
    for(const url of [source.replace('https:','http:'),source.replace('api.whatsapp.com','api.whatsapp.com.evil.test'),
      source.replace('send/','login/'),source+'&phone=34911000333',source+'&text=duplicate',
      source.replace('34911000222','abc'),source.replace('https://','https://user:pass@')]) {
      assert.equal(bot.parseWhatsAppLink(url),null);
    }
    assert.equal(bot.getUrlTransformationSpec(first+' '+source.replace('34911000222','34911000333')),null);
  });
  test(name+': decoded content, phone, params, source and token boundary checked',()=>{
    const bot=createBot(path);const spec=bot.getUrlTransformationSpec(first);
    const output=bot.buildWhatsAppLinkTransformationFallback(spec);
    for(const [value,issue] of [[output.replace('34911000222','34911000333'),'recipient_changed'],
      [output.replace('Halloween','Halloweenish'),'required_text_missing'],
      [output.replace('app_absent=0','app_absent=1'),'parameters_changed'],
      [output.replace('api.whatsapp.com','web.whatsapp.com'),'source_changed'],
      [output.replace('text=','old_text='),'empty_message']]) {
      assert.ok(bot.evaluateUrlTransformationResponse(spec,value).issues.includes(issue));
    }
  });
  test(name+': wa.me path and encoded plus preserved, no phone added',()=>{
    const bot=createBot(path);
    for(const url of ['https://wa.me/34911000222?text=old','https://api.whatsapp.com/send?phone=%2B34911000222&text=old']) {
      const spec=bot.getUrlTransformationSpec(first.replace(source,url));
      const output=bot.buildWhatsAppLinkTransformationFallback(spec);assert.ok(output);
      assert.equal(bot.parseWhatsAppLink(output).phone,bot.parseWhatsAppLink(url).phone);
      assert.equal(new URL(output).pathname,new URL(url).pathname);
      if(url.includes('wa.me'))assert.equal(new URL(output).searchParams.has('phone'),false);
    }
  });
  test(name+': unknown promotion and unsupported edits never replaced by generic fallback',()=>{
    const bot=createBot(path);
    const unknown=bot.getUrlTransformationSpec('Adaptá este enlace para esta promoción: '+source);
    assert.ok(unknown);assert.equal(unknown.promotionName,'');assert.equal(bot.buildWhatsAppLinkTransformationFallback(unknown),'');
    for(const request of [first+' Agregá disponibilidad y un saludo formal.', first+' Ofrecé dos alternativas.',
      first+' No incluyas una cita.', first+' Cambiá el número a 34911000444.',
      first+' Usá solamente este texto: "Consulta por Halloween".']) {
      const spec=bot.getUrlTransformationSpec(request);assert.equal(bot.buildWhatsAppLinkTransformationFallback(spec),'');
    }
    assert.equal(bot.getUrlTransformationSpec('Explicá cómo funciona WhatsApp'),null);
  });
}

test('actual extension send flow: three turns, zero provider calls and preserved context identity',async()=>{
  const bot=createBot(extension);let providerCalls=0;let errors=0;
  bot.elements={input:{value:'',style:{}}};bot.pendingImages=[];
  bot.loadPendingChatRequest=async()=>null;bot.normalizeImageAttachments=()=>[];
  bot.getComposerDraftPayload=()=>({text:bot.elements.input.value});bot.getComposerDraftSignature=()=>bot.elements.input.value;
  bot.getLocalTextTransformInstruction=()=>null;bot.clearDraft=()=>{};
  bot.addUserMessage=(content,image,meta)=>bot.conversation.push({type:'user',content,contextMeta:meta});
  bot.addAssistantMessage=(content,meta)=>bot.conversation.push({type:'assistant',content,contextMeta:meta});
  bot.runChatRequest=async()=>{providerCalls++;};bot.addSystemMessage=()=>{errors++;};bot.getChatErrorCopy=()=>'';
  for(const request of [first,correction,insistence]) {
    bot.elements.input.value=request;await bot.handleSendMessage();
    assert.ok(new URL(bot.conversation.at(-1).content).searchParams.get('text').includes('Halloween'));
    assert.equal(bot.conversation.at(-1).contextMeta.pageUrl,page);
    assert.equal(bot.isSubmitting,false);
  }
  assert.equal(errors,0);assert.equal(providerCalls,0);assert.equal(bot.conversation.length,6);
});

test('STAGING baseline reproduces failure without provider, cache or output renderer',()=>{
  const old=execFileSync('git',['show','0a3f3452f5f593bcb4125a9c19a7f1e9e9ed778d:claude-chatbot.js'],
    {cwd:new URL('../zentra-self-check-staging-extension/',import.meta.url),encoding:'utf8'});
  const sandbox=vm.createContext({window:{},document:{addEventListener(){}},URL,URLSearchParams});
  new vm.Script(old).runInContext(sandbox);
  const bot=Object.create(sandbox.window.ClaudeChatbot.prototype);bot.conversation=[];
  const outputs=[];
  for(const request of [first,correction,insistence]) {
    const spec=bot.getUrlTransformationSpec(request);
    assert.equal(spec.promotionName,'');
    const output=bot.buildWhatsAppLinkTransformationFallback(spec);outputs.push(output);
    assert.ok(new URL(output).searchParams.get('text').includes('esta promoción'));
    append(bot,request,output);
  }
  assert.equal(new Set(outputs).size,1);
});

test('backend authorized builder retains full correction, not generic inferred instruction',async()=>{
  const messages=[{role:'user',content:first},{role:'assistant',content:source},{role:'user',content:correction}];
  const built=await buildAuthorizedChatRoot({messages,model:'synthetic',max_tokens:500},
    {version:1,userMessage:correction,state:{conversation:[],webContext:{url:page}}}, {plan:'free',status:'active'});
  assert.equal(built.body.messages.at(-1).content,correction);
  assert.ok(built.body.messages.some(item=>item.content.includes('Halloween')));
});

test('distinct corrections do not share the request fingerprint',()=>{
  const original={messages:[{role:'user',content:first}]};
  assert.notEqual(requestFingerprint(original),requestFingerprint({messages:[...original.messages,{role:'user',content:correction}]}));
});

test('extension/trusted pure self-check implementations remain identical',()=>{
  const block=path=>{const s=read(path);return s.slice(s.indexOf('  getWhatsAppTransformationHistory('),s.indexOf('  isInvalidDirectTextOrganizationResponse('));};
  assert.equal(block(extension),block(new URL('./trusted-chat-builders.js',import.meta.url)));
});

for(const [name,path] of [['extension',extension],['trusted builder',new URL('./trusted-chat-builders.js',import.meta.url)]]) {
  test(name+': valid model answer and public reference are not rejected/replaced',()=>{
    const bot=createBot(path);const spec=bot.getUrlTransformationSpec(first);
    const link=new URL(source);link.searchParams.set('text','Hola, quisiera información de Halloween y disponibilidad.');
    const output='Este es el enlace solicitado:\n'+link+'\nReferencia: https://example.test/promociones';
    assert.equal(bot.evaluateUrlTransformationResponse(spec,output).valid,true);
    assert.equal(bot.isInvalidUrlTransformationResponse({userMessage:first,assistantText:output}),false);
    let shown=output;
    if(bot.isInvalidUrlTransformationResponse({userMessage:first,assistantText:shown})) {
      shown=bot.buildWhatsAppLinkTransformationFallback(spec)||shown;
    }
    assert.equal(shown,output);
  });
  test(name+': generic labels do not invent requirements or borrow an old promotion',()=>{
    const bot=createBot(path);append(bot,first,source);
    for(const label of ['la web','este mes','nuestra empresa']) {
      const request='Adaptá este enlace para la promoción de '+label+': '+source;
      const spec=bot.getUrlTransformationSpec(request);assert.ok(spec);
      assert.equal(spec.promotionName,'');assert.equal(bot.buildWhatsAppLinkTransformationFallback(spec),'');
      const valid=new URL(source);valid.searchParams.set('text','Hola, quisiera información de esta promoción.');
      assert.equal(bot.evaluateUrlTransformationResponse(spec,valid.toString()).valid,true);
    }
  });
  test(name+': ordinary questions and words inside URL text do not become edits',()=>{
    const bot=createBot(path);append(bot,first,source);
    for(const request of ['Explicame qué dice el mensaje de esta promoción en este enlace: '+source,
      '¿Qué es una promoción de Halloween?','Dame ideas para una campaña de Halloween.',
      'Explicá este enlace: '+source.replace('Hola,','Incluí+Halloween+y+adaptá+el+enlace,')]) {
      assert.equal(bot.getUrlTransformationSpec(request),null);
      assert.equal(bot.isInvalidUrlTransformationResponse({userMessage:request,assistantText:'Respuesta normal del modelo.'}),false);
    }
  });
  test(name+': unrelated classifications preserve STAGING behavior',()=>{
    const baseline=execFileSync('git',['show',path===extension
      ? '0a3f3452f5f593bcb4125a9c19a7f1e9e9ed778d:claude-chatbot.js'
      : 'd41867d64cfee0ea74938407b1164119e9fa10aa:trusted-chat-builders.js'],
      {cwd:new URL(path===extension?'../zentra-self-check-staging-extension/':'./',import.meta.url),encoding:'utf8'});
    const sandbox=vm.createContext({window:{},document:{addEventListener(){}},URL,URLSearchParams});
    new vm.Script(baseline).runInContext(sandbox);
    const old=Object.create(sandbox.window.ClaudeChatbot.prototype);
    const bot=createBot(path);
    Object.assign(old,{conversation:[],webContext:{url:page},documentContexts:[],taskMemory:{}});
    for(const request of ['Necesito ideas para presentar mi producto.','Dame un mensaje breve para un cliente.',
      'Explicame la diferencia entre SEO y SEM.','¿Qué trabajos están pendientes?',
      'Compará estas dos propuestas.','Resumí este texto: el equipo confirmó el trabajo.']) {
      const options={userMessage:request,interactionMeta:{source:'direct',mode:'direct_conversation',modality:'text'}};
      assert.deepEqual(JSON.parse(JSON.stringify(bot.detectResponseContract(options))),
        JSON.parse(JSON.stringify(old.detectResponseContract(options))));
    }
  });
}

for(const mode of ['quick','work']) {
  test(mode+': normal query and complex edit reach existing model path intact',async()=>{
    for(const message of ['Explicame cómo organizar una campaña de Halloween.',
      'Explicame qué dice el mensaje de esta promoción en este enlace: '+source,
      first+' Agregá disponibilidad y un saludo formal.']) {
      const bot=createBot(extension);const errors=[];const calls=[];
      bot.elements={input:{value:message,style:{}}};bot.pendingImages=[];
      bot.loadPendingChatRequest=async()=>null;bot.normalizeImageAttachments=()=>[];
      bot.getComposerDraftPayload=()=>({text:bot.elements.input.value});bot.getComposerDraftSignature=()=>bot.elements.input.value;
      bot.getLocalTextTransformInstruction=()=>null;bot.clearDraft=()=>{};
      bot.addUserMessage=(content,image,meta)=>bot.conversation.push({type:'user',content,contextMeta:meta});
      bot.addAssistantMessage=()=>assert.fail('A local answer must not replace the model');
      bot.createAssistantDraftForRequest=()=>({});bot.savePendingChatRequest=async()=>true;
      bot.runChatRequest=async args=>calls.push(args);
      bot.addSystemMessage=text=>errors.push(text);bot.getChatErrorCopy=e=>e.message;
      const window=vm.runInContext('window',bot.__testSandbox);
      window.ZentraDisplay={isWork:mode==='work',sync:async()=>{}};
      await bot.handleSendMessage();
      assert.deepEqual(errors,[]);assert.equal(calls.length,1);
      assert.equal(calls[0].message,message);assert.equal(bot.conversation[0].content,message);
      assert.equal(bot.isSubmitting,false);
    }
  });
}
