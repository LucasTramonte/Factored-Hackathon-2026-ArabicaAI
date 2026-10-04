/** Agent reads exercise persisted handoffs, optional ownership joins and actual events. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createStore } from '../../src/store/d1.js';
import { route } from '../../src/router.js';
import { tokenHash } from '../../src/auth/session.js';
import { assertContract } from '../support/contract.js';
const env = {};
const customerToken = 'a'.repeat(64), agentToken = 'b'.repeat(64);
const request = (path, { method = 'GET', cookie = `demo_agent_session=${agentToken}`, body } = {}) =>
  new Request('https://demo.example' + path, { method, headers: { Cookie: cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function setup(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.exec("INSERT INTO customers(customer_id,display_name) VALUES('ana','Ana'),('bruno','Bruno'); INSERT INTO transactions(transaction_id,customer_id,occurred_at,source_occurred_at,merchant_name,amount,currency) VALUES('tx-ana','ana',NULL,'2026-06-17 12:00:00','Shop','10.00','ARS'),('tx-bruno','bruno',NULL,'2026-06-17 12:00:00','Other','20.00','ARS')");
  for (const [token, actor, owner] of [[customerToken,'customer','ana'],[agentToken,'agent',null]])
    db.prepare('INSERT INTO sessions(token_hash,actor,customer_id,expires_at) VALUES(?,?,?,?)').run(await tokenHash(token), actor, owner, Date.now() + 3600000);
  const store = createStore({ prepare: sql => ({ bind: (...p) => ({ all: () => ({ results: db.prepare(sql).all(...p) }) }) }),
    batch: async statements => { db.exec('BEGIN'); try { const results = statements.map(s => s.all()); db.exec('COMMIT'); return results; } catch(e) { db.exec('ROLLBACK'); throw e; } } });
  const customer = (path, body, selected = store) => route(request(path, { method:'POST', cookie:`demo_session=${customerToken}`, body }), env, selected);
  const start = async () => (await (await customer('/intake/start', { language:'pt', mode:'guided', report_type:'unrecognized_charge',reason:'not_mine', customer_statement:'Não reconheço esta cobrança.', idempotency_key:crypto.randomUUID() })).json()).episode_id;
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
  // The first open of each report stamps first_opened_at (migration 0018): two reports opened, two writes; nothing else changes.
  assert.equal(changes(),writesBefore+2,'only the two first opens write');
  const afterFirstOpens = changes();
  await get('/agent/intake-detail?protocol=' + incomplete.receipt.protocol); await get('/agent/intakes');
  assert.equal(changes(),afterFirstOpens,'later agent reads write nothing');
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

test('agent intake paths enforce methods agent sessions and strict protocol query', async t => {
  const {db,store,get} = await setup(t);
  for(const path of ['/agent/intakes','/agent/intake-detail','/agent/intakes/extra','/agent/intake-detail/extra'])for(const method of ['GET','HEAD','POST','PUT','DELETE','OPTIONS']) {
    assert.equal((await route(request(path,{method,cookie:''}),env,store)).status,path.endsWith('/extra')?404:method==='GET'?401:405);
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

test('POST /agent/intake-status validates its body, moves forward one step only and replays without writing', async t => {
  const { db, store, finish } = await setup(t);
  const { receipt } = await finish('incomplete');
  db.prepare("INSERT INTO notification_targets VALUES('ana','iv.x',1)").run();
  const post = (body, cookie) => route(request('/agent/intake-status', { method: 'POST', body, ...(cookie && { cookie }) }), env, store);
  const p = receipt.protocol;
  for (const body of [null, [], {}, { protocol: p }, { status: 'closed' }, { protocol: p, status: 'received' }, { protocol: p, status: 'resolved' },
    { protocol: 'x', status: 'closed' }, { protocol: 42, status: 'closed' }, { protocol: p, status: 'closed', extra: 1 }, { protocol: p, status: 'closed', customer_id: 'ana' }])
    assert.equal((await post(body)).status, 422, JSON.stringify(body));
  for (const cookie of [`demo_session=${customerToken}`, `demo_agent_session=${'f'.repeat(64)}`, 'x=1'])
    assert.equal((await post({ protocol: p, status: 'in_review' }, cookie)).status, 401);
  assert.equal((await post({ protocol: crypto.randomUUID(), status: 'in_review' })).status, 404);
  assert.equal((await post({ protocol: p, status: 'closed', closing_note: 'Review explanation' })).status, 409, 'no skipping');
  const first = await post({ protocol: p.toUpperCase(), status: 'in_review' });
  assert.equal(first.status, 200); const body = await first.json(); assertContract('intakeTransition', body);
  assert.equal(body.protocol, p); assert.equal(body.status, 'in_review');
  const writes = db.prepare('SELECT total_changes() AS n').get().n;
  const replay = await post({ protocol: p, status: 'in_review' });
  assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), body);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, writes, 'a replay writes nothing');
  assert.equal((await post({ protocol: p, status: 'closed', closing_note: 'Review explanation' })).status, 200);
  assert.equal((await post({ protocol: p, status: 'in_review' })).status, 409, 'never backwards');
  const history = db.prepare('SELECT status,agent_session_ref FROM handoff_status_history ORDER BY rowid').all();
  const ref = (await tokenHash(agentToken)).slice(0, 12);
  assert.deepEqual(history.map(r => ({ ...r })), [{ status: 'in_review', agent_session_ref: ref }, { status: 'closed', agent_session_ref: ref }]);
  assert.deepEqual(db.prepare("SELECT template FROM email_outbox WHERE template<>'received' ORDER BY rowid").all().map(r => r.template), ['in_review', 'closed']);
  assert.equal(db.prepare('SELECT status FROM intake_handoffs WHERE handoff_id=?').get(p).status, 'closed');
});

test('a reserved but unacknowledged handoff cannot be moved and gets no history', async t => {
  const { db, store, finish } = await setup(t);
  const pending = await finish('complete', { ...store, readIntakeReceipt: async () => { throw new Error('readback unavailable'); } });
  assert.equal(pending.response.status, 503);
  const protocol = db.prepare('SELECT complete_case_id FROM intake_handoffs WHERE episode_id=?').get(pending.episode_id).complete_case_id;
  const res = await route(request('/agent/intake-status', { method: 'POST', body: { protocol, status: 'in_review' } }), env, store);
  assert.equal(res.status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM handoff_status_history').get().n, 0);
});

test('a report from before the customer could choose a reason reads reason null, never 0016\'s default (migration 0017)', async t => {
  const { db, finish, get } = await setup(t);
  const chosen = await finish('incomplete'), old = await finish('incomplete');
  // An episode stored before 0016/0017 has the column defaults: reason 'not_mine', reason_source 'not_recorded'.
  db.prepare("UPDATE intake_episodes SET reason_source='not_recorded' WHERE episode_id=?").run(old.episode_id);
  const list = await (await get('/agent/intakes')).json(); assertContract('agentIntakeList', list);
  const byEpisode = Object.fromEntries(list.items.map(i => [i.episode_id, i.reason]));
  assert.equal(byEpisode[chosen.episode_id], 'not_mine'); assert.equal(byEpisode[old.episode_id], null);
  const detail = await (await get('/agent/intake-detail?protocol=' + old.receipt.protocol)).json();
  assertContract('agentIntakeDetail', detail); assert.equal(detail.reason, null);
  assert.equal(db.prepare('SELECT reason FROM intake_episodes WHERE episode_id=?').get(old.episode_id).reason, 'not_mine', 'the stored value is kept; only its reading changes');
});

test('detail summarises only the same customer\'s other reports and stamps the first open once', async t => {
  const { db, finish, get } = await setup(t);
  // Bruno's report must never count in Ana's history (isolation), and the report itself is never in its own history.
  const brunoToken = 'c'.repeat(64);
  db.prepare('INSERT INTO sessions(token_hash,actor,customer_id,expires_at) VALUES(?,?,?,?)').run(await tokenHash(brunoToken), 'customer', 'bruno', Date.now() + 3600000);
  const asBruno = (path, body) => route(request(path, { method: 'POST', cookie: `demo_session=${brunoToken}`, body }), env, createStore({
    prepare: sql => ({ bind: (...p) => ({ all: () => ({ results: db.prepare(sql).all(...p) }) }) }),
    batch: async st => { db.exec('BEGIN'); try { const r = st.map(s => s.all()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } }));
  const brunoStart = await (await asBruno('/intake/start', { language: 'pt', mode: 'guided', report_type: 'unrecognized_charge', reason: 'other', customer_statement: 'Não reconheço esta cobrança.', idempotency_key: crypto.randomUUID() })).json();
  assert.equal((await asBruno('/intake/handoff', { episode_id: brunoStart.episode_id, kind: 'incomplete', idempotency_key: crypto.randomUUID() })).status, 201);

  const first = await get('/agent/intake-detail?protocol=' + (await finish('incomplete')).receipt.protocol);
  const firstBody = await first.json(); assertContract('agentIntakeDetail', firstBody);
  assert.deepEqual(firstBody.customer_history, { reports: 0, open: 0, high_urgency: 0, last_status: null, last_accepted_at: null, has_more: false }, 'first report; Bruno\'s is not counted');

  const older = await finish('incomplete'), latest = await finish('complete');
  db.prepare("UPDATE intake_handoffs SET status='closed' WHERE complete_case_id IS NULL AND handoff_id=?").run(older.receipt.protocol);
  const res = await get('/agent/intake-detail?protocol=' + latest.receipt.protocol);
  const body = await res.json(); assertContract('agentIntakeDetail', body);
  assert.equal(body.customer_history.reports, 2); assert.equal(body.customer_history.open, 1); assert.equal(body.customer_history.high_urgency, 0);
  assert.ok(['received', 'closed'].includes(body.customer_history.last_status)); assert.ok(body.customer_history.last_accepted_at);
  assert.ok(!JSON.stringify(body.customer_history).includes('ana'), 'the summary names no customer');

  const stamped = db.prepare('SELECT first_opened_at FROM intake_handoffs WHERE complete_case_id=?').get(latest.receipt.protocol).first_opened_at;
  assert.equal(body.first_opened_at, new Date(stamped).toISOString());
  const again = await (await get('/agent/intake-detail?protocol=' + latest.receipt.protocol)).json();
  assert.equal(again.first_opened_at, body.first_opened_at, 'a later read keeps the first open time');
  assert.equal(db.prepare('SELECT count(*) n FROM intake_handoffs WHERE first_opened_at IS NOT NULL').get().n, 2, 'only opened reports are stamped');
});

test('a full customer episode window stays partial when starts and pending reservations hide older reports', async t => {
  const { db, start, finish, store, get } = await setup(t);
  const reports = [];
  const created = Date.UTC(2026, 9, 3, 12);
  for (let i = 0; i < 30; i++) {
    const report = await finish('incomplete'); reports.push(report);
    db.prepare('UPDATE intake_episodes SET created_at=? WHERE episode_id=?').run(created + i, report.episode_id);
    db.prepare('UPDATE intake_handoffs SET accepted_at=? WHERE episode_id=?').run(new Date(created + i).toISOString(), report.episode_id);
  }
  const read = async protocol => {
    const body = await (await get('/agent/intake-detail?protocol=' + protocol)).json();
    assertContract('agentIntakeDetail', body); return body;
  };
  const old = await read(reports[0].receipt.protocol);
  assert.equal(old.customer_history.reports, 20, 'opening an old report still caps its other reports at 20');
  assert.equal(old.customer_history.has_more, true);

  for (let i = 0; i < 5; i++) {
    const episode_id = i < 2
      ? (await finish('incomplete', { ...store, readIntakeReceipt: async () => { throw new Error('lost readback'); } })).episode_id
      : await start();
    db.prepare('UPDATE intake_episodes SET created_at=? WHERE episode_id=?').run(created + 30 + i, episode_id);
    if (i === 2 || i === 3) db.prepare("UPDATE intake_episodes SET state='abandoned' WHERE episode_id=?").run(episode_id);
  }
  db.prepare("UPDATE intake_handoffs SET status='closed',urgency='high' WHERE episode_id=?").run(reports[28].episode_id);
  const mixed = await read(reports[29].receipt.protocol);
  assert.deepEqual(mixed.customer_history, { reports: 15, open: 14, high_urgency: 1, last_status: 'closed',
    last_accepted_at: new Date(created + 28).toISOString(), has_more: true }, 'only acknowledged other reports count; the full raw window warns of omissions');

  for (let i = 0; i < 21; i++) {
    const episode_id = await start();
    db.prepare("UPDATE intake_episodes SET state='abandoned',created_at=? WHERE episode_id=?").run(created + 40 + i, episode_id);
  }
  const obscured = await read(reports[29].receipt.protocol);
  assert.deepEqual(obscured.customer_history, { reports: 0, open: 0, high_urgency: 0, last_status: null, last_accepted_at: null, has_more: true },
    'zero visible reports in a saturated window never means this is the first report');
  assert.equal(obscured.first_opened_at, mixed.first_opened_at);
});

test('simultaneous first opens write one epoch-ms stamp and SQL pickup preserves milliseconds', async t => {
  const { db, store, finish } = await setup(t);
  const { receipt } = await finish('incomplete');
  const accepted = '2026-10-03T12:00:00.123Z', now = Date.parse(accepted) + 4567;
  db.prepare('UPDATE intake_handoffs SET accepted_at=? WHERE handoff_id=?').run(accepted, receipt.protocol);
  const changes = () => db.prepare('SELECT total_changes() AS n').get().n;
  const before = changes();
  const [first, concurrent] = await Promise.all([store.findIntakeHandoff(receipt.protocol, now), store.findIntakeHandoff(receipt.protocol, now + 100)]);
  assert.equal(first.first_opened_at, now); assert.equal(concurrent.first_opened_at, now);
  assert.equal(changes(), before + 1, 'concurrent opens stamp only once');
  const pickup = db.prepare('SELECT typeof(first_opened_at) AS unit,first_opened_at - '
    + 'CAST(ROUND((julianday(accepted_at)-2440587.5)*86400000) AS INTEGER) AS pickup_ms FROM intake_handoffs WHERE handoff_id=?').get(receipt.protocol);
  assert.equal(pickup.unit, 'integer'); assert.equal(pickup.pickup_ms, 4567);
  assert.equal((await store.findIntakeHandoff(receipt.protocol, now + 1000)).first_opened_at, now);
  assert.equal(changes(), before + 1, 'later reads write nothing');
});


test('a failed closing update rolls back explanation, history and notification together', async t => {
  const { db, store, finish } = await setup(t);
  const { receipt } = await finish('incomplete');
  db.prepare("INSERT INTO notification_targets VALUES('ana','iv.x',1)").run();
  const post = body => route(request('/agent/intake-status', { method: 'POST', body }), env, store);
  assert.equal((await post({ protocol: receipt.protocol, status: 'in_review' })).status, 200);
  db.exec("CREATE TRIGGER fail_closing BEFORE UPDATE OF status ON intake_handoffs WHEN NEW.status='closed' BEGIN SELECT RAISE(ABORT,'forced failure'); END;");
  await assert.rejects(post({ protocol: receipt.protocol, status: 'closed', closing_note: 'Must roll back' }), /forced failure/);
  assert.equal(db.prepare('SELECT status FROM intake_handoffs').get().status, 'in_review');
  assert.equal(db.prepare('SELECT closing_note FROM intake_handoffs').get().closing_note, null);
  assert.equal(db.prepare("SELECT count(*) n FROM handoff_status_history WHERE status='closed'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM email_outbox WHERE template='closed'").get().n, 0);
});
