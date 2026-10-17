// Isolated local PostgreSQL only. Never reads production credentials or calls providers.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLemonHandlers, lemonCatalog } from '../../release-lemon.js';

assert.ok(process.env.ZENTRA_LOCAL_PG_RUNTIME, 'Provide the installed local test runtime; no download');
const require=createRequire(import.meta.url);
const {Client}=require(path.join(process.env.ZENTRA_LOCAL_PG_RUNTIME,'node_modules/pg'));
const bin=path.join(process.env.ZENTRA_LOCAL_PG_RUNTIME,'node_modules/@embedded-postgres',process.platform+'-'+process.arch,'native/bin');
const run=promisify(execFile);
const root=fileURLToPath(new URL('../../',import.meta.url));
const sql=await readFile(new URL('../migrations/01-production-schema.sql',import.meta.url),'utf8');
const server=await readFile(new URL('../../server.js',import.meta.url),'utf8');
const start=server.indexOf('const LEMON_PRODUCTS = {');
const products=vm.runInNewContext(server.slice(start,server.indexOf('\nfunction getPlanFromLemonKey',start))+'\nLEMON_PRODUCTS');
const catalog=lemonCatalog(products);
const listener=net.createServer(); await new Promise(r=>listener.listen(0,'127.0.0.1',r));
const port=listener.address().port; await new Promise(r=>listener.close(r));
const directory=await mkdtemp(path.join(os.tmpdir(),'zentra-rc-schema-'));
const database=path.join(directory,'db');
let db; let started=false; let passed=0; const pass=name=>{passed++;console.log('PASS '+name);};
const snapshot=async()=> (await db.query('select to_jsonb(u) j from users u order by id')).rows.map(r=>r.j);
const result=()=>({statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}});
let forbiddenNetworkCalls=0;
try {
  await run(path.join(bin,'initdb'),['-D',database,'-A','trust','-U','postgres','--no-locale','-E','UTF8','--no-sync'],{timeout:60000});
  await run(path.join(bin,'pg_ctl'),['-D',database,'-l',path.join(directory,'postgres.log'),'-o','-h 127.0.0.1 -p '+port,'-w','start'],{timeout:20000});started=true;
  db=new Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});await db.connect();
  await db.query('create role anon; create role authenticated; create role service_role');
  await db.query(await readFile(path.join(root,'supabase-users.sql'),'utf8'));
  for(let i=0;i<8;i++) await db.query(`insert into users(email,plan,plan_type,actions_used,audits_used,premium_pdf_used,audit_credits,audit_credits_used)
    values($1,$2,$3,$4,$5,$6,$7,$8)`,[
    'fixture'+i+'@example.test',i<2||i===7?'agency':'free',i===7?'audit':'subscription',i+1,i<2?2:0,i<2?70:0,i===7?2:0,i===7?1:0]);
  const before=await snapshot();
  await db.query('create function public.zentra_unknown_fixture() returns int language sql as $$select 1$$');
  await assert.rejects(db.query(sql),/Partial\/unknown Zentra schema/); await db.query('rollback');
  assert.equal((await db.query("select to_regclass('public.zentra_usage_receipts') t")).rows[0].t,null);
  await db.query('drop function public.zentra_unknown_fixture()');
  pass('unknown/partial baseline is refused before any schema or account overwrite');

  const fault=sql.replace('  create table if not exists public.zentra_ai_schema_releases (',"  raise exception 'synthetic migration failure';\n  create table if not exists public.zentra_ai_schema_releases (");
  await assert.rejects(db.query(fault),/synthetic migration failure/); await db.query('rollback');
  assert.deepEqual(await snapshot(),before);
  assert.equal((await db.query("select to_regclass('public.zentra_lemon_customers') t")).rows[0].t,null);
  pass('mid-install failure rolls back all DDL, rows and counters atomically');

  await db.query(sql);
  const projected=(await snapshot()).map((row,i)=>Object.fromEntries(Object.keys(before[i]).map(k=>[k,row[k]])));
  assert.deepEqual(projected,before);
  assert.equal((await db.query('select count(*)::int n from users where auth_user_id is not null')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from zentra_lemon_subscriptions')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from zentra_lemon_customers')).rows[0].n,0);
  assert.deepEqual((await db.query('select capacity_total,activated_total from zentra_free_launch_config')).rows[0],{capacity_total:300,activated_total:0});
  pass('eight synthetic legacy accounts survive unchanged; no invented billing bindings or Free slots');

  // Test fixture only: represent accounts that have legitimately authenticated.
  for(let i=0;i<8;i++)await db.query('update users set auth_user_id=$1 where email=$2',['fixture-'+i,'fixture'+i+'@example.test']);

  const definitions=await db.query("select p.proname,pg_get_function_identity_arguments(p.oid) a,md5(pg_get_functiondef(p.oid)) h from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'zentra_%' order by p.proname,a");
  const after=await snapshot(); await db.query(sql);
  assert.deepEqual(await snapshot(),after);
  assert.deepEqual((await db.query("select p.proname,pg_get_function_identity_arguments(p.oid) a,md5(pg_get_functiondef(p.oid)) h from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'zentra_%' order by p.proname,a")).rows,definitions.rows);
  pass('second install is a no-op: wrappers, identities, counters and Free capacity preserved');

  const saved=(await db.query("select pg_get_functiondef('public.zentra_free_notify(text,text)'::regprocedure) definition")).rows[0].definition;
  await db.query("create or replace function public.zentra_free_notify(p_auth_id text,p_email text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$begin return '{}'::jsonb;end$$");
  await assert.rejects(db.query(sql),/RPC definitions\/grants have drifted/);await db.query('rollback');
  await db.query(saved);
  pass('definition drift after installation is refused instead of overwriting an unknown RPC');

  const exposed=await db.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'zentra_%' and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))");
  assert.equal(exposed.rows[0].n,0);
  assert.equal((await db.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and (c.relname='users' or c.relname like 'zentra_%') and not c.relrowsecurity")).rows[0].n,0);
  await assert.rejects(db.query("select zentra_consume('fixture-0','fixture0@example.test','subscription','audits_used',$1,true)",[crypto.randomUUID()]),/Unlimited test mode/);
  await assert.rejects(db.query("select zentra_acquire_audit('fixture-0','fixture0@example.test','subscription',$1,'https://site.example.test/',null,true)",[crypto.randomUUID()]),/Unlimited test mode/);
  pass('all RPCs private/RLS enabled; production SQL rejects unlimited even through service-only parameters');

  const client={async rpc(name,args){assert.match(name,/^zentra_[a-z_]+$/);try {
    const values=Object.values(args);const call=name+'('+values.map((_,i)=>'$'+(i+1)).join(',')+')';
    return {data:(await db.query('select '+call+' r',values)).rows[0].r};
  }catch{return {error:new Error('synthetic DB refusal')};}}};
  const secret='synthetic-test-signing-secret';
  const handlers=createLemonHandlers({client,products,env:{LEMON_SQUEEZY_STORE_ID:'42',LEMON_SQUEEZY_WEBHOOK_SECRET:secret},
    logger:{warn(){}},fetchImpl:async()=>{forbiddenNetworkCalls++;assert.fail('No provider/network permitted');}});
  let next=0;let response=result();
  await handlers.reconcile({auth:{userId:'fixture-0',email:'fixture0@example.test'},path:'/api/chat',body:{}},response,()=>next++);
  assert.equal(response.statusCode,503);assert.equal(response.body.code,'billing_association_required');assert.equal(next,0);
  assert.equal((await db.query("select premium_pdf_used from users where auth_user_id='fixture-0'")).rows[0].premium_pdf_used,70);
  pass('unbound test Agency remains unbound and blocked; legacy 70 units are not reset/converted');
  await db.query("update users set auth_user_id=null where email='fixture1@example.test'");
  response=result();next=0;
  await handlers.reconcile({auth:{userId:'fixture-1',email:'fixture1@example.test'},path:'/api/chat',body:{}},response,()=>next++);
  assert.equal(response.body.code,'billing_association_required');assert.equal(next,0);
  assert.equal((await db.query("select actions_used from users where auth_user_id='fixture-1'")).rows[0].actions_used,2);
  assert.equal((await db.query('select count(*)::int n from zentra_lemon_subscriptions')).rows[0].n,0);
  pass('first authenticated legacy access resolves Auth only, then blocks unverified billing before consumption');

  async function checkout(auth,key){const res=result();await handlers.checkout({auth:{userId:auth,email:auth+'@example.test'},body:{productKey:key}},res);assert.equal(res.statusCode,200);return new URL(res.body.url).searchParams.get('checkout[custom][zentra_binding]');}
  const times=new Map();
  async function webhook(auth,key,sub,customer,binding,extra={},signatureValid=true){const map=catalog.byKey.get(key);
    if(!times.has(sub))times.set(sub,new Date().toISOString());const time=times.get(sub);
    const body={meta:{event_name:'subscription_created',custom_data:binding?{zentra_binding:binding}:{}},data:{type:'subscriptions',id:sub,
      attributes:{store_id:42,customer_id:customer,product_id:map.product,variant_id:map.variant,status:'active',
        created_at:time,updated_at:time,ends_at:null,renews_at:null,...extra}}};
    const rawBody=Buffer.from(JSON.stringify(body));const res=result();await handlers.webhook({body,rawBody,
      get:n=>n==='X-Signature'?(signatureValid?crypto.createHmac('sha256',secret).update(rawBody).digest('hex'):'bad'):null},res);return res;}
  const token=await checkout('buyer','pro_monthly');
  const denied=result();await handlers.checkout({auth:{userId:'buyer',email:'buyer@example.test'},body:{productKey:'pro_monthly',plan:'agency'}},denied);assert.equal(denied.statusCode,400);
  assert.equal((await webhook('buyer','pro_monthly','8001','9001',token,{},false)).statusCode,401);
  assert.equal((await webhook('buyer','pro_monthly','8001','9001',null)).statusCode,503);
  assert.equal((await webhook('buyer','agency_monthly','8001','9001',token)).statusCode,503);
  assert.equal((await db.query("select plan from users where auth_user_id='buyer'")).rows[0].plan,'free');
  const paid=await webhook('buyer','pro_monthly','8001','9001',token);assert.equal(paid.statusCode,200);
  const bound=(await db.query("select u.plan,u.auth_user_id,u.lemon_store_id,u.lemon_customer_id,u.lemon_subscription_id,c.auth_user_id owner from users u join zentra_lemon_customers c on c.store_id=u.lemon_store_id and c.customer_id=u.lemon_customer_id join zentra_lemon_subscriptions s on s.store_id=u.lemon_store_id and s.subscription_id=u.lemon_subscription_id and s.user_id=u.id where u.auth_user_id='buyer'")).rows[0];
  assert.deepEqual(bound,{plan:'pro',auth_user_id:'buyer',lemon_store_id:'42',lemon_customer_id:'9001',lemon_subscription_id:'8001',owner:'buyer'});
  assert.equal((await webhook('buyer','pro_monthly','8001','9001',token)).body.duplicate,true);
  const other=await checkout('other','pro_monthly');assert.equal((await webhook('other','pro_monthly','8002','9001',other)).statusCode,503);
  assert.equal((await db.query("select plan from users where auth_user_id='other'")).rows[0].plan,'free');
  pass('authenticated opaque checkout + signed exact variant binds store/customer/subscription/Auth; forgery/replay/owner conflicts safe');

  async function consume(auth,counter,key){return (await db.query('select zentra_consume($1,$2,\'subscription\',$3,$4,false) r',[auth,auth+'@example.test',counter,key])).rows[0].r;}
  for(const [auth,key,cap,sub,customer] of [['buyer','pro_monthly',10,'8001','9001'],['agencybuyer','agency_monthly',30,'8003','9003']]){
    if(auth!=='buyer'){const t=await checkout(auth,key);assert.equal((await webhook(auth,key,sub,customer,t)).statusCode,200);}
    await db.query('update users set premium_pdf_used=$1 where auth_user_id=$2',[cap-1,auth]);
    const operation=crypto.randomUUID();assert.equal((await consume(auth,'premium_pdf_used',operation)).allowed,true);
    assert.equal((await consume(auth,'premium_pdf_used',operation)).duplicate,true);
    assert.equal((await consume(auth,'premium_pdf_used',crypto.randomUUID())).allowed,false);
    assert.equal((await db.query('select premium_pdf_used from users where auth_user_id=$1',[auth])).rows[0].premium_pdf_used,cap);
  }
  pass('Pro 10 / Agency 30: one receipt per audit across refinements/retries, no 30/80 phase accounting');

  const auditOp=crypto.randomUUID();const audit=await db.query("select zentra_consume('fixture-7','fixture7@example.test','audit','audit_credits_used',$1,false) r",[auditOp]);
  assert.equal(audit.rows[0].r.allowed,true);
  assert.equal((await db.query("select zentra_consume('fixture-7','fixture7@example.test','audit','audit_credits_used',$1,false) r",[auditOp])).rows[0].r.duplicate,true);
  assert.equal((await db.query("select audits_used from users where auth_user_id='fixture-0'")).rows[0].audits_used,2);
  pass('shared one-time audit accounting stays separate from subscription counters');
  assert.equal(forbiddenNetworkCalls,0);

  // Generated catalog contract: SQL types/signatures only, never fixture rows.
  const tables=(await db.query("select c.table_name,c.column_name,c.data_type,c.is_nullable from information_schema.columns c where table_schema='public' and (table_name='users' or table_name like 'zentra_%') order by table_name,ordinal_position")).rows;
  const functions=(await db.query("select p.proname,oidvectortypes(p.proargtypes) args,md5(p.prosrc) body_md5 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'zentra_%' order by p.proname,args")).rows;
  if(process.env.ZENTRA_WRITE_SCHEMA_CONTRACT==='1'){
    await writeFile(new URL('../migrations/required-schema.json',import.meta.url),JSON.stringify({tables,functions},null,2)+'\n');
    const literal=s=>"'"+s.replaceAll("'","''")+"'";
    const inventory=`-- READ ONLY: catalog discrepancies only; never accounts, keys or billing rows.\n-- Execute only after separate authorization on the verified production project.\nbegin read only;\nwith expected(table_name,column_name,data_type) as (values\n${tables.map(t=>'('+[t.table_name,t.column_name,t.data_type].map(literal).join(',')+')').join(',\n')})\nselect e.*,case when c.column_name is null then 'MISSING' else 'TYPE_MISMATCH' end status from expected e left join information_schema.columns c on c.table_schema='public' and c.table_name=e.table_name and c.column_name=e.column_name where c.column_name is null or c.data_type<>e.data_type order by e.table_name,e.column_name;\nwith expected(signature,body_md5) as (values\n${functions.map(f=>'('+[literal('public.'+f.proname+'('+f.args+')'),literal(f.body_md5)].join(',')+')').join(',\n')})\nselect e.signature,case when p.oid is null then 'MISSING' when md5(p.prosrc)<>e.body_md5 then 'DEFINITION_DIFFERS' else 'UNSAFE_GRANTS_OR_SECURITY' end status from expected e left join pg_proc p on p.oid=to_regprocedure(e.signature) where p.oid is null or md5(p.prosrc)<>e.body_md5 or not p.prosecdef or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE') order by e.signature;\nselect case when not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'zentra\\_%' escape '\\') and not exists(select 1 from pg_tables where schemaname='public' and tablename like 'zentra\\_%' escape '\\') then 'LEGACY_USERS_ONLY' else 'INSTALLED_OR_PARTIAL_REVIEW_BEFORE_BOOTSTRAP' end baseline;\nrollback;\n`;
    await db.query(inventory); // Validate the metadata-only SQL locally, never remotely.
    await writeFile(new URL('../migrations/00-required-catalog.sql',import.meta.url),inventory);
  }
  console.log('RESULT '+passed+'/'+passed+' focused scenarios; zero providers; local ephemeral PostgreSQL only');
} finally {
  if(db)await db.end();
  if(started)await run(path.join(bin,'pg_ctl'),['-D',database,'-m','fast','-w','stop'],{timeout:20000});
  await rm(directory,{recursive:true,force:true}); // Exact mkdtemp fixture directory only.
}
