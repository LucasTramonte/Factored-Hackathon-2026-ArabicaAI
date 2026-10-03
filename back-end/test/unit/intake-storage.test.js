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
import { close } from '../support/close.js';

const env = { DEMO_PICKER: '1' };
const EPISODES = 100;
// A 77-code-point statement (the typical length used by ADR-004) and the 2,000-code-point maximum.
const TYPICAL = 'No reconozco el cargo de Mercado Demo del 25 de septiembre; no hice la compra';
const VARIANTS = { typical: TYPICAL, max_ascii: 'x'.repeat(2000), max_4byte: '\u{1F600}'.repeat(2000) };
// Bytes of retained pages per episode (rows, index entries and B-tree free space), about 10% above the values
// measured on 2026-09-30; ADR-004 uses these bounds. Sessions are excluded: they are purged at expiry.
const BOUND = { complete: { typical: 5500, max_ascii: 13800, max_4byte: 23400 }, incomplete: { typical: 3700, max_ascii: 7800, max_4byte: 12900 } };

/** A fresh in-memory D1 with every migration up to, not including, ``before`` (all of them by default). */
function setup(before = '~') {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort().filter(f => f < before)) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.exec(readFileSync(new URL('../../seeds/seed_fictitious.sql', import.meta.url), 'utf8'));
  const store = createStore({ prepare: sql => ({ bind: (...p) => ({ all: () => ({ results: db.prepare(sql).all(...p) }) }) }),
    batch: async statements => { db.exec('BEGIN'); try { const r = statements.map(s => s.all()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } });
  let cookie = '';
  const call = async (path, body) => {
    const response = await route(new Request('https://demo.example' + path, { method: 'POST', body: JSON.stringify(body),
      headers: { ...(cookie ? { Cookie: cookie } : {}) } }), env, store);
    const set = response.headers.get('set-cookie'); if (set) cookie = set.split(';', 1)[0];
    return { status: response.status, body: await response.json() };
  };
  return { db, store, call };
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
      const { db, store, call } = setup();
      assert.equal((await call('/demo/session', { customer_id: 'demo-ana' })).status, 200);
      const before = usage(db); const count = Object.fromEntries(TABLES.map(t => [t, rows(db, t)]));
      for (let i = 0; i < EPISODES; i++) {
        const start = await call('/intake/start', { language: 'es', mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine', customer_statement: statement, idempotency_key: crypto.randomUUID() });
        assert.equal(start.status, 201);
        const done = kind === 'complete'
          ? await call('/intake/confirm', { episode_id: start.body.episode_id, transaction_id: 'demo-tx-001', customer_confirmed: true, idempotency_key: crypto.randomUUID() })
          : await call('/intake/handoff', { episode_id: start.body.episode_id, kind: 'incomplete', idempotency_key: crypto.randomUUID() });
        assert.equal(done.status, 201);
        if (kind === 'complete') await close(store, done.body.protocol); // a person closed it, so the next episode may report the same charge
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
  const { db, store, call } = setup();
  assert.equal((await call('/demo/session', { customer_id: 'demo-ana' })).status, 200);
  for (const complete of [true, false]) {
    const start = await call('/intake/start', { language: 'pt', mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine', customer_statement: 'Não reconheço esta cobrança.', idempotency_key: crypto.randomUUID() });
    const done = complete
      ? await call('/intake/confirm', { episode_id: start.body.episode_id, transaction_id: 'demo-tx-001', customer_confirmed: true, idempotency_key: crypto.randomUUID() })
      : await call('/intake/handoff', { episode_id: start.body.episode_id, kind: 'incomplete', idempotency_key: crypto.randomUUID() });
    assert.equal(done.status, 201);
  }
  await store.insertChargeView({ viewRef: crypto.randomUUID(), customerId: 'demo-ana', language: 'en', rowCount: 2, hasMore: false, coverage: 'all', now: 1 });
  assert.equal((await call('/cases', { transaction_id: 'demo-tx-002', customer_statement: 'I do not recognize this charge.', customer_confirmed: true, idempotency_key: crypto.randomUUID() })).status, 201);
  // The pre-intake recipe in ADR-004 now violates intake_handoffs.complete_case_id -> cases(case_id).
  assert.throws(() => db.exec('BEGIN; DELETE FROM cases; DELETE FROM sessions; COMMIT'), /FOREIGN KEY/);
  db.exec('ROLLBACK');
  const seed = ['customers', 'transactions', 'context_cards', 'sample_provenance'].map(t => rows(db, t));
  db.exec(readFileSync(new URL('../../scripts/reset-demo-activity.sql', import.meta.url), 'utf8'));
  for (const table of [...TABLES, 'sessions', 'charge_views']) assert.equal(rows(db, table), 0, table);
  assert.deepEqual(['customers', 'transactions', 'context_cards', 'sample_provenance'].map(t => rows(db, t)), seed);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();
});

test('migration 0014 admits English and keeps every episode, foreign key and index of intake_episodes', async () => {
  const MIGRATION = '0014_english_reports.sql';
  const { db, store, call } = setup(MIGRATION);
  // Today's start writes the reason and its source (0016, 0017, ADR-010): add them to fill the old table, drop them to restore the pre-0014 shape.
  const reason = ['0016_report_reason.sql', '0017_reason_source.sql'].map(f => readFileSync(new URL('../../migrations/' + f, import.meta.url), 'utf8')).join('\n');
  db.exec(reason);
  assert.equal((await call('/demo/session', { customer_id: 'demo-ana' })).status, 200);
  for (const [language, statement, complete] of [['es', 'No reconozco este cargo.', true], ['pt', 'Não reconheço esta cobrança.', false], ['es', 'No reconozco este otro cargo.', null]]) {
    const start = await call('/intake/start', { language, mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine', customer_statement: statement, idempotency_key: crypto.randomUUID() });
    assert.equal(start.status, 201);
    if (complete === null) continue; // an open episode with no handoff
    const done = complete
      ? await call('/intake/confirm', { episode_id: start.body.episode_id, transaction_id: 'demo-tx-001', customer_confirmed: true, idempotency_key: crypto.randomUUID() })
      : await call('/intake/handoff', { episode_id: start.body.episode_id, kind: 'incomplete', idempotency_key: crypto.randomUUID() });
    assert.equal(done.status, 201);
    if (complete) await close(store, done.body.protocol);
  }
  db.exec('ALTER TABLE intake_episodes DROP COLUMN reason_source'); db.exec('ALTER TABLE intake_episodes DROP COLUMN reason');
  assert.throws(() => db.exec("UPDATE intake_episodes SET language='en'"), /CHECK/, 'before 0014 English is refused');
  const indexes = () => db.prepare('PRAGMA index_list(intake_episodes)').all()
    .map(({ name, unique, origin, partial }) => ({ name, unique, origin, partial })).sort((a, b) => a.name.localeCompare(b.name));
  const columns = () => db.prepare('PRAGMA table_xinfo(intake_episodes)').all();
  const episodes = () => db.prepare('SELECT * FROM intake_episodes ORDER BY episode_id').all();
  const before = { indexes: indexes(), columns: columns(), episodes: episodes(), rows: TABLES.map(t => rows(db, t)) };
  assert.equal(before.indexes.length, 4); // primary key, UNIQUE(customer_id,start_key), owner, idle (partial)
  db.exec('BEGIN'); db.exec(readFileSync(new URL('../../migrations/' + MIGRATION, import.meta.url), 'utf8')); db.exec('COMMIT');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual({ indexes: indexes(), columns: columns(), episodes: episodes(), rows: TABLES.map(t => rows(db, t)) }, before);
  for (const child of ['intake_turns', 'intake_events', 'intake_handoffs']) {
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_list(${child})`).all().filter(k => k.from === 'episode_id').map(k => k.table), ['intake_episodes'], child);
  }
  db.exec(reason);
  const english = await call('/intake/start', { language: 'en', mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine', customer_statement: 'I do not recognize this charge.', idempotency_key: crypto.randomUUID() });
  assert.equal(english.status, 201);
  assert.equal(db.prepare('SELECT language FROM intake_episodes WHERE episode_id=?').get(english.body.episode_id).language, 'en');
  assert.throws(() => db.exec("UPDATE intake_episodes SET language='fr'"), /CHECK/);
  db.close();
});

test('a charge view is recorded once and acknowledged only by its customer, keeping the first display time', async () => {
  const { db, store } = setup();
  const viewRef = crypto.randomUUID();
  await store.insertChargeView({ viewRef, customerId: 'demo-ana', language: 'es', rowCount: 20, hasMore: true, coverage: 'newest_20', now: 1000 });
  const row = () => db.prepare('SELECT * FROM charge_views WHERE view_ref=?').get(viewRef);
  assert.deepEqual({ ...row() }, { view_ref: viewRef, customer_id: 'demo-ana', language: 'es', row_count: 20, has_more: 1,
    coverage: 'newest_20', retrieved_at: 1000, displayed_at: null });
  assert.equal(await store.acknowledgeChargeView(viewRef, 'demo-bruno', 1500), null, 'another customer matches nothing');
  assert.equal(row().displayed_at, null);
  assert.equal(await store.acknowledgeChargeView(viewRef, 'demo-ana', 2000), 2000);
  assert.equal(await store.acknowledgeChargeView(viewRef, 'demo-ana', 3000), 2000, 'a replay keeps the first time');
  assert.equal(await store.acknowledgeChargeView(crypto.randomUUID(), 'demo-ana', 3000), null, 'an unknown view matches nothing');
  await assert.rejects(store.insertChargeView({ viewRef: crypto.randomUUID(), customerId: 'demo-ana', language: 'fr', rowCount: 0, hasMore: false, coverage: 'all', now: 1 }), /CHECK/);
  await assert.rejects(store.insertChargeView({ viewRef: crypto.randomUUID(), customerId: 'demo-ana', language: 'en', rowCount: -1, hasMore: false, coverage: 'all', now: 1 }), /CHECK/);
  db.close();
});
