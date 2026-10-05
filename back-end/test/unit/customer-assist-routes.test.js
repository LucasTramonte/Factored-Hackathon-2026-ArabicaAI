import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customerAssist } from '../../src/modules/intake/assist-routes.js';
const protocol = crypto.randomUUID();
const req = body => new Request(`https://demo.example/intake/handoff/${protocol}/assist`, {method:'POST',headers:{Cookie:'demo_session='+'a'.repeat(64)},body:JSON.stringify({question:'What is the status?',language:'en',request_id:crypto.randomUUID(),...body})});
const usage={llm_calls:1,known_input_tokens:1,known_output_tokens:1,usage_unavailable_calls:0};
const store = () => ({findSession:async()=>({customer_id:'demo-ana',expires_at:Date.now()+60000}),findCustomerAssist:async()=>({protocol,source:'fictitious',status:'received',message_count:0}),reserveAssist:async()=> 'reserved',finishAssist:async()=>{}});
test('customer classifier receives only question and language, returns fresh closure snapshot',async()=>{
 const s=store();let reads=0;s.findCustomerAssist=async()=>({protocol,source:'fictitious',status:++reads<3?'received':'closed',message_count:reads<3?0:1});
 const res=await customerAssist(req(),{ASSIST_CUSTOMER_ENABLED:'1'},s,null,async(env,args)=>{assert.deepEqual(args,{mode:'customer',language:'en',input:{question:'What is the status?'}});return {ok:true,value:{intent:'status',field:null},usage};});
 assert.equal(res.status,200);assert.deepEqual((await res.json()).snapshot,{status:'closed',message_count:1});
});
test('foreign and missing scope, strict fields, dataset and off prevent calls',async()=>{
 for(const missing of [null]){const s=store();s.findCustomerAssist=async()=>missing;assert.equal((await customerAssist(req(),{ASSIST_CUSTOMER_ENABLED:'1'},s,null,()=>assert.fail())).status,404);}
 for(const body of [{customer_id:'spoof'},{question:''},{question:'\ud800'},{field:'amount'}])assert.equal((await customerAssist(req(body),{ASSIST_CUSTOMER_ENABLED:'1'},store(),null,()=>assert.fail())).status,422);
 const s=store();s.findCustomerAssist=async()=>({protocol,source:'dataset'});s.reserveAssist=()=>assert.fail();assert.equal((await customerAssist(req(),{ASSIST_CUSTOMER_ENABLED:'1'},s,null,()=>assert.fail())).status,503);
 assert.equal((await customerAssist(req(),{},store(),null,()=>assert.fail())).status,503);
});
test('revocation between reservation and call consumes its slot but never calls provider',async()=>{
 const s=store();let reads=0,finished;s.findSession=async()=>++reads<3?{customer_id:'demo-ana'}:null;s.recordAuthEvent=async()=>{};s.finishAssist=async value=>finished=value;
 const response=await customerAssist(req(),{ASSIST_CUSTOMER_ENABLED:'1'},s,null,()=>assert.fail('no provider after revocation'));
 assert.equal(response.status,401);assert.equal(finished.outcome,'stale');assert.equal(finished.usage.llm_calls,0);
});
test('all classifier intent/field pairs obey the production parser',async()=>{
 const {parseAssist}=await import('../../src/modules/intake/assist.js');
 for(const intent of ['status','next_step','provide_details','human','unsupported'])for(const field of [null,'merchant','amount','currency','date','description']){
  const raw=JSON.stringify({intent,field});if(intent==='provide_details'||field===null)assert.deepEqual(parseAssist('customer',raw),{intent,field});else assert.throws(()=>parseAssist('customer',raw));
 }
});
