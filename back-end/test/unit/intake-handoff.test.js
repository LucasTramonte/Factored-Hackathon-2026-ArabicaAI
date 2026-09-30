/** Terminal handoffs exercise real constraints and SQL; injected outages wrap only failed I/O. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createStore } from '../../src/store/d1.js';
import { route } from '../../src/router.js';
import { tokenHash } from '../../src/auth/session.js';
import { assertContract } from '../support/contract.js';
const env = { DEMO_ACCESS_USERNAME: 'u', DEMO_ACCESS_PASSWORD: 'p' };
const token = 'a'.repeat(64);
const post = (path, body) => new Request('https://demo.example' + path, { method: 'POST',
  headers: { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64'), Cookie: `demo_session=${token}` }, body: JSON.stringify(body) });
async function setup(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.exec("INSERT INTO customers VALUES('ana','Ana'),('bruno','Bruno'); INSERT INTO transactions VALUES('tx-ana','ana',NULL,'2026-06-17 12:00:00','Shop','10.00','ARS'),('tx-bruno','bruno',NULL,'2026-06-17 12:00:00','Other','20.00','ARS')");
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(await tokenHash(token), 'customer', 'ana', Date.now() + 3600000);
  const store = createStore({ prepare: sql => ({ bind: (...p) => ({ all: () => ({ results: db.prepare(sql).all(...p) }) }) }),
    batch: async statements => { db.exec('BEGIN'); try { const results = statements.map(s => s.all()); db.exec('COMMIT'); return results; } catch(e) { db.exec('ROLLBACK'); throw e; } } });
  const start = async () => { const res = await route(post('/intake/start', { language:'es',mode:'guided',report_type:'unrecognized_charge',customer_statement:'No reconozco este cargo.',idempotency_key:crypto.randomUUID() }),env,store); assert.equal(res.status,201); return (await res.json()).episode_id; };
  return { db, store, start };
}
const confirm = episode_id => ({episode_id,transaction_id:'tx-ana',customer_confirmed:true,idempotency_key:crypto.randomUUID()});
const events = db => db.prepare('SELECT event_json FROM intake_events ORDER BY seq').all().map(r=>JSON.parse(r.event_json));

test('confirmed_case_and_handoff_chain_commit_once', async t => {
  const { db,store,start }=await setup(t); const episode=await start(); const body=confirm(episode);
  assert.equal((await route(post('/intake/confirm',{...body,transaction_id:'tx-bruno'}),env,store)).status,404);
  const responses=await Promise.all(Array.from({length:8},()=>route(post('/intake/confirm',body),env,store)));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,200,200,200,200,200,200,201]);
  const payloads=await Promise.all(responses.map(r=>r.json()));
  for(const receipt of payloads) assertContract('intakeReceipt',receipt);
  assert.equal(new Set(payloads.map(r=>r.protocol)).size,1);
  assert.equal(db.prepare('SELECT count(*) n FROM cases').get().n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM intake_handoffs').get().n,1);
  const chain=events(db); assert.deepEqual(chain.map(e=>e.event),['intake_started','transaction_confirmed','handoff_created','handoff_accepted','intake_ended']);
  assert.equal(chain.at(-1).safety,'not_assessed'); assert.equal(chain.at(-1).llm_calls,0);
  assert.ok(chain.at(-1).duration_ms>=0); assert.ok(chain.at(-1).tool_calls>0);
  assert.notEqual(chain[1].transaction_ref,'tx-ana');
  assert.equal(chain[1].transaction_ref,db.prepare('SELECT handoff_id FROM intake_handoffs').get().handoff_id,'opaque reference resolves to stored verified evidence');
  for(const change of [{idempotency_key:crypto.randomUUID()},{transaction_id:'tx-bruno'}]) assert.equal((await route(post('/intake/confirm',{...body,...change}),env,store)).status,409);
  assert.equal(events(db).length,5);
});

test('readback failure preserves pending original payload and retries its receipt',async t=>{
  const {db,store,start}=await setup(t);const episode=await start();const body=confirm(episode);
  const failed={...store,readIntakeReceipt:async()=>{throw new Error('readback down');}};
  for(let i=0;i<2;i++){const res=await route(post('/intake/confirm',body),env,failed);assert.equal(res.status,503);assert.equal((await res.json()).protocol,undefined);}
  assert.equal(events(db).length,1);
  assert.equal((await route(post('/intake/handoff',{episode_id:episode,kind:'incomplete',idempotency_key:crypto.randomUUID()}),env,store)).status,409);
  const res=await route(post('/intake/confirm',body),env,store);assert.equal(res.status,200);assert.equal((await res.json()).replayed,true);
  assert.equal(db.prepare('SELECT count(*) n FROM cases').get().n,1);assert.equal(events(db).length,5);
});

test('terminal_incomplete_handoff_recovery_uses_new_episode',async t=>{
  const {db,store,start}=await setup(t);const episode=await start();const body={episode_id:episode,kind:'incomplete',idempotency_key:crypto.randomUUID()};
  const res=await route(post('/intake/handoff',body),env,store);assert.equal(res.status,201);const receipt=await res.json();assertContract('intakeReceipt',receipt);
  assert.deepEqual(events(db).map(e=>e.event),['intake_started','handoff_created','intake_ended']);assert.equal(events(db).at(-1).outcome,'routed');
  assert.equal(db.prepare('SELECT count(*) n FROM cases').get().n,0);
  assert.equal(db.prepare('SELECT complete_case_id FROM intake_handoffs').get().complete_case_id,null);
  assert.deepEqual(await (await route(post('/intake/handoff',body),env,store)).json(),{...receipt,replayed:true});
  const original=events(db);const next=await start();assert.notEqual(next,episode);
  assert.deepEqual(events(db).filter(e=>e.case_id===episode),original);
  assert.equal((await route(post('/intake/confirm',confirm(episode)),env,store)).status,409);
});

test('handoff trust boundaries reject identity, forged failures and stale evidence',async t=>{
  const {db,store,start}=await setup(t);const episode=await start();const body=confirm(episode);
  for(const change of [{customer_id:'bruno'},{customer_confirmed:false},{actions:['refund']},{transaction_id:'x\u0000'},{episode_id:'bad'},{idempotency_key:'bad'}]) assert.equal((await route(post('/intake/confirm',{...body,...change}),env,store)).status,422);
  assert.equal((await route(post('/intake/confirm',{...body,episode_id:crypto.randomUUID()}),env,store)).status,404);
  assert.equal((await route(post('/intake/handoff',{episode_id:episode,kind:'technical',idempotency_key:crypto.randomUUID()}),env,store)).status,422);
  db.prepare('DELETE FROM transactions WHERE transaction_id=?').run('tx-ana');assert.equal((await route(post('/intake/confirm',body),env,store)).status,404);
  db.prepare('UPDATE sessions SET expires_at=1').run();assert.equal((await route(post('/intake/confirm',body),env,store)).status,401);
  assert.equal(events(db).length,1);
});

test('server lookup failure ends technical once and preserves failed-attempt tool usage',async t=>{
  const {db,store,start}=await setup(t);const episode=await start();const body=confirm(episode);
  const failing={...store,findOwnedTransaction:async()=>{throw new Error('unavailable');},readIntakeReceipt:async()=>{throw new Error('readback down');}};
  assert.equal((await route(post('/intake/confirm',body),env,failing)).status,503);
  const res=await route(post('/intake/confirm',body),env,store);assert.equal(res.status,200);assert.equal((await res.json()).kind,'technical');
  assert.equal(db.prepare('SELECT count(*) n FROM cases').get().n,0);
  assert.deepEqual(events(db).map(e=>e.event),['intake_started','handoff_created','intake_ended']);
  assert.equal(events(db).at(-1).outcome,'technical_failure');
  assert.equal(events(db).at(-1).tool_calls,7,'start; failed lookup+persist+readback; replay persist+readback+finalize');
  const saved=events(db);assert.equal((await route(post('/intake/confirm',body),env,store)).status,200);assert.deepEqual(events(db),saved);
});

test('session revoked during lookup cannot persist a case or handoff',async t=>{
  const {db,store,start}=await setup(t);const episode=await start();
  const revoke={...store,findOwnedTransaction:async(...args)=>{const tx=await store.findOwnedTransaction(...args);db.exec('DELETE FROM sessions');return tx;}};
  assert.equal((await route(post('/intake/confirm',confirm(episode)),env,revoke)).status,401);
  assert.equal(db.prepare('SELECT count(*) n FROM cases').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM intake_handoffs').get().n,0);
});

test('a consumed start key cannot become a handoff key',async t=>{
  const {db,store,start}=await setup(t);const episode=await start();const key=db.prepare('SELECT start_key FROM intake_episodes').get().start_key;
  assert.equal((await route(post('/intake/confirm',{...confirm(episode),idempotency_key:key}),env,store)).status,409);
  assert.equal(db.prepare('SELECT count(*) n FROM cases').get().n,0);
});

test('failed pre-insert persistence keeps owned episode attempt usage and elapsed time',async t=>{
  const {db,store,start}=await setup(t);const episode=await start();const body=confirm(episode);
  const failed={...store,persistIntakeHandoff:async()=>{await new Promise(done=>setTimeout(done,12));throw new Error('write failed before insert');}};
  const rejected=await route(post('/intake/confirm',body),env,failed);assert.equal(rejected.status,503);assert.equal((await rejected.json()).protocol,undefined);
  assert.equal(db.prepare('SELECT count(*) n FROM intake_handoffs').get().n,0);
  const usage=JSON.parse((await store.findIntake('ana',episode)).usage_json);assert.equal(usage.tool_calls,3,'initial start plus failed lookup/persist');assert.ok(usage.operation_duration_ms>=10);
  const recovered=await route(post('/intake/confirm',body),env,store);assert.equal(recovered.status,201);
  assert.equal(events(db).at(-1).tool_calls,7);
  const handoffUsage=JSON.parse(db.prepare('SELECT usage_json FROM intake_handoffs').get().usage_json);assert.ok(handoffUsage.operation_duration_ms>=usage.operation_duration_ms);
});

test('late session revocation or expiry preserves pending reservation until same-owner renewal',async t=>{
  const {db,store,start}=await setup(t);
  for(const pending of [false,true])for(const expiry of [false,true]){
    db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)').run(await tokenHash(token),'customer','ana',Date.now()+3600000);
    const episode=await start();const body=confirm(episode);
    if(pending)assert.equal((await route(post('/intake/confirm',body),env,{...store,readIntakeReceipt:async()=>{throw new Error('readback down');}})).status,503);
    const revoked={...store,readIntakeReceipt:async(...args)=>{const receipt=await store.readIntakeReceipt(...args);db.exec(expiry?'UPDATE sessions SET expires_at=1':'DELETE FROM sessions');return receipt;}};
    const res=await route(post('/intake/confirm',body),env,revoked);assert.equal(res.status,401);assert.equal((await res.json()).protocol,undefined);
    assert.equal((await store.findIntake('ana',episode)).state,'handoff_pending');
    assert.deepEqual(events(db).filter(e=>e.case_id===episode).map(e=>e.event),['intake_started']);
    const reserved=db.prepare('SELECT handoff_id FROM intake_handoffs WHERE episode_id=?').get(episode).handoff_id;
    db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)').run(await tokenHash(token),'customer','ana',Date.now()+3600000);
    const recovered=await route(post('/intake/confirm',body),env,store);assert.equal(recovered.status,200);assert.equal((await recovered.json()).replayed,true);
    assert.equal(db.prepare('SELECT handoff_id FROM intake_handoffs WHERE episode_id=?').get(episode).handoff_id,reserved);
    assert.equal(events(db).filter(e=>e.case_id===episode&&e.event==='intake_ended').length,1);
  }
  const terminal=db.prepare('SELECT episode_id FROM intake_handoffs LIMIT 1').get().episode_id;
  const key=db.prepare('SELECT turn_key FROM intake_handoffs WHERE episode_id=?').get(terminal).turn_key;
  const saved=events(db);
  const revokedReplay={...store,readIntakeReceipt:async(...args)=>{const receipt=await store.readIntakeReceipt(...args);db.exec('DELETE FROM sessions');return receipt;}};
  assert.equal((await route(post('/intake/confirm',{...confirm(terminal),idempotency_key:key}),env,revokedReplay)).status,401);
  assert.deepEqual(events(db),saved,'terminal replay never changes the chain');
});
