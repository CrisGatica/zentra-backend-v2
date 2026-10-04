import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import EmbeddedPostgres, { Pool, JSDOM } from './local-postgres.mjs';

const backend = process.env.ZENTRA_BACKEND_DIR;
const root = process.env.ZENTRA_CHAT_ROOT;
const { createOperationGuard } = await import(pathToFileURL(backend + '/release-operations.js'));
const { createAuditAcquisitionHandler } = await import(pathToFileURL(backend + '/release-audit-acquisition.js'));
const { createFreeNotifyHandler } = await import(pathToFileURL(backend + '/release-free-launch.js'));
function response() {
  return Object.assign(new EventEmitter(), { statusCode: 200, set() { return this; },
    status(n) { this.statusCode=n; return this; }, json(v) { this.body=v; this.emit('finish'); return this; } });
}

test('Free launch: real PostgreSQL atomic grants, lifetime usage, commercial boundary and resume', async t => {
  const port = 55521;
  const pg = new EmbeddedPostgres({ databaseDir: '/tmp/zentra-free-' + process.pid,
    port, user: 'postgres', password: crypto.randomUUID(), persistent: false,
    postgresFlags: ['-h', '127.0.0.1'], onLog() {}, onError() {} });
  let db, pool;
  try {
    await pg.initialise(); await pg.start(); db=pg.getPgClient(); await db.connect();
    await db.query('create role anon; create role authenticated; create role service_role');
    for (const name of ['users','release-guard','execution-guard','http-rate','lemon',
      'executive-refiner','premium-reasoning','search-lifecycle','executive-recovery','free-launch','free-launch']) {
      await db.query(await readFile(backend + '/supabase-' + name + '.sql', 'utf8'));
    }
    pool = new Pool({ host:'127.0.0.1', port, user:'postgres', password: pg.options?.password, max:24 });
    const rpc = async (name, args) => {
      try {
        const values=Object.values(args);
        const call=name+'('+values.map((_,i)=>'$'+(i+1)).join(',')+')';
        const result=await pool.query('select '+(name==='zentra_access'?'to_jsonb('+call+')':call)+' r',values);
        return {data:result.rows[0].r};
      } catch(error) { return {error}; }
    };
    const client={rpc};
    const consume=async (id, counter='actions_used', key=crypto.randomUUID(), product='subscription') => {
      const r=await rpc('zentra_consume',{a:id,e:id+'@fixture.test',p:product,c:counter,k:key,u:false});
      if(r.error)throw r.error; return r.data;
    };
    const status=async id => {
      const r=await rpc('zentra_free_status',{a:id,e:id+'@fixture.test',p:'subscription'});
      if(r.error)throw r.error;return r.data;
    };
    await t.test('signup and usage reads do not claim a slot; migration is repeatable and private',async()=>{
      assert.equal((await status('registered')).state,'free_eligible');
      assert.equal((await db.query('select activated_total from zentra_free_launch_config')).rows[0].activated_total,0);
      assert.equal((await db.query("select has_function_privilege('authenticated','zentra_consume(text,text,text,text,text,boolean)','execute') ok")).rows[0].ok,false);
      assert.equal((await db.query("select has_table_privilege('anon','zentra_free_launch_config','update') ok")).rows[0].ok,false);
    });
    await t.test('exactly 300 distinct concurrent first actions succeed, account 301 waitlisted',async()=>{
      const results=await Promise.all(Array.from({length:301},(_,i)=>consume('account-'+i)));
      assert.equal(results.filter(r=>r.allowed).length,300);
      assert.equal(results.filter(r=>r.reason==='free_access_blocked').length,1);
      assert.equal((await db.query('select activated_total from zentra_free_launch_config')).rows[0].activated_total,300);
      assert.equal((await db.query('select count(*)::int n from zentra_free_access where ever_used')).rows[0].n,300);
      assert.equal((await status('registered')).state,'free_waitlist');
      const denied=results.find(r=>!r.allowed);
      assert.ok(denied.commercial.waitlisted_at);
      assert.equal(denied.user.actions_used,0);
    });
    await t.test('waitlist preference uses authenticated identity, survives reads, never claims',async()=>{
      const res=response();
      await createFreeNotifyHandler({client})({auth:{userId:'registered',email:'registered@fixture.test'},
        body:{userId:'victim'}},res);
      assert.equal(res.body.notify_free_opening,true);
      assert.equal((await status('registered')).notify_free_opening,true);
      assert.equal((await db.query("select count(*)::int n from zentra_free_access where auth_user_id='victim'")).rows[0].n,0);
    });
    await t.test('capacity increase opens new slots without resetting counts or expiry',async()=>{
      await db.query('update zentra_free_launch_config set capacity_total=800');
      assert.equal((await consume('registered')).allowed,true);
      const s=await status('registered');
      assert.equal(s.state,'free_active');
      assert.equal(new Date(s.expires_at)-new Date(s.activated_at),30*86400000);
      assert.equal(s.notify_free_opening,true);
    });
    await t.test('Chat and Audit concurrent activation and repeated same operation charge exactly once',async()=>{
      const key=crypto.randomUUID();
      const result=await Promise.all([consume('both','actions_used',key),consume('both','actions_used',key),
        consume('both','audits_used',crypto.randomUUID())]);
      assert.ok(result.every(r=>r.allowed));
      assert.equal((await status('both')).actions_remaining,19);
      assert.equal((await status('both')).audits_remaining,0);
      assert.equal((await db.query("select count(*)::int n from zentra_free_access where auth_user_id='both' and ever_used")).rows[0].n,1);
    });
    await t.test('different product rows share one Auth activation and one lifetime Free allowance',async()=>{
      const before=(await db.query('select activated_total from zentra_free_launch_config')).rows[0].activated_total;
      const r=await Promise.all([consume('cross-product','actions_used'),
        consume('cross-product','audits_used',crypto.randomUUID(),'audit')]);
      assert.ok(r.every(v=>v.allowed));
      assert.equal((await status('cross-product')).actions_remaining,19);
      assert.equal((await status('cross-product')).audits_remaining,0);
      assert.equal((await db.query('select activated_total from zentra_free_launch_config')).rows[0].activated_total,before+1);
    });
    await t.test('legacy separate Free product rows do not replenish limits at activation',async()=>{
      await db.query("insert into users(email,auth_user_id,plan_type,actions_used,audits_used) values ('old-both@fixture.test','old-both','subscription',10,0),('old-both@fixture.test','old-both','audit',0,1)");
      assert.equal((await consume('old-both')).user.actions_used,11);
      assert.equal((await status('old-both')).audits_remaining,0);
      assert.equal((await consume('old-both','audits_used',crypto.randomUUID(),'audit')).allowed,false);
    });
    await t.test('concurrent first user-row creation repeatedly resolves Auth uniqueness without failure',async()=>{
      for(let i=0;i<20;i++) {
        const key=crypto.randomUUID(),id='creation-'+i;
        const results=await Promise.all(Array.from({length:6},()=>consume(id,'actions_used',key)));
        assert.ok(results.every(r=>r.allowed));
        assert.equal((await status(id)).actions_remaining,19);
      }
    });
    await t.test('first Audit acquires Free before crawl and renewals do not reconsume',async()=>{
      const op=crypto.randomUUID(),req={auth:{userId:'audit-first',email:'audit-first@fixture.test'},
        body:{zentra_operation:{id:op,product:'subscription',source:'https://fixture.test/'}}};
      const r=response();await createAuditAcquisitionHandler({client})(req,r);
      assert.equal(r.statusCode,200);assert.equal(r.body.entitlement.maxPages,3);
      req.body.lease_token=r.body.lease_token;
      const again=response();await createAuditAcquisitionHandler({client})(req,again);
      assert.equal(again.statusCode,200);assert.equal((await status('audit-first')).audits_remaining,0);
      await rpc('zentra_release_audit',{a:'audit-first',e:'audit-first@fixture.test',p:'subscription',o:op,l:r.body.lease_token});
      assert.equal((await status('audit-first')).audits_remaining,1);
      assert.equal((await status('audit-first')).ever_used,true);
    });
    await t.test('partial exhaustion, total exhaustion and quotas do not grant a second access',async()=>{
      for(let i=0;i<20;i++) assert.equal((await consume('quota')).allowed,true);
      assert.equal((await status('quota')).chat_block,'free_actions_exhausted');
      assert.equal((await status('quota')).audit_allowed,true);
      assert.equal((await consume('quota')).reason,'free_access_blocked');
      assert.equal((await consume('quota','audits_used')).allowed,true);
      assert.equal((await status('quota')).chat_block,'free_exhausted');
      assert.equal((await status('quota')).audit_block,'free_exhausted');
      assert.equal((await status('both')).audit_block,'free_audits_exhausted');
      assert.equal((await status('both')).chat_allowed,true);
    });
    await t.test('expiry is terminal, new capacity never recycles expired activations, no monthly Free reset',async()=>{
      const before=(await db.query('select activated_total from zentra_free_launch_config')).rows[0].activated_total;
      await db.query("update zentra_free_access set activated_at=now()-interval '31 days',expires_at=now()-interval '1 day' where auth_user_id='registered'");
      await db.query("update users set billing_cycle_start=1 where auth_user_id='registered'");
      assert.equal((await status('registered')).state,'free_expired');
      assert.equal((await consume('registered')).allowed,false);
      assert.equal((await status('registered')).actions_remaining,19);
      assert.equal((await db.query('select activated_total from zentra_free_launch_config')).rows[0].activated_total,before);
      assert.equal((await db.query("select billing_cycle_start from users where auth_user_id='registered'")).rows[0].billing_cycle_start,'1');
    });
    await t.test('existing legacy counters preserved, paid overrides expired/waitlist, paid renewals unchanged',async()=>{
      await db.query("insert into users(email,auth_user_id,actions_used,audits_used) values('legacy@fixture.test','legacy',10,0)");
      assert.equal((await consume('legacy')).user.actions_used,11);
      for(const id of ['registered','paid-waitlist']) {
        if(id==='paid-waitlist') {
          await db.query('update zentra_free_launch_config set capacity_total=0');
          assert.equal((await consume(id)).commercial.state,'free_waitlist');
          await db.query('update zentra_free_launch_config set capacity_total=800');
        }
        await status(id);
        await db.query("update users set plan='starter',status='active',actions_used=10,audits_used=1 where auth_user_id=$1",[id]);
        assert.equal((await status(id)).state,'paid');
        assert.equal((await consume(id)).allowed,true);
      }
      await db.query("update users set billing_cycle_start=1 where auth_user_id='registered'");
      assert.equal((await consume('registered')).user.actions_used,1);
      await db.query("update users set plan='free' where auth_user_id='registered'");
      assert.equal((await status('registered')).state,'free_expired');
      assert.equal((await status('registered')).actions_remaining,19);
    });
    await t.test('configuration is dynamic, paused campaign blocks only new activations',async()=>{
      await db.query('update zentra_free_launch_config set access_days=2,enabled=false');
      assert.equal((await consume('paused')).commercial.state,'free_waitlist');
      assert.equal((await consume('both')).allowed,true);
      await db.query('update zentra_free_launch_config set enabled=true');
      assert.equal((await consume('two-days')).allowed,true);
      const s=await status('two-days');
      assert.equal(new Date(s.expires_at)-new Date(s.activated_at),2*86400000);
      await db.query('update zentra_free_launch_config set access_days=30');
    });
    await t.test('refund and retry adjust lifetime usage once without freeing promotional capacity',async()=>{
      const op=crypto.randomUUID(),src='a'.repeat(64),hash='b'.repeat(64);
      const begin=()=>rpc('zentra_begin_request',{a:'refund',e:'refund@fixture.test',p:'subscription',o:op,s:src,h:hash,k:'chat',u:false});
      const first=(await begin()).data;
      assert.equal(first.allowed,true);
      const args={u:first.user.id,o:op,h:hash,l:first.lease_token,r:null,s:false};
      assert.equal((await rpc('zentra_finish_request',args)).data.accepted,true);
      assert.equal((await rpc('zentra_finish_request',args)).data.accepted,false);
      assert.equal((await status('refund')).actions_remaining,20);
      assert.equal((await begin()).data.allowed,true);
      assert.equal((await status('refund')).actions_remaining,19);
    });
    await t.test('real operation middleware: first Chat continues, completion replay/expiry/refinements no provider duplicate',async()=>{
      let provider=0;
      const req={method:'POST',path:'/api/chat',auth:{userId:'live',email:'live@fixture.test'},
        body:{messages:[{role:'user',content:'Hola'}],zentra_operation:{id:crypto.randomUUID()}}};
      const original=structuredClone(req.body);
      const guard=createOperationGuard({client}),r=response();
      await guard(req,r,async()=>{
        await req.startProviderOperation();provider++;
        await r.json({success:true,response:'Respuesta completa'});
      });
      // The middleware invokes next without awaiting its async return.
      for(let i=0;i<100 && !r.body;i++)await new Promise(resolve=>setTimeout(resolve,5));
      assert.equal(provider,1);assert.equal(r.body.response,'Respuesta completa');
      await db.query("update zentra_free_access set activated_at=now()-interval '31 days',expires_at=now()-interval '1 day' where auth_user_id='live'");
      const replay=response();await guard({...req,body:original},replay,()=>assert.fail('Cached replay called provider'));
      assert.equal(replay.body.response,'Respuesta completa');assert.equal(provider,1);
      assert.equal((await status('live')).actions_remaining,19);
    });
    await t.test('real Chat/Audit boundaries block waitlist/expired/quotas before provider or crawl',async()=>{
      await db.query('update zentra_free_launch_config set capacity_total=0');
      for(const id of ['blocked','registered','quota']) {
        const r=response();
        await createOperationGuard({client})({method:'POST',path:'/api/chat',
          auth:{userId:id,email:id+'@fixture.test'},
          body:{messages:[{role:'user',content:'Hola'}],zentra_operation:{id:crypto.randomUUID()}}},
          r,()=>assert.fail('Commercial denial called provider'));
        assert.equal(r.statusCode,403);assert.equal(r.body.code,'free_access_blocked');
        const a=response();
        await createAuditAcquisitionHandler({client})({auth:{userId:id,email:id+'@fixture.test'},
          body:{zentra_operation:{id:crypto.randomUUID(),product:'subscription',source:'https://fixture.test/'}}},a);
        assert.equal(a.statusCode,403);assert.equal(a.body.code,'free_access_blocked');
      }
    });
  } finally { await pool?.end();await db?.end();await pg.stop(); }
});

test('STAGING UI consumes only structured states, persists notify, preserves paid limits, and opens pricing tab',async()=>{
  const dom=new JSDOM('<body><details id="seo-audit-accordion"></details><div id="chat-input-area"></div><textarea id="chat-input"></textarea></body>',
    {url:'https://fixture.test',runScripts:'outside-only'});
  const w=dom.window,requests=[],tabs=[];
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.HTMLElement.prototype.scrollIntoView=function(){};
  w.matchMedia=()=>({matches:true});
  w.chrome={tabs:{create(v){tabs.push(v);}}};
  w.zentraSubscription={backendBaseUrl:'https://staging.fixture.test'};
  w.zentraApiFetch=async(url,init)=>{requests.push({url,init});return new Response(JSON.stringify({success:true,notify_free_opening:true}));};
  try {
    w.eval(await readFile(root+'/free-launch-ui.js','utf8'));
    assert.equal(w.zentraFreeLaunch.commercialError({error:'free_waitlist'}),null);
    const state={state:'free_waitlist',chat_block:'free_waitlist',audit_block:'free_waitlist'};
    w.zentraFreeLaunch.show(state);
    const buttons=w.document.querySelectorAll('button');
    buttons[0].click();
    for(let i=0;i<20;i++)await Promise.resolve();
    assert.equal(requests.length,1);assert.equal(requests[0].init.body,'{}');
    assert.match(w.document.querySelector('p').textContent,/quedaste anotado/);
    buttons[1].click();assert.equal(tabs[0].url,'https://tryzentra.app/#planes');
    w.zentraFreeLaunch.show({chat_block:'free_actions_exhausted',audits_remaining:1,expires_at:'2026-12-01T00:00:00Z'});
    assert.match(w.document.querySelector('p').textContent,/1 auditoría/);
    w.document.querySelector('button').click();assert.equal(w.document.querySelector('details').open,true);
    w.zentraFreeLaunch.show({audit_block:'free_audits_exhausted',actions_remaining:7},'audit');
    assert.match(w.document.querySelector('p').textContent,/7 acciones/);
    w.eval(await readFile(root+'/subscription-manager.js','utf8'));
    const sub=w.zentraSubscription;
    const current=sub.normalizeUser({plan:'free',actions_used:10,billing_cycle_start:1,free_access:state});
    assert.equal(sub.resetMonthlyUsageIfNeeded(current).actions_used,10);
    assert.equal(sub.canUseAction(current).allowed,true,'Backend root reservation, not local inference, decides denial');
    assert.equal(sub.canUseAction({plan:'starter',actions_used:300}).allowed,false);
    assert.equal(sub.normalizeUser(current).free_access.state,'free_waitlist');
  } finally {w.close();}
});

test('actual STAGING transports and Chat lifecycle preserve commercial state without error/history/resume fallback',async()=>{
  const dom=new JSDOM('<body></body>',{url:'https://fixture.test',runScripts:'outside-only'});
  const w=dom.window;
  w.console={log(){},warn(){},error(){}};
  const commercial={state:'free_waitlist',chat_block:'free_waitlist',audit_block:'free_waitlist'};
  let requests=0,shown=0,removed=0,cleared=0,ended=0;
  try {
    w.eval(await readFile(root+'/free-launch-ui.js','utf8'));
    w.zentraFreeLaunch.show=(state,kind)=>{assert.equal(state.state,'free_waitlist');assert.equal(kind,'chat');shown++;};
    w.zentraApiFetch=async()=>{
      requests++;return new Response(JSON.stringify({code:'free_access_blocked',commercial}),{status:403});
    };
    w.eval(await readFile(root+'/ai-provider.js','utf8'));
    const provider=w.ZentraAIProvider;
    assert.ok(provider);
    for(const method of ['sendMessages','streamMessages']) {
      await assert.rejects(provider[method]({body:{messages:[{role:'user',content:'Hola'}]}}),
        error=>error.code==='free_access_blocked' && error.commercial.state==='free_waitlist');
    }
    assert.equal(requests,2,'Each transport attempts once, no provider retry');
    w.eval(await readFile(root+'/claude-chatbot.js','utf8'));
    const bot=Object.create(w.ClaudeChatbot.prototype);
    Object.assign(bot,{loadPendingChatRequest:async()=>({operationId:'same-id'}),
      sendToAPI:()=>provider.sendMessages({body:{messages:[{role:'user',content:'Hola'}]}}),
      removeAssistantDraftMessage(){removed++;},
      clearPendingChatRequest:async id=>{assert.equal(id,'same-id');cleared++;},
      getEnvironmentContextSummary:()=>'',detectContextualSurface:()=>({}),
      clearPendingImage(){},clearPendingDocument(){},
      addSystemMessage(){assert.fail('Commercial block rendered as technical error');}
    });
    w.zentraOperations={begin(){},end(){ended++;}};
    const subscriptionManager={usageFreshAt:10};
    await bot.runChatRequest({message:'Hola',assistantDraft:{},subscriptionManager});
    assert.equal(removed,1);assert.equal(cleared,1);assert.equal(ended,1);assert.equal(shown,1);
    assert.equal(subscriptionManager.usageFreshAt,0);
    assert.equal(requests,3);
    const source=await readFile(root+'/claude-chatbot.js','utf8');
    assert.ok(source.includes("if (streamError.code === 'free_access_blocked') throw streamError;"));
  } finally {w.close();}
});
