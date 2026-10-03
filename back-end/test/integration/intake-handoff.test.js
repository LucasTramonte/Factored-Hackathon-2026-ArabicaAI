/** Real D1 handoff races, ownership, strict contracts and measured budgets. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client,base,closeReport } from '../support/client.js';
import { assertContract } from '../support/contract.js';
async function customer(id='demo-ana') { const c=client();assert.equal((await c.call('/demo/session',{customer_id:id})).status,200);return c; }
async function start(c) { const r=await c.call('/intake/start',{language:'pt',mode:'guided',report_type:'unrecognized_charge',reason:'not_mine',customer_statement:'Não reconheço esta cobrança.',idempotency_key:crypto.randomUUID()});assert.equal(r.status,201);return r.body.episode_id; }

test('confirmed_case_and_handoff_chain_commit_once on real local D1',async()=>{
 const ana=await customer();const episode_id=await start(ana);const body={episode_id,transaction_id:'demo-tx-001',customer_confirmed:true,idempotency_key:crypto.randomUUID()};
 const results=await Promise.all(Array.from({length:10},()=>fetch(base+'/intake/confirm',{method:'POST',headers:{Cookie:ana.cookie,'Content-Type':'application/json'},body:JSON.stringify(body)}).then(async r=>({status:r.status,body:await r.json()}))));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,200,200,200,200,200,200,200,200,201]);assert.equal(new Set(results.map(r=>r.body.protocol)).size,1);for(const r of results)assertContract('intakeReceipt',r.body);
 const replay=await ana.call('/intake/confirm',body);assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assertContract('intakeReceipt',replay.body);console.log('D1_INTAKE_CONFIRM_REPLAY '+JSON.stringify(replay.metrics));
 for(const change of [{idempotency_key:crypto.randomUUID()},{transaction_id:'demo-tx-003'}])assert.equal((await ana.call('/intake/confirm',{...body,...change})).status,409);
 const bruno=await customer('demo-bruno');assert.equal((await bruno.call('/intake/confirm',body)).status,404);const own=await start(bruno);assert.equal((await bruno.call('/intake/confirm',{...body,episode_id:own})).status,404);
 await closeReport(replay.body.protocol);
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
 const expected=path.endsWith('/extra')?404:method==='POST'?401:405;for(const headers of [{},{Authorization:'Basic eDp5'}])assert.equal((await fetch(base+path,{method,headers})).status,expected,`${method} ${path} (no team gate on customer paths)`);}
 const agent=client();await agent.call('/demo/agent-session',{});agent.cookie=agent.cookie.replace('demo_agent_session=','demo_session=');assert.equal((await agent.call('/intake/handoff',{})).status,401);
 for(const token of ['f'.repeat(64),process.env.EXPIRED_TOKEN]){const c=client();c.cookie=`demo_session=${token}`;assert.equal((await c.call('/intake/confirm',{})).status,401);}
 const ana=await customer();for(const invalid of ['{bad','[]','null',{},'x'.repeat(20000)])assert.equal((await ana.call('/intake/confirm',invalid)).status,typeof invalid==='string'&&invalid.length>16000?413:422);
});

test('complete handoff measures its own D1 work preserving legacy ceilings',async()=>{
 const ana=await customer();const episode_id=await start(ana);const r=await ana.call('/intake/confirm',{episode_id,transaction_id:'demo-tx-001',customer_confirmed:true,idempotency_key:crypto.randomUUID()});assert.equal(r.status,201);assertContract('intakeReceipt',r.body);assert.ok(r.metrics);console.log('D1_INTAKE_CONFIRM '+JSON.stringify(r.metrics));await closeReport(r.body.protocol);
});

test('terminal receipt replay still requires live same-owner authority after session rotation',async()=>{
 const ana=await customer();const episode_id=await start(ana);const body={episode_id,transaction_id:'demo-tx-001',customer_confirmed:true,idempotency_key:crypto.randomUUID()};
 const original=await ana.call('/intake/confirm',body);assert.equal(original.status,201);assertContract('intakeReceipt',original.body);
 const revoked=client();revoked.cookie=ana.cookie;
 assert.equal((await ana.call('/demo/session',{customer_id:'demo-ana'})).status,200);
 const denied=await revoked.call('/intake/confirm',body);assert.equal(denied.status,401);assert.equal(denied.body.protocol,undefined);
 const replay=await ana.call('/intake/confirm',body);assert.equal(replay.status,200);assert.deepEqual(replay.body,{...original.body,replayed:true});
 const bruno=await customer('demo-bruno');const foreign=await bruno.call('/intake/confirm',body);assert.equal(foreign.status,404);assert.equal(foreign.body.protocol,undefined);
 await closeReport(original.body.protocol);
});

test('incomplete handoff details reach the agent statement once on real D1, and only with the same key and content',async()=>{
 const ana=await customer();const episode_id=await start(ana);const details="Uns 50 reais na terça; a loja chamava 'Moda X'.";
 const body={episode_id,kind:'incomplete',idempotency_key:crypto.randomUUID(),details};
 const accepted=await ana.call('/intake/handoff',body);assert.equal(accepted.status,201);assertContract('intakeReceipt',accepted.body);assert.equal(accepted.body.kind,'incomplete');console.log('D1_INTAKE_INCOMPLETE_DETAILS '+JSON.stringify(accepted.metrics));
 const replay=await ana.call('/intake/handoff',body);assert.equal(replay.status,200);assert.deepEqual(replay.body,{...accepted.body,replayed:true});
 assert.equal((await ana.call('/intake/handoff',{...body,details:'Outra coisa completamente diferente.'})).status,409);
 assert.equal((await ana.call('/intake/handoff',{episode_id,kind:'incomplete',idempotency_key:body.idempotency_key})).status,409);
 const agent=client();await agent.call('/demo/agent-session',{});const detail=await agent.call('/agent/intake-detail?protocol='+accepted.body.protocol);
 assert.equal(detail.status,200);assertContract('agentIntakeDetail',detail.body);assert.equal(detail.body.customer_statement,'Não reconheço esta cobrança.\n'+details);
 const bruno=await customer('demo-bruno');assert.equal((await bruno.call('/intake/handoff',{...body,idempotency_key:crypto.randomUUID()})).status,404);
 const fresh=await start(ana);for(const bad of [{details:'curto'},{details:'x'.repeat(2001)},{details:'nulo \u0000 aqui'},{details:7}])assert.equal((await ana.call('/intake/handoff',{episode_id:fresh,kind:'incomplete',idempotency_key:crypto.randomUUID(),...bad})).status,422);
 assert.equal((await ana.call('/intake/handoff',{episode_id:fresh,kind:'incomplete',idempotency_key:crypto.randomUUID()})).status,201,'the episode stayed open');
});

test('one open report per charge: a second confirm is refused until a person closes the first; replay still answers',async()=>{
 const ana=await customer();const body={episode_id:await start(ana),transaction_id:'demo-tx-004',customer_confirmed:true,idempotency_key:crypto.randomUUID()};
 const first=await ana.call('/intake/confirm',body);assert.equal(first.status,201);
 const again=await ana.call('/intake/confirm',{...body,episode_id:await start(ana),idempotency_key:crypto.randomUUID()});
 assert.equal(again.status,409);assertContract('error',again.body);assert.equal(again.body.detail,'This charge already has an open report');
 const replay=await ana.call('/intake/confirm',body);assert.equal(replay.status,200);assert.deepEqual(replay.body,{...first.body,replayed:true});
 await closeReport(first.body.protocol);
 const reopened=await ana.call('/intake/confirm',{...body,episode_id:await start(ana),idempotency_key:crypto.randomUUID()});
 assert.equal(reopened.status,201);assert.notEqual(reopened.body.protocol,first.body.protocol);await closeReport(reopened.body.protocol);
});
