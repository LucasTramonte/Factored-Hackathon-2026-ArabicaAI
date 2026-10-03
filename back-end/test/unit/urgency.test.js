/** urgencyOf: a stated fixed threshold per currency, or above the customer's own p95 with at least 5 others. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { urgencyOf } from '../../src/modules/intake/urgency.js';
import config from '../../src/config/urgency.json' with { type: 'json' };

const tx = (amount, currency = 'BRL') => ({ amount, currency });
const others = (amounts, currency = 'BRL') => amounts.map(a => tx(a, currency));

test('the fixed threshold applies per currency, inclusive, on string amounts', () => {
  for (const [currency, limit] of Object.entries(config.fixed)) {
    assert.equal(urgencyOf(tx(String(limit), currency), [], config), 'high', currency);
    assert.equal(urgencyOf(tx((limit - 0.01).toFixed(2), currency), [], config), 'normal', currency);
  }
  assert.equal(urgencyOf(tx('3890.00'), [], config), 'high');
});

test('above the p95 (nearest rank) of at least 5 same-currency others is high; at the p95 is not', () => {
  const five = others(['10.00', '20.00', '30.00', '40.00', '50.00']); // nearest-rank p95 of 5 is the 5th value
  assert.equal(urgencyOf(tx('50.01'), five, config), 'high');
  assert.equal(urgencyOf(tx('50.00'), five, config), 'normal');
  const twenty = others(Array.from({ length: 20 }, (_, i) => String(i + 1))); // p95 rank 19 -> 19
  assert.equal(urgencyOf(tx('19.50'), twenty, config), 'high');
  assert.equal(urgencyOf(tx('19.00'), twenty, config), 'normal');
});

test('fewer than 5 same-currency others leave only the fixed rule; other currencies do not count', () => {
  assert.equal(urgencyOf(tx('400.00'), others(['1.00', '1.00', '1.00', '1.00']), config), 'normal');
  const mixed = [...others(['1.00', '1.00', '1.00', '1.00']), tx('1.00', 'USD'), tx('1.00', 'COP')];
  assert.equal(urgencyOf(tx('400.00'), mixed, config), 'normal');
});

test('an unknown currency uses the relative rule only', () => {
  assert.equal(urgencyOf(tx('999999999', 'XYZ'), [], config), 'normal');
  assert.equal(urgencyOf(tx('60', 'XYZ'), others(['10', '20', '30', '40', '50'], 'XYZ'), config), 'high');
});

test('the policy names every served currency with a positive round amount and a demo block line', () => {
  for (const currency of ['BRL', 'USD', 'COP', 'ARS', 'MXN']) assert.ok(config.fixed[currency] > 0, currency);
  assert.equal(config.relative_min_others, 5);
  assert.deepEqual(config.high_reasons, ['card_lost_or_stolen']);
  assert.match(config.demo_block_line, /\(demo\)$/);
});

test('a failed read of the served purchases still accepts the report, with only the fixed amount applied', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFileSync, readdirSync } = await import('node:fs');
  const { createStore } = await import('../../src/store/d1.js');
  const { route } = await import('../../src/router.js');
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.exec(readFileSync(new URL('../../seeds/seed_fictitious.sql', import.meta.url), 'utf8'));
  const store = { ...createStore({ prepare: sql => ({ bind: (...p) => ({ all: () => ({ results: db.prepare(sql).all(...p) }) }) }),
    batch: async statements => { db.exec('BEGIN'); try { const r = statements.map(s => s.all()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } }),
  listTransactions: async () => { throw new Error('D1 unavailable'); } };
  let cookie = '';
  const call = async (path, body) => {
    const response = await route(new Request('https://demo.example' + path, { method: 'POST', body: JSON.stringify(body),
      headers: cookie ? { Cookie: cookie } : {} }), { DEMO_PICKER: '1' }, store);
    const set = response.headers.get('set-cookie'); if (set) cookie = set.split(';', 1)[0];
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call('/demo/session', { customer_id: 'demo-ana' })).status, 200);
  const confirm = async transaction_id => call('/intake/confirm', { transaction_id, customer_confirmed: true, idempotency_key: crypto.randomUUID(),
    episode_id: (await call('/intake/start', { language: 'es', mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
      customer_statement: 'No reconozco este cargo.', idempotency_key: crypto.randomUUID() })).body.episode_id });
  const normal = await confirm('demo-tx-001');
  assert.equal(normal.status, 201); assert.equal(normal.body.kind, 'complete'); assert.equal(normal.body.urgency, 'normal');
  const high = await confirm('demo-tx-006');
  assert.equal(high.status, 201); assert.equal(high.body.urgency, 'high', 'the fixed amount needs no purchase history');
});
