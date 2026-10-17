import test from 'node:test';
import assert from 'node:assert/strict';
import { createLemonHandlers } from '../../release-lemon.js';
const products={SAAS:{pro_monthly:{variantId:1,productId:2,link:'https://tryzentra.lemonsqueezy.com/checkout/buy/fixture'}}};
const response=()=>({statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}});
test('legacy paid row without Auth id is checked for billing on its first authenticated request',async()=>{
  let identityResolved=false,next=0,network=0;const calls=[],res=response();
  const handlers=createLemonHandlers({products,client:{async rpc(name,args){calls.push({name,args});
    if(name==='zentra_access'){identityResolved=true;return {data:{plan:'agency',status:'active'}};}
    if(name==='zentra_lemon_sync_claim')return {data:identityResolved?{unverified:true}:null};
    assert.fail('Unexpected RPC');}},env:{},fetchImpl:async()=>{network++;assert.fail('No external provider');}});
  await handlers.reconcile({path:'/api/chat',auth:{userId:'verified-auth',email:'verified@example.test'},body:{plan:'agency'}},res,()=>next++);
  assert.equal(next,0);assert.equal(res.statusCode,503);assert.equal(res.body.code,'billing_association_required');
  assert.deepEqual(calls.map(c=>c.name),['zentra_access','zentra_lemon_sync_claim']);
  assert.deepEqual(calls[0].args,{p_auth_id:'verified-auth',p_email:'verified@example.test',p_product:'subscription'});
  assert.equal(network,0);
});
test('unauthenticated requests and shared audit product do not resolve subscription identities',async()=>{
  let rpc=0,next=0;const handlers=createLemonHandlers({products,client:{async rpc(){rpc++;assert.fail('No RPC expected');}}});
  for(const req of [{path:'/api/chat',body:{}},{path:'/api/chat',auth:{userId:'fixture'},body:{zentra_operation:{product:'audit'}}}])
    await handlers.reconcile(req,response(),()=>next++);
  assert.equal(rpc,0);assert.equal(next,2);
});
