/** Read-only handoff views through authenticated Worker routes and real local D1. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, base, closeReport } from '../support/client.js';
import { assertContract } from '../support/contract.js';
async function report(c, complete) {
  const started = await c.call('/intake/start',{language:'es',mode:'guided',report_type:'unrecognized_charge',reason:'not_mine',customer_statement:'No reconozco este cargo; solicito revisión.',idempotency_key:crypto.randomUUID()});
  assert.equal(started.status,201);
  const episode_id = started.body.episode_id;
  const res = await c.call(complete?'/intake/confirm':'/intake/handoff',complete
    ?{episode_id,transaction_id:'demo-tx-001',customer_confirmed:true,idempotency_key:crypto.randomUUID()}
    :{episode_id,kind:'incomplete',idempotency_key:crypto.randomUUID()});
  assert.equal(res.status,201); assertContract('intakeReceipt',res.body); return res.body;
}

test('agent detail retrieves complete and incomplete evidence and service history; only the first open writes (its stamp)',async()=>{
  const c=client(); await c.call('/demo/session',{customer_id:'demo-ana'});
  const complete=await report(c,true), incomplete=await report(c,false);
  const agent=client(); await agent.call('/demo/agent-session',{});
  const queue=await agent.call('/agent/intakes'); assert.equal(queue.status,200); assertContract('agentIntakeList',queue.body);
  assert.ok(queue.body.items.some(x=>x.protocol===complete.protocol)); assert.ok(queue.body.items.some(x=>x.protocol===incomplete.protocol));
  assert.ok(queue.body.items.every(x=>!('customer_statement' in x)));
  const measurements={queue:queue.metrics};
  for(const receipt of [complete,incomplete]){
    const detail=await agent.call('/agent/intake-detail?protocol='+receipt.protocol); assert.equal(detail.status,200); assertContract('agentIntakeDetail',detail.body);
    assert.equal(detail.body.customer_statement,'No reconozco este cargo; solicito revisión.');
    assert.equal(detail.body.destination,'case_service'); assert.equal(detail.body.kind,receipt.kind);
    assert.deepEqual(detail.body.history.map(x=>x.seq),receipt.kind==='complete'?[0,1,2,3,4]:[0,1,2]);
    assert.deepEqual(detail.body.history.map(x=>x.event),receipt.kind==='complete'
      ?['intake_started','transaction_confirmed','handoff_created','handoff_accepted','intake_ended']
      :['intake_started','handoff_created','intake_ended']);
    assert.equal(detail.body.history.at(-1).outcome,receipt.kind==='complete'?'accepted':'routed');
    assert.equal(detail.body.history_has_more,false); assert.equal(detail.metrics.rows_written,1,'the first open stamps first_opened_at');
    assert.deepEqual(detail.body.model_reading,{mode:'off',model_version:null,llm_calls:0},'switch off locally: no model read the case');
    if(receipt.kind==='complete'){
      assert.equal(detail.body.verified_evidence.transaction.transaction_id,'demo-tx-001');
      assert.equal(detail.body.verified_evidence.transaction.amount,'125.50');
      assert.equal(detail.body.verified_evidence.transaction.currency,'BRL');
    }else{
      assert.equal(detail.body.verified_evidence.transaction,null); assert.deepEqual(detail.body.unresolved_questions,['matching_transaction','customer_confirmation']);
    }
    const again=await agent.call('/agent/intake-detail?protocol='+receipt.protocol);
    assert.deepEqual(again.body,detail.body,'a later read returns the same detail, first_opened_at included'); assert.equal(again.metrics.rows_written,0);
    measurements[receipt.kind]=detail.metrics;
  }
  assert.equal(queue.metrics.rows_written,0); console.log('D1_AGENT_INTAKES '+JSON.stringify(measurements));
  await closeReport(complete.protocol); // releases demo-tx-001 for later suites
});

test('agent handoff reads reject method path customer swaps forged tokens expiry and hostile protocols',async()=>{
  const c=client(); await c.call('/demo/session',{customer_id:'demo-ana'});
  const receipt=await report(c,false); const paths=['/agent/intakes','/agent/intake-detail?protocol='+receipt.protocol];
  for(const path of paths)for(const method of ['GET','HEAD','POST','PUT','DELETE','OPTIONS']){
    const response=await fetch(base+path,{method});
    assert.equal(response.status,method==='GET'?401:405); if(response.status===405)assert.equal(response.headers.get('Allow'),'GET');
  }
  for(const path of ['/agent/intakes/extra','/agent/intake-detail/extra'])assert.equal((await c.call(path)).status,404);
  for(const path of paths)assert.equal((await c.call(path)).status,401);
  const agent=client(); await agent.call('/demo/agent-session',{});
  const wrongRole=client(); wrongRole.cookie=agent.cookie.replace('demo_agent_session=','demo_session=');
  for(const path of paths)assert.equal((await wrongRole.call(path)).status,401);
  wrongRole.cookie=c.cookie.replace('demo_session=','demo_agent_session=');
  for(const path of paths)assert.equal((await wrongRole.call(path)).status,401);
  for(const token of ['f'.repeat(64),process.env.EXPIRED_TOKEN]){
    const denied=client(); denied.cookie=`demo_agent_session=${token}`; for(const path of paths)assert.equal((await denied.call(path)).status,401);
  }
  for(const query of ['', '?protocol=bad','?protocol=%27%20OR%201%3D1--','?protocol='+receipt.protocol+'&customer_id=demo-ana','?protocol='+receipt.protocol+'&protocol='+receipt.protocol]){
    const res=await agent.call('/agent/intake-detail'+query); assert.equal(res.status,422); assertContract('error',res.body);
  }
  const missing=await agent.call('/agent/intake-detail?protocol='+crypto.randomUUID()); assert.equal(missing.status,404); assertContract('error',missing.body);
  assert.equal(missing.metrics.rows_written,0,'an unknown protocol never stamps any report');
});
