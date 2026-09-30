/** Real D1 handoff races, ownership, strict contracts and measured budgets. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client,base,auth } from '../support/client.js';
import { assertContract } from '../support/contract.js';
async function customer(id='demo-ana') { const c=client();assert.equal((await c.call('/demo/session',{customer_id:id})).status,200);return c; }
async function start(c) { const r=await c.call('/intake/start',{language:'pt',mode:'guided',report_type:'unrecognized_charge',customer_statement:'Não reconheço esta cobrança.',idempotency_key:crypto.randomUUID()});assert.equal(r.status,201);return r.body.episode_id; }

test('confirmed_case_and_handoff_chain_commit_once on real local D1',async()=>{
 const ana=await customer();const episode_id=await start(ana);const body={episode_id,transaction_id:'demo-tx-001',customer_confirmed:true,idempotency_key:crypto.randomUUID()};
 const results=await Promise.all(Array.from({length:10},()=>fetch(base+'/intake/confirm',{method:'POST',headers:{Authorization:auth,Cookie:ana.cookie,'Content-Type':'application/json'},body:JSON.stringify(body)}).then(async r=>({status:r.status,body:await r.json()}))));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,200,200,200,200,200,200,200,200,201]);assert.equal(new Set(results.map(r=>r.body.protocol)).size,1);for(const r of results)assertContract('intakeReceipt',r.body);
 const replay=await ana.call('/intake/confirm',body);assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assertContract('intakeReceipt',replay.body);console.log('D1_INTAKE_CONFIRM_REPLAY '+JSON.stringify(replay.metrics));
 for(const change of [{idempotency_key:crypto.randomUUID()},{transaction_id:'demo-tx-003'}])assert.equal((await ana.call('/intake/confirm',{...body,...change})).status,409);
 const bruno=await customer('demo-bruno');assert.equal((await bruno.call('/intake/confirm',body)).status,404);const own=await start(bruno);assert.equal((await bruno.call('/intake/confirm',{...body,episode_id:own})).status,404);
});

test('terminal_incomplete_handoff_recovery_uses_new_episode on real D1',async()=>{
 const ana=await customer();const episode_id=await start(ana);const body={episode_id,kind:'incomplete',idempotency_key:crypto.randomUUID()};
 const accepted=await ana.call('/intake/handoff',body);assert.equal(accepted.status,201);assertContract('intakeReceipt',accepted.body);assert.equal(accepted.body.kind,'incomplete');console.log('D1_INTAKE_INCOMPLETE '+JSON.stringify(accepted.metrics));
 const replay=await ana.call('/intake/handoff',body);assert.equal(replay.status,200);assert.deepEqual(replay.body,{...accepted.body,replayed:true});
 assert.equal((await ana.call('/intake/confirm',{episode_id,transaction_id:'demo-tx-001',customer_confirmed:true,idempotency_key:crypto.randomUUID()})).status,409);assert.notEqual(await start(ana),episode_id);
 for(const change of [{kind:'technical'},{actions_taken:['refund']},{customer_id:'demo-bruno'}])assert.equal((await ana.call('/intake/handoff',{...body,...change})).status,422);
});

test('handoff endpoints gate methods paths roles expiry and malformed bodies',async()=>{
 for(const path of ['/intake/confirm','/intake/handoff','/intake/confirm/extra','/intake/handoff/extra'])for(const method of ['GET','POST','HEAD','OPTIONS','PUT','DELETE']){
 assert.equal((await fetch(base+path,{method})).status,401);assert.equal((await fetch(base+path,{method,headers:{Authorization:auth}})).status,path.endsWith('/extra')?404:method==='POST'?401:405);}
 const agent=client();await agent.call('/demo/agent-session',{});agent.cookie=agent.cookie.replace('demo_agent_session=','demo_session=');assert.equal((await agent.call('/intake/handoff',{})).status,401);
 for(const token of ['f'.repeat(64),process.env.EXPIRED_TOKEN]){const c=client();c.cookie=`demo_session=${token}`;assert.equal((await c.call('/intake/confirm',{})).status,401);}
 const ana=await customer();for(const invalid of ['{bad','[]','null',{},'x'.repeat(20000)])assert.equal((await ana.call('/intake/confirm',invalid)).status,typeof invalid==='string'&&invalid.length>16000?413:422);
});

test('complete handoff measures its own D1 work preserving legacy ceilings',async()=>{
 const ana=await customer();const episode_id=await start(ana);const r=await ana.call('/intake/confirm',{episode_id,transaction_id:'demo-tx-001',customer_confirmed:true,idempotency_key:crypto.randomUUID()});assert.equal(r.status,201);assertContract('intakeReceipt',r.body);assert.ok(r.metrics);console.log('D1_INTAKE_CONFIRM '+JSON.stringify(r.metrics));
});

test('terminal receipt replay still requires live same-owner authority after session rotation',async()=>{
 const ana=await customer();const episode_id=await start(ana);const body={episode_id,transaction_id:'demo-tx-001',customer_confirmed:true,idempotency_key:crypto.randomUUID()};
 const original=await ana.call('/intake/confirm',body);assert.equal(original.status,201);assertContract('intakeReceipt',original.body);
 const revoked=client();revoked.cookie=ana.cookie;
 assert.equal((await ana.call('/demo/session',{customer_id:'demo-ana'})).status,200);
 const denied=await revoked.call('/intake/confirm',body);assert.equal(denied.status,401);assert.equal(denied.body.protocol,undefined);
 const replay=await ana.call('/intake/confirm',body);assert.equal(replay.status,200);assert.deepEqual(replay.body,{...original.body,replayed:true});
 const bruno=await customer('demo-bruno');const foreign=await bruno.call('/intake/confirm',body);assert.equal(foreign.status,404);assert.equal(foreign.body.protocol,undefined);
});
