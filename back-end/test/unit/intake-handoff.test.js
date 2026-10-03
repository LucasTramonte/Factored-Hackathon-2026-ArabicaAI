/** Terminal handoffs exercise real constraints and SQL; injected outages wrap only failed I/O. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createStore } from '../../src/store/d1.js';
import { route } from '../../src/router.js';
import { tokenHash } from '../../src/auth/session.js';
import { assertContract } from '../support/contract.js';
import { close as closeReport } from '../support/close.js';
const env = {};
const token = 'a'.repeat(64);
const post = (path, body) => new Request('https://demo.example' + path, { method: 'POST',
  headers: { Cookie: `demo_session=${token}` }, body: JSON.stringify(body) });
async function setup(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.exec("INSERT INTO customers(customer_id,display_name) VALUES('ana','Ana'),('bruno','Bruno'); INSERT INTO transactions VALUES('tx-ana','ana',NULL,'2026-06-17 12:00:00','Shop','10.00','ARS'),('tx-bruno','bruno',NULL,'2026-06-17 12:00:00','Other','20.00','ARS')");
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(await tokenHash(token), 'customer', 'ana', Date.now() + 3600000);
  const store = createStore({ prepare: sql => ({ bind: (...p) => ({ all: () => ({ results: db.prepare(sql).all(...p) }) }) }),
    batch: async statements => { db.exec('BEGIN'); try { const results = statements.map(s => s.all()); db.exec('COMMIT'); return results; } catch(e) { db.exec('ROLLBACK'); throw e; } } });
  const start = async () => { const res = await route(post('/intake/start', { language:'es',mode:'guided',report_type:'unrecognized_charge',reason:'not_mine',customer_statement:'No reconozco este cargo.',idempotency_key:crypto.randomUUID() }),env,store); assert.equal(res.status,201); return (await res.json()).episode_id; };
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
    const recovered=await route(post('/intake/confirm',body),env,store);assert.equal(recovered.status,200);const replayed=await recovered.json();assert.equal(replayed.replayed,true);
    assert.equal(db.prepare('SELECT handoff_id FROM intake_handoffs WHERE episode_id=?').get(episode).handoff_id,reserved);
    assert.equal(events(db).filter(e=>e.case_id===episode&&e.event==='intake_ended').length,1);
    await closeReport(store,replayed.protocol);
  }
  const terminal=db.prepare('SELECT episode_id FROM intake_handoffs LIMIT 1').get().episode_id;
  const key=db.prepare('SELECT turn_key FROM intake_handoffs WHERE episode_id=?').get(terminal).turn_key;
  const saved=events(db);
  const revokedReplay={...store,readIntakeReceipt:async(...args)=>{const receipt=await store.readIntakeReceipt(...args);db.exec('DELETE FROM sessions');return receipt;}};
  assert.equal((await route(post('/intake/confirm',{...confirm(terminal),idempotency_key:key}),env,revokedReplay)).status,401);
  assert.deepEqual(events(db),saved,'terminal replay never changes the chain');
});

test('a refused reservation answers from a fresh read and records the attempt', async t => {
  const {db,store,start}=await setup(t);
  const usage = id => JSON.parse(db.prepare('SELECT usage_json FROM intake_episodes WHERE episode_id=?').get(id).usage_json).tool_calls;
  // Session expires in SQL between the live check and the reservation.
  let episode=await start();
  const expiring={...store,persistIntakeHandoff:async args=>{db.exec("UPDATE sessions SET expires_at=1 WHERE actor='customer'");return store.persistIntakeHandoff(args);}};
  let res=await route(post('/intake/handoff',{episode_id:episode,kind:'incomplete',idempotency_key:crypto.randomUUID()}),env,expiring);
  assert.equal(res.status,401);assert.match((await res.json()).detail,/Session expired/);assert.equal(usage(episode),2,'start plus the refused persistence');
  assert.equal(db.prepare('SELECT count(*) n FROM intake_handoffs').get().n,0);
  db.prepare('UPDATE sessions SET expires_at=?').run(Date.now()+3600000);
  // A sweep closes the episode between the route's state check and the reservation.
  episode=await start(); db.prepare('UPDATE intake_episodes SET updated_at=updated_at-700000 WHERE episode_id=?').run(episode);
  const racing={...store,findOwnedTransaction:async(...a)=>{const tx=await store.findOwnedTransaction(...a);await store.closeIdleIntakes({now:Date.now(),limit:100});return tx;}};
  const body=confirm(episode);
  res=await route(post('/intake/confirm',body),env,racing);
  assert.equal(res.status,409);assert.equal((await res.json()).detail,'Episode is no longer open');
  assert.equal((await route(post('/intake/confirm',body),env,store)).status,409,'the same-key retry agrees');
  // The owned transaction vanishes between the lookup and the reservation: acceptance stays unknown.
  episode=await start();
  const vanishing={...store,findOwnedTransaction:async(...a)=>{const tx=await store.findOwnedTransaction(...a);db.prepare('DELETE FROM transactions WHERE transaction_id=?').run('tx-ana');return tx;}};
  res=await route(post('/intake/confirm',confirm(episode)),env,vanishing);
  assert.equal(res.status,503);assert.equal((await res.json()).protocol,undefined);assert.equal(usage(episode),3,'start plus lookup and refused persistence');
  assert.equal(db.prepare('SELECT count(*) n FROM cases').get().n,0);
  // A failing re-read never promises a receipt either.
  episode=await start(); let refused=false;
  const blind={...store,persistIntakeHandoff:async()=>{refused=true;return {handoff:null,replayed:false};},
    findIntake:async(...a)=>{if(refused)throw new Error('down');return store.findIntake(...a);}};
  res=await route(post('/intake/handoff',{episode_id:episode,kind:'incomplete',idempotency_key:crypto.randomUUID()}),env,blind);
  assert.equal(res.status,503);assert.equal((await res.json()).protocol,undefined);
});

test('receipt reports the read-back checks and open questions for every kind', async t => {
  const { store, start } = await setup(t);
  const complete = await (await route(post('/intake/confirm', confirm(await start())), env, store)).json();
  assertContract('intakeReceipt', complete);
  assert.deepEqual([complete.actions_taken, complete.unresolved_questions], [['owned_transaction_retrieved','customer_confirmation_recorded'], []]);
  const incomplete = await (await route(post('/intake/handoff', { episode_id: await start(), kind: 'incomplete', idempotency_key: crypto.randomUUID() }), env, store)).json();
  assert.deepEqual([incomplete.actions_taken, incomplete.unresolved_questions], [[], ['matching_transaction','customer_confirmation']]);
  const failing = { ...store, findOwnedTransaction: async () => { throw new Error('unavailable'); } };
  const technical = await (await route(post('/intake/confirm', confirm(await start())), env, failing)).json();
  assert.equal(technical.kind, 'technical');
  assert.deepEqual([technical.actions_taken, technical.unresolved_questions], [['transaction_lookup_failed'], ['matching_transaction','customer_confirmation']]);
});

test('incomplete handoff details are appended once to the statement, hashed into the key, and bounded with it', async t => {
  const { db, store, start } = await setup(t);
  const statement = episode => db.prepare('SELECT customer_statement s, state FROM intake_episodes WHERE episode_id=?').get(episode);
  const episode = await start(); const details = 'Unos 50 euros el martes, en una tienda de ropa.';
  const body = { episode_id: episode, kind: 'incomplete', idempotency_key: crypto.randomUUID(), details: `  ${details}  ` };
  const res = await route(post('/intake/handoff', body), env, store); assert.equal(res.status, 201); const receipt = await res.json(); assertContract('intakeReceipt', receipt);
  assert.equal(receipt.kind, 'incomplete'); assert.equal(statement(episode).s, 'No reconozco este cargo.\n' + details);
  assert.deepEqual(await (await route(post('/intake/handoff', body), env, store)).json(), { ...receipt, replayed: true });
  assert.equal(statement(episode).s, 'No reconozco este cargo.\n' + details, 'a replay appends nothing');
  assert.equal((await route(post('/intake/handoff', { ...body, details: 'Otra cosa distinta, no lo mismo.' }), env, store)).status, 409, 'same key, other details');
  assert.equal((await route(post('/intake/handoff', { episode_id: episode, kind: 'incomplete', idempotency_key: body.idempotency_key }), env, store)).status, 409, 'same key, details dropped');
  // Hostile or malformed details never reach SQL: wrong type, too short, too long, U+0000, lone surrogate, an extra field, details on a confirmation.
  const open = await start();
  for (const bad of [{ details: 7 }, { details: 'corto' }, { details: 'x'.repeat(2001) }, { details: 'tiene un nulo \u0000 dentro' }, { details: 'mal formado \ud800 aquí' }, { details, extra: 1 }]) {
    assert.equal((await route(post('/intake/handoff', { episode_id: open, kind: 'incomplete', idempotency_key: crypto.randomUUID(), ...bad }), env, store)).status, 422, JSON.stringify(bad).slice(0, 30));
  }
  assert.equal((await route(post('/intake/confirm', { ...confirm(open), details }), env, store)).status, 422);
  assert.equal(statement(open).state, 'selection_required', 'rejections leave the episode open');
  // Details that would push the statement past 2000 code points are refused before the write; the episode stays open for a shorter answer.
  const overflow = await route(post('/intake/handoff', { episode_id: open, kind: 'incomplete', idempotency_key: crypto.randomUUID(), details: '😀'.repeat(1990) }), env, store);
  assert.equal(overflow.status, 422); assert.equal(statement(open).state, 'selection_required');
  assert.equal((await route(post('/intake/handoff', { episode_id: open, kind: 'incomplete', idempotency_key: crypto.randomUUID(), details: '😀'.repeat(1975) }), env, store)).status, 201);
  assert.equal([...statement(open).s].length, 2000);
  assert.deepEqual(events(db).filter(e => e.case_id === open).map(e => e.event), ['intake_started', 'handoff_created', 'intake_ended']);
});

test('two episodes confirming the same charge at once open one report; the loser is 409 and writes no case', async t => {
  const { db,store,start }=await setup(t);
  const [a,b]=[await start(),await start()];
  // Both requests pass the fast pre-check before either batch runs, which is the race the batch condition closes.
  const responses=await Promise.all([confirm(a),confirm(b)].map(body=>route(post('/intake/confirm',body),env,store)));
  assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);
  const loser=await responses.find(r=>r.status===409).json();
  assertContract('error',loser); assert.equal(loser.detail,'This charge already has an open report');
  assert.equal(db.prepare('SELECT count(*) n FROM cases').get().n,1);
  assert.equal(db.prepare("SELECT count(*) n FROM intake_handoffs WHERE kind='complete'").get().n,1);
  const open=db.prepare("SELECT state FROM intake_episodes WHERE episode_id IN (?,?) ORDER BY state").all(a,b).map(r=>r.state);
  assert.deepEqual(open,['complete_handoff','selection_required'],'the loser stays open, so the customer can still hand it off');
});

test('a pending reservation (lost acknowledgement) also blocks a second report on its charge', async t => {
  const { db,store,start }=await setup(t);
  const first=await start(); assert.equal((await route(post('/intake/confirm',confirm(first)),env,store)).status,201);
  db.prepare("UPDATE intake_episodes SET state='handoff_pending' WHERE episode_id=?").run(first);
  const second=await route(post('/intake/confirm',confirm(await start())),env,store);
  assert.equal(second.status,409); assert.equal((await second.json()).detail,'This charge already has an open report');
  assert.equal(db.prepare('SELECT count(*) n FROM cases').get().n,1);
});

test('expired pending confirmations release the charge and cannot acknowledge after a new report', async t => {
  const { db, store, start } = await setup(t);
  const episodeId = await start(); const body = confirm(episodeId);
  const failedRead = { ...store, readIntakeReceipt: async () => { throw new Error('readback down'); } };
  assert.equal((await route(post('/intake/confirm', body), env, failedRead)).status, 503);
  const cutoff = Date.now() - 3600000;
  db.prepare('UPDATE intake_handoffs SET accepted_at=? WHERE episode_id=?').run(new Date(cutoff).toISOString(), episodeId);
  assert.equal(await store.openReportForTransaction('ana', 'tx-ana', cutoff + 3600000), null, 'the exact one-hour boundary is expired');
  const episode = await store.findIntake('ana', episodeId);
  const receipt = await store.readIntakeReceipt('ana', episodeId, { sessionHash: await tokenHash(token), now: Date.now() });
  const replacement = await route(post('/intake/confirm', confirm(await start())), env, store);
  assert.equal(replacement.status, 201, 'an expired pending reservation does not block a fresh report');
  const before = db.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual(await store.finishIntakeHandoff({ customerId: 'ana', episode, receipt, sessionHash: await tokenHash(token),
    now: Date.now(), operationDuration: 0, toolCalls: 0 }), { acknowledged: false, emailId: null }, 'the SQL batch refuses a stale acknowledgement');
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before, 'expired acknowledgement writes nothing');
  const retry = await route(post('/intake/confirm', body), env, store);
  assert.equal(retry.status, 409); assert.equal((await retry.json()).detail, 'Reservation expired; start a new report');
  assert.equal((await store.findIntake('ana', episodeId)).state, 'handoff_pending', 'reservation retained for audit and denominator');
  assert.deepEqual(events(db).filter(e => e.case_id === episodeId).map(e => e.event), ['intake_started']);
  assert.equal(db.prepare("SELECT count(*) n FROM intake_episodes WHERE state='complete_handoff'").get().n, 1);
});

test('acknowledged reports never expire at the pending cutoff and their receipts still replay', async t => {
  const { db, store, start } = await setup(t); const body = confirm(await start());
  const first = await route(post('/intake/confirm', body), env, store); assert.equal(first.status, 201);
  db.prepare('UPDATE intake_handoffs SET accepted_at=?').run(new Date(Date.now() - 7200000).toISOString());
  assert.ok(await store.openReportForTransaction('ana', 'tx-ana'));
  assert.equal((await route(post('/intake/confirm', confirm(await start())), env, store)).status, 409);
  assert.equal((await route(post('/intake/confirm', body), env, store)).status, 200);
});

test('a delayed pre-expiry acknowledgement stays superseded after its replacement is reserved, accepted or closed', async t => {
  const { db, store, start } = await setup(t);
  const failedRead = { ...store, readIntakeReceipt: async () => { throw new Error('readback down'); } };
  const firstEpisode = await start(); const firstBody = confirm(firstEpisode);
  assert.equal((await route(post('/intake/confirm', firstBody), env, failedRead)).status, 503);
  const accepted = Date.now() - 3600000 - 100;
  db.prepare('UPDATE intake_handoffs SET accepted_at=? WHERE episode_id=?').run(new Date(accepted).toISOString(), firstEpisode);
  // This request captured its clock before expiry, then its D1 batch was delayed behind the replacement.
  const oldNow = accepted + 3600000 - 1, sessionHash = await tokenHash(token);
  const episode = await store.findIntake('ana', firstEpisode);
  const receipt = await store.readIntakeReceipt('ana', firstEpisode, { sessionHash, now: oldNow });
  const replacementEpisode = await start(); const replacementBody = confirm(replacementEpisode);
  assert.equal((await route(post('/intake/confirm', replacementBody), env, failedRead)).status, 503);
  const refuseOld = async label => {
    const before = db.prepare('SELECT total_changes() n').get().n;
    assert.deepEqual(await store.finishIntakeHandoff({ customerId: 'ana', episode, receipt, sessionHash,
      now: oldNow, operationDuration: 0, toolCalls: 0 }), { acknowledged: false, emailId: null }, label);
    assert.equal(db.prepare('SELECT total_changes() n').get().n, before, 'refused delayed acknowledgement writes nothing');
    assert.equal((await store.findIntake('ana', firstEpisode)).state, 'handoff_pending');
    assert.deepEqual(events(db).filter(e => e.case_id === firstEpisode).map(e => e.event), ['intake_started']);
  };
  await refuseOld('a newer pending reservation supersedes the old one');
  const replacement = await route(post('/intake/confirm', replacementBody), env, store);
  assert.equal(replacement.status, 200); const nextReceipt = await replacement.json();
  await refuseOld('a newer accepted report supersedes the old one');
  await closeReport(store, nextReceipt.protocol);
  await refuseOld('closing the replacement never resurrects the superseded reservation');
  assert.equal((await route(post('/intake/confirm', replacementBody), env, store)).status, 200, 'the acknowledged replacement still replays');
  assert.equal((await route(post('/intake/confirm', firstBody), env, store)).status, 409, 'the old customer retry explains expiration');
});
