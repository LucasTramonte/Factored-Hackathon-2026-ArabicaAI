/**
 * The short human reference (issue #52): one random AR-XXXX-XXXX code per handoff, stored 1:1 with it, returned
 * with the receipt and to agents, stable on replay, unique in SQL, and never derived from or usable as the UUID.
 * Memory model: one in-memory SQLite built from the Worker's own migrations per test, closed at the end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createStore, newShortReference, SHORT_REFERENCE } from '../../src/store/d1.js';
import { route } from '../../src/router.js';
import { assertContract } from '../support/contract.js';
import { close } from '../support/close.js';

const env = { DEMO_PICKER: '1' };

function setup(options) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.exec(readFileSync(new URL('../../seeds/seed_fictitious.sql', import.meta.url), 'utf8'));
  const store = createStore({ prepare: sql => ({ bind: (...p) => ({ all: () => ({ results: db.prepare(sql).all(...p) }) }) }),
    batch: async statements => { db.exec('BEGIN'); try { const r = statements.map(s => s.all()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } },
  options);
  const actor = () => {
    let cookie = '';
    return async (path, body) => {
      const response = await route(new Request('https://demo.example' + path, { method: body === undefined ? 'GET' : 'POST',
        body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(cookie ? { Cookie: cookie } : {}) } }), env, store);
      const set = response.headers.get('set-cookie'); if (set) cookie = set.split(';', 1)[0];
      return { status: response.status, body: await response.json() };
    };
  };
  return { db, store, actor };
}

async function customer(actor, id = 'demo-ana') {
  const call = actor(); assert.equal((await call('/demo/session', { customer_id: id })).status, 200); return call;
}
async function start(call) {
  const r = await call('/intake/start', { language: 'es', mode: 'guided', report_type: 'unrecognized_charge',
    customer_statement: 'No reconozco este cargo.', idempotency_key: crypto.randomUUID() });
  assert.equal(r.status, 201); return r.body.episode_id;
}
const confirm = (call, episode_id, key = crypto.randomUUID()) =>
  call('/intake/confirm', { episode_id, transaction_id: 'demo-tx-001', customer_confirmed: true, idempotency_key: key });

test('the code is AR plus two groups of four Crockford characters, from 40 random bits', () => {
  const codes = new Set(Array.from({ length: 2000 }, newShortReference));
  assert.equal(codes.size, 2000);
  for (const code of codes) assert.match(code, SHORT_REFERENCE);
  // No ambiguous characters a customer could misread over the phone.
  assert.ok(![...codes].some(code => /[ILOU]/.test(code.slice(3))));
});

test('every receipt kind carries a short reference, and replays return the same one', async () => {
  const { db, store, actor } = setup();
  const ana = await customer(actor);
  const key = crypto.randomUUID(); const episode = await start(ana);
  const complete = await confirm(ana, episode, key);
  assert.equal(complete.status, 201); assertContract('intakeReceipt', complete.body);
  assert.match(complete.body.reference_short, SHORT_REFERENCE);
  const replay = await confirm(ana, episode, key);
  assert.equal(replay.status, 200); assert.equal(replay.body.reference_short, complete.body.reference_short);

  const incomplete = await ana('/intake/handoff', { episode_id: await start(ana), kind: 'incomplete', idempotency_key: crypto.randomUUID() });
  assert.equal(incomplete.status, 201); assertContract('intakeReceipt', incomplete.body);
  assert.match(incomplete.body.reference_short, SHORT_REFERENCE);

  store.findOwnedTransaction = async () => { throw new Error('lookup down'); };
  const technical = await confirm(ana, await start(ana));
  assert.equal(technical.status, 201); assert.equal(technical.body.kind, 'technical');
  assert.match(technical.body.reference_short, SHORT_REFERENCE);

  const stored = db.prepare('SELECT reference_short FROM intake_handoffs').all().map(r => r.reference_short);
  assert.deepEqual(stored.sort(), [complete, incomplete, technical].map(r => r.body.reference_short).sort());
  db.close();
});

test('codes are independent of the case UUID and unique across many handoffs', async () => {
  const { db, store, actor } = setup();
  const ana = await customer(actor);
  const receipts = [];
  for (let i = 0; i < 40; i++) { receipts.push((await confirm(ana, await start(ana))).body); await close(store, receipts.at(-1).protocol); }
  assert.equal(new Set(receipts.map(r => r.reference_short)).size, 40);
  for (const r of receipts) {
    const code = r.reference_short.slice(3).replace('-', '').toLowerCase();
    assert.ok(!r.protocol.replaceAll('-', '').includes(code) && !r.episode_id.replaceAll('-', '').includes(code));
  }
  db.close();
});

test('SQL refuses a duplicate code, and the store retries with a fresh one instead of failing the customer', async () => {
  const codes = ['AR-AAAA-AAAA', 'AR-AAAA-AAAA', 'AR-BBBB-BBBB'];
  const { db, store, actor } = setup({ shortReference: () => codes.shift() });
  const ana = await customer(actor);
  const first = await confirm(ana, await start(ana));
  assert.equal(first.body.reference_short, 'AR-AAAA-AAAA'); await close(store, first.body.protocol);
  const second = await confirm(ana, await start(ana));
  assert.equal(second.status, 201); assert.equal(second.body.reference_short, 'AR-BBBB-BBBB');
  assert.throws(() => db.prepare("UPDATE intake_handoffs SET reference_short='AR-AAAA-AAAA' WHERE reference_short='AR-BBBB-BBBB'").run(), /UNIQUE/);
  assert.throws(() => db.prepare("UPDATE intake_handoffs SET reference_short='ar-not-valid' WHERE reference_short='AR-BBBB-BBBB'").run(), /CHECK/);
  db.close();
});

test('when every retry collides, nothing is reserved and no reference is promised', async () => {
  const { db, store, actor } = setup({ shortReference: () => 'AR-CCCC-CCCC' });
  const ana = await customer(actor);
  const first = await confirm(ana, await start(ana));
  assert.equal(first.status, 201); await close(store, first.body.protocol);
  const key = crypto.randomUUID(); const episode = await start(ana);
  const blocked = await confirm(ana, episode, key);
  assert.equal(blocked.status, 503); assert.equal(blocked.body.reference_short, undefined); assert.equal(blocked.body.protocol, undefined);
  assert.equal(db.prepare('SELECT count(*) AS n FROM intake_handoffs').get().n, 1);
  db.close();
});

test('agents see the same code in the queue and the detail; it is not a lookup key, and other customers never see it', async () => {
  const { db, actor } = setup();
  const ana = await customer(actor);
  const receipt = (await confirm(ana, await start(ana))).body;
  const agent = actor(); assert.equal((await agent('/demo/agent-session', {})).status, 200);
  const queue = await agent('/agent/intakes'); assertContract('agentIntakeList', queue.body);
  assert.equal(queue.body.items.find(i => i.protocol === receipt.protocol).reference_short, receipt.reference_short);
  const detail = await agent('/agent/intake-detail?protocol=' + receipt.protocol);
  assert.equal(detail.status, 200); assertContract('agentIntakeDetail', detail.body);
  assert.equal(detail.body.reference_short, receipt.reference_short);
  for (const [schema, body] of [['intakeReceipt', receipt], ['agentIntake', queue.body.items[0]], ['agentIntakeDetail', detail.body]]) {
    assertContract(schema, { ...body, reference_short: null });
    for (const reference_short of ['AR-AAAA-AAA', 'AR-AAAA-AAAI', 'ar-aaaa-aaaa', 123]) {
      assert.throws(() => assertContract(schema, { ...body, reference_short }), /reference_short/);
    }
    const { reference_short, ...missing } = body;
    assert.throws(() => assertContract(schema, missing), /missing reference_short/);
  }
  assert.equal((await agent('/agent/intake-detail?protocol=' + receipt.reference_short)).status, 422);
  const bruno = await customer(actor, 'demo-bruno');
  const foreign = await bruno('/intake/confirm', { episode_id: receipt.episode_id, transaction_id: 'demo-tx-001', customer_confirmed: true, idempotency_key: crypto.randomUUID() });
  assert.equal(foreign.status, 404); assert.ok(!JSON.stringify(foreign.body).includes(receipt.reference_short));
  db.close();
});

test('handoffs stored before the column existed read back with a null code', async () => {
  const { db, actor } = setup();
  const ana = await customer(actor);
  const key = crypto.randomUUID(); const episode = await start(ana);
  assert.equal((await confirm(ana, episode, key)).status, 201);
  db.exec('UPDATE intake_handoffs SET reference_short=NULL');
  const replay = await confirm(ana, episode, key);
  assert.equal(replay.status, 200); assertContract('intakeReceipt', replay.body); assert.equal(replay.body.reference_short, null);
  db.close();
});
