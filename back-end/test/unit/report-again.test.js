/** A follow-up is a new owned episode with a durable link; closed source rows never reopen or change. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createStore } from '../../src/store/d1.js';
import { route } from '../../src/router.js';
import { tokenHash } from '../../src/auth/session.js';
import { assertContract } from '../support/contract.js';

const tokens = { ana: 'a'.repeat(64), bruno: 'b'.repeat(64), agent: 'c'.repeat(64) };
const body = previous_protocol => ({ language: 'es', mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
  customer_statement: 'El problema continúa; solicito otra revisión.', idempotency_key: crypto.randomUUID(),
  ...(previous_protocol && { previous_protocol }) });

async function setup(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.exec("INSERT INTO customers(customer_id,display_name) VALUES('ana','Ana'),('bruno','Bruno'); INSERT INTO transactions(transaction_id,customer_id,occurred_at,source_occurred_at,merchant_name,amount,currency) VALUES('tx-ana','ana',NULL,'2026-06-17 12:00:00','Shop','10.00','ARS'),('tx-bruno','bruno',NULL,'2026-06-17 12:00:00','Other','20.00','ARS')");
  for (const [actor, token] of Object.entries(tokens)) db.prepare('INSERT INTO sessions(token_hash,actor,customer_id,expires_at) VALUES(?,?,?,?)')
    .run(await tokenHash(token), actor === 'agent' ? 'agent' : 'customer', actor === 'agent' ? null : actor, Date.now() + 3600000);
  const store = createStore({ prepare: sql => ({ bind: (...p) => ({ all: () => ({ results: db.prepare(sql).all(...p) }) }) }),
    batch: async statements => { db.exec('BEGIN'); try { const result = statements.map(s => s.all()); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; } } });
  const call = (path, payload, actor = 'ana', selected = store) => route(new Request('https://demo.example' + path, {
    method: 'POST', headers: { Cookie: `${actor === 'agent' ? 'demo_agent_session' : 'demo_session'}=${tokens[actor]}` },
    body: JSON.stringify(payload) }), {}, selected);
  const source = async (actor = 'ana', complete = false, closed = true) => {
    const start = await call('/intake/start', body(), actor); assert.equal(start.status, 201);
    const episode_id = (await start.json()).episode_id;
    const res = await call(complete ? '/intake/confirm' : '/intake/handoff', complete
      ? { episode_id, transaction_id: 'tx-' + actor, customer_confirmed: true, idempotency_key: crypto.randomUUID() }
      : { episode_id, kind: 'incomplete', idempotency_key: crypto.randomUUID() }, actor);
    assert.equal(res.status, 201); const receipt = await res.json(); assertContract('intakeReceipt', receipt);
    if (closed) for (const status of ['in_review', 'closed']) assert.equal((await call('/agent/intake-status', { protocol: receipt.protocol, status, ...(status === 'closed' ? { closing_note: 'Review finished; contact the bank for help.' } : {}) }, 'agent')).status, 200);
    return { episode_id, receipt, handoff: db.prepare('SELECT * FROM intake_handoffs WHERE episode_id=?').get(episode_id) };
  };
  return { db, store, call, source };
}

test('a linked follow-up confirms through normal intake and preserves the original closed report', async t => {
  const { db, call, source } = await setup(t); const original = await source('ana', true);
  const before = db.prepare('SELECT * FROM intake_episodes WHERE episode_id=?').get(original.episode_id);
  const started = await call('/intake/start', body(original.receipt.protocol)); assert.equal(started.status, 201);
  const start = await started.json(); assertContract('intakeStart', start);
  assert.notEqual(start.episode_id, original.episode_id);
  assert.equal(db.prepare('SELECT previous_handoff_id FROM intake_episodes WHERE episode_id=?').get(start.episode_id).previous_handoff_id, original.handoff.handoff_id);
  const confirmation = { episode_id: start.episode_id, transaction_id: 'tx-ana', customer_confirmed: true, idempotency_key: crypto.randomUUID() };
  const finish = await call('/intake/confirm', confirmation); assert.equal(finish.status, 201);
  const receipt = await finish.json(); assertContract('intakeReceipt', receipt); assert.notEqual(receipt.protocol, original.receipt.protocol);
  assert.equal((await call('/intake/confirm', confirmation)).status, 200);
  assert.deepEqual(db.prepare('SELECT * FROM intake_handoffs WHERE episode_id=?').get(original.episode_id), original.handoff);
  assert.deepEqual(db.prepare('SELECT * FROM intake_episodes WHERE episode_id=?').get(original.episode_id), before);
  assert.equal(db.prepare('SELECT count(*) n FROM cases').get().n, 2);
  assert.equal(db.prepare('SELECT status FROM intake_handoffs WHERE episode_id=?').get(start.episode_id).status, 'received');
  const another = await call('/intake/start', body(original.receipt.protocol));
  assert.equal((await call('/intake/confirm', { ...confirmation, episode_id: (await another.json()).episode_id, idempotency_key: crypto.randomUUID() })).status, 409,
    'a linked start never bypasses one open report per charge');
  db.exec(readFileSync(new URL('../../scripts/reset-demo-activity.sql', import.meta.url), 'utf8'));
  assert.equal(db.prepare('SELECT count(*) n FROM intake_episodes').get().n, 0, 'reset handles the optional episode/handoff FK cycle');
  assert.equal(db.prepare('SELECT count(*) n FROM customers').get().n, 2);
});

test('concurrent linked starts replay once; changing or removing the source conflicts and old hashes stay valid', async t => {
  const { db, call, source } = await setup(t); const first = await source(), second = await source();
  const payload = body(first.receipt.protocol);
  const responses = await Promise.all([call('/intake/start', payload), call('/intake/start', payload), call('/intake/start', payload)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 200, 201]);
  const starts = await Promise.all(responses.map(r => r.json())); starts.forEach(r => assertContract('intakeStart', r));
  assert.equal(new Set(starts.map(r => r.episode_id)).size, 1);
  assert.equal((await call('/intake/start', { ...payload, previous_protocol: first.receipt.protocol.toUpperCase() })).status, 200);
  assert.equal((await call('/intake/start', { ...payload, previous_protocol: second.receipt.protocol })).status, 409);
  const { previous_protocol, ...unlinked } = payload;
  assert.equal((await call('/intake/start', unlinked)).status, 409);
  const old = body(); assert.equal((await call('/intake/start', old)).status, 201); assert.equal((await call('/intake/start', old)).status, 200);
  const stored = db.prepare('SELECT payload_hash,previous_handoff_id FROM intake_episodes WHERE start_key=?').get(old.idempotency_key);
  assert.equal(stored.payload_hash, await tokenHash(JSON.stringify([old.language, old.customer_statement, old.reason])));
  assert.equal(stored.previous_handoff_id, null);
});

test('linked starts reject foreign/missing/pending sources, open states, malformed links and wrong sessions', async t => {
  const { db, store, call, source } = await setup(t);
  const foreign = await source('bruno'), open = await source('ana', false, false), closed = await source();
  const changes = () => db.prepare('SELECT total_changes() n').get().n;
  for (const previous of [foreign.receipt.protocol, crypto.randomUUID()]) {
    const before = changes(); const rejected = await call('/intake/start', body(previous));
    assert.equal(rejected.status, 404); assertContract('error', await rejected.json()); assert.equal(changes(), before);
  }
  for (const status of ['received', 'in_review']) {
    db.prepare('UPDATE intake_handoffs SET status=? WHERE handoff_id=?').run(status, open.handoff.handoff_id);
    const before = changes(); assert.equal((await call('/intake/start', body(open.receipt.protocol))).status, 409); assert.equal(changes(), before);
  }
  db.prepare("UPDATE intake_episodes SET state='handoff_pending' WHERE episode_id=?").run(closed.episode_id);
  assert.equal((await call('/intake/start', body(closed.receipt.protocol))).status, 404, 'closed but unacknowledged is not a source');
  for (const previous_protocol of [null, '', 42, 'AR-AAAA-BBBB', "' OR 1=1--"]) {
    assert.equal((await call('/intake/start', { ...body(), previous_protocol })).status, 422);
  }
  for (const extra of [{ customer_id: 'bruno' }, { previous_handoff_id: closed.handoff.handoff_id }])
    assert.equal((await call('/intake/start', { ...body(closed.receipt.protocol), ...extra })).status, 422);
  assert.equal((await call('/intake/start', body(open.receipt.protocol), 'agent')).status, 401);
  db.prepare("UPDATE sessions SET expires_at=1 WHERE actor='customer'").run();
  assert.equal((await call('/intake/start', body(open.receipt.protocol))).status, 401);
  assert.equal((await store.findIntake('ana', foreign.episode_id)), null);
});

test('linked insert rechecks closed state ownership and live session atomically', async t => {
  const { db, store, call, source } = await setup(t); const original = await source();
  const attempt = async (mutate, expected) => {
    const before = db.prepare('SELECT count(*) n FROM intake_episodes').get().n;
    const response = await call('/intake/start', body(original.receipt.protocol), 'ana', { ...store,
      startIntake: args => { mutate(); return store.startIntake(args); } });
    assert.equal(response.status, expected); assert.equal(db.prepare('SELECT count(*) n FROM intake_episodes').get().n, before);
  };
  await attempt(() => db.prepare("UPDATE intake_handoffs SET status='received' WHERE handoff_id=?").run(original.handoff.handoff_id), 409);
  db.prepare("UPDATE intake_handoffs SET status='closed' WHERE handoff_id=?").run(original.handoff.handoff_id);
  await attempt(() => db.prepare("UPDATE intake_episodes SET customer_id='bruno' WHERE episode_id=?").run(original.episode_id), 404);
  db.prepare("UPDATE intake_episodes SET customer_id='ana' WHERE episode_id=?").run(original.episode_id);
  await attempt(() => db.prepare("DELETE FROM sessions WHERE actor='customer' AND customer_id='ana'").run(), 401);
});

test('revocation during a linked replay neither renews the episode nor returns its receipt', async t => {
  const { db, store, call, source } = await setup(t); const original = await source(); const payload = body(original.receipt.protocol);
  const response = await call('/intake/start', payload); assert.equal(response.status, 201); const started = await response.json();
  const saved = db.prepare('SELECT * FROM intake_episodes WHERE episode_id=?').get(started.episode_id);
  const refused = await call('/intake/start', payload, 'ana', { ...store, startIntake: args => {
    db.prepare("DELETE FROM sessions WHERE actor='customer' AND customer_id='ana'").run(); return store.startIntake(args);
  } });
  assert.equal(refused.status, 401);
  assert.deepEqual(db.prepare('SELECT * FROM intake_episodes WHERE episode_id=?').get(started.episode_id), saved);
});


test('lost linked-start authority hides whether the source is open, closed, missing or foreign', async t => {
  const { db, store, call, source } = await setup(t);
  const closed = await source(), open = await source('ana', false, false), foreign = await source('bruno');
  const hash = await tokenHash(tokens.ana);
  const saved = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(hash);
  for (const protocol of [closed.receipt.protocol, open.receipt.protocol, foreign.receipt.protocol, crypto.randomUUID()]) {
    for (const mutation of [
      () => db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash),
      () => db.prepare('UPDATE sessions SET expires_at=1 WHERE token_hash=?').run(hash),
      () => db.prepare("UPDATE sessions SET actor='agent',customer_id=NULL WHERE token_hash=?").run(hash),
      () => db.prepare("UPDATE sessions SET customer_id='bruno' WHERE token_hash=?").run(hash)
    ]) {
      const before = db.prepare('SELECT * FROM intake_episodes ORDER BY episode_id').all();
      const refused = await call('/intake/start', body(protocol), 'ana', { ...store, startIntake: args => {
        mutation(); return store.startIntake(args);
      } });
      assert.equal(refused.status, 401);
      assert.deepEqual(await refused.json(), { detail: 'Start a demo session first' });
      assert.deepEqual(db.prepare('SELECT * FROM intake_episodes ORDER BY episode_id').all(), before);
      db.prepare('INSERT OR REPLACE INTO sessions(token_hash,actor,customer_id,expires_at) VALUES(?,?,?,?)').run(saved.token_hash, saved.actor, saved.customer_id, saved.expires_at);
    }
  }
});
