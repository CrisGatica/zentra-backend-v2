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
const catalogSQL=await readFile(new URL('../migrations/00-required-catalog.sql',import.meta.url),'utf8');
const baseline=JSON.parse(await readFile(new URL('../migrations/production-baseline.json',import.meta.url),'utf8'));
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
const inspectCatalog=async()=> (await db.query(catalogSQL)).filter(r=>r.command==='SELECT').map(r=>r.rows);
const schemaSnapshot=async()=>({
  columns:(await db.query("select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' order by table_name,ordinal_position")).rows,
  functions:(await db.query("select p.proname,oidvectortypes(p.proargtypes) args,md5(p.prosrc) h from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by p.proname,args")).rows,
  indexes:(await db.query("select tablename,indexname,indexdef from pg_indexes where schemaname='public' order by tablename,indexname")).rows
});
const result=()=>({statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}});
let forbiddenNetworkCalls=0;
try {
  await run(path.join(bin,'initdb'),['-D',database,'-A','trust','-U','postgres','--no-locale','-E','UTF8','--no-sync'],{timeout:60000});
  await run(path.join(bin,'pg_ctl'),['-D',database,'-l',path.join(directory,'postgres.log'),'-o','-h 127.0.0.1 -p '+port,'-w','start'],{timeout:20000});started=true;
  db=new Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});await db.connect();
  console.log('ENGINE '+(await db.query('show server_version')).rows[0].server_version+'; synthetic Supabase roles; loopback only');
  await db.query('create role anon; create role authenticated; create role service_role');
  await db.query(await readFile(path.join(root,'supabase-users.sql'),'utf8'));
  const baselineColumns=(await db.query("select column_name,data_type from information_schema.columns where table_schema='public' and table_name='users' order by column_name")).rows;
  assert.deepEqual(baselineColumns,[...baseline.columns].sort((a,b)=>a.column_name.localeCompare(b.column_name)));
  pass('local legacy fixture matches all 20 supplied production CSV column names/types');
  const initialCatalog=await inspectCatalog();
  assert.equal(initialCatalog[2][0].baseline,'LEGACY_USERS_ONLY');
  assert.equal(initialCatalog[0].filter(r=>r.table_name==='users'&&r.status==='MISSING').length,14);
  assert.ok(initialCatalog[1].length>0&&initialCatalog[1].every(r=>r.status==='MISSING'));
  pass('original 00 executes completely on CSV baseline and reports the 14 missing users columns and missing RPCs');
  await db.query('alter table users alter column audits_used type bigint');
  assert.ok((await inspectCatalog())[0].some(r=>r.column_name==='audits_used'&&r.status==='TYPE_MISMATCH'));
  await assert.rejects(db.query(sql),/Legacy users identity\/types differ/);await db.query('rollback');
  assert.equal((await db.query("select to_regclass('public.zentra_lemon_customers') t")).rows[0].t,null);
  await db.query('alter table users alter column audits_used type integer');
  pass('existing counter type mismatch aborts without implicit conversion');
  await db.query('create schema other_fixture;create function other_fixture.zentra_access() returns int language sql as $$select 1$$');
  await assert.rejects(db.query(sql),/RPCs exist outside public/);await db.query('rollback');
  await db.query('drop function other_fixture.zentra_access();drop schema other_fixture');
  pass('RPC implementation in another schema is detected, never silently duplicated/redirected');
  for(let i=0;i<8;i++) await db.query(`insert into users(email,plan,plan_type,actions_used,audits_used,premium_pdf_used,audit_credits,audit_credits_used)
    values($1,$2,$3,$4,$5,$6,$7,$8)`,[
    'fixture'+i+'@example.test',i<2||i===7?'agency':'free',i===7?'audit':'subscription',i+1,i<2?2:0,i<2?70:0,i===7?2:0,i===7?1:0]);
  for(const i of [0,1,7])await db.query("update users set purchase_history=$1 where email=$2",[
    JSON.stringify([{fixture:true,lemonOrderId:'synthetic-paid-'+i,amount:99,currency:'USD'}]),'fixture'+i+'@example.test']);
  const before=await snapshot();
  await db.query('create function public.zentra_unknown_fixture() returns int language sql as $$select 1$$');
  await assert.rejects(db.query(sql),/Partial\/unknown Zentra schema/); await db.query('rollback');
  assert.equal((await db.query("select to_regclass('public.zentra_usage_receipts') t")).rows[0].t,null);
  await db.query('drop function public.zentra_unknown_fixture()');
  pass('unknown/partial baseline is refused before any schema or account overwrite');

  const beforeSchema=await schemaSnapshot();
  const fault=sql.replace('  create table if not exists public.zentra_ai_schema_releases (',"  raise exception 'synthetic migration failure';\n  create table if not exists public.zentra_ai_schema_releases (");
  await assert.rejects(db.query(fault),/synthetic migration failure/); await db.query('rollback');
  assert.deepEqual(await snapshot(),before);
  assert.deepEqual(await schemaSnapshot(),beforeSchema);
  assert.equal((await db.query("select to_regclass('public.zentra_lemon_customers') t")).rows[0].t,null);
  pass('mid-install failure rolls back all DDL, rows and counters atomically');

  await db.query(sql);
  const installedCatalog=await inspectCatalog();
  assert.deepEqual(installedCatalog[0],[]);assert.deepEqual(installedCatalog[1],[]);
  pass('complete 00 executes after complete 01 with zero column/function discrepancies');
  const projected=(await snapshot()).map((row,i)=>Object.fromEntries(Object.keys(before[i]).map(k=>[k,row[k]])));
  assert.deepEqual(projected,before);
  assert.equal((await db.query('select count(*)::int n from users where auth_user_id is not null')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from zentra_lemon_subscriptions')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from zentra_lemon_customers')).rows[0].n,0);
  assert.deepEqual((await db.query('select capacity_total,activated_total,enabled from zentra_free_launch_config')).rows[0],{capacity_total:100,activated_total:0,enabled:false});
  pass('eight synthetic legacy accounts survive unchanged; no invented billing bindings or Free slots');

  // Test fixture only: represent accounts that have legitimately authenticated.
  for(let i=0;i<8;i++)await db.query('update users set auth_user_id=$1 where email=$2',['fixture-'+i,'fixture'+i+'@example.test']);
  const freeBefore=(await db.query("select actions_used,audits_used,premium_chat_used,premium_pdf_used,billing_cycle_start from users where auth_user_id='fixture-2'")).rows[0];
  for(const counter of ['actions_used','audits_used']){
    const blocked=(await db.query("select zentra_consume('fixture-2','fixture2@example.test','subscription',$1,$2,false) r",[counter,crypto.randomUUID()])).rows[0].r;
    assert.equal(blocked.allowed,false);assert.equal(blocked.reason,'free_access_blocked');assert.equal(blocked.commercial.state,'free_waitlist');
  }
  assert.deepEqual((await db.query("select actions_used,audits_used,premium_chat_used,premium_pdf_used,billing_cycle_start from users where auth_user_id='fixture-2'")).rows[0],freeBefore);
  assert.equal((await db.query('select activated_total from zentra_free_launch_config')).rows[0].activated_total,0);
  assert.equal((await db.query('select count(*)::int n from zentra_free_access where ever_used')).rows[0].n,0);
  pass('Free is OFF: Chat/Audit denied with no slot, receipt debit, expiry or counter change');

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
  assert.equal((await db.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and (c.relname='users' or c.relname like 'zentra_%') and (has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE'))")).rows[0].n,0);
  await assert.rejects(db.query("select zentra_consume('fixture-0','fixture0@example.test','subscription','audits_used',$1,true)",[crypto.randomUUID()]),/Unlimited test mode/);
  await assert.rejects(db.query("select zentra_acquire_audit('fixture-0','fixture0@example.test','subscription',$1,'https://site.example.test/',null,true)",[crypto.randomUUID()]),/Unlimited test mode/);
  pass('all RPCs private/RLS enabled; production SQL rejects unlimited even through service-only parameters');
  const unlimitedFunctions=(await db.query("select p.proname,p.proargnames from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and 'p_unlimited'=any(p.proargnames) order by p.proname")).rows;
  const unlimitedArgs={zentra_consume:['fixture-0','fixture0@example.test','subscription','audits_used',crypto.randomUUID(),false],
    zentra_consume_before_free:['fixture-0','fixture0@example.test','subscription','audits_used',crypto.randomUUID(),false],
    zentra_consume_generation:['fixture-0','fixture0@example.test','subscription','audits_used',crypto.randomUUID(),'a'.repeat(64),crypto.randomUUID(),false],
    zentra_begin_request:['fixture-0','fixture0@example.test','subscription',crypto.randomUUID(),'a'.repeat(64),'b'.repeat(64),'audit',false,null],
    zentra_acquire_audit:['fixture-0','fixture0@example.test','subscription',crypto.randomUUID(),'https://fixture.example.test/',null,false]};
  assert.equal(unlimitedFunctions.length,5);
  for(const f of unlimitedFunctions)for(const value of [true,null]){
    const args=[...unlimitedArgs[f.proname]];assert.ok(args);args[f.proargnames.indexOf('p_unlimited')]=value;
    await assert.rejects(db.query('select '+f.proname+'('+args.map((_,i)=>'$'+(i+1)).join(',')+')',args),/Unlimited test mode/);
  }
  pass('every unlimited-capable RPC rejects true and NULL, including internal cores');

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
  await db.query("update users set actions_used=17,audits_used=2,premium_pdf_used=1 where auth_user_id='buyer'");
  const beforeDuplicate=await snapshot();
  const eventCount=(await db.query('select count(*)::int n from zentra_lemon_events')).rows[0].n;
  assert.equal((await webhook('buyer','pro_monthly','8001','9001',token)).body.duplicate,true);
  assert.deepEqual(await snapshot(),beforeDuplicate);
  assert.equal((await db.query('select count(*)::int n from zentra_lemon_events')).rows[0].n,eventCount);
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
  for(const [key,plan,cap,sub,customer]of [['starter_monthly','starter',5,'8100','9100'],['pro_monthly','pro',10,'8101','9101'],['agency_monthly','agency',30,'8102','9102']]){
    const auth='limit-'+plan,t=await checkout(auth,key);assert.equal((await webhook(auth,key,sub,customer,t)).statusCode,200);
    await db.query('update users set audits_used=$1 where auth_user_id=$2',[cap-1,auth]);
    const op=crypto.randomUUID();assert.equal((await consume(auth,'audits_used',op)).allowed,true);
    assert.equal((await consume(auth,'audits_used',op)).duplicate,true);
    assert.equal((await consume(auth,'audits_used',crypto.randomUUID())).allowed,false);
    assert.equal((await db.query('select audits_used from users where auth_user_id=$1',[auth])).rows[0].audits_used,cap);
  }
  pass('commercial audit caps enforced at the boundary: Starter 5 / Pro 10 / Agency 30');

  const auditOp=crypto.randomUUID();const audit=await db.query("select zentra_consume('fixture-7','fixture7@example.test','audit','audit_credits_used',$1,false) r",[auditOp]);
  assert.equal(audit.rows[0].r.allowed,true);
  assert.equal((await db.query("select zentra_consume('fixture-7','fixture7@example.test','audit','audit_credits_used',$1,false) r",[auditOp])).rows[0].r.duplicate,true);
  assert.equal((await db.query("select audits_used from users where auth_user_id='fixture-0'")).rows[0].audits_used,2);
  pass('shared one-time audit accounting stays separate from subscription counters');
  assert.equal(forbiddenNetworkCalls,0);
  const beforeFinalReplay=await snapshot();
  const bindingsBefore=(await db.query('select to_jsonb(s) row from zentra_lemon_subscriptions s order by subscription_id')).rows;
  await db.query(sql);
  assert.deepEqual(await snapshot(),beforeFinalReplay);
  assert.deepEqual((await db.query('select to_jsonb(s) row from zentra_lemon_subscriptions s order by subscription_id')).rows,bindingsBefore);
  pass('migration replay after synthetic payments preserves billing bindings and every account/counter');

  // Generated catalog contract: SQL types/signatures only, never fixture rows.
  const tables=(await db.query("select c.table_name,c.column_name,c.data_type,c.is_nullable from information_schema.columns c where table_schema='public' and (table_name='users' or table_name like 'zentra_%') order by table_name,ordinal_position")).rows;
  const functions=(await db.query("select p.proname,oidvectortypes(p.proargtypes) args,md5(p.prosrc) body_md5 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'zentra_%' order by p.proname,args")).rows;
  if(process.env.ZENTRA_WRITE_SCHEMA_CONTRACT==='1'){
    await writeFile(new URL('../migrations/required-schema.json',import.meta.url),JSON.stringify({tables,functions},null,2)+'\n');
    const literal=s=>"'"+s.replaceAll("'","''")+"'";
    const inventory=`-- READ ONLY: catalog discrepancies only; never accounts, keys or billing rows.\n-- Execute only after separate authorization on the verified production project.\nbegin read only;\nwith expected(table_name,column_name,data_type) as (values\n${tables.map(t=>'('+[t.table_name,t.column_name,t.data_type].map(literal).join(',')+')').join(',\n')})\nselect e.*,case when c.column_name is null then 'MISSING' else 'TYPE_MISMATCH' end status from expected e left join information_schema.columns c on c.table_schema='public' and c.table_name=e.table_name and c.column_name=e.column_name where c.column_name is null or c.data_type<>e.data_type order by e.table_name,e.column_name;\nwith expected(signature,body_md5) as (values\n${functions.map(f=>'('+[literal('public.'+f.proname+'('+f.args+')'),literal(f.body_md5)].join(',')+')').join(',\n')})\nselect e.signature,case when p.oid is null then 'MISSING' when md5(p.prosrc)<>e.body_md5 then 'DEFINITION_DIFFERS' else 'UNSAFE_GRANTS_OR_SECURITY' end status from expected e left join pg_proc p on p.oid=to_regprocedure(e.signature) where p.oid is null or md5(p.prosrc)<>e.body_md5 or not p.prosecdef or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE') order by e.signature;\nselect case when not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'zentra\\_%' escape '\\') and not exists(select 1 from pg_tables where schemaname='public' and tablename like 'zentra\\_%' escape '\\') then 'LEGACY_USERS_ONLY' else 'INSTALLED_OR_PARTIAL_REVIEW_BEFORE_BOOTSTRAP' end baseline;\nrollback;\n`;
    const visibility=`-- Visibility/ownership and names across schemas; no function bodies or account rows.\nselect current_user as inspection_role,r.rolsuper as is_superuser,r.rolbypassrls as bypasses_rls,\n  has_table_privilege(current_user,'public.users','SELECT') as can_select_users,\n  pg_has_role(current_user,c.relowner,'USAGE') as has_table_owner_rights\nfrom pg_roles r cross join pg_class c where r.rolname=current_user and c.oid='public.users'::regclass;\nselect n.nspname as schema_name,p.proname as function_name,pg_get_function_identity_arguments(p.oid) as arguments\nfrom pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace\nwhere left(p.proname,7)='zentra_' order by 1,2,3;\nselect conname,pg_get_constraintdef(oid) as definition from pg_catalog.pg_constraint where conrelid='public.users'::regclass order by conname;\nselect indexname,indexdef from pg_catalog.pg_indexes where schemaname='public' and tablename='users' order by indexname;\n`;
    const finalInventory=inventory.replace('rollback;\n',visibility+'rollback;\n');
    await db.query(finalInventory); // Validate the metadata-only SQL locally, never remotely.
    await writeFile(new URL('../migrations/00-required-catalog.sql',import.meta.url),finalInventory);
  }
  const finalCatalog=await inspectCatalog();assert.deepEqual(finalCatalog[0],[]);assert.deepEqual(finalCatalog[1],[]);
  console.log('RESULT '+passed+'/'+passed+' focused scenarios; zero providers; local ephemeral PostgreSQL only');
} finally {
  if(db)await db.end();
  if(started)await run(path.join(bin,'pg_ctl'),['-D',database,'-m','fast','-w','stop'],{timeout:20000});
  await rm(directory,{recursive:true,force:true}); // Exact mkdtemp fixture directory only.
}
