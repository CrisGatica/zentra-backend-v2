import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import EmbeddedPostgres from './local-postgres.mjs';
import { Client } from './local-postgres.mjs';
import { pathToFileURL } from 'node:url';
import { auditFixture } from './audit-fixtures.mjs';

const backend = process.env.ZENTRA_BACKEND_DIR;
const port = 55479;
const pg = new EmbeddedPostgres({
  databaseDir: '/tmp/zentra-release-pg-' + process.pid, user: 'postgres', password: crypto.randomUUID(),
  port, persistent: false, postgresFlags: ['-h', '127.0.0.1'],
  onLog() {}, onError() {}
});
const clients = [];
let count = 0;
function passed(name) { console.log('PASS', name); count++; }
try {
  await pg.initialise();
  await pg.start();
  const db = pg.getPgClient(); await db.connect(); clients.push(db);
  await db.query('create role anon; create role authenticated; create role service_role');
  await db.query(await readFile(backend + '/supabase-users.sql', 'utf8'));
  await db.query(await readFile(backend + '/supabase-release-guard.sql', 'utf8'));
  await db.query(await readFile(backend + '/supabase-release-guard.sql', 'utf8'));
  await db.query(await readFile(backend + '/supabase-execution-guard.sql', 'utf8'));
  await db.query(await readFile(backend + '/supabase-execution-guard.sql', 'utf8'));
  await db.query(await readFile(backend + '/supabase-search-lifecycle.sql', 'utf8'));
  await db.query(await readFile(backend + '/supabase-executive-recovery.sql', 'utf8'));
  await db.query(await readFile(backend + '/supabase-lemon.sql', 'utf8'));
  passed('migration repeatable');
  const db2 = pg.getPgClient(); await db2.connect(); clients.push(db2);
  await db.query("insert into users(email,auth_user_id,plan,actions_used) values('test@example.test','u1','starter',299)");
  const consume = (connection, key) => connection.query(
    "select zentra_consume('u1','test@example.test','subscription','actions_used',$1,false) as result", [key]
  ).then(result => result.rows[0].result);
  const results = await Promise.all([consume(db,crypto.randomUUID()), consume(db2,crypto.randomUUID())]);
  assert.equal(results.filter(result => result.allowed).length,1);
  assert.equal((await db.query("select actions_used from users where auth_user_id='u1'")).rows[0].actions_used,300);
  passed('299/300: two independent connections, only one allowed');
  await db.query("update users set actions_used=299 where auth_user_id='u1'");
  const key=crypto.randomUUID();
  const repeated=await Promise.all([consume(db,key),consume(db2,key)]);
  assert.ok(repeated.every(result=>result.allowed));
  assert.equal(repeated.filter(result=>result.duplicate).length,1);
  assert.equal((await db.query("select actions_used from users where auth_user_id='u1'")).rows[0].actions_used,300);
  passed('concurrent same id: exactly one debit');
  await db.query("update users set actions_used=0,audits_used=4 where auth_user_id='u1'");
  assert.ok((await db.query("select zentra_consume('u1','test@example.test','subscription','audits_used',$1,false) r",[crypto.randomUUID()])).rows[0].r.allowed);
  assert.equal((await db.query("select zentra_consume('u1','test@example.test','subscription','audits_used',$1,false) r",[crypto.randomUUID()])).rows[0].r.allowed,false);
  passed('Starter: fifth audit allowed, sixth rejected');
  const op = crypto.randomUUID();
  const source='a'.repeat(64);
  const register=(identity,email,operation,hash,step)=>db.query(
    "select zentra_register_chat_step($1,$2,'subscription',$3,$4,$5,$6,null)",
    [identity,email,operation,step,hash,{messages:[{role:'user',content:'Fixture de etapa autorizada por servidor'}]}]);
  for(const [hash,step] of [['b','root'],['c','rewrite'],['d','polish'],['e','visible']]) {
    await register('u1','test@example.test',op,hash.repeat(64),step);
  }
  const request=(hash,src=source)=>db.query("select zentra_begin_request('u1','test@example.test','subscription',$1,$2,$3,'chat',false) r",[op,src,hash]).then(r=>r.rows[0].r);
  assert.ok((await request('b'.repeat(64))).allowed);
  assert.equal((await request('b'.repeat(64))).reason,'in_progress');
  assert.ok((await request('c'.repeat(64))).allowed);
  assert.equal((await db.query("select actions_used from users where auth_user_id='u1'")).rows[0].actions_used,1);
  assert.equal((await request('d'.repeat(64),'e'.repeat(64))).reason,'operation_conflict');
  passed('repair shares charge; source conflict blocked; duplicate in-flight blocked');
  await db.query("update zentra_requests set state='done',response='{\"text\":\"Respuesta\"}' where operation_key=$1 and request_hash=$2",[op,'b'.repeat(64)]);
  const cached=await request('b'.repeat(64)); assert.ok(cached.cached); assert.equal(cached.response.text,'Respuesta');
  passed('completed response replayed');
  assert.ok((await request('d'.repeat(64))).allowed);
  assert.ok((await request('e'.repeat(64))).allowed);
  assert.equal((await request('f'.repeat(64))).reason,'unauthorized_refinement');
  passed('unregistered repair blocked in SQL');
  await db.query("insert into users(email,auth_user_id,plan,plan_type,audit_credits) values('test@example.test','u1','pro','audit',1)");
  const auditOp=crypto.randomUUID();
  for (const [hash,step] of [['1','seo_analysis'],['2','premium_reasoning_audit']]) {
    await db.query("select zentra_register_audit_step('u1','test@example.test','audit',$1,$2,$3,'{}',null)", [auditOp,step,hash.repeat(64)]);
  }
  const audit=(hash,id=auditOp)=>db.query("select zentra_begin_request('u1','test@example.test','audit',$1,$2,$3,'audit',false) r",[id,source,hash]).then(r=>r.rows[0].r);
  assert.ok((await audit('1'.repeat(64))).allowed);
  assert.ok((await audit('2'.repeat(64))).allowed);
  const credits=(await db.query("select audit_credits_used,audits_used from users where auth_user_id='u1' and plan_type='audit'")).rows[0];
  assert.equal(credits.audit_credits_used,1); assert.equal(credits.audits_used,0);
  passed('Audit last credit: refinements once, subscription isolated');
  assert.equal((await audit('3'.repeat(64),crypto.randomUUID())).allowed,false);
  passed('exhausted paid Audit cannot downgrade to free credit');
  const subscriptionBinding=crypto.createHash('sha256').update('verified local quota fixture').digest('hex');
  await db.query("select zentra_lemon_checkout('u1','test@example.test',$1,'42','1683111','1073694','subscription','pro','month')",[subscriptionBinding]);
  const payment=async(connection,product,id,status,changed,ends=null)=>{
    if(product!=='subscription') return connection.query(
      "select zentra_apply_payment('test@example.test',$1,'pro',$2,$3,$4,null,$5,0,0,$6) r",
      [product,id,status,ends,changed,JSON.stringify({lemonOrderId:id})]
    ).then(r=>r.rows[0].r);
    const item={store:'42',customer:'9001',subscription:'8001',variant:'1683111',product:'1073694',plan:'pro',interval:'month',
      status,ends_at:ends,renews_at:null,trial_ends_at:null,pause_mode:null,created_at:new Date().toISOString(),updated_at:changed};
    const key=crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex');
    const result=(await connection.query("select zentra_lemon_event($1,'subscription_updated','subscriptions','8001',$2,$3) r",[key,subscriptionBinding,item])).rows[0].r;
    result.user=(await connection.query("select to_jsonb(u) r from users u where auth_user_id='u1' and plan_type='subscription'")).rows[0].r;
    return result;
  };
  const purchase=await Promise.all([payment(db,'audit','order1','paid',null),payment(db2,'audit','order1','paid',null)]);
  assert.equal(purchase.filter(r=>r.duplicate).length,1);
  assert.equal((await db.query("select audit_credits from users where auth_user_id='u1' and plan_type='audit'")).rows[0].audit_credits,2);
  passed('concurrent paid webhook: one credit');
  const future=new Date(Date.now()+86400000).toISOString();
  const past=new Date(Date.now()-86400000).toISOString();
  const cancelled=await payment(db,'subscription','subscription1','cancelled','2026-09-20T01:00:00Z',future);
  assert.equal(cancelled.user.status,'active'); assert.equal(cancelled.user.billing_status,'cancelled');
  assert.equal(cancelled.user.actions_used,1);
  passed('cancelled preserves paid access and counters');
  const older=await payment(db,'subscription','subscription1','active','2026-09-19T01:00:00Z');
  assert.ok(older.duplicate); assert.equal(older.user.billing_status,'cancelled');
  passed('out-of-order webhook cannot reactivate');
  const pastDue=await payment(db,'subscription','subscription1','past_due','2026-09-21T01:00:00Z');
  assert.equal(pastDue.user.billing_status,'past_due'); assert.equal(pastDue.user.billing_policy_pending,false);
  passed('past_due preserves premium under the confirmed commercial policy');
  await payment(db,'subscription','subscription1','cancelled','2026-09-22T01:00:00Z',past);
  assert.equal((await db.query("select status from users where auth_user_id='u1' and plan_type='subscription'")).rows[0].status,'cancelled');
  passed('cancelled outside paid period loses paid access');
  await assert.rejects(db.query("select zentra_access('attacker','test@example.test','subscription')"),/Identity conflict/);
  passed('cannot bind another account');
  await db.query('set role authenticated');
  await assert.rejects(db.query("select zentra_consume('u1','test@example.test','subscription','actions_used',$1,true)",[crypto.randomUUID()]),/permission denied/);
  await assert.rejects(db.query("update users set plan='agency'"),/permission denied/);
  await db.query('reset role');
  passed('public role cannot call quota RPC or upgrade plan');
  await db.query("insert into users(email,auth_user_id,plan) values('refund@example.test','refund-user','starter')");
  const refundUser=(await db.query("select id from users where auth_user_id='refund-user'")).rows[0].id;
  const refundBegin=async(operation,hash='6'.repeat(64),connection=db)=>{
    await register('refund-user','refund@example.test',operation,'6'.repeat(64),'root');
    if(hash!=='6'.repeat(64)) await register('refund-user','refund@example.test',operation,hash,'polish');
    return connection.query("select zentra_begin_request('refund-user','refund@example.test','subscription',$1,$2,$3,'chat',false) r",
      [operation,source,hash]).then(r=>r.rows[0].r);
  };
  const finish=(operation,lease,success=false,hash='6'.repeat(64),connection=db)=>connection.query(
    "select zentra_finish_request($1,$2,$3,$4,$5,$6) r",
    [refundUser,operation,hash,lease,success?{text:'Respuesta util'}:null,success]).then(r=>r.rows[0].r);
  const refundState=()=>db.query("select * from users where id=$1",[refundUser]).then(r=>r.rows[0]);
  const failedOp=crypto.randomUUID();
  let failedLease=await refundBegin(failedOp);
  assert.equal((await refundState()).actions_used,1);
  const finishes=await Promise.all([
    finish(failedOp,failedLease.lease_token),finish(failedOp,failedLease.lease_token,false,'6'.repeat(64),db2)
  ]);
  assert.equal(finishes.filter(r=>r.accepted).length,1);
  assert.equal((await refundState()).actions_used,0);
  passed('failed generation refunds once even with simultaneous completions');
  for(let attempt=2;attempt<=3;attempt++) {
    failedLease=await refundBegin(failedOp);assert.ok(failedLease.allowed);
    assert.equal((await refundState()).actions_used,1);
    await finish(failedOp,failedLease.lease_token);
    assert.equal((await refundState()).actions_used,0);
  }
  assert.equal((await refundBegin(failedOp)).reason,'retry_limit');
  passed('retry reacquires refunded reservation; three failed attempts leave no charge');
  const usableOp=crypto.randomUUID();
  const usableLease=await refundBegin(usableOp);
  await finish(usableOp,usableLease.lease_token,true);
  const repairLease=await refundBegin(usableOp,'7'.repeat(64));
  await finish(usableOp,repairLease.lease_token,false,'7'.repeat(64));
  assert.equal((await refundState()).actions_used,1);
  passed('failed refinement does not refund an already usable response');
  const parallelOp=crypto.randomUUID();
  const firstParallel=await refundBegin(parallelOp);
  const secondParallel=await refundBegin(parallelOp,'7'.repeat(64));
  await finish(parallelOp,firstParallel.lease_token);
  assert.equal((await refundState()).actions_used,2);
  await finish(parallelOp,secondParallel.lease_token,false,'7'.repeat(64));
  assert.equal((await refundState()).actions_used,1);
  passed('refund waits until no sibling generation remains in progress');
  const crashedOp=crypto.randomUUID();
  const oldLease=await refundBegin(crashedOp);
  await db.query("update zentra_requests set lease_until=now()-interval '1 second' where operation_key=$1",[crashedOp]);
  await db.query("select zentra_access('refund-user','refund@example.test','subscription')");
  assert.equal((await refundState()).actions_used,1);
  const newLease=await refundBegin(crashedOp);
  assert.ok(newLease.allowed);assert.notEqual(newLease.lease_token,oldLease.lease_token);
  assert.equal((await finish(crashedOp,oldLease.lease_token,true)).accepted,false);
  assert.equal((await db.query("select zentra_renew_request($1,$2,$3,$4) r",[refundUser,crashedOp,'6'.repeat(64),oldLease.lease_token])).rows[0].r,false);
  assert.equal((await db.query("select zentra_renew_request($1,$2,$3,$4) r",[refundUser,crashedOp,'6'.repeat(64),newLease.lease_token])).rows[0].r,true);
  await finish(crashedOp,newLease.lease_token,true);
  assert.equal((await refundState()).actions_used,2);
  passed('crash recovery refunds; new worker reserves; stale worker cannot finish or renew');
  await db.query("update users set actions_used=300,extra_actions_balance=1 where id=$1",[refundUser]);
  const extraOp=crypto.randomUUID();const extraLease=await refundBegin(extraOp);
  assert.equal((await refundState()).extra_actions_balance,0);
  await db.query("update users set billing_cycle_start=billing_cycle_start+1000,actions_used=8,extra_actions_used_cycle=3 where id=$1",[refundUser]);
  await finish(extraOp,extraLease.lease_token);
  const extraRefund=await refundState();
  assert.equal(extraRefund.extra_actions_balance,1);assert.equal(extraRefund.actions_used,8);
  assert.equal(extraRefund.extra_actions_used_cycle,3);
  passed('extra unit returns to balance without decrementing the new billing cycle');
  const monthOp=crypto.randomUUID();const monthLease=await refundBegin(monthOp);
  await db.query("update users set billing_cycle_start=billing_cycle_start+1000,actions_used=4 where id=$1",[refundUser]);
  await finish(monthOp,monthLease.lease_token);
  assert.equal((await refundState()).actions_used,4);
  passed('old base reservation cannot refund somebody else’s usage in a new cycle');
  const premiumOp=crypto.randomUUID();const premiumLease=await refundBegin(premiumOp);
  const premium=lease=>db.query("select zentra_consume_generation('refund-user','refund@example.test','subscription','premium_chat_used',$1,$2,$3,false) r",
    [premiumOp,'6'.repeat(64),lease]).then(r=>r.rows[0].r);
  assert.equal((await premium(crypto.randomUUID())).reason,'stale_lease');
  assert.equal((await refundState()).premium_chat_used,0);
  assert.ok((await premium(premiumLease.lease_token)).allowed);
  assert.ok((await premium(premiumLease.lease_token)).duplicate);
  assert.equal((await refundState()).premium_chat_used,1);
  await finish(premiumOp,premiumLease.lease_token);
  assert.equal((await refundState()).premium_chat_used,0);
  assert.equal((await premium(premiumLease.lease_token)).reason,'stale_lease');
  assert.equal((await refundState()).actions_used,4);
  passed('premium debit requires live lease; repeated passes share charge; total failure refunds both');
  const auditRefundOp=crypto.randomUUID();const auditRefundLease=await audit('4'.repeat(64),auditRefundOp);
  assert.ok(auditRefundLease.allowed);
  await db.query("select zentra_finish_request($1,$2,$3,$4,null,false)",[
    auditRefundLease.user.id,auditRefundOp,'4'.repeat(64),auditRefundLease.lease_token]);
  assert.equal((await db.query("select audit_credits_used from users where id=$1",[auditRefundLease.user.id])).rows[0].audit_credits_used,1);
  passed('failed paid Audit returns its purchased credit');
  await db.query('set role authenticated');
  await assert.rejects(db.query("select zentra_refund_failed($1,$2)",[refundUser,usableOp]),/permission denied/);
  await assert.rejects(db.query("select zentra_finish_request($1,$2,$3,$4,null,false)",[refundUser,usableOp,'6'.repeat(64),usableLease.lease_token]),/permission denied/);
  await assert.rejects(db.query("select zentra_register_chat_step('refund-user','refund@example.test','subscription',$1,'polish',$2,'{}',null)",[usableOp,'8'.repeat(64)]),/permission denied/);
  await db.query('reset role');
  passed('public clients cannot refund or complete reservations themselves');
  const {default:express}=await import(pathToFileURL(backend+'/node_modules/express/index.js'));
  const {createOperationGuard,hasUsableResponse}=await import(pathToFileURL(backend+'/release-operations.js'));
  for(const empty of [undefined,null,'','  ',{},[],{response:''},'{"response":{}}']) assert.equal(hasUsableResponse(empty),false);
  for(const useful of ['Respuesta',{response:'Respuesta'},{cards:[{title:'Titulo',text:'Accion'}]},'{"response":"Texto']) assert.equal(hasUsableResponse(useful),true);
  passed('empty containers are not billed as usable content; partial text is preserved');
  const {createApiSecurity}=await import(pathToFileURL(backend+'/release-security.js'));
  let turn=0, generationCount=0;
  const emptyFixtures=new Set();
  const generatedBodies=[];
  const client={
    auth:{getUser:async token=>['valid','other'].includes(token)?{data:{user:{
      id:token==='valid'?'u1':'u2',email:token==='valid'?'test@example.test':'other@example.test',email_confirmed_at:'2026-01-01'
    }}}:{error:token==='expired'?'jwt expired':'invalid'}},
    async rpc(name,args) {
      const values=Object.values(args);
      const call=name+'('+values.map((_,i)=>'$'+(i+1)).join(',')+')';
      const query='select '+(name==='zentra_access'?'to_jsonb('+call+')':call)+' r';
      try {const result=await (++turn%2?db:db2).query(query,values);return {data:result.rows[0].r}}
      catch(error){return {error}}
    },
    from(name) {
      assert.equal(name,'zentra_requests');
      return {update(values) {
        const filters=[];
        const query={eq(key,value){filters.push([key,value]);return query},async then(resolve,reject) {
          try {
            const entries=Object.entries(values);
            const params=[...entries.map(([,value])=>value),...filters.map(([,value])=>value)];
            const sql='update zentra_requests set '+entries.map(([key],i)=>key+'=$'+(i+1)).join(',')+
              ' where '+filters.map(([key],i)=>key+'=$'+(i+1+entries.length)).join(' and ');
            await db.query(sql,params);resolve({error:null});
          }catch(error){resolve({error})}
        }};
        return query;
      }};
    }
  };
  const app=express();
  const auditTest=await auditFixture(backend+'/../publicacion/chrome-store/zentra-ai-chrome-store-clean','pro',{
    pageOverride:{title:'Partner management software',h1s:['Partner management software'],
      metaDescription:'Partner relationship management software for teams',textContent:'Partner management software for teams.'}
  });
  const { recoverAuditConsultative } = await import(pathToFileURL(backend+'/release-audit-json.js'));
  let consultativeRetries = 0;
  app.use(createApiSecurity({client,origins:''}));
  app.use(express.json());
  app.use(createOperationGuard({client}));
  const { createAuditSearchGuard } = await import(pathToFileURL(backend+'/release-audit-steps.js'));
  const { createCompetitiveSearchHandler } = await import(pathToFileURL(backend+'/release-competitive-search.js'));
  let searchProviderCalls = 0;
  app.post('/api/audit/competitive-search',createAuditSearchGuard({client}),createCompetitiveSearchHandler({
    apiKey:'fixture-only',fetchImpl:async()=>{
      searchProviderCalls++;
      await new Promise(resolve=>setTimeout(resolve,30));
      return {ok:true,json:async()=>({status:'completed',output:[{type:'web_search_call',action:{sources:[]}},
        {type:'message',content:[{type:'output_text',text:'{"results":[]}'}]}]})};
    }
  }));
  // Probe middleware coverage without invoking unrelated production handlers.
  const sensitiveProbes = ['/api/user','/api/subscription/usage','/api/subscription/capacity/offers',
    '/api/subscription/consume','/api/audit/consume','/api/audio/transcribe','/api/audit/reserve','/api/audit/release'];
  app.all(sensitiveProbes,(req,res)=>res.json({identity:req.auth}));
  app.get('/api/health',(_req,res)=>res.json({ok:true}));
  app.post('/api/lemon/webhook',(_req,res)=>res.json({reached:true}));
  app.post(['/api/chat','/api/chat/stream'],async(req,res)=>{
    generationCount++;
    generatedBodies.push(JSON.parse(JSON.stringify(req.body)));
    await new Promise(resolve=>setTimeout(resolve,30));
    if(req.body.fixture==='failure') return res.status(502).json({error:'Unavailable'});
    if(req.body.fixture==='empty' && !emptyFixtures.has(req.operation.id)) {
      emptyFixtures.add(req.operation.id);
      return res.json({success:true,response:{response:''}});
    }
    if(req.body.fixture==='stream-failure') {
      await req.failOperation();
      return res.end(JSON.stringify({type:'error',message:'Unavailable'})+'\n');
    }
    if(req.path.endsWith('/stream')) {
      await req.completeOperation('Respuesta conservada');
      res.setHeader('Content-Type','application/x-ndjson');
      res.end(JSON.stringify({type:'final',text:'Respuesta conservada'})+'\n');
    } else if (req.body.task_type === 'seo_analysis') {
      const result = await recoverAuditConsultative({
        initial: { ok: true, api: 'responses', data: { output_text: '{"summary":"unfinished', incomplete_details: { reason: 'max_output_tokens' } } },
        regenerate: async () => { consultativeRetries++; return { ok: true, api: 'responses', data: { output_text: auditTest.outputs.seo_analysis, status: 'completed' } }; }
      });
      res.json({success:true,response:result.analysis,audit_consultative:result.metadata});
    } else res.json({success:true,response:auditTest.outputs[req.body.task_type] || 'Respuesta conservada'});
  });
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.on('listening',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  try {
    const authBefore = generationCount;
    const usersBeforeAuth=(await db.query("select jsonb_agg(to_jsonb(u) order by id) state from users u")).rows[0].state;
    for (const path of [...sensitiveProbes,'/api/chat','/api/chat/stream','/api/audit/competitive-search']) {
      for (const token of [null,'invalid','expired']) {
        const response = await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',
          ...(token?{Authorization:'Bearer '+token}:{})},body:'{}'});
        assert.equal(response.status,401,path+' '+token);await response.text();
      }
    }
    assert.equal(generationCount,authBefore);assert.equal(searchProviderCalls,0);
    assert.deepEqual((await db.query("select jsonb_agg(to_jsonb(u) order by id) state from users u")).rows[0].state,usersBeforeAuth);
    assert.equal((await fetch(url+'/api/health')).status,200);
    assert.equal((await fetch(url+'/api/lemon/webhook',{method:'POST'})).status,200);
    passed('all eleven sensitive routes: missing/invalid/expired auth rejected before provider; public middleware exclusions preserved');
    await db.query("update users set status='active',billing_status='active',subscription_ends_at=null,plan='starter',actions_used=299 where auth_user_id='u1' and plan_type='subscription'");
    const post=(id,path='/api/chat',extras={})=>fetch(url+path,{method:'POST',
      headers:{Authorization:'Bearer valid','Content-Type':'application/json'},
      body:JSON.stringify({messages:[{role:'user',content:'Prueba'}],
        user_id:'another-user',email:'owner@example.test',
        zentra_operation:{id,source:'Prueba',product:'subscription'},...extras})});
    const id=crypto.randomUUID();
    const stream=await post(id,'/api/chat/stream');
    assert.equal(stream.status,200); await stream.text();
    const replay=await post(id);assert.equal(replay.status,200);
    assert.equal((await replay.json()).response,'Respuesta conservada');assert.equal(generationCount,1);
    const exhausted=await post(crypto.randomUUID());assert.equal(exhausted.status,403);
    assert.equal(generationCount,1);
    passed('HTTP + real DB: stream/plain replay, forged identity ignored, limit before generation');
    const invalid=await post(crypto.randomUUID(),'/api/chat',{messages:[]});
    assert.equal(invalid.status,400);assert.equal(generationCount,1);
    passed('empty request rejected without generation');
    await db.query("update users set actions_used=299 where auth_user_id='u1' and plan_type='subscription'");
    const concurrent=await Promise.all([post(crypto.randomUUID()),post(crypto.randomUUID())]);
    assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,403]);
    await Promise.all(concurrent.map(r=>r.text()));
    assert.equal(generationCount,2);
    passed('HTTP + real DB: simultaneous independent actions cannot bypass 299/300');
    const substituted=await post(id,'/api/chat',{
      messages:[{role:'user',content:'Otra consulta diferente, no un refinado.'}]
    });
    assert.equal(substituted.status,409);
    await substituted.text();
    assert.equal(generationCount,2);
    passed('HTTP: changed prompt with reused operation/source rejected before generation');
    await db.query("update users set actions_used=0 where auth_user_id='u1' and plan_type='subscription'");
    const charged=()=>db.query("select actions_used from users where auth_user_id='u1' and plan_type='subscription'").then(r=>r.rows[0].actions_used);
    for(const fixture of ['failure','empty','stream-failure']) {
      const failingId=crypto.randomUUID();
      const response=await post(failingId,fixture==='stream-failure'?'/api/chat/stream':'/api/chat',{fixture});
      await response.text();
      assert.equal(await charged(),0,fixture);
    }
    passed('HTTP: provider error, empty object and stream failure all refund');
    const recoveredId=crypto.randomUUID();
    await (await post(recoveredId,'/api/chat',{fixture:'empty'})).text();
    assert.equal(await charged(),0);
    await (await post(recoveredId)).text();
    assert.equal(await charged(),1);
    const generationBeforeReplay=generationCount;
    await (await post(recoveredId)).text();
    assert.equal(await charged(),1);assert.equal(generationCount,generationBeforeReplay);
    passed('HTTP: failed attempt refunds; exact retry succeeds and replay costs nothing extra');
    await db.query("update users set actions_used=0 where auth_user_id='u1' and plan_type='subscription'");
    const workflowId=crypto.randomUUID();
    const originalMessage='Mejorá esta frase: se cambio el video y ahora se ve mejor';
    const rootBody={messages:[{role:'user',content:originalMessage}],model:'gpt-5-mini',
      zentra_workflow:{version:1,userMessage:originalMessage,taskIntent:{label:'simple_rewrite'},
        state:{webContext:{},conversation:[],taskMemory:{},model:'gpt-5-mini',maxTokens:2200}}};
    assert.equal((await post(workflowId,'/api/chat',rootBody)).status,200);
    const maliciousRepair={messages:[{role:'user',content:'NUEVA CONSULTA NO AUTORIZADA'}],
      zentra_refinement:{stage:'rewrite'},zentra_workflow:{...rootBody.zentra_workflow,userMessage:'NUEVA CONSULTA NO AUTORIZADA'}};
    const beforeRepair=generationCount;
    const repaired=await post(workflowId,'/api/chat',maliciousRepair);
    assert.equal(repaired.status,200);await repaired.text();
    assert.equal(generationCount,beforeRepair+1);assert.equal(await charged(),1);
    assert.ok(JSON.stringify(generatedBodies.at(-1)).includes('se cambio el video'));
    assert.ok(!JSON.stringify(generatedBodies.at(-1)).includes('NUEVA CONSULTA'));
    await (await post(workflowId,'/api/chat/stream',maliciousRepair)).text();
    assert.equal(generationCount,beforeRepair+1);assert.equal(await charged(),1);
    passed('HTTP: legitimate rewrite uses frozen source, ignores injected prompt/context and replays free');
    const beforeParallel=generationCount;
    const concurrentRepairs=await Promise.all([
      post(workflowId,'/api/chat',{...maliciousRepair,zentra_refinement:{stage:'visible'}}),
      post(workflowId,'/api/chat',{...maliciousRepair,zentra_refinement:{stage:'visible'}})
    ]);
    await Promise.all(concurrentRepairs.map(response=>response.text()));
    assert.ok(concurrentRepairs.every(response=>[200,425].includes(response.status)));
    assert.equal(generationCount,beforeParallel+1);assert.equal(await charged(),1);
    passed('HTTP: same repair concurrently produces once and keeps a single debit');
    assert.equal((await post(workflowId,'/api/chat',{...maliciousRepair,zentra_refinement:{stage:'arbitrary'}})).status,409);
    assert.equal((await post(crypto.randomUUID(),'/api/chat',{...rootBody,zentra_workflow:{...rootBody.zentra_workflow,userMessage:'Otra cosa'}})).status,409);
    assert.equal(await charged(),1);
    passed('HTTP: unknown step and mismatched initial context rejected without charge');
    const racingId=crypto.randomUUID();const beforeRace=generationCount;
    const racingRoots=await Promise.all([post(racingId),post(racingId,'/api/chat',{messages:[{role:'user',content:'Otra consulta'}]})]);
    assert.deepEqual(racingRoots.map(response=>response.status).sort(),[200,409]);
    await Promise.all(racingRoots.map(response=>response.text()));
    assert.equal(generationCount,beforeRace+1);assert.equal(await charged(),2);
    passed('HTTP: concurrent different roots cannot share an operation');
    await db.query("insert into users(email,auth_user_id,plan,actions_used) values('other@example.test','u2','free',20)");
    const otherPost=(body)=>fetch(url+'/api/chat',{method:'POST',headers:{Authorization:'Bearer other','Content-Type':'application/json'},body:JSON.stringify(body)});
    const spoofed={messages:[{role:'user',content:'Prueba'}],user_id:'u1',email:'test@example.test',
      plan:'agency',tier:'agency',isAgency:true,isPro:true,remaining:999999,quota:999999,
      zentra_operation:{id:crypto.randomUUID(),product:'subscription'}};
    const beforeSpoof=generationCount;
    assert.equal((await otherPost(spoofed)).status,403);assert.equal(generationCount,beforeSpoof);
    assert.equal((await db.query("select plan,actions_used from users where auth_user_id='u2'")).rows[0].plan,'free');
    passed('HTTP: Free plan and exhausted quota cannot be overridden by Agency/identity/remaining in body');
    await db.query("update users set actions_used=0 where auth_user_id='u2'");
    assert.equal((await otherPost({...maliciousRepair,zentra_operation:{id:workflowId,product:'subscription'}})).status,409);
    assert.equal(generationCount,beforeSpoof);
    const isolated=await otherPost({...spoofed,zentra_operation:{id:workflowId,product:'subscription'}});
    assert.equal(isolated.status,200);await isolated.text();
    assert.equal(generationCount,beforeSpoof+1);
    assert.equal((await db.query("select actions_used from users where auth_user_id='u2'")).rows[0].actions_used,1);
    passed('HTTP: another user cannot refine/replay owner operation; same UUID as own root is separately charged');
    await db.query("update users set plan='pro',audits_used=9 where auth_user_id='u1' and plan_type='subscription'");
    await db.query("update users set plan='pro',audit_credits=1,audit_credits_used=0 where auth_user_id='u1' and plan_type='audit'");
    for (const product of ['subscription','audit']) {
      const substitutedId = crypto.randomUUID();
      const substitutedReservation = await client.rpc('zentra_acquire_audit', { p_auth_id: 'u1',
        p_email: 'test@example.test', p_product: product, p_operation: substitutedId, p_source: 'https://other.example.test/' });
      assert.equal(substitutedReservation.data.allowed, true);
      const beforeSubstitution = generationCount;
      const substituted = await post(substitutedId, '/api/chat', { ...auditTest.calls[0],
        zentra_operation: { id: substitutedId, product },
        zentra_acquisition: { token: substitutedReservation.data.lease_token } });
      assert.equal(substituted.status, 409);
      assert.equal(generationCount, beforeSubstitution);
      assert.equal((await db.query('select * from zentra_audit_steps where operation_key=$1', [substitutedId])).rows.length, 0);
      const released = await client.rpc('zentra_release_audit', { p_auth_id: 'u1', p_email: 'test@example.test',
        p_product: product, p_operation: substitutedId, p_lease: substitutedReservation.data.lease_token });
      assert.equal(released.data, true);
      passed('HTTP Audit '+product+': reserved target from real DB cannot be substituted; zero provider/root registration');
      const auditId=crypto.randomUUID();
      const acquisition = await client.rpc('zentra_acquire_audit', { p_auth_id: 'u1', p_email: 'test@example.test',
        p_product: product, p_operation: auditId, p_source: auditTest.calls[0].zentra_audit_workflow.pageData.url });
      assert.equal(acquisition.data.allowed, true);
      const sendAudit=(body,id=auditId,path='/api/chat')=>post(id,path,{
        ...body,zentra_operation:{id,source:'Misma URL',product},
        ...(id === auditId ? { zentra_acquisition: { token: acquisition.data.lease_token } } : {})
      });
      const [initial,reasoning,executive]=auditTest.calls;
      const retriesBefore = consultativeRetries;
      const initialResponse = await sendAudit(initial);
      assert.equal(initialResponse.status,200);
      assert.equal((await initialResponse.json()).audit_consultative.status,'recovered');
      assert.equal(consultativeRetries,retriesBefore+1);
      const cachedInitial = await sendAudit(initial);
      assert.equal(cachedInitial.status,200);
      assert.equal((await cachedInitial.json()).audit_consultative.status,'recovered');
      assert.equal(consultativeRetries,retriesBefore+1);
      passed('HTTP Audit '+product+': one internal JSON regeneration, cached replay does not regenerate');
      const searchBody={queries:reasoning.zentra_audit_evidence.queries,siteDomain:initial.zentra_audit_workflow.pageData.domain,
        scope:'web',zentra_operation:{id:auditId,product}};
      const sendSearch=(body=searchBody,token='valid')=>fetch(url+'/api/audit/competitive-search',{
        method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
      const searchBefore=searchProviderCalls;
      assert.equal((await sendSearch({...searchBody,zentra_operation:undefined})).status,403);
      assert.equal((await sendSearch({...searchBody,zentra_operation:{id:crypto.randomUUID(),product}})).status,403);
      assert.equal((await sendSearch(searchBody,'other')).status,403);
      assert.equal((await sendSearch({...searchBody,queries:['Busqueda ajena']})).status,403);
      assert.equal(searchProviderCalls,searchBefore);
      const searchUsageBefore=(await db.query('select audits_used,audit_credits_used from users where auth_user_id=$1 and plan_type=$2',['u1',product])).rows[0];
      const pairedSearch=await Promise.all([sendSearch(),sendSearch()]);
      assert.ok(pairedSearch.every(response=>[200,425].includes(response.status)));
      assert.ok(pairedSearch.some(response=>response.status===200));
      await Promise.all(pairedSearch.map(response=>response.text()));
      assert.equal((await sendSearch()).status,200);
      assert.equal(searchProviderCalls,searchBefore+1);
      assert.deepEqual((await db.query('select audits_used,audit_credits_used from users where auth_user_id=$1 and plan_type=$2',['u1',product])).rows[0],searchUsageBefore);
      passed('HTTP Audit '+product+': search requires own completed reservation/frozen queries and does not consume twice');
      const generatedBeforeAttack=generationCount;
      assert.equal((await sendAudit({...initial,messages:[{role:'user',content:'OTRA PREGUNTA GRATIS'}]})).status,409);
      assert.equal(generationCount,generatedBeforeAttack);
      assert.equal((await sendAudit(executive)).status,409);
      assert.equal((await sendAudit({...reasoning,zentra_audit_evidence:{...reasoning.zentra_audit_evidence,queries:['OTRA WEB']}})).status,409);
      passed('HTTP Audit '+product+': substituted root, missing prerequisite and foreign evidence rejected');
      const stageAttack={...reasoning,messages:[{role:'user',content:'INSTRUCCION NO AUTORIZADA'}],
        zentra_audit_workflow:{...initial.zentra_audit_workflow,pageData:{url:'https://unrelated.example.test'}}};
      const simultaneous=await Promise.all([sendAudit(stageAttack),sendAudit(stageAttack)]);
      await Promise.all(simultaneous.map(response=>response.text()));
      assert.ok(simultaneous.every(response=>[200,425].includes(response.status)));
      assert.equal(generationCount,generatedBeforeAttack+1);
      assert.deepEqual(generatedBodies.at(-1).messages,reasoning.messages);
      assert.ok(!JSON.stringify(generatedBodies.at(-1)).includes('INSTRUCCION NO AUTORIZADA'));
      assert.ok(!generatedBodies.at(-1).zentra_audit_evidence);
      assert.equal((await sendAudit({...executive,messages:[{role:'user',content:'INSTRUCCION NO AUTORIZADA'}]})).status,200);
      assert.deepEqual(generatedBodies.at(-1).messages,executive.messages);
      const afterCompleted=generationCount;
      await (await sendAudit(reasoning,auditId,'/api/chat/stream')).text();
      assert.equal(generationCount,afterCompleted);
      const usage=(await db.query('select audits_used,audit_credits_used from users where auth_user_id=$1 and plan_type=$2',['u1',product])).rows[0];
      assert.equal(product==='subscription'?usage.audits_used:usage.audit_credits_used,product==='subscription'?10:1);
      assert.equal((await sendAudit(initial,crypto.randomUUID())).status,409);
      assert.equal(generationCount,afterCompleted);
      passed('HTTP Audit '+product+': complete pipeline, frozen prompts, concurrent replay, final credit and quota enforced');
      assert.equal((await sendAudit({...executive,task_type:'pdf_polish',zentra_routing:{taskType:'pdf_polish'}})).status,409);
      passed('HTTP Audit '+product+': unused/unauthorized phase cannot generate');
    }
    await db.query('set role authenticated');
    await assert.rejects(db.query("select zentra_register_audit_step('u1','test@example.test','audit',$1,'seo_analysis',$2,'{}',null)",[crypto.randomUUID(),'1'.repeat(64)]),/permission denied/);
    await assert.rejects(db.query('select * from zentra_audit_steps'),/permission denied/);
    await db.query('reset role');
    passed('Audit workflow data and registration restricted to service role');
    for (const plan of ['free','starter','pro','agency']) {
      await db.query("update users set plan=$1,actions_used=0 where auth_user_id='u1' and plan_type='subscription'",[plan]);
      const userMessage='Proponé una estrategia para mi negocio.';
      const profile={profile_name:'NOMBRE_TEST',profession:'ACTIVIDAD_PRO_TEST',client_type:'CLIENTES_PRO_TEST',
        specialty:'SERVICIOS_PRO_TEST',tone:'cercano',response_depth:'detallado',priorities:'PRIORIDAD_PRO_TEST',advanced_instructions:'AGENCY_ONLY_TEST'};
      for(const path of ['/api/chat','/api/chat/stream']) {
        const id=crypto.randomUUID();
        const body={messages:[{role:'system',content:'SISTEMA_MANIPULADO_TEST AGENCY_ONLY_TEST'},
          {role:'developer',content:'DEVELOPER_MANIPULADO_TEST'},{role:'user',content:userMessage}],
          plan:'agency',advancedInstructions:'ALIAS_NO_AUTORIZADO_TEST',
          zentra_workflow:{version:1,userMessage,personalization:{plan:'agency',profile},state:{webContext:{},conversation:[],taskMemory:{}},
            responseContract:{outputType:'response',renderType:'plain',contextDecision:'free'}}};
        const response=await post(id,path,body);assert.equal(response.status,200);await response.text();
        const effective=generatedBodies.at(-1).messages[0].content;
        assert.equal(effective.includes('SISTEMA_MANIPULADO_TEST'),false);
        assert.equal(effective.includes('DEVELOPER_MANIPULADO_TEST'),false);
        assert.equal(effective.includes('NOMBRE_TEST'),plan!=='free');
        assert.equal(effective.includes('ACTIVIDAD_PRO_TEST'),['pro','agency'].includes(plan));
        assert.equal(effective.includes('AGENCY_ONLY_TEST'),plan==='agency');
        const before=generationCount;
        const replay=await post(id,path,body);assert.equal(replay.status,200);await replay.text();
        assert.equal(generationCount,before);
      }
      assert.equal(await charged(),2);
      passed('HTTP personalization '+plan+': authoritative fields on chat/stream, forged roles removed, replay adds no provider/debit');
    }
    const { requestFingerprint } = await import(pathToFileURL(backend+'/release-security.js'));
    const legacyBuilders = vm.createContext({ window: {}, document: { addEventListener() {} }, URL, URLSearchParams, console });
    vm.runInContext(await readFile(backend+'/trusted-chat-builders.js','utf8'),legacyBuilders);
    const legacyBot = Object.create(legacyBuilders.window.ClaudeChatbot.prototype);
    const preservedProfile={profile_name:'LEGACY_BRAND',profession:'LEGACY_PRO',client_type:'LEGACY_CLIENTS',
      specialty:'LEGACY_SERVICE',tone:'cercano',response_depth:'detallado',priorities:'LEGACY_PRIORITIES',advanced_instructions:'LEGACY_AGENCY_ONLY'};
    for(const [from,to] of [['agency','starter'],['starter','pro'],['pro','free'],['free','agency'],['agency','free'],['pro','pro']]) {
      await db.query("update users set plan=$1,actions_used=0 where auth_user_id='u1' and plan_type='subscription'",[from]);
      const id=crypto.randomUUID(),userMessage='Proponé una estrategia para esta web.';
      const frozen={messages:[{role:'system',content:legacyBot.buildPromptPersonalizationBlock({plan:'agency',profile:preservedProfile})
        +'\n\nREGLA PRINCIPAL DE INTENCION DEL CHAT\nLEGACY_UNTRUSTED_SYSTEM'},
        {role:'developer',content:'LEGACY_UNTRUSTED_DEVELOPER'},
        {role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,AA=='}}]},
        {role:'assistant',content:'HISTORIAL_PRESERVADO'}, {role:'user',content:userMessage}]};
      const ctx={version:1,userMessage,responseContract:{outputType:'response',renderType:'plain',contextDecision:'mixed'},
        state:{webContext:{},conversation:[{type:'assistant',content:'PRODUCTO OCR ORIGINAL',contextMeta:{imageOcrText:'PRODUCTO OCR ORIGINAL\nPrecio: 19,95 euros\nIncluye envio y asesoramiento personalizado.'}}],
          taskMemory:{},documentContexts:[{id:'doc1',name:'fuente.txt',type:'text',text:'DOCUMENTO_PRESERVADO'}]}};
      const hash=requestFingerprint(frozen);
      await db.query("select zentra_register_chat_step('u1','test@example.test','subscription',$1,'root',$2,$3,$4)",[id,hash,frozen,ctx]);
      const reservation=(await db.query("select zentra_begin_request('u1','test@example.test','subscription',$1,$2,$2,'chat',false)",[id,hash])).rows[0].zentra_begin_request;
      assert.ok(reservation.allowed);assert.equal(await charged(),1);
      await db.query("update zentra_requests set lease_until=now()-interval '1 second' where operation_key=$1",[id]);
      await db.query("update users set plan=$1 where auth_user_id='u1' and plan_type='subscription'",[to]);
      const before=generationCount;
      const response=await post(id,'/api/chat/stream',frozen);assert.equal(response.status,200);await response.text();
      const effective=generatedBodies.at(-1);
      const system=effective.messages[0].content;
      assert.equal(system.includes('LEGACY_AGENCY_ONLY'),to==='agency');
      assert.equal(system.includes('LEGACY_PRO'),['pro','agency'].includes(to));
      assert.equal(system.includes('LEGACY_UNTRUSTED_SYSTEM'),false);
      assert.equal(system.includes('LEGACY_UNTRUSTED_DEVELOPER'),false);
      assert.ok(system.includes('DOCUMENTO_PRESERVADO'));
      assert.deepEqual(effective.messages.slice(1),frozen.messages.filter(m=>['user','assistant'].includes(m.role)));
      const persisted=(await db.query("select body,context,request_hash from zentra_chat_steps where operation_key=$1 and step_name='root'",[id])).rows[0];
      assert.deepEqual(persisted.body,frozen);assert.deepEqual(persisted.context,ctx);assert.equal(persisted.request_hash,hash);
      assert.equal((await db.query("select count(*) from zentra_requests where operation_key=$1",[id])).rows[0].count,'1');
      assert.equal((await db.query("select count(*) from zentra_usage_receipts where operation_key=$1",[id])).rows[0].count,'1');
      assert.equal(await charged(),1);assert.equal(generationCount,before+1);
      const cached=await post(id,'/api/chat',frozen);assert.equal(cached.status,200);await cached.text();
      assert.equal(generationCount,before+1);assert.equal(await charged(),1);
      passed('legacy HTTP resume '+from+' -> '+to+': current profile, sources intact, same hash/action/debit, completed replay has zero generation');
    }
    const serverSource=await readFile(backend+'/server.js','utf8');
    const streamStart=serverSource.indexOf('app.post("/api/chat/stream", ');
    const streamEnd=serverSource.indexOf('\napp.post("/api/chat", ',streamStart);
    const routeSource=serverSource.slice(streamStart+'app.post("/api/chat/stream", '.length,streamEnd).trim().slice(0,-2);
    let actualStreamProviderCalls=0;
    let fastShouldFail=false;
    const actualStream=vm.runInNewContext('('+routeSource+')',{
      normalizeTaskType:value=>value,sanitizeChatMessages:value=>value,clampMaxTokens:()=>4096,
      resolveAiRoutingForRequest:async (_req,options)=>{if(options?.consumePremium===false)return {premiumAvailable:true};throw new Error('Fixture: premium DB failure after useful fast layer')},
      chatTierRoute:()=>({}),normalizePlan:value=>value,
      ZENTRA_CHAT_FAST_PROVIDER:'fixture',ZENTRA_CHAT_FAST_MODEL:'fixture',ZENTRA_BASE_PROVIDER:'fixture',ZENTRA_BASE_MODEL:'fixture',
      buildLayeredChatFastInstruction:()=>'',normalizeChatFastLayerPayload:parsed=>parsed,
      firstNonEmptyString:value=>value,Date,
      callLayeredChatStep:async()=>{actualStreamProviderCalls++;return fastShouldFail?{ok:false,error:'Fixture provider failure'}:{ok:true,parsed:{response:'Respuesta util preservada',needsReasoning:true}}},
      consumeSubscriptionUsage:async()=>{throw new Error('Fixture: premium DB failure after useful fast layer')},
      writeNdjsonEvent:(res,payload)=>res.write(JSON.stringify(securityEvent(payload))+'\n')
    });
    const {publicStreamEvent:securityEvent}=await import(pathToFileURL(backend+'/release-security.js'));
    const streamApp=express();streamApp.use(createApiSecurity({client}));streamApp.use(express.json());
    streamApp.use(createOperationGuard({client}));streamApp.post('/api/chat/stream',actualStream);
    const streamServer=streamApp.listen(0,'127.0.0.1');await new Promise(resolve=>streamServer.on('listening',resolve));
    try {
      await db.query("update users set actions_used=0 where auth_user_id='u1' and plan_type='subscription'");
      const streamId=crypto.randomUUID();
      const sendActual=(id=streamId)=>fetch('http://127.0.0.1:'+streamServer.address().port+'/api/chat/stream',{
        method:'POST',headers:{Authorization:'Bearer valid','Content-Type':'application/json'},
        body:JSON.stringify({messages:[{role:'user',content:'Analiza esta pagina'}],task_type:'chat_premium',
          zentra_operation:{id,product:'subscription'}})});
      const events=(await (await sendActual()).text()).trim().split('\n').map(JSON.parse);
      assert.ok(events.some(event=>event.type==='layer'&&event.text==='Respuesta util preservada'));
      assert.equal(await charged(),1,'Useful stream must not refund after a later DB failure');
      assert.equal(events.at(-1).type,'final');assert.equal(events.at(-1).text,'Respuesta util preservada');
      assert.equal((await (await sendActual()).text()).includes('Respuesta util preservada'),true);
      assert.equal(actualStreamProviderCalls,1);assert.equal(await charged(),1);
      passed('actual stream handler + DB: later failure preserves useful response/charge/cache; replay calls no provider');
      fastShouldFail=true;
      const failingEvents=(await (await sendActual(crypto.randomUUID())).text()).trim().split('\n').map(JSON.parse);
      assert.equal(failingEvents.at(-1).type,'error');assert.equal(await charged(),1);
      passed('actual stream handler + DB: no useful answer still refunds only its own reservation');
    } finally {await new Promise(resolve=>streamServer.close(resolve))}
  } finally {await new Promise(resolve=>server.close(resolve))}
  console.log('TOTAL',count);
} finally {
  for (const client of clients) await client.end();
  await pg.stop();
}
