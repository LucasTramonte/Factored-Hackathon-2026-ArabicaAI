/** Session changes between route authorization and message storage must block both writes and replay readbacks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createStore } from '../../src/store/d1.js';
import { route } from '../../src/router.js';
import { tokenHash } from '../../src/auth/session.js';

async function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.exec(readFileSync(new URL('../../seeds/seed_fictitious.sql', import.meta.url), 'utf8'));
  const store = createStore({ prepare: sql => ({ bind: (...p) => ({ all: () => ({ results: db.prepare(sql).all(...p) }) }) }),
    batch: async statements => {
      db.exec('BEGIN');
      try { const results = statements.map(s => s.all()); db.exec('COMMIT'); return results; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    } });
  let cookie = '';
  const call = async (path, body, selected = store) => {
    const response = await route(new Request('https://demo.example' + path, { method: 'POST',
      headers: { Cookie: cookie }, body: JSON.stringify(body) }), { DEMO_PICKER: '1' }, selected);
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';', 1)[0];
    return response;
  };
  assert.equal((await call('/demo/session', { customer_id: 'demo-ana' })).status, 200);
  const hash = await tokenHash(cookie.split('=')[1]);
  const start = await call('/intake/start', { language: 'es', mode: 'guided', report_type: 'unrecognized_charge',
    reason: 'not_mine', customer_statement: 'No reconozco este cargo.', idempotency_key: crypto.randomUUID() });
  assert.equal(start.status, 201);
  const handoff = await call('/intake/handoff', { episode_id: (await start.json()).episode_id,
    kind: 'incomplete', idempotency_key: crypto.randomUUID() });
  assert.equal(handoff.status, 201);
  return { db, store, call, hash, receipt: await handoff.json() };
}

for (const change of ['revoked', 'expired', 'swapped', 'wrong actor']) {
  test(`a ${change} customer session cannot write or read back a prior message after route authorization`, async t => {
    const { db, store, call, hash, receipt } = await setup(t);
    const path = `/intake/handoff/${receipt.protocol}/messages`;
    const payload = { body: 'Hola', idempotency_key: crypto.randomUUID() };
    assert.equal((await call(path, payload)).status, 201);
    const selected = { ...store, postMessage: async args => {
      assert.equal(args.sessionHash, hash, 'the caller supplies the presented session hash');
      assert.ok(Number.isSafeInteger(args.now));
      if (change === 'revoked') db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
      if (change === 'expired') db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(args.now, hash);
      if (change === 'swapped') db.prepare("UPDATE sessions SET customer_id='demo-bruno' WHERE token_hash=?").run(hash);
      if (change === 'wrong actor') db.prepare("UPDATE sessions SET actor='agent',customer_id=NULL WHERE token_hash=?").run(hash);
      return store.postMessage(args);
    } };
    for (const ref of [receipt.protocol, receipt.reference_short]) {
      for (const key of [payload.idempotency_key, crypto.randomUUID()]) {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
        db.prepare("INSERT INTO sessions(token_hash,actor,customer_id,expires_at) VALUES(?,'customer','demo-ana',?)")
          .run(hash, Date.now() + 60000);
        const response = await call(`/intake/handoff/${ref}/messages`, { ...payload, idempotency_key: key }, selected);
        assert.equal(response.status, 404);
        assert.equal((await response.json()).detail, 'Report not found');
        assert.equal(db.prepare('SELECT count(*) n FROM handoff_messages').get().n, 1);
      }
    }
    const agent = await store.postMessage({ protocol: receipt.protocol, author: 'agent', body: 'Respuesta',
      key: crypto.randomUUID(), messageId: crypto.randomUUID(), now: Date.now(), agentSessionRef: 'a'.repeat(12) });
    assert.equal(agent.message.body, 'Respuesta', 'agent storage still needs no customer session');
  });
}

for (const change of ['revoked', 'expired', 'wrong actor']) {
  test(`a ${change} agent session blocks insert and idempotent readback inside the message batch`, async t => {
    const { db, store, call, receipt } = await setup(t);
    assert.equal((await call('/demo/agent-session', {})).status, 200);
    const body = { protocol: receipt.protocol, body: 'Respuesta humana', idempotency_key: crypto.randomUUID() };
    assert.equal((await call('/agent/intake-messages', body)).status, 201);
    const selected = { ...store, postMessage: async args => {
      assert.match(args.sessionHash, /^[a-f0-9]{64}$/);
      if (change === 'revoked') db.prepare('DELETE FROM sessions WHERE token_hash=?').run(args.sessionHash);
      if (change === 'expired') db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(args.now, args.sessionHash);
      if (change === 'wrong actor') db.prepare("UPDATE sessions SET actor='customer',customer_id='demo-ana' WHERE token_hash=?").run(args.sessionHash);
      return store.postMessage(args);
    } };
    assert.equal((await call('/agent/intake-messages', body, selected)).status, 404);
    assert.equal(db.prepare('SELECT count(*) n FROM handoff_messages').get().n, 1);
  });
}
