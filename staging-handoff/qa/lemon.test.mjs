import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { verifyCheckoutEntryPoints, verifyCapacityCheckoutEntries } from './checkout-entrypoints.test.mjs';

const backend = process.env.ZENTRA_BACKEND_DIR;
const { lemonCatalog, validLemonSignature } = await import(pathToFileURL(backend + '/release-lemon.js'));
const { PLAN_ENTITLEMENTS, auditEntitlement } = await import(pathToFileURL(backend + '/release-entitlements.js'));
const source = await readFile(backend + '/server.js', 'utf8');
const products = vm.runInNewContext(source.slice(source.indexOf('const LEMON_PRODUCTS = {'),
  source.indexOf('\nfunction getPlanFromLemonKey')) + '\nLEMON_PRODUCTS');
const catalog = lemonCatalog(products);
const pg = new EmbeddedPostgres({ databaseDir: '/tmp/zentra-lemon-pg-' + process.pid,
  user: 'postgres', password: crypto.randomUUID(), port: 55485, persistent: false,
  postgresFlags: ['-h', '127.0.0.1'], onLog() {}, onError() {} });
let db;
const workers = [];
let passes = 0;
const pass = name => { passes++; console.log('PASS', name); };
const secret = 'local-lemon-fixture';
let version = Date.now();
const timestamp = () => { version=Math.max(version+1,Date.now()); return new Date(version).toISOString(); };
const future = () => new Date(Date.now() + 86400000).toISOString();
const past = () => new Date(Date.now() - 86400000).toISOString();
async function worker(config) {
  const child = fork(fileURLToPath(new URL('./lemon-worker.mjs', import.meta.url)), [], {
    execArgv: [], env: { ...process.env, ZENTRA_TEST_PG_CONFIG: JSON.stringify(config) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const pending = new Map(); let id = 0; let output = '';
  child.stderr.on('data', value => { output += value; process.stderr.write(value); });
  const ready = await new Promise((resolve, reject) => {
    child.on('message', msg => {
      if (msg.type === 'ready') return resolve(msg);
      const item = pending.get(msg.id); if (item) { pending.delete(msg.id); item.resolve(msg.value); }
    });
    child.on('exit', code => {
      reject(new Error('Worker exited ' + code + ': ' + output));
      for (const item of pending.values()) item.reject(new Error('Worker exited'));
    });
  });
  return { ...ready, child, call(type, args = {}) { const key = ++id;
    return new Promise((resolve, reject) => { pending.set(key, { resolve, reject }); child.send({ type, id: key, ...args }); });
  } };
}
async function checkout(key, auth = 'alice', extra = {}) {
  const response = await fetch(workers[0].url + '/api/lemon/checkout', { method: 'POST',
    headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ productKey: key, ...extra }) });
  return { status: response.status, body: await response.json() };
}
function payload(key, id = '1', binding, changes = {}, event = 'subscription_updated') {
  const mapping = catalog.byKey.get(key);
  return { meta: { event_name: event, custom_data: binding ? { zentra_binding: binding } : {} }, data: {
    type: 'subscriptions', id, attributes: { store_id: 42, customer_id: Number(id) + 1000,
      product_id: Number(mapping.product), variant_id: Number(mapping.variant), status: 'active', test_mode: true,
      user_email: 'this-is-not-authority@example.test', created_at: new Date().toISOString(), updated_at: timestamp(),
      ends_at: null, renews_at: future(), trial_ends_at: null, pause: null, ...changes }
  } };
}
async function webhook(body, index = 0, options = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const response = await fetch(workers[index].url + '/api/lemon/webhook', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': options.signature ?? signature,
      ...(options.header ? { 'X-Event-Name': options.header } : {}) }, body: raw });
  return { status: response.status, body: await response.json() };
}
async function state(auth = 'alice') { return (await db.query("select * from users where auth_user_id=$1 and plan_type='subscription'", [auth])).rows[0]; }
const tokenFrom = result => { assert.equal(result.status,200,JSON.stringify(result.body)); return new URL(result.body.url).searchParams.get('checkout[custom][zentra_binding]'); };
async function access(auth = 'alice') {
  const result = await db.query("select to_jsonb(zentra_access($1,$2,'subscription')) r", [auth, auth + '@example.test']);
  return result.rows[0].r;
}
try {
  await pg.initialise(); await pg.start(); db = pg.getPgClient(); await db.connect();
  await db.query('create role anon; create role authenticated; create role service_role');
  for (const file of ['supabase-users.sql','supabase-release-guard.sql','supabase-execution-guard.sql','supabase-lemon.sql','supabase-lemon.sql']) {
    await db.query(await readFile(backend + '/' + file, 'utf8'));
  }
  pass('billing migration applies twice; existing reset/lease code preserved');
  const config = { ...db.connectionParameters, password: db.connectionParameters.password, host: '127.0.0.1', port: 55485, max: 12 }; delete config.ssl;
  workers.push(await worker(config)); workers.push(await worker(config));
  assert.notEqual(workers[0].pid, workers[1].pid);
  pass('two independent Node processes using the same PostgreSQL');
  const popup=await readFile(backend.slice(0,backend.lastIndexOf('/'))+'/publicacion/chrome-store/zentra-ai-chrome-store-clean/popup.js','utf8');
  const tabs=[],requests=[];
  const ui=vm.createContext({URL,Response,window:{zentraApiFetch:async(url,options)=>{
    requests.push({url,body:JSON.parse(options.body)});
    return new Response(JSON.stringify({success:true,url:'https://tryzentra.lemonsqueezy.com/checkout/buy/fixture?checkout%5Bcustom%5D%5Bzentra_binding%5D=fixture'}));
  }},chrome:{tabs:{create:async value=>tabs.push(value)}}});
  vm.runInContext(popup.slice(popup.indexOf('const ZENTRA_LEMON_URLS'),popup.indexOf('const ZENTRA_PLAN_OPTIONS'))+
    popup.slice(popup.indexOf('async function openVerifiedLemonCheckout'),popup.indexOf('\nfunction openPlanModal')),ui);
  await ui.openVerifiedLemonCheckout(vm.runInContext('ZENTRA_LEMON_URLS.starterAnnual',ui));
  assert.equal(requests[0].body.productKey,'starter_yearly');assert.equal(tabs.length,1);
  await ui.openVerifiedLemonCheckout(vm.runInContext('ZENTRA_AGENCY_CAPACITY_OFFERS[0].checkoutUrl',ui));
  assert.equal(requests[1].body.productKey,'growth');
  ui.window.zentraApiFetch=async()=>new Response(JSON.stringify({error:'fixture unauthenticated'}),{status:401});
  await assert.rejects(ui.openVerifiedLemonCheckout(vm.runInContext('ZENTRA_LEMON_URLS.pro',ui)));
  assert.equal(tabs.length,2);
  ui.window.zentraApiFetch=async()=>new Response(JSON.stringify({success:true,url:'https://foreign.test/checkout/buy/fixture'}));
  await assert.rejects(ui.openVerifiedLemonCheckout(vm.runInContext('ZENTRA_LEMON_URLS.pro',ui)));
  assert.equal(tabs.length,2);
  pass('actual Chrome checkout helper uses authenticated server key; missing auth/foreign destination has no public-link fallback');
  await verifyCheckoutEntryPoints({ backend, worker: workers[0], db, catalog, pass });
  const raw = Buffer.from('{}'); const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  assert.ok(validLemonSignature(raw, sig, secret));
  for (const invalid of ['', sig + 'aa', sig + 'junk', 'f'.repeat(64), sig.slice(0, 63)]) {
    assert.equal(validLemonSignature(raw, invalid, secret), false);
    assert.equal((await webhook('{}', 0, { signature: invalid })).status, 401);
  }
  assert.equal(validLemonSignature(Buffer.from('{"altered":true}'), sig, secret), false);
  assert.equal((await db.query('select count(*) n from zentra_lemon_events')).rows[0].n, '0');
  pass('valid HMAC accepted; missing/invalid/altered/trailing-text signatures rejected without DB writes');
  assert.equal((await checkout('starter_monthly', 'invalid')).status, 401);
  assert.equal((await checkout('starter_monthly','alice',{ user_id: 'bob', variant_id: 1683081 })).status, 400);
  assert.equal((await checkout('fake')).status, 400);
  for (const extra of [{ variantId:1683081 }, { productId:1073676 }, { userId:'bob' }, { plan:'agency' }, { interval:'weekly' }, { price:1 }]) {
    assert.equal((await checkout('starter_monthly','alice',extra)).status,400);
  }
  assert.equal((await checkout('starter_weekly')).status,400);
  pass('checkout rejects forged camelCase IDs, identity, plan/price and unknown interval without accepting client authority');
  pass('checkout requires verified session and server-approved key; forged identity/variant cannot grant access');
  const binding = tokenFrom(await checkout('starter_monthly'));
  let current = payload('starter_monthly', '1', binding);
  assert.equal((await webhook(current)).status, 200);
  assert.equal((await state()).plan, 'starter');
  assert.equal((await state()).auth_user_id, 'alice');
  assert.equal((await state()).lemon_customer_id, '1001');
  pass('valid webhook binds internal identity/customer/subscription; buyer email is not authority');
  await db.query("update users set actions_used=299,audits_used=4 where auth_user_id='alice'");
  const cycle = (await state()).billing_cycle_start;
  current = payload('starter_monthly', '1', binding);
  const duplicateResults = await Promise.all(Array.from({ length: 10 }, (_, i) => webhook(current, i % 2)));
  assert.ok(duplicateResults.every(r => r.status === 200));
  assert.equal(duplicateResults.filter(r => !r.body.duplicate).length, 1);
  assert.equal((await state()).actions_used, 299); assert.equal((await state()).billing_cycle_start, cycle);
  pass('ten identical deliveries across two processes: one atomic transition, no usage reset');
  assert.ok((await webhook(JSON.stringify(current,null,2))).body.duplicate);
  pass('idempotency key survives JSON whitespace differences');
  const old = current;
  assert.equal((await webhook(payload('pro_monthly','1',binding))).status, 200);
  assert.equal((await state()).plan, 'pro'); assert.equal((await state()).actions_used, 299);
  // Different delivery body but the same older provider version.
  old.meta.custom_data.extra = 'reordered fixture';
  assert.ok((await webhook(old)).body.duplicate);
  assert.equal((await state()).plan, 'pro');
  pass('upgrade preserves consumption; older provider version cannot roll back plan');
  assert.equal((await webhook(payload('starter_yearly','1',binding))).status, 200);
  assert.equal((await state()).plan,'starter'); assert.equal((await state()).billing_interval,'year');
  assert.equal((await state()).actions_used,299); assert.equal((await state()).audits_used,4);
  pass('real variant downgrade is immediate, preserves usage; annual does not reset usage');
  for (const [status, pause, expected] of [
    ['past_due',null,'starter'],['active',null,'starter'],['past_due',null,'starter'],['unpaid',null,'free'],
    ['active',null,'starter'],['paused',{mode:'free'},'starter'],['paused',{mode:'void'},'free'],['active',null,'starter']
  ]) {
    const event = status === 'paused' ? 'subscription_paused' : 'subscription_updated';
    assert.equal((await webhook(payload('starter_yearly','1',binding,{ status, pause },event))).status,200);
    assert.equal(auditEntitlement(await access()).plan, expected);
    assert.equal((await state()).billing_policy_pending,false);
    pass(status + (pause ? '/' + pause.mode : '') + ' -> ' + expected);
  }
  for(const [event,status,expected,id] of [
    ['subscription_payment_failed','past_due','starter','2001'],
    ['subscription_payment_failed','unpaid','free','2002'],
    ['subscription_payment_recovered','active','starter','2003'],
    ['subscription_payment_success','active','starter','2004']
  ]) {
    const supplier=payload('starter_yearly','1',null,{status});
    for(const w of workers) await w.call('provider',{payload:supplier});
    const invoice={meta:{event_name:event},data:{type:'subscription-invoices',id,
      attributes:{store_id:42,customer_id:1001,subscription_id:1,status:'paid',updated_at:timestamp(),test_mode:true}}};
    assert.equal((await webhook(invoice)).status,200);
    assert.equal(auditEntitlement(await access()).plan,expected);
    const callsBefore=(await workers[0].call('metrics')).providerCalls;
    assert.ok((await webhook(invoice)).body.duplicate);
    assert.equal((await workers[0].call('metrics')).providerCalls,callsBefore);
    assert.equal((await state()).actions_used,299);assert.equal((await state()).billing_cycle_start,cycle);
    pass(event+' resolves real subscription (not invoice ID), '+expected+', no reset or replay API call');
  }
  assert.equal((await webhook(payload('starter_yearly','1',binding,{status:'cancelled',ends_at:future()},'subscription_cancelled'))).status,200);
  assert.equal(auditEntitlement(await access()).plan,'starter');
  assert.equal((await state()).billing_status,'cancelled');
  pass('cancelled future ends_at retains premium and raw billing state');
  // Crossing ends_at without an expired webhook must still remove entitlement.
  await db.query("update users set subscription_ends_at=now()-interval '1 second' where auth_user_id='alice'");
  assert.equal(auditEntitlement(await access()).plan,'free');
  pass('ends_at enforcement works server-side without another webhook');
  for (const [status, changes] of [['cancelled',{ends_at:past()}],['expired',{ends_at:past()}],
    ['on_trial',{trial_ends_at:future()}],['on_trial',{trial_ends_at:past()}],['active',{}]]) {
    assert.equal((await webhook(payload('starter_yearly','1',binding,{status,...changes}))).status,200);
    assert.equal(auditEntitlement(await access()).plan,status==='active'||(status==='on_trial'&&changes.trial_ends_at>new Date().toISOString())?'starter':'free');
    pass(status+' date-bound effective access');
  }
  for (const amount of [500,1200]) {
    const refund = { meta:{event_name:'subscription_payment_refunded'},data:{type:'subscription-invoices',id:String(amount),
      attributes:{store_id:42,customer_id:1001,subscription_id:1,refunded_amount:amount,refunded:true,
        updated_at:timestamp(),test_mode:true}} };
    assert.equal((await webhook(refund)).status,200);
    assert.equal((await state()).status,'active'); assert.equal((await state()).plan,'starter');
  }
  assert.equal((await db.query("select count(*) n from zentra_lemon_events where outcome='refund_review'")).rows[0].n,'2');
  assert.ok((await db.query("select metadata from zentra_lemon_events where outcome='refund_review'")).rows.every(r=>r.metadata.order_id===null));
  pass('partial/full invoice refund registered; neither changes entitlement');
  const orderRefund={meta:{event_name:'order_refunded'},data:{type:'orders',id:'900',attributes:{store_id:42,customer_id:1001,refunded_amount:100,refunded:true,updated_at:timestamp()}}};
  assert.equal((await webhook(orderRefund)).status,200);
  assert.ok((await webhook(orderRefund)).body.duplicate);
  pass('order refunds are recorded idempotently too');
  for (const changes of [{product_id:999999999,variant_id:999999999,product_name:'Agency'},
    {product_id:1073703,variant_id:999999999,product_name:'Starter'},
    {product_id:1073703,variant_id:1683081,product_name:'Agency'}]) {
    const r = await webhook(payload('starter_yearly','1',binding,changes));
    assert.equal(r.status,200);assert.ok(r.body.ignored);assert.equal((await state()).plan,'starter');
  }
  pass('unknown variant, named Agency, known product or mismatched pair cannot authorize premium');
  const bobBinding=tokenFrom(await checkout('agency_monthly','bob'));
  const impersonation=await webhook(payload('agency_monthly','1',bobBinding));
  assert.equal(impersonation.status,503);assert.equal((await state('bob')).plan,'free');assert.equal((await state()).plan,'starter');
  assert.equal((await webhook(payload('agency_monthly','44',bobBinding,{customer_id:1001}))).status,503);
  assert.equal((await webhook(payload('agency_monthly','55',null,{user_email:'alice@example.test'}))).status,503);
  pass('subscription/customer belonging to A cannot bind to B; email-only activation refused');
  assert.equal((await webhook(payload('starter_yearly','1',binding),0,{header:'subscription_expired'})).status,400);
  assert.equal((await webhook(payload('starter_yearly','1',binding,{store_id:99}))).status,400);
  pass('unsigned event header and foreign store cannot override signed identity');
  const outage = payload('agency_yearly','1',binding);
  const beforeFailure=(await db.query('select count(*) n from zentra_lemon_events')).rows[0].n;
  await workers[0].call('failDB',{enabled:true}); assert.equal((await webhook(outage)).status,503);
  assert.equal((await db.query('select count(*) n from zentra_lemon_events')).rows[0].n,beforeFailure);
  await workers[0].call('failDB',{enabled:false}); assert.equal((await webhook(outage)).status,200);
  assert.equal((await state()).plan,'agency');
  pass('DB failure remains retryable and does not acknowledge/persist an event receipt');
  const badState=await webhook(payload('agency_yearly','1',binding,{status:'not_a_provider_state'}));
  assert.equal(badState.status,503);assert.equal((await state()).billing_status,'active');
  for(const changes of [{status:'cancelled',ends_at:null},{status:'on_trial',trial_ends_at:null},{status:'paused',pause:null}]) {
    assert.equal((await webhook(payload('agency_yearly','1',binding,changes))).status,503);
    assert.equal((await state()).billing_status,'active');
  }
  pass('unknown provider state is not mistaken for a valid entitlement transition');
  const auditBinding=tokenFrom(await checkout('auditPro'));
  const order=(id,product,variant,token)=>({meta:{event_name:'order_created',custom_data:{zentra_binding:token}},data:{type:'orders',id,
    attributes:{store_id:42,customer_id:1001,status:'paid',created_at:new Date().toISOString(),updated_at:timestamp(),
      first_order_item:{product_id:product,variant_id:variant},user_email:'wrong@example.test',test_mode:true}}});
  const auditOrder=order('700',1073731,1683159,auditBinding);
  const purchased=await Promise.all(Array.from({length:10},(_,i)=>webhook(auditOrder,i%2)));
  assert.ok(purchased.every(r=>r.status===200));assert.equal(purchased.filter(r=>!r.body.duplicate).length,1);
  const credit=(await db.query("select * from users where auth_user_id='alice' and plan_type='audit'")).rows[0];
  assert.equal(credit.audit_credits,1);assert.equal(credit.plan,'pro');
  assert.equal((await state()).plan,'agency');
  pass('verified one-time order across two processes adds one Audit credit; SaaS counters isolated');
  const extraBinding=tokenFrom(await checkout('growth'));
  assert.equal((await webhook(order('701',1073777,1683224,extraBinding))).status,200);
  assert.equal((await state()).extra_actions_balance,300);assert.equal((await state()).extra_audits_balance,5);
  assert.equal((await state()).actions_used,299);assert.equal((await state()).billing_cycle_start,cycle);
  pass('verified extra order uses existing accounting without resetting base/cycle usage');
  await verifyCapacityCheckoutEntries({ backend, worker: workers[0], db, catalog, pass });
  let n=10;
  for(const key of ['starter_monthly','starter_yearly','pro_monthly','pro_yearly','agency_monthly','agency_yearly']) {
    const auth='user'+n;const id=String(n++);const b=tokenFrom(await checkout(key,auth));
    assert.equal((await webhook(payload(key,id,b))).status,200);
    const s=await access(auth), mapping=catalog.byKey.get(key);
    assert.equal(auditEntitlement(s).plan,mapping.plan);assert.equal(s.billing_interval,mapping.interval);
    assert.ok([300,800,3000].includes(PLAN_ENTITLEMENTS[mapping.plan].actions));
    pass(key+' -> canonical monthly entitlement');
  }
  const equalBinding=tokenFrom(await checkout('pro_monthly','user60'));
  const sameVersion=payload('pro_monthly','60',equalBinding);
  assert.equal((await webhook(sameVersion)).status,200);
  await db.query("update users set actions_used=17,audits_used=2 where auth_user_id='user60'");
  const originalCycle=(await state('user60')).billing_cycle_start;
  const conflicting=structuredClone(sameVersion);
  conflicting.data.attributes.status='unpaid';
  conflicting.data.attributes.authoritative_api=true;
  assert.ok((await webhook(conflicting)).body.duplicate);
  assert.equal((await state('user60')).billing_status,'active');
  assert.ok((await db.query("select checked_at<=now()-interval '5 minutes' due from zentra_lemon_subscriptions where subscription_id='60'")).rows[0].due);
  // Webhook attributes cannot impersonate the stronger, server-set API origin.
  conflicting.meta.event_name='subscription_paused';
  conflicting.data.attributes.status='paused';conflicting.data.attributes.pause={mode:'void'};
  assert.ok((await webhook(conflicting)).body.ignored);
  assert.equal((await state('user60')).billing_status,'active');
  const canonical=structuredClone(sameVersion);
  canonical.data.attributes.status='unpaid';
  for(const w of workers) await w.call('provider',{payload:canonical});
  const canonicalResponse=await fetch(workers[0].url+'/api/subscription/usage',{headers:{Authorization:'Bearer user60'}});
  assert.equal(canonicalResponse.status,200);
  assert.equal(auditEntitlement(await access('user60')).plan,'free');
  assert.equal((await state('user60')).billing_status,'unpaid');
  assert.equal((await state('user60')).actions_used,17);
  assert.equal((await state('user60')).audits_used,2);
  assert.equal((await state('user60')).billing_cycle_start,originalCycle);
  const older=structuredClone(sameVersion);
  older.data.attributes.updated_at=new Date(Date.parse(sameVersion.data.attributes.updated_at)-1000).toISOString();
  for(const w of workers) await w.call('provider',{payload:older});
  await db.query("update zentra_lemon_subscriptions set checked_at=now()-interval '6 minutes' where subscription_id='60'");
  assert.equal((await fetch(workers[1].url+'/api/subscription/usage',{headers:{Authorization:'Bearer user60'}})).status,200);
  assert.equal((await state('user60')).billing_status,'unpaid');
  pass('same-version conflicting deliveries queue canonical API verification; webhook cannot forge API authority; older API never rolls back or resets usage');
  // Fresh access enforces the same reservation boundaries after the billing migration.
  await db.query("update users set plan='starter',actions_used=299,audits_used=4 where auth_user_id='user10'");
  const db2=pg.getPgClient();await db2.connect();
  try {
    const consume=connection=>connection.query("select zentra_consume('user10','user10@example.test','subscription','actions_used',$1,false) r",[crypto.randomUUID()]);
    const r=await Promise.all([consume(db),consume(db2)]);
    assert.equal(r.filter(x=>x.rows[0].r.allowed).length,1);
    assert.ok((await db.query("select zentra_consume('user10','user10@example.test','subscription','audits_used',$1,false) r",[crypto.randomUUID()])).rows[0].r.allowed);
    assert.equal((await db.query("select zentra_consume('user10','user10@example.test','subscription','audits_used',$1,false) r",[crypto.randomUUID()])).rows[0].r.allowed,false);
  } finally { await db2.end(); }
  pass('post-migration 299/300 race and Starter fifth/sixth Audit boundary unchanged');
  await db.query("update users set actions_used=0,audits_used=0 where auth_user_id='user10'");
  const chatOp=crypto.randomUUID(),chatHash='a'.repeat(64),chatSource='b'.repeat(64);
  await db.query("select zentra_register_chat_step('user10','user10@example.test','subscription',$1,'root',$2,'{}',null)",[chatOp,chatHash]);
  const chat=(await db.query("select zentra_begin_request('user10','user10@example.test','subscription',$1,$2,$3,'chat',false) r",[chatOp,chatSource,chatHash])).rows[0].r;
  assert.ok(chat.allowed);
  await db.query('select zentra_finish_request($1,$2,$3,$4,$5,true)',[chat.user.id,chatOp,chatHash,chat.lease_token,{text:'Useful fixture response'}]);
  assert.ok((await db.query("select zentra_begin_request('user10','user10@example.test','subscription',$1,$2,$3,'chat',false) r",[chatOp,chatSource,chatHash])).rows[0].r.cached);
  assert.equal((await state('user10')).actions_used,1);
  const acquire=crypto.randomUUID();
  const acquired=(await db.query("select zentra_acquire_audit('user10','user10@example.test','subscription',$1,'https://fixture.test/',null,false) r",[acquire])).rows[0].r;
  assert.ok(acquired.allowed);assert.equal((await state('user10')).audits_used,1);
  assert.ok((await db.query("select zentra_release_audit('user10','user10@example.test','subscription',$1,$2) r",[acquire,acquired.lease_token])).rows[0].r);
  assert.equal((await state('user10')).audits_used,0);
  pass('chat consumption/replay and Audit acquisition/refund operate unchanged with billing migration');
  await db.query("update users set actions_used=300,audits_used=5,billing_cycle_start=(extract(epoch from now()-interval '2 months')*1000)::bigint where auth_user_id='user11'");
  assert.equal((await access('user11')).actions_used,0);assert.equal((await access('user11')).audits_used,0);
  assert.equal((await state('user11')).billing_interval,'year');
  pass('annual account receives monthly lazy reset, not a yearly pool');
  assert.equal(auditEntitlement(await access('user99')).plan,'free');
  pass('account without verified subscription remains Free');
  await assert.rejects(db.query("select zentra_apply_payment('alice@example.test','subscription','agency','1','active',null,null,now(),0,0,'{}')"),/Verified Lemon/);
  await db.query('set role authenticated');
  await assert.rejects(db.query("select zentra_lemon_event($1,'x','x','1',null,'{}')",['a'.repeat(64)]),/permission denied/);
  await assert.rejects(db.query("select zentra_apply_payment('alice@example.test','audit','pro','999','paid',null,null,now(),0,0,'{}')"),/permission denied/);
  await assert.rejects(db.query("select * from zentra_lemon_checkouts"),/permission denied/);
  await db.query('reset role');
  pass('legacy email-only SaaS mutation and public access to billing authority are denied');
  await db.query("update zentra_lemon_subscriptions set checked_at=now()-interval '6 minutes' where subscription_id='1'");
  const previousCalls=(await Promise.all(workers.map(w=>w.call('metrics')))).reduce((sum,m)=>sum+m.providerCalls,0);
  const latest=payload('agency_yearly','1',null,{status:'expired',ends_at:past()});
  for(const w of workers) await w.call('provider',{payload:latest});
  const replies=await Promise.all(workers.map(w=>fetch(w.url+'/api/subscription/usage',{headers:{Authorization:'Bearer alice'}})));
  assert.ok(replies.some(r=>r.status===200));
  assert.ok(replies.every(r=>[200,503].includes(r.status)));
  assert.equal(auditEntitlement(await access()).plan,'free');
  const metrics=await Promise.all(workers.map(w=>w.call('metrics')));
  assert.equal(metrics.reduce((sum,m)=>sum+m.providerCalls,0)-previousCalls,1);
  await fetch(workers[1].url+'/api/subscription/usage',{headers:{Authorization:'Bearer alice'}});
  assert.equal((await workers[1].call('metrics')).providerCalls,metrics[1].providerCalls);
  assert.ok(!JSON.stringify(metrics.flatMap(m=>m.logs)).includes('example.test'));
  assert.ok(!JSON.stringify(metrics.flatMap(m=>m.logs)).includes(binding));
  pass('missed expiry reconciled via official API shape; two processes perform one check; safe logs');
  await db.query("update zentra_lemon_subscriptions set checked_at=now()-interval '6 minutes' where subscription_id='1'");
  await workers[0].call('provider',{payload:null});
  const unavailable=await fetch(workers[0].url+'/api/subscription/usage',{headers:{Authorization:'Bearer alice'}});
  assert.equal(unavailable.status,503);
  assert.equal((await state()).billing_status,'expired');
  assert.equal((await db.query("select sync_token from zentra_lemon_subscriptions where subscription_id='1'")).rows[0].sync_token,null);
  const spoofed=payload('agency_yearly','1',null,{customer_id:1002});
  await workers[0].call('provider',{payload:spoofed});
  assert.equal((await fetch(workers[0].url+'/api/subscription/usage',{headers:{Authorization:'Bearer alice'}})).status,503);
  assert.equal((await state()).lemon_customer_id,'1001');
  pass('failed/foreign API response cannot rebind customer or grant access; reconciliation lease released');
  await db.query("insert into users(email,auth_user_id,plan) values('user98@example.test','user98','agency')");
  const unverified=await fetch(workers[0].url+'/api/subscription/usage',{headers:{Authorization:'Bearer user98'}});
  assert.equal(unverified.status,503);assert.equal((await unverified.json()).code,'billing_association_required');
  assert.equal((await state('user98')).plan,'agency');
  for(const path of ['/API/SUBSCRIPTION/USAGE/','/api/subscription/usage?plan_type=audit']) {
    assert.equal((await fetch(workers[0].url+path,{headers:{Authorization:'Bearer user98'}})).status,503);
  }
  pass('legacy paid rows require verified binding; no email-only premium grant or destructive downgrade');
  pass('case/trailing-slash aliases and irrelevant query cannot bypass billing association');
  console.log('Lemon checks passed:',passes);
} finally {
  for (const w of workers) if(w.child.connected) await w.call('stop');
  await db?.end(); await pg.stop().catch(()=>{});
}
