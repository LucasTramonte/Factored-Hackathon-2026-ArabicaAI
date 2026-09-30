/**
 * Retained D1 storage per guided episode, measured with SQLite's dbstat over the Worker's own migrations and
 * routes. Memory model: one in-memory SQLite per variant holding 100 episodes (about 2 MB at the 2,000-code-point
 * 4-byte maximum), closed before the next. The upper bounds below are the storage inputs of ADR-004's capacity figures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createStore } from '../../src/store/d1.js';
import { route } from '../../src/router.js';

const env = { DEMO_ACCESS_USERNAME: 'u', DEMO_ACCESS_PASSWORD: 'p' };
const EPISODES = 100;
// A 77-code-point statement (the typical length used by ADR-004) and the 2,000-code-point maximum.
const TYPICAL = 'No reconozco el cargo de Mercado Demo del 25 de septiembre; no hice la compra';
const VARIANTS = { typical: TYPICAL, max_ascii: 'x'.repeat(2000), max_4byte: '\u{1F600}'.repeat(2000) };
// Bytes of retained pages per episode (rows, index entries and B-tree free space), about 10% above the values
// measured on 2026-09-30; ADR-004 uses these bounds. Sessions are excluded: they are purged at expiry.
const BOUND = { complete: { typical: 5700, max_ascii: 14000, max_4byte: 23500 }, incomplete: { typical: 3900, max_ascii: 8000, max_4byte: 13000 } };

function setup() {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.exec(readFileSync(new URL('../../seeds/seed_fictitious.sql', import.meta.url), 'utf8'));
  const store = createStore({ prepare: sql => ({ bind: (...p) => ({ all: () => ({ results: db.prepare(sql).all(...p) }) }) }),
    batch: async statements => { db.exec('BEGIN'); try { const r = statements.map(s => s.all()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } });
  let cookie = '';
  const call = async (path, body) => {
    const response = await route(new Request('https://demo.example' + path, { method: 'POST', body: JSON.stringify(body),
      headers: { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64'), ...(cookie ? { Cookie: cookie } : {}) } }), env, store);
    const set = response.headers.get('set-cookie'); if (set) cookie = set.split(';', 1)[0];
    return { status: response.status, body: await response.json() };
  };
  return { db, call };
}

/** Bytes per table group (table plus its indexes) from dbstat; page granularity is amortized over 100 episodes. */
function usage(db) {
  const owner = Object.fromEntries(db.prepare("SELECT name,tbl_name FROM sqlite_master WHERE type IN ('table','index')").all().map(r => [r.name, r.tbl_name]));
  const bytes = {};
  for (const { name, size } of db.prepare('SELECT name,SUM(pgsize) AS size FROM dbstat GROUP BY name').all()) {
    const table = owner[name] ?? name; bytes[table] = (bytes[table] ?? 0) + size;
  }
  return bytes;
}
const rows = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const TABLES = ['intake_episodes', 'intake_turns', 'intake_events', 'intake_handoffs', 'cases'];

test('retained storage per guided episode stays within the ADR-004 capacity inputs', async () => {
  const measured = {};
  for (const kind of ['complete', 'incomplete']) {
    for (const [variant, statement] of Object.entries(VARIANTS)) {
      const { db, call } = setup();
      assert.equal((await call('/demo/session', { customer_id: 'demo-ana' })).status, 200);
      const before = usage(db); const count = Object.fromEntries(TABLES.map(t => [t, rows(db, t)]));
      for (let i = 0; i < EPISODES; i++) {
        const start = await call('/intake/start', { language: 'es', mode: 'guided', report_type: 'unrecognized_charge', customer_statement: statement, idempotency_key: crypto.randomUUID() });
        assert.equal(start.status, 201);
        const done = kind === 'complete'
          ? await call('/intake/confirm', { episode_id: start.body.episode_id, transaction_id: 'demo-tx-001', customer_confirmed: true, idempotency_key: crypto.randomUUID() })
          : await call('/intake/handoff', { episode_id: start.body.episode_id, kind: 'incomplete', idempotency_key: crypto.randomUUID() });
        assert.equal(done.status, 201);
      }
      const after = usage(db);
      const perRow = Object.fromEntries(TABLES.map(t => {
        const added = rows(db, t) - count[t];
        return [t, added ? { rows_per_episode: added / EPISODES, bytes_per_row: Math.round(((after[t] ?? 0) - (before[t] ?? 0)) / added) } : null];
      }).filter(([, v]) => v));
      const total = TABLES.reduce((sum, t) => sum + (after[t] ?? 0) - (before[t] ?? 0), 0);
      measured[`${kind}_${variant}`] = { bytes_per_episode: Math.round(total / EPISODES), tables: perRow };
      db.close();
    }
  }
  console.log('D1_STORAGE ' + JSON.stringify(measured));
  for (const kind of ['complete', 'incomplete']) for (const variant of Object.keys(VARIANTS)) {
    const { bytes_per_episode: bytes } = measured[`${kind}_${variant}`];
    assert.ok(bytes <= BOUND[kind][variant], `${kind} ${variant}: ${bytes} bytes per episode`);
  }
});

test('the documented demo-activity reset respects intake foreign keys and keeps seed data', async () => {
  const { db, call } = setup();
  assert.equal((await call('/demo/session', { customer_id: 'demo-ana' })).status, 200);
  for (const complete of [true, false]) {
    const start = await call('/intake/start', { language: 'pt', mode: 'guided', report_type: 'unrecognized_charge', customer_statement: 'Não reconheço esta cobrança.', idempotency_key: crypto.randomUUID() });
    const done = complete
      ? await call('/intake/confirm', { episode_id: start.body.episode_id, transaction_id: 'demo-tx-001', customer_confirmed: true, idempotency_key: crypto.randomUUID() })
      : await call('/intake/handoff', { episode_id: start.body.episode_id, kind: 'incomplete', idempotency_key: crypto.randomUUID() });
    assert.equal(done.status, 201);
  }
  assert.equal((await call('/cases', { transaction_id: 'demo-tx-002', customer_statement: 'I do not recognize this charge.', customer_confirmed: true, idempotency_key: crypto.randomUUID() })).status, 201);
  // The pre-intake recipe in ADR-004 now violates intake_handoffs.complete_case_id -> cases(case_id).
  assert.throws(() => db.exec('BEGIN; DELETE FROM cases; DELETE FROM sessions; COMMIT'), /FOREIGN KEY/);
  db.exec('ROLLBACK');
  const seed = ['customers', 'transactions', 'context_cards', 'sample_provenance'].map(t => rows(db, t));
  db.exec(readFileSync(new URL('../../scripts/reset-demo-activity.sql', import.meta.url), 'utf8'));
  for (const table of [...TABLES, 'sessions']) assert.equal(rows(db, table), 0, table);
  assert.deepEqual(['customers', 'transactions', 'context_cards', 'sample_provenance'].map(t => rows(db, t)), seed);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();
});
