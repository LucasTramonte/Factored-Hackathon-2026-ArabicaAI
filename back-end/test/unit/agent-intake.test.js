/** Agent reads exercise persisted handoffs, optional ownership joins and actual events. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createStore } from '../../src/store/d1.js';
import { route } from '../../src/router.js';
import { tokenHash } from '../../src/auth/session.js';
import { assertContract } from '../support/contract.js';
const env = { DEMO_ACCESS_USERNAME: 'u', DEMO_ACCESS_PASSWORD: 'p' };
const auth = 'Basic ' + Buffer.from('u:p').toString('base64');
const customerToken = 'a'.repeat(64), agentToken = 'b'.repeat(64);
const request = (path, { method = 'GET', cookie = `demo_agent_session=${agentToken}`, authorization = auth, body } = {}) =>
  new Request('https://demo.example' + path, { method, headers: { Authorization: authorization, Cookie: cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function setup(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.exec("INSERT INTO customers(customer_id,display_name) VALUES('ana','Ana'),('bruno','Bruno'); INSERT INTO transactions VALUES('tx-ana','ana',NULL,'2026-06-17 12:00:00','Shop','10.00','ARS'),('tx-bruno','bruno',NULL,'2026-06-17 12:00:00','Other','20.00','ARS')");
  for (const [token, actor, owner] of [[customerToken,'customer','ana'],[agentToken,'agent',null]])
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(await tokenHash(token), actor, owner, Date.now() + 3600000);
  const store = createStore({ prepare: sql => ({ bind: (...p) => ({ all: () => ({ results: db.prepare(sql).all(...p) }) }) }),
    batch: async statements => { db.exec('BEGIN'); try { const results = statements.map(s => s.all()); db.exec('COMMIT'); return results; } catch(e) { db.exec('ROLLBACK'); throw e; } } });
  const customer = (path, body, selected = store) => route(request(path, { method:'POST', cookie:`demo_session=${customerToken}`, body }), env, selected);
  const start = async () => (await (await customer('/intake/start', { language:'pt', mode:'guided', report_type:'unrecognized_charge', customer_statement:'Não reconheço esta cobrança.', idempotency_key:crypto.randomUUID() })).json()).episode_id;
  const finish = async (kind = 'complete', selected = store) => {
    const episode_id = await start();
    const body = kind === 'incomplete' ? { episode_id, kind, idempotency_key:crypto.randomUUID() }
      : { episode_id, transaction_id:'tx-ana', customer_confirmed:true, idempotency_key:crypto.randomUUID() };
    const res = await customer(kind === 'incomplete' ? '/intake/handoff' : '/intake/confirm', body, selected);
    return { episode_id, body, response: res, receipt: await res.json() };
  };
  const get = path => route(request(path), env, store);
  return { db, store, start, finish, customer, get };
}

test('agent_detail_includes_incomplete_handoff_without_transaction', async t => {
  const { db, store, finish, get } = await setup(t);
  const complete = await finish(), incomplete = await finish('incomplete');
  const saved = db.prepare('SELECT * FROM intake_events ORDER BY episode_id,seq').all();
  const usage = db.prepare('SELECT usage_json FROM intake_handoffs ORDER BY handoff_id').all();
  // The node:sqlite stand-in reports no D1 meta, so count writes with SQLite's own connection counter.
  const changes = () => db.prepare('SELECT total_changes() AS n').get().n;
  const writesBefore = changes();
  const queue = await get('/agent/intakes'); assert.equal(queue.status,200); const list = await queue.json();
  assertContract('agentIntakeList',list); assert.deepEqual(new Set(list.items.map(x=>x.kind)),new Set(['complete','incomplete']));
  assert.ok(list.items.every(x=>!('customer_statement' in x)));
  const detail = await get('/agent/intake-detail?protocol=' + incomplete.receipt.protocol); assert.equal(detail.status,200);
  const upper = await get('/agent/intake-detail?protocol=' + incomplete.receipt.protocol.toUpperCase());
  assert.equal(upper.status,200,'protocol lookup is case-insensitive');
  const body = await detail.json(); assertContract('agentIntakeDetail',body);
  assert.equal(body.customer_statement,'Não reconheço esta cobrança.'); assert.equal(body.verified_evidence.transaction,null);
  assert.deepEqual(body.unresolved_questions,['matching_transaction','customer_confirmation']); assert.deepEqual(body.actions_taken,[]);
  assert.equal(body.destination,'case_service'); assert.equal(body.priority,'normal'); assert.equal(body.language,'pt');
  assert.deepEqual(body.history.map(x=>x.event),['intake_started','handoff_created','intake_ended']);
  assert.equal(body.history.at(-1).outcome,'routed'); assert.deepEqual(body.history.map(x=>x.seq),[0,1,2]);
  const full = await (await get('/agent/intake-detail?protocol=' + complete.receipt.protocol)).json(); assertContract('agentIntakeDetail',full);
  assert.deepEqual(full.verified_evidence.transaction,{transaction_id:'tx-ana',occurred_at:null,source_occurred_at:'2026-06-17 12:00:00',merchant_name:'Shop',amount:'10.00',currency:'ARS'});
  assert.deepEqual(full.actions_taken,['owned_transaction_retrieved','customer_confirmation_recorded']);
  assert.deepEqual(full.history.map(x=>x.event),['intake_started','transaction_confirmed','handoff_created','handoff_accepted','intake_ended']);
  assert.equal(full.history.at(-1).outcome,'accepted');
  assert.deepEqual(db.prepare('SELECT * FROM intake_events ORDER BY episode_id,seq').all(),saved);
  assert.deepEqual(db.prepare('SELECT usage_json FROM intake_handoffs ORDER BY handoff_id').all(),usage);
  assert.equal(changes(),writesBefore,'agent reads write nothing');
  for (const bad of [{...body,extra:'leak'},{...body,verified_evidence:{...body.verified_evidence,customer_id:'ana'}},
    {...body,history:[{...body.history[0],customer_statement:'leak'}]}]) assert.throws(()=>assertContract('agentIntakeDetail',bad),/violated/);
  assert.throws(()=>assertContract('agentIntakeList',{...list,items:[{...list.items[0],customer_statement:'leak'}]}),/violated/);
});

test('agent reads exclude pending reservations and preserve technical terminal history', async t => {
  const { db,store,finish,get } = await setup(t);
  const pending = await finish('complete',{...store,readIntakeReceipt:async()=>{throw new Error('readback unavailable');}});
  assert.equal(pending.response.status,503);
  const protocol = db.prepare('SELECT complete_case_id FROM intake_handoffs WHERE episode_id=?').get(pending.episode_id).complete_case_id;
  assert.equal((await get('/agent/intake-detail?protocol='+protocol)).status,404);
  assert.deepEqual((await (await get('/agent/intakes')).json()).items,[]);
  const technical = await finish('complete',{...store,findOwnedTransaction:async()=>{throw new Error('lookup unavailable');}});
  const detail = await (await get('/agent/intake-detail?protocol='+technical.receipt.protocol)).json(); assertContract('agentIntakeDetail',detail);
  assert.equal(detail.kind,'technical'); assert.equal(detail.tool_status,'failed'); assert.equal(detail.verified_evidence.transaction,null);
  assert.deepEqual(detail.actions_taken,['transaction_lookup_failed']); assert.equal(detail.history.at(-1).outcome,'technical_failure');
  assert.deepEqual(detail.history.map(x=>x.event),['intake_started','handoff_created','intake_ended']);
  const row = db.prepare('SELECT event_json FROM intake_events WHERE episode_id=? AND seq=0').get(technical.episode_id);
  db.prepare('UPDATE intake_events SET event_json=? WHERE episode_id=? AND seq=0').run(JSON.stringify({...JSON.parse(row.event_json),customer_statement:'Never expose in history'}),technical.episode_id);
  const safe = await (await get('/agent/intake-detail?protocol='+technical.receipt.protocol)).json(); assertContract('agentIntakeDetail',safe);
  assert.equal(safe.history[0].customer_statement,undefined);
});

test('optional complete evidence requires case and transaction owner agreement without dropping handoff', async t => {
  const { db,finish,get } = await setup(t); const complete = await finish();
  db.exec('PRAGMA foreign_keys=OFF'); db.prepare('UPDATE transactions SET customer_id=? WHERE transaction_id=?').run('bruno','tx-ana');
  const detail = await (await get('/agent/intake-detail?protocol='+complete.receipt.protocol)).json(); assertContract('agentIntakeDetail',detail);
  assert.equal(detail.verified_evidence.transaction,null); assert.equal(detail.kind,'complete');
  db.prepare('UPDATE cases SET customer_id=?,transaction_id=? WHERE case_id=?').run('bruno','tx-bruno',complete.receipt.protocol);
  assert.equal((await (await get('/agent/intake-detail?protocol='+complete.receipt.protocol)).json()).verified_evidence.transaction,null);
  assert.equal((await (await get('/agent/intakes')).json()).items.length,1);
});

test('agent queue returns only the newest 50 acknowledged handoffs and reports more', async t => {
  const { db,finish,get } = await setup(t);
  for(let i=0;i<52;i++) {
    const { episode_id } = await finish('incomplete');
    db.prepare('UPDATE intake_handoffs SET accepted_at=? WHERE episode_id=?').run(new Date(Date.UTC(2026,8,29,0,0,i)).toISOString(),episode_id);
  }
  const list = await (await get('/agent/intakes')).json(); assertContract('agentIntakeList',list);
  assert.equal(list.items.length,50); assert.equal(list.has_more,true);
  assert.equal(list.items[0].accepted_at,'2026-09-29T00:00:51.000Z'); assert.equal(list.items.at(-1).accepted_at,'2026-09-29T00:00:02.000Z');
  db.exec("UPDATE intake_handoffs SET accepted_at='2026-09-29T00:00:00.000Z'");
  const tied = await (await get('/agent/intakes')).json();
  assert.deepEqual(tied.items.map(x=>x.protocol),db.prepare('SELECT handoff_id FROM intake_handoffs ORDER BY handoff_id LIMIT 50').all().map(x=>x.handoff_id));
});

test('agent intake paths enforce gate methods agent sessions and strict protocol query', async t => {
  const {db,store,get} = await setup(t);
  for(const path of ['/agent/intakes','/agent/intake-detail','/agent/intakes/extra','/agent/intake-detail/extra'])for(const method of ['GET','HEAD','POST','PUT','DELETE','OPTIONS']) {
    assert.equal((await route(request(path,{method,authorization:''}),env,store)).status,401);
    const res = await route(request(path,{method}),env,store);
    assert.equal(res.status,path.endsWith('/extra')?404:method==='GET'?(path.endsWith('detail')?422:200):405);
    if(res.status===405)assert.equal(res.headers.get('Allow'),'GET');
  }
  for(const cookie of ['',`demo_session=${customerToken}`,`demo_agent_session=${customerToken}`,`demo_session=${agentToken}`,`demo_agent_session=${'f'.repeat(64)}`])
    for(const path of ['/agent/intakes','/agent/intake-detail?protocol='+crypto.randomUUID()])assert.equal((await route(request(path,{cookie}),env,store)).status,401);
  for(const query of ['', '?protocol=bad', '?protocol='+crypto.randomUUID()+'&customer_id=ana','?protocol='+crypto.randomUUID()+'&protocol='+crypto.randomUUID(),"?protocol=%27%20OR%201%3D1--"])
    assert.equal((await get('/agent/intake-detail'+query)).status,422);
  assert.equal((await get('/agent/intake-detail?protocol='+crypto.randomUUID())).status,404);
  db.prepare('UPDATE sessions SET expires_at=1 WHERE actor=?').run('agent'); assert.equal((await get('/agent/intakes')).status,401);
});


test('history is bounded with explicit overflow and preserves persisted sequence order', async t => {
  const { db,finish,get }=await setup(t); const {episode_id,receipt}=await finish('incomplete');
  const insert=db.prepare('INSERT INTO intake_events VALUES(?,?,?)');
  for(let seq=102;seq>=3;seq--)insert.run(episode_id,seq,JSON.stringify({event:'clarification_requested',seq,ts:'2026-09-29T00:00:00.000Z',missing:['matching_transaction']}));
  const body=await (await get('/agent/intake-detail?protocol='+receipt.protocol)).json(); assertContract('agentIntakeDetail',body);
  assert.equal(body.history.length,100); assert.equal(body.history_has_more,true);
  assert.deepEqual(body.history.map(x=>x.seq),Array.from({length:100},(_,i)=>i));
});
