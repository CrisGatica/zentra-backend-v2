import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createConversationAudioEntitlement} from '../../release-conversation-audio-entitlement.js';
import {createConversationAudioHandlers} from '../../release-conversation-audio.js';

const env={SUPABASE_URL:'https://qfwmjgoiwketpkuhvixm.supabase.co',RENDER_EXTERNAL_HOSTNAME:'zentra-backend-v2-staging.onrender.com'};
const source=readFileSync(new URL('../../server.js',import.meta.url),'utf8');
function sharedResolver(row) {
  const calls=[];
  const pick=(name,next)=>source.slice(source.indexOf('function '+name+'('),source.indexOf('function '+next+'('));
  const sandbox=vm.createContext({TEMP_UNLIMITED_AGENCY_EMAILS:new Set(['cristiangaticanegocios@gmail.com']),
    normalizeEmail:email=>String(email).trim().toLowerCase(),normalizeIdentityInput:value=>value,
    getDefaultSubscriptionUser:()=>({}),getSupabaseClient:()=>({async rpc(name,args){calls.push({name,args});
      return name==='zentra_access'?{data:structuredClone(row)}:{data:{state:'free_waitlist',usage:structuredClone(row)}};}})});
  new vm.Script(pick('hasUnlimitedAgencyOverride','getUnlimitedAuditUsage')+'\nasync '+
    pick('ensureFreshSubscriptionUsage','consumeSubscriptionUsage').replace(/async\s*$/,'')+
    '\nthis.resolve=ensureFreshSubscriptionUsage;this.override=hasUnlimitedAgencyOverride;').runInContext(sandbox);
  return {resolveSubscription:sandbox.resolve,isUnlimited:sandbox.override,calls};
}
test('audio reuses the exact existing Chat subscription resolver, Free/paid/override unchanged',async()=>{
  for(const [dbPlan,email,expected] of [['free','fixture@staging.test','free'],['starter','fixture@staging.test','starter'],
    ['pro','fixture@staging.test','pro'],['agency','fixture@staging.test','agency'],['free','cristiangaticanegocios@gmail.com','agency']]){
    const shared=sharedResolver({plan:dbPlan,status:'active',actions_used:7});
    const resolve=createConversationAudioEntitlement({...shared,env});
    const result=await resolve({userId:'verified',email,identitySource:'verified_session'});
    assert.equal(result.plan,expected);assert.equal(result.unlimited,email==='cristiangaticanegocios@gmail.com');
    assert.equal(shared.calls[0].name,'zentra_access');assert.equal(shared.calls[0].args.p_auth_id,'verified');
    assert.equal(shared.calls.some(c=>c.name==='zentra_free_status'),dbPlan==='free'&&expected==='free');
  }
  assert.ok(source.includes('resolveSubscription:ensureFreshSubscriptionUsage,isUnlimited:hasUnlimitedAgencyOverride'));
});
test('override cannot propagate outside both exact STAGING guards or without verified identity',async()=>{
  const shared=sharedResolver({plan:'free',status:'active'});
  for(const other of [{...env,SUPABASE_URL:'https://production.example'},{...env,RENDER_EXTERNAL_HOSTNAME:'production.example'},
    {SUPABASE_URL:env.SUPABASE_URL}]){
    await assert.rejects(createConversationAudioEntitlement({...shared,env:other})({userId:'verified',email:'cristiangaticanegocios@gmail.com'}),/entitlement_unavailable/);
  }
  await assert.rejects(createConversationAudioEntitlement({...shared,env})({email:'cristiangaticanegocios@gmail.com'}),/unauthenticated/);
});
test('client plan/override spoof does not enter service-role audio RPC arguments',async()=>{
  const shared=sharedResolver({plan:'free',status:'active'}),calls=[];
  const resolve=createConversationAudioEntitlement({...shared,env});
  const handlers=createConversationAudioHandlers({env,resolveEntitlement:resolve,client:{async rpc(name,args){calls.push({name,args});return {data:{allowed:false,reason:'audio_disabled'}};}},
    transcribe(){throw Error('Provider forbidden');}});
  const res={status(){return this;},json(body){this.body=body;}};
  await handlers.prepare({auth:{userId:'verified-free',email:'fixture@staging.test'},body:{plan:'agency',p_unlimited:true,unlimited_agency:true,
    email:'cristiangaticanegocios@gmail.com',operationId:'10000000-0000-4000-8000-000000000001',
    conversationContext:{schema_version:'zentra.conversation.v1',platform:'respond.io',type:'conversation',contact:{id:'fixture'},messages:[]}}},res);
  assert.equal(calls.length,1);assert.equal(calls[0].args.p_unlimited,false);
  assert.equal(calls[0].args.p_auth_id,'verified-free');assert.equal(calls[0].args.p_email,'fixture@staging.test');
  assert.equal(res.body.code,'audio_disabled');
});

const url='https://app.respond.io/space/1/inbox/fixture';
const ctx=resource=>({platform:'respond.io',contact:{id:'fixture'},messages:[{id:'audio-one',type:'audio',direction:'outgoing',
  audio:{native_status:'unavailable',duration_ms:null},media:resource?[{type:'audio',url:'https://cdn.chatapi.net/fixture.mp3'}]:[]}]});
function transport() {
  const sandbox=vm.createContext({URL,Uint8Array,AbortController,setTimeout,clearTimeout,btoa});
  new vm.Script(readFileSync(process.env.ZENTRA_CHAT_ROOT+'/conversation-audio-transport.js','utf8')).runInContext(sandbox);
  return sandbox.createConversationAudioTransport;
}
const input={authorized:true,tabId:1,pageUrl:url,contactId:'fixture',messageId:'audio-one'};
for(const lazy of [false,true])test('resource '+(lazy?'lazy':'immediate')+' with unknown/00:00 metadata transports without playback',async()=>{
  let reads=0,waits=0,fetches=0;
  const obtain=transport()({getTab:async()=>({active:true,url}),getContext:async()=>({url,data:ctx(!lazy||++reads>=3)}),
    wait:async()=>waits++,fetchImpl:async()=>{fetches++;return new Response(new Uint8Array([1,2,3]));}});
  assert.equal((await obtain(input)).id,'audio-one');assert.equal(fetches,1);assert.equal(waits,lazy?2:0);
});
test('missing resource stops locally, bounded polling; no fetch or backend call',async()=>{
  let reads=0,fetches=0;
  const obtain=transport()({getTab:async()=>({active:true,url}),getContext:async()=>{reads++;return {url,data:ctx(false)};},wait:async()=>{},
    fetchImpl:async()=>{fetches++;throw Error('Forbidden');}});
  await assert.rejects(obtain(input),/audio_resource_unavailable/);assert.equal(reads,20);assert.equal(fetches,0);
});
test('lazy wait rechecks contact/native/active tab rather than crossing conversations',async()=>{
  let reads=0;
  const obtain=transport()({getTab:async()=>({active:true,url}),getContext:async()=>{const data=ctx(false);if(++reads===2)data.contact.id='other';return {url,data};},
    wait:async()=>{},fetchImpl:async()=>{throw Error('Forbidden');}});
  await assert.rejects(obtain(input),/conversación activa cambió/);assert.equal(reads,2);
});
test('transport failure cannot reserve minutes or consume actions; transport has no backend endpoint',async()=>{
  const obtain=transport()({getTab:async()=>({active:true,url}),getContext:async()=>({url,data:ctx(true)}),
    fetchImpl:async()=>new Response(null,{status:403})});
  await assert.rejects(obtain(input),/obtener el audio/);
  const text=readFileSync(process.env.ZENTRA_CHAT_ROOT+'/conversation-audio-transport.js','utf8');
  assert.ok(!text.includes('.play('));assert.ok(!text.includes('chrome.cookies'));assert.ok(!text.includes('onrender.com'));
});
