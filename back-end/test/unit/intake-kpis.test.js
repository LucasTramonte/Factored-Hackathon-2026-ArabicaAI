/**
 * intakeKpis on an in-memory SQLite with every migration: the boundaries the local-D1 fixture cannot place in real time
 * (90 days between reports, 24 h to the first open), currencies kept apart, null rates on empty denominators, and a query
 * plan that finds the window by index instead of scanning episodes or answers. Times come from the store's own ``now``.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { KPI_OPEN_MS, KPI_REPEAT_MS, createStore } from '../../src/store/d1.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const DAY = 24 * 3600 * 1000;
const SESSION = 'f'.repeat(64);

function setup() {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.exec("INSERT INTO customers(customer_id,display_name) VALUES('x','X'),('y','Y'),('z','Z');"
    + "INSERT INTO transactions(transaction_id,customer_id,occurred_at,source_occurred_at,merchant_name,amount,currency,bank_flagged) VALUES"
    + "('x1','x','2025-12-01T00:00:00+00:00',NULL,'A','10.00','BRL',0),('x2','x','2025-12-02T00:00:00+00:00',NULL,'B','9.50','BRL',0),"
    + "('x3','x','2025-12-03T00:00:00+00:00',NULL,'C','100.00','BRL',1),('y1','y','2025-12-01T00:00:00+00:00',NULL,'D','20000.00','COP',0),"
    + "('z1','z','2025-12-01T00:00:00+00:00',NULL,'E','7.00','USD',1)");
  for (const customer of ['x', 'y', 'z'])
    db.prepare("INSERT INTO sessions(token_hash,actor,customer_id,expires_at) VALUES(?,'customer',?,?)").run(SESSION + customer, customer, T0 + 400 * DAY);
  const statements = [];
  const store = createStore({ prepare: sql => ({ bind: (...p) => ({ all: () => { statements.push([sql, p]); return { results: db.prepare(sql).all(...p) }; } }) }),
    batch: async list => { db.exec('BEGIN'); try { const r = list.map(s => s.all()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } });
  return { db, store, statements };
}

/** One report through the store's own path, at ``now``: start, reserve, read back, acknowledge. Returns its protocol. */
async function report(store, customerId, now, { language = 'es', transactionId = null } = {}) {
  const kind = transactionId ? 'complete' : 'incomplete';
  const sessionHash = SESSION + customerId;
  const { episode } = await store.startIntake({ customerId, language, statement: 'No reconozco este cargo.', key: crypto.randomUUID(), reason: 'not_mine', now, expiresAt: now + 3600000 });
  const { handoff } = await store.persistIntakeHandoff({ customerId, episodeId: episode.episode_id, turnKey: crypto.randomUUID(), payloadHash: 'h', sessionHash,
    completeCase: transactionId ? { transaction_id: transactionId } : null, kind, evidence: {}, actions: [], questions: [], usage: { tool_calls: 0, operation_duration_ms: 0 }, now });
  const receipt = await store.readIntakeReceipt(customerId, episode.episode_id, { sessionHash, now });
  const { acknowledged } = await store.finishIntakeHandoff({ customerId, episode: await store.findIntake(customerId, episode.episode_id), receipt, sessionHash, now, operationDuration: 0, toolCalls: 0 });
  assert.ok(acknowledged);
  return handoff.complete_case_id ?? handoff.handoff_id;
}

test('an empty window has zero counts and null rates and percentiles, and reads no episode or answer by scan', async () => {
  const { db, store, statements } = setup();
  await report(store, 'x', T0, { transactionId: 'x1' });
  const kpis = await store.intakeKpis({ sinceMs: T0 + DAY, untilMs: T0 + 2 * DAY });
  const all = kpis.by_language.all;
  assert.equal(all.reports.started, 0);
  assert.deepEqual(all.reports.not_complete_handoff, { numerator: 0, denominator: 0, rate: null });
  assert.deepEqual(all.workload.opened_within_24h, { numerator: 0, denominator: 0, rate: null });
  assert.deepEqual(all.friction.span_ms, { ended: 0, p50: null, p95: null });
  assert.deepEqual(all.repeat_reporters, { numerator: 0, denominator: 0, rate: null });
  assert.deepEqual(all.repeat_reporters_3plus_in_90d, { numerator: 0, denominator: 0, rate: null });
  assert.deepEqual(all.friction.technical_handoffs, { numerator: 0, denominator: 0, rate: null });
  assert.deepEqual(all.workload.by_kind, { complete: 0, incomplete: 0, technical: 0 });
  assert.deepEqual(kpis.alerts.complete_handoffs_after_recognized, { numerator: 0, denominator: 0, rate: null });
  assert.deepEqual(all.persistence.confirmed_suggestion_marked_wrong.rate, null);
  assert.deepEqual(all.value_at_stake, { complete_handoffs: {}, no_amount: 0 });
  assert.deepEqual(kpis.alerts.deflected_by_explanation, { numerator: 0, denominator: 0, rate: null });
  assert.deepEqual(kpis.alerts.value_at_stake_deflected, {});
  assert.ok(!JSON.stringify(kpis).includes('"x"'), 'no customer id in the output');
  const reads = statements.slice(-7);
  assert.equal(reads.length, 7);
  for (const [sql, params] of reads) {
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(row => row.detail).join(' | ');
    // Base tables go by these aliases; d, lanes, ranks, gaps and x are the statement's own small intermediate results.
    assert.doesNotMatch(plan, /SCAN (e|h|r|c|m|t|p|v|intake_\w+|handoff_\w+|proactive_answers|transactions|cases)( |$)/, plan);
  }
});

test('repeat reporters: two acknowledged reports at most 90 days apart, both in the window; one more millisecond is not a repeat', async () => {
  const { store } = setup();
  await report(store, 'x', T0); await report(store, 'x', T0 + KPI_REPEAT_MS, { language: 'pt' });
  await report(store, 'y', T0); await report(store, 'y', T0 + KPI_REPEAT_MS + 1);
  await report(store, 'z', T0 + DAY);
  const kpis = await store.intakeKpis({ sinceMs: T0, untilMs: T0 + 200 * DAY });
  assert.deepEqual(kpis.by_language.all.repeat_reporters, { numerator: 1, denominator: 3, rate: 1 / 3 });
  // Per language, x has one report in each, so nobody repeats within a language.
  assert.deepEqual(kpis.by_language.es.repeat_reporters, { numerator: 0, denominator: 3, rate: 0 });
  assert.deepEqual(kpis.by_language.pt.repeat_reporters, { numerator: 0, denominator: 1, rate: 0 });
  assert.deepEqual(kpis.by_language.en.repeat_reporters, { numerator: 0, denominator: 0, rate: null });
  // A window that holds only the later reports sees no repeat: an earlier report outside it doesn't count.
  assert.deepEqual((await store.intakeKpis({ sinceMs: T0 + 2 * DAY, untilMs: T0 + 200 * DAY })).by_language.all.repeat_reporters, { numerator: 0, denominator: 2, rate: 0 });
});

test('three reports within 90 days (first to third, inclusive) flag the interim tail proxy; three spread wider do not', async () => {
  const { store } = setup();
  for (const at of [T0, T0 + 45 * DAY, T0 + KPI_REPEAT_MS]) await report(store, 'x', at);
  for (const at of [T0, T0 + 50 * DAY, T0 + 100 * DAY]) await report(store, 'y', at);
  await report(store, 'z', T0);
  const { all } = (await store.intakeKpis({ sinceMs: T0, untilMs: T0 + 200 * DAY })).by_language;
  assert.deepEqual(all.repeat_reporters, { numerator: 2, denominator: 3, rate: 2 / 3 });
  assert.deepEqual(all.repeat_reporters_3plus_in_90d, { numerator: 1, denominator: 3, rate: 1 / 3 });
});

test('not_complete_handoff is over ended reports: a pending start is in neither part', async () => {
  const { store } = setup();
  await report(store, 'x', T0, { transactionId: 'x1' }); await report(store, 'y', T0);
  await store.startIntake({ customerId: 'z', language: 'es', statement: 'No reconozco este cargo.', key: crypto.randomUUID(), reason: 'not_mine', now: T0, expiresAt: T0 + 3600000 });
  const { reports, workload, friction } = (await store.intakeKpis({ sinceMs: T0, untilMs: T0 + DAY })).by_language.all;
  assert.equal(reports.outcomes.pending, 1);
  assert.deepEqual(reports.not_complete_handoff, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.deepEqual(workload.by_kind, { complete: 1, incomplete: 1, technical: 0 });
  assert.deepEqual(friction.technical_handoffs, { numerator: 0, denominator: 3, rate: 0 });
});

test('first open within 24 h is inclusive at the boundary; unopened handoffs stay in the denominator', async () => {
  const { store } = setup();
  const onTime = await report(store, 'x', T0, { transactionId: 'x1' });
  const late = await report(store, 'x', T0, { transactionId: 'x2' });
  await report(store, 'y', T0);
  assert.ok(await store.findIntakeHandoff(onTime, T0 + KPI_OPEN_MS));
  assert.ok(await store.findIntakeHandoff(late, T0 + KPI_OPEN_MS + 1));
  const { workload } = (await store.intakeKpis({ sinceMs: T0, untilMs: T0 + DAY })).by_language.all;
  assert.deepEqual(workload.opened_within_24h, { numerator: 1, denominator: 3, rate: 1 / 3 });
  assert.equal(workload.unopened, 1);
  assert.deepEqual(workload.status, { received: 3, in_review: 0, closed: 0 });
});

test('value at stake: nearest-rank quartiles per source currency, never summed across them; a report without a charge is no_amount', async () => {
  const { store } = setup();
  await report(store, 'x', T0, { transactionId: 'x1' });
  await report(store, 'x', T0 + 1, { transactionId: 'x2', language: 'pt' });
  await report(store, 'x', T0 + 2, { transactionId: 'x3' });
  await report(store, 'y', T0 + 3, { transactionId: 'y1' });
  await report(store, 'z', T0 + 4);
  const { by_language } = await store.intakeKpis({ sinceMs: T0, untilMs: T0 + DAY });
  // BRL sorted by value: 9.50, 10.00, 100.00 (text order would put 100.00 first); ranks ceil(.25n)=1, ceil(.5n)=2, ceil(.75n)=3.
  assert.deepEqual(by_language.all.value_at_stake, { complete_handoffs: { BRL: { n: 3, p25: '9.50', p50: '10.00', p75: '100.00' },
    COP: { n: 1, p25: '20000.00', p50: '20000.00', p75: '20000.00' } }, no_amount: 1 });
  assert.deepEqual(by_language.es.value_at_stake.complete_handoffs.BRL, { n: 2, p25: '10.00', p50: '10.00', p75: '100.00' });
  assert.deepEqual(by_language.pt.value_at_stake, { complete_handoffs: { BRL: { n: 1, p25: '9.50', p50: '9.50', p75: '9.50' } }, no_amount: 0 });
});

test('alerts: recognized, not mine, reported only after the answer and before the window ends; answers by an admin are not the customer', async () => {
  const { store } = setup();
  await store.answerProactiveAlert({ customerId: 'x', transactionId: 'x3', answeredBy: 'customer', answer: 'mine', now: T0 });
  await store.answerProactiveAlert({ customerId: 'z', transactionId: 'z1', answeredBy: 'customer', answer: 'report', now: T0 });
  await store.answerProactiveAlert({ customerId: 'z', transactionId: 'z1', answeredBy: 'admin', answer: 'mine', now: T0 });
  await report(store, 'x', T0 + DAY, { transactionId: 'x3' });
  const before = await store.intakeKpis({ sinceMs: T0, untilMs: T0 + DAY });
  assert.deepEqual([before.alerts.answered, before.alerts.recognized, before.alerts.not_mine, before.alerts.reported], [2, 1, 1, 0]);
  assert.deepEqual(before.alerts.persistence_recognized_then_reported, { numerator: 0, denominator: 1, rate: 0 });
  assert.deepEqual(before.alerts.deflected_by_explanation, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.deepEqual(before.alerts.value_at_stake_deflected, { BRL: { n: 1, p25: '100.00', p50: '100.00', p75: '100.00' } });
  assert.deepEqual(before.alerts.complete_handoffs_after_recognized, { numerator: 0, denominator: 0, rate: null });
  // Once the recognized charge is reported, it is persistence, no longer a deflection, and its amount leaves the deflected value.
  const after = await store.intakeKpis({ sinceMs: T0, untilMs: T0 + 2 * DAY });
  assert.deepEqual(after.alerts.persistence_recognized_then_reported, { numerator: 1, denominator: 1, rate: 1 });
  assert.deepEqual([after.alerts.recognized_then_reported, after.alerts.deflected], [1, 0]);
  assert.deepEqual(after.alerts.deflected_by_explanation, { numerator: 0, denominator: 2, rate: 0 });
  assert.deepEqual(after.alerts.value_at_stake_deflected, {});
  assert.deepEqual(after.alerts.complete_handoffs_after_recognized, { numerator: 1, denominator: 1, rate: 1 });
});

test('a malformed window is refused before any query', async () => {
  const { store, statements } = setup();
  for (const [sinceMs, untilMs] of [[-1, 1], [1, 1], [2, 1], [0.5, 2], [0, Number.MAX_SAFE_INTEGER + 2], ['0', 1]])
    await assert.rejects(store.intakeKpis({ sinceMs, untilMs }), /Invalid KPI window/);
  assert.equal(statements.length, 0);
});

test('the script takes a strict UTC window: dates are midnight, the default is the last seven days, anything else is refused', async () => {
  const { kpiWindow } = await import('../../scripts/intake-kpis.mjs');
  const clock = Date.parse('2026-10-04T12:00:00Z');
  assert.deepEqual(kpiWindow({}, clock), { sinceMs: clock - 7 * DAY, untilMs: clock });
  assert.deepEqual(kpiWindow({ since: '2026-10-01', until: '2026-10-02T06:30:00Z' }, clock),
    { sinceMs: Date.parse('2026-10-01T00:00:00Z'), untilMs: Date.parse('2026-10-02T06:30:00Z') });
  for (const values of [{ since: '2026-02-30' }, { since: '1700000000000' }, { until: '2026-10-01T00:00:00+03:00' }, { since: '' },
    { since: '2026-10-02', until: '2026-10-01' }, { since: '2026-10-01', until: '2026-10-01' }, { since: '1960-01-01' }])
    assert.throws(() => kpiWindow(values, clock), /Invalid KPI window/, JSON.stringify(values));
});
