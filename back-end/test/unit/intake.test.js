/** Guided starts exercise the real store SQL against SQLite; local-D1 tests cover the runtime. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createStore } from '../../src/store/d1.js';
import { route } from '../../src/router.js';
import { tokenHash } from '../../src/auth/session.js';
import { assertContract } from '../support/contract.js';

const env = { ASSETS: { fetch: () => new Response('asset') } };
const token = 'a'.repeat(64);
const body = { language: 'es', mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
  customer_statement: 'No reconozco este cargo.', idempotency_key: '0f8fad5b-d9cb-469f-a165-70867728950e' };

function request(payload = body, { path = '/intake/start', method = 'POST', cookie = `demo_session=${token}` } = {}) {
  return new Request('https://d.example' + path, { method,
    headers: { Cookie: cookie },
    ...(method === 'POST' ? { body: typeof payload === 'string' ? payload : JSON.stringify(payload) } : {}) });
}

async function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  const migrations = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).sort()) db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  db.exec("INSERT INTO customers(customer_id,display_name) VALUES('ana','Ana'),('bruno','Bruno')");
  const expiry = Date.now() + 3600_000;
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(await tokenHash(token), 'customer', 'ana', expiry);
  const prepare = sql => ({ bind: (...params) => ({ all: () => ({ results: db.prepare(sql).all(...params) }) }) });
  const store = createStore({ prepare, batch: async statements => {
    db.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(statement.all()); db.exec('COMMIT'); return results; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } });
  return { db, store, expiry };
}

test('guided_start_is_owned_and_idempotent', async t => {
  const { db, store } = await setup(t);
  const results = await Promise.all([route(request(), env, store), route(request(), env, store)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
  const payloads = await Promise.all(results.map(r => r.json()));
  for (const payload of payloads) { assertContract('intakeStart', payload); assert.equal(payload.protocol, undefined); }
  assert.equal(payloads[0].episode_id, payloads[1].episode_id);
  assert.deepEqual(payloads.map(p => p.replayed).sort(), [false, true]);
  const rows = db.prepare('SELECT * FROM intake_episodes').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].customer_id, 'ana');
  assert.equal(rows[0].customer_statement, body.customer_statement);
  assert.equal((await store.findIntake('bruno', rows[0].episode_id)), null);
  assert.equal((await store.findIntake('ana', rows[0].episode_id)).episode_id, rows[0].episode_id);
  const events = db.prepare('SELECT event_json FROM intake_events').all();
  assert.equal(events.length, 1);
  const event = JSON.parse(events[0].event_json);
  assert.deepEqual(event, { event: 'intake_started', version: '2', case_id: rows[0].episode_id,
    ts: new Date(rows[0].created_at).toISOString(), seq: 0, session_ref: rows[0].session_ref,
    language: 'es', model_version: 'guided-0.1' });
  for (const secret of ['ana', token, await tokenHash(token), body.customer_statement]) assert.notEqual(event.session_ref, secret);
  assert.equal(db.prepare('SELECT count(*) AS n FROM intake_turns').get().n, 1);
  for (const change of [{ customer_statement: 'Otro cargo que no reconozco.' }, { language: 'pt' }]) {
    assert.equal((await route(request({ ...body, ...change }), env, store)).status, 409);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM intake_events').get().n, 1);
});

test('invalid starts, roles, expiry, methods and paths never write intake rows', async t => {
  const { db, store } = await setup(t);
  const invalid = [null, [], '"text"', '{bad', { ...body, customer_id: 'bruno' }, { ...body, language: 'fr' }, { ...body, language: 'EN' },
    { ...body, mode: 'ai' }, { ...body, report_type: 'balance' }, { ...body, reason: 'nope' }, { ...body, idempotency_key: 'bad' },
    { ...body, customer_statement: 'short' }, { ...body, customer_statement: 'x'.repeat(2001) },
    { ...body, customer_statement: '\ud800'.repeat(10) }, { ...body, extra: true },
    { ...body, session_ref: 'forged' }, { ...body, language: null }, { ...body, customer_statement: null }];
  for (const payload of invalid) assert.equal((await route(request(payload), env, store)).status, 422, JSON.stringify(payload));
  assert.equal((await route(request('x'.repeat(20_000)), env, store)).status, 413);
  for (const cookie of ['', `demo_agent_session=${token}`, `demo_session=${'f'.repeat(64)}`]) {
    assert.equal((await route(request(body, { cookie }), env, store)).status, 401);
  }
  db.prepare('UPDATE sessions SET expires_at=1').run();
  assert.equal((await route(request(), env, store)).status, 401);
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
    assert.equal((await route(request(body, { method }), env, store)).status, 405);
  }
  for (const path of ['/intake', '/intake/', '/intake/unknown', '/intake/start/extra']) {
    assert.equal((await route(request(body, { path }), env, store)).status, 404);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM intake_episodes').get().n, 0);
});

test('same-owner renewal keeps opaque session reference and original replay while rebinding trusted expiry', async t => {
  const { db, store, expiry } = await setup(t);
  const original = await (await route(request(), env, store)).json();
  const row = await store.findIntake('ana', original.episode_id);
  assert.equal(row.expires_at, expiry);
  const renewed = 'b'.repeat(64);
  db.prepare('DELETE FROM sessions').run();
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(await tokenHash(renewed), 'customer', 'ana', expiry + 1000);
  const replay = await route(request(body, { cookie: `demo_session=${renewed}` }), env, store);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { ...original, replayed: true });
  const resumed = await store.findIntake('ana', original.episode_id);
  assert.equal(resumed.expires_at, expiry + 1000);
  assert.equal(resumed.session_ref, row.session_ref);
  db.prepare("UPDATE intake_episodes SET state='abandoned'").run();
  await route(request(body, { cookie: `demo_session=${renewed}` }), env, store);
  assert.equal((await store.findIntake('ana', original.episode_id)).state, 'abandoned');
  const bruno = 'c'.repeat(64);
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(await tokenHash(bruno), 'customer', 'bruno', expiry + 2000);
  const other = await (await route(request(body, { cookie: `demo_session=${bruno}` }), env, store)).json();
  assert.notEqual(other.episode_id, original.episode_id);
  assert.equal(await store.findIntake('bruno', original.episode_id), null);
});

test('Unicode code-point bounds and SQL-like statements remain data', async t => {
  const { db, store } = await setup(t);
  for (const statement of ['😀'.repeat(10), '😀'.repeat(2000), "'); DELETE FROM sessions; -- no reconozco este cargo"]) {
    const res = await route(request({ ...body, customer_statement: statement, idempotency_key: crypto.randomUUID() }), env, store);
    assert.equal(res.status, 201);
    const episode = await store.findIntake('ana', (await res.json()).episode_id);
    assert.equal(episode.customer_statement, statement);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
});


test('start contract admits es, pt and en; rejects a case reference, other languages and extra identity fields', () => {
  const receipt = { episode_id: '11111111-2222-4333-8444-555555555555', state: 'selection_required', language: 'es', mode: 'guided', replayed: false };
  assertContract('intakeStart', receipt);
  assertContract('intakeStart', { ...receipt, language: 'en' });
  for (const invalid of [{ ...receipt, protocol: 'case-id' }, { ...receipt, language: 'fr' },
    { ...receipt, customer_id: 'ana' }, { ...receipt, replayed: 'yes' }]) assert.throws(() => assertContract('intakeStart', invalid), /violated/);
});

test('atomic start failure leaves no partial episode or durable receipt', async t => {
  const { db, store } = await setup(t);
  db.exec('DROP TABLE intake_events');
  const res = await route(request(), env, store);
  assert.equal(res.status, 503);
  assert.match((await res.json()).detail, /same idempotency key/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM intake_episodes').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM intake_turns').get().n, 0);
});

test('U+0000 statements return 422 before storage and do not consume the start key', async t => {
  const { db, store } = await setup(t);
  for (const statement of ['a\u0000bbbbbbbbbb', 'No reconozco este cargo.\u0000']) {
    const res = await route(request({ ...body, customer_statement: statement }), env, store);
    assert.equal(res.status, 422);
    assertContract('error', await res.json());
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM intake_episodes').get().n, 0);
  assert.equal((await route(request(), env, store)).status, 201);
});

test('a start key retried in a different letter case replays the same episode', async t => {
  const { db, store } = await setup(t);
  const first = await route(request(), env, store);
  assert.equal(first.status, 201);
  const upper = await route(request({ ...body, idempotency_key: body.idempotency_key.toUpperCase() }), env, store);
  assert.equal(upper.status, 200);
  assert.equal((await upper.json()).episode_id, (await first.json()).episode_id);
  assert.equal(db.prepare('SELECT count(*) n FROM intake_episodes').get().n, 1);
  assert.equal(db.prepare('SELECT start_key FROM intake_episodes').get().start_key, body.idempotency_key);
});
