import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditEntitlement, validateAuditEntitlement, PLAN_ENTITLEMENTS} from '../../release-entitlements.js';
import {createAuditAcquisitionHandler} from '../../release-audit-acquisition.js';
import {createApiSecurity} from '../../release-security.js';
import {createLemonHandlers, validLemonSignature} from '../../release-lemon.js';
import {buildAuditStep, prepareAuditStep} from '../../release-audit-steps.js';
import {auditFixture} from '../../staging-handoff/qa/audit-fixtures.mjs';
import {extractAuditResponse} from '../../release-audit-json.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const extension=fileURLToPath(new URL('../../../zentra-ai-v1-rc-extension/',import.meta.url));
const previous=process.env.ZENTRA_PREVIOUS_CLIENT;
assert.ok(previous,'Provide the local previous Zentra AI client; never an Audit app');
const read=f=>fs.readFileSync(path.join(extension,f),'utf8');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const original=execFileSync('git',['show','origin/main:server.js'],{cwd:root,encoding:'utf8'});
const clone=v=>JSON.parse(JSON.stringify(v));
const silent={log(){},warn(){},error(){},info(){},debug(){}};
const noNetwork=()=>assert.fail('Network/provider prohibited');
function fn(source,name){const start=source.search(new RegExp('^(?:async )?function '+name+'\\(','m'));assert.ok(start>=0,name);const next=source.slice(start+1).search(/^(?:async )?function /m);return next<0?source.slice(start):source.slice(start,start+next+1);}
const unlimited=vm.runInNewContext('('+fn(server,'hasUnlimitedAgencyOverride')+')');
const block=(source,name)=>{const start=source.indexOf('const '+name+' =');assert.ok(start>=0);return source.slice(start,source.indexOf('\n};',start)+3);};
const products=vm.runInNewContext(block(server,'LEMON_PRODUCTS')+'\nLEMON_PRODUCTS');
const res=()=>({statusCode:200,status(n){this.statusCode=n;return this;},set(){return this;},json(v){this.body=v;return this;}});

test('main JSON recovery keeps safe finish reasons, not arbitrary provider fields',()=>{
  assert.equal(extractAuditResponse({api:'responses',data:{status:'synthetic-private-value'}}).finishReason,null);
  assert.equal(extractAuditResponse({api:'responses',data:{status:'completed'}}).finishReason,'completed');
});

test('production override cannot be enabled by identity, env or request flags',()=>{
  assert.doesNotMatch(server,/TEMP_UNLIMITED_AGENCY_EMAILS|user\.unlimited_agency\s*\|\|/);
  for(const env of [{},{NODE_ENV:'test'},{NODE_ENV:'production'},
    {SUPABASE_URL:'https://qfwmjgoiwketpkuhvixm.supabase.co',RENDER_EXTERNAL_HOSTNAME:'zentra-backend-v2-staging.onrender.com',ZENTRA_UNLIMITED:'true'}]){
    for(const value of ['fixture@example.test','agency',null,{unlimited_agency:true,plan:'agency'}]){
      assert.equal(unlimited(value,{env,unlimited_agency:true}),false);
    }
  }
  const sqlPolicyCalls=server.match(/isUnlimited:\s*(?:email\s*=>\s*)?hasUnlimitedAgencyOverride/g)||[];
  assert.ok(sqlPolicyCalls.length>=3,'operations, acquisition and audio use the closed server policy');
});

test('STAGING override source remains intact and its allowed account still works offline',()=>{
  const source=execFileSync('git',['show','d41867d:server.js'],{cwd:root,encoding:'utf8'});
  const declaration=source.match(/const TEMP_UNLIMITED_AGENCY_EMAILS = new Set\(\[[\s\S]*?\]\);/)[0];
  const sandbox=vm.createContext({});
  vm.runInContext(declaration+'\n'+fn(source,'normalizeEmail')+'\n'+fn(source,'hasUnlimitedAgencyOverride')+
    '\nresult=hasUnlimitedAgencyOverride([...TEMP_UNLIMITED_AGENCY_EMAILS][0]);',sandbox);
  assert.equal(sandbox.result,true);
});

for(const [plan,pages]of Object.entries({free:3,starter:5,pro:7,agency:11}))test(plan+': DB authority sets depth; client cannot spoof plan/unlimited/identity',async()=>{
  const calls=[];
  const handler=createAuditAcquisitionHandler({isUnlimited:unlimited,client:{async rpc(name,args){calls.push({name,args});return {data:name==='zentra_access'?{plan,status:'active'}:{allowed:true,lease_token:crypto.randomUUID()}};}}});
  const response=res();
  await handler({auth:{userId:'verified-user',email:'verified@example.test'},body:{plan:'agency',unlimited_agency:true,
    userId:'other',requestedPages:999999,zentra_operation:{id:crypto.randomUUID(),product:'subscription',source:'https://example.test/'}}},response);
  assert.equal(response.statusCode,200);assert.equal(response.body.entitlement.plan,plan);
  assert.equal(response.body.entitlement.totalPages,pages);assert.equal(auditEntitlement({plan,status:'active'}).maxPages,pages);
  assert.equal(calls[0].args.p_auth_id,'verified-user');assert.equal(calls[1].args.p_unlimited,false);
});

test('commercial catalog, base quotas and production premium defaults are preserved',()=>{
  assert.equal(block(server,'LEMON_PRODUCTS'),block(original,'LEMON_PRODUCTS'));
  assert.equal(block(server,'PLAN_LIMITS'),block(original,'PLAN_LIMITS'));
  assert.equal(block(server,'PREMIUM_LIMITS'),block(original,'PREMIUM_LIMITS'));
  assert.deepEqual(Object.fromEntries(Object.entries(PLAN_ENTITLEMENTS).map(([p,v])=>[p,[v.actions,v.audits]])),
    {free:[20,1],starter:[300,5],pro:[800,10],agency:[3000,30]});
});

test('authentication rejects foreign project tokens before any operation',async()=>{
  let next=0;const response=res();
  await createApiSecurity({origins:'https://tryzentra.app',client:{auth:{async getUser(){return {error:new Error('wrong project')};}}}})(
    {path:'/api/chat',method:'POST',ip:'fixture',get:key=>key==='Authorization'?'Bearer fixture-token':key==='Origin'?'https://tryzentra.app':null},response,()=>next++);
  assert.equal(response.statusCode,401);assert.equal(next,0);
});

test('paid reconciliation without verified binding fails closed even with spoofed flags',async()=>{
  const calls=[];let next=0;const response=res();
  const handlers=createLemonHandlers({products,env:{SUPABASE_URL:'https://ohakwaihhuenpensoedh.supabase.co',RENDER_EXTERNAL_HOSTNAME:'zentra-backend-v2.onrender.com'},
    fetchImpl:noNetwork,client:{async rpc(name,args){calls.push({name,args});return {data:{unverified:true}};}}});
  await handlers.reconcile({auth:{userId:'verified-user',email:'fixture@example.test'},path:'/api/chat',body:{plan:'agency',unlimited_agency:true}},response,()=>next++);
  assert.equal(response.statusCode,503);assert.equal(response.body.code,'billing_association_required');assert.equal(next,0);
  assert.deepEqual(calls.map(c=>c.name),['zentra_lemon_sync_claim']);assert.equal(calls[0].args.p_auth,'verified-user');
});

test('webhooks require a valid signature; no payment is submitted',()=>{
  const body=Buffer.from('{"fixture":true}'),secret='synthetic-not-a-credential';
  const signature=crypto.createHmac('sha256',secret).update(body).digest('hex');
  assert.equal(validLemonSignature(body,signature,secret),true);
  assert.equal(validLemonSignature(Buffer.from('{}'),signature,secret),false);
  assert.equal(validLemonSignature(body,'',secret),false);
});

test('production artifact cannot enable the manual billing fixture by accidental staging env',async()=>{
  const response=res();let next=0;
  const handlers=createLemonHandlers({products,env:{SUPABASE_URL:'https://qfwmjgoiwketpkuhvixm.supabase.co',RENDER_EXTERNAL_HOSTNAME:'zentra-backend-v2-staging.onrender.com'},
    fetchImpl:noNetwork,client:{async rpc(){return {data:{unverified:true}};}}});
  await handlers.reconcile({auth:{userId:'0f45490e-8049-4af6-8dd8-089628738cef'},path:'/api/chat',body:{}},response,()=>next++);
  assert.equal(response.statusCode,503);assert.equal(response.body.code,'billing_association_required');assert.equal(next,0);
});

function subscription(){const sandbox=vm.createContext({window:{},URL,console:silent,localStorage:{getItem(){return null;}},fetch:noNetwork});vm.runInContext(read('subscription-manager.js'),sandbox);return sandbox.window.zentraSubscription;}
test('public extension ignores test flags without changing legitimate paid plans',()=>{
  const manager=subscription();manager.debugUnlimitedFree=true;manager.debugPlanOverride='agency';
  const user=manager.normalizeUser({plan:'free',status:'active',unlimited_agency:true});
  assert.equal(user.plan,'free');assert.equal(user.unlimited_agency,false);
  assert.deepEqual(clone(manager.getPlanLimits('free',user)),{actions:20,audits:1});
  assert.equal(manager.getPremiumLimitForTask('free','chat_premium',{unlimited_agency:true}),3);
  for(const plan of ['starter','pro','agency'])assert.equal(manager.normalizeUser({plan,unlimited_agency:true}).plan,plan);
});

test('PDF presentation follows the server reservation; test labels cannot expand scope',async()=>{
  const sandbox=vm.createContext({window:{zentraSubscription:{async getUserState(){return {plan:'agency',status:'active',unlimited_agency:true};}},
    zentraOperations:{getAuditEntitlement:()=>({plan:'free',totalPages:3})}},console:silent});
  vm.runInContext(read('claude-pdf-generator.js'),sandbox);
  assert.equal(await sandbox.window.claudePDFGenerator.resolvePDFPresentationPlan(),'free');
  sandbox.window.zentraOperations.getAuditEntitlement=()=>({plan:'agency',totalPages:11});
  assert.equal(await sandbox.window.claudePDFGenerator.resolvePDFPresentationPlan(),'agency');
});

test('public manifest has production permissions/CSP, no bridge, debug or development resources',()=>{
  const manifest=JSON.parse(read('manifest.json'));
  assert.equal(manifest.name,'Zentra AI');assert.equal(manifest.version,'1.0.3');
  assert.deepEqual(manifest.permissions,['activeTab','tabs','storage','scripting','downloads']);
  assert.deepEqual(manifest.host_permissions,['<all_urls>']);
  assert.doesNotMatch(manifest.content_security_policy.extension_pages,/http:|ws:|localhost|127\.0\.0\.1/);
  assert.doesNotMatch(read('background.js'),/ZENTRA_DESKTOP_BRIDGE|zentraPollDesktopBridge|chrome\.alarms|storage-change/);
  assert.match(read('background.js'),/importScripts\('work-window-controller.js'\)/);
  for(const f of ['zentra-dev-flags.js','conversation-audio-ui.js','conversation-audio-transport.js','tests','.env','.gitignore'])assert.equal(fs.existsSync(path.join(extension,f)),false,f);
  assert.doesNotMatch(read('popup.html'),/zentra-dev-flags|conversation-audio-ui/);
  const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?e.name==='.git'?[]:walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
  for(const file of walk(extension).filter(f=>/\.(?:js|json|html|css)$/.test(f)&&!f.includes('/lib/'))){
    const value=fs.readFileSync(file,'utf8');assert.doesNotMatch(value,/zentra-backend-v2-staging\.onrender\.com|qfwmjgoiwketpkuhvixm|__ZENTRA_INTERNAL_DEBUG__\s*=\s*true/,path.basename(file));
  }
});

test('every packaged script/style/import and content script exists locally',()=>{
  const html=read('popup.html'),manifest=JSON.parse(read('manifest.json'));
  const references=[...html.matchAll(/(?:src|href)="([^"#?]+\.(?:js|css))"/g)].map(m=>m[1]);
  references.push(...manifest.content_scripts.flatMap(s=>s.js),manifest.background.service_worker,
    ...[...read('background.js').matchAll(/importScripts\('([^']+)'\)/g)].map(m=>m[1]));
  for(const file of references){assert.doesNotMatch(file,/^https?:/);assert.ok(fs.existsSync(path.join(extension,file)),file);}
  assert.equal(read('supabase.js').match(/const SUPABASE_URL = '([^']+)'/)[1],'https://ohakwaihhuenpensoedh.supabase.co');
  const key=read('supabase.js').match(/const SUPABASE_ANON_KEY = '([^']+)'/)[1];
  if(key.startsWith('sb_publishable_')){
    assert.match(key,/^sb_publishable_[A-Za-z0-9_-]+$/);
    const previousKey=fs.readFileSync(path.join(previous,'supabase.js'),'utf8').match(/const SUPABASE_ANON_KEY = '([^']+)'/)[1];
    assert.equal(key,previousKey,'retain the public production key without logging it; Live association remains pending');
  }else{
    const payload=JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString());
    assert.equal(payload.role,'anon');assert.equal(payload.ref,'ohakwaihhuenpensoedh');
  }
});

test('transport sends credentials only to production and begins crawl after authorization',async()=>{
  const requests=[],messages=[];let allowed=true;
  const sandbox=vm.createContext({window:{supabaseClient:{auth:{async getSession(){return {data:{session:{access_token:'fixture-only',user:{id:'owner'}}}};}}}},
    chrome:{runtime:{getManifest:()=>({name:'Zentra AI'}),async sendMessage(m){messages.push(m);return {success:true};}}},
    crypto,URL,Headers,Response,AbortController,AbortSignal,setInterval:()=>1,clearInterval(){},
    async fetch(url,init){requests.push({url,init});return new Response(JSON.stringify(allowed?
      {success:true,lease_token:crypto.randomUUID(),entitlement:auditEntitlement({plan:'agency',status:'active'})}:
      {error:'No access',code:'usage_limit_reached'}),{status:allowed?200:403});}});
  vm.runInContext(read('zentra-api-client.js'),sandbox);
  const operations=sandbox.window.zentraOperations;
  await operations.reserveAudit('https://example.test/',crypto.randomUUID());
  assert.equal(requests[0].url,'https://zentra-backend-v2.onrender.com/api/audit/reserve');
  assert.equal(requests[0].init.headers.get('Authorization'),'Bearer fixture-only');
  assert.equal(messages[0].action,'beginAuditCrawl');assert.equal(messages[0].totalPages,11);
  operations.end('audit');assert.equal(messages.at(-1).action,'endAuditCrawl');
  const before=requests.length;
  await assert.rejects(sandbox.window.zentraApiFetch('https://zentra-backend-v2-staging.onrender.com/api/chat'),/no autorizado/);
  assert.equal(requests.length,before);
  allowed=false;const count=messages.length;
  await assert.rejects(operations.reserveAudit('https://example.test/',crypto.randomUUID()),/No access/);
  assert.equal(messages.length,count,'no crawl begins on rejected authorization');
});

test('saved chats, recovery and draft storage retain their keys and capacity',()=>{
  const source=read('claude-chatbot.js');
  assert.match(source,/maxSavedConversations = 11/);assert.match(source,/savedConversationsStorageKey = 'zentra-saved-conversations'/);
  for(const key of ['zentra-chat-history','zentra-chat-pending-request','zentra-task-memory'])assert.ok(source.includes(key));
  assert.match(read('chat-draft-store.js'),/indexedDB.open\('zentra-staging-composer-drafts',1\)/);
  assert.ok(read('zentra-api-client.js').includes('operation-status'));
});

function crawl(){const storage={};const sandbox=vm.createContext({URL,TextEncoder,structuredClone,console:silent,
  chrome:{runtime:{id:'fixture-extension',getURL:p=>'chrome-extension://fixture-extension/'+p},storage:{session:{async get(){return storage;},async set(v){Object.assign(storage,v);}}}}});
  vm.runInContext(read('background.js').slice(read('background.js').indexOf('function normalizeFetchedUrl('),read('background.js').indexOf('\nfunction cleanFetchedHtml(')),sandbox);
  vm.runInContext(read('audit-crawl-security.js'),sandbox);return sandbox;}
for(const mode of ['','?mode=work'])test('crawl owns the reserved scope in '+(mode?'work':'quick')+' mode',async()=>{
  const sandbox=crawl(),sender={id:'fixture-extension',url:'chrome-extension://fixture-extension/popup.html'+mode,documentId:'ui-'+mode};
  await sandbox.startAuditCrawl({auditId:crypto.randomUUID(),source:'https://example.test/',totalPages:3},sender);
  const session=await sandbox.auditCrawlFor(sender);let reads=0;
  for(const url of ['https://example.test/','https://example.test/a','https://example.test/b'])await sandbox.readBoundAuditPage(session,url,async()=>{reads++;return {url,readStatus:'complete'};});
  await sandbox.readBoundAuditPage(session,'https://example.test/a',noNetwork);assert.equal(reads,3);
  await assert.rejects(sandbox.readBoundAuditPage(session,'https://example.test/c',noNetwork),/Limite/);
  await assert.rejects(sandbox.readBoundAuditPage(session,'https://other.test/',noNetwork),/scope/);
  assert.throws(()=>sandbox.auditSenderKey({...sender,url:'https://example.test/'}),/autorizado/);
  assert.throws(()=>sandbox.auditSenderKey({...sender,id:'other-extension'}),/autorizado/);
});

for(const [label,client]of [['candidate',extension],['previous local client',previous]])test(label+': authorized root compatibility is measured without calling a provider',async()=>{
  const fixture=await auditFixture(client,'agency',{multiPage:true});
  const request=fixture.calls.find(r=>r.zentra_audit_workflow);assert.ok(request);
  const built=await buildAuditStep('seo_analysis',{body:request,context:request.zentra_audit_workflow});
  const compatible=JSON.stringify(built.messages)===JSON.stringify(request.messages);
  assert.equal(validateAuditEntitlement(request.zentra_audit_workflow,'agency'),true,'isolate prompt compatibility from entitlement');
  if(label==='candidate')assert.equal(compatible,true);
  else console.log('COMPATIBILITY previous-local-client exact-authorized-root:',compatible?'compatible':'BLOCKED: prompt differs; published client still unverified');
  if(!compatible){let registrations=0;
    const result=await prepareAuditStep({client:{async rpc(name){if(name==='zentra_read_audit_steps')return {data:{steps:[],acquisitionSource:request.zentra_audit_workflow.pageData.url}};if(name==='zentra_access')return {data:{plan:'agency',status:'active'}};registrations++;throw Error('No registration/provider permitted');}},
      identity:{userId:'verified-user',email:'fixture@example.test'},product:'subscription',operationId:crypto.randomUUID(),body:request});
    assert.equal(result.conflict,true);assert.equal(registrations,0);
  }
});
