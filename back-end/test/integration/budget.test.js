/**
 * Per-request D1 budgets for customer episodes, agent reads and operator housekeeping/export. The legacy ceilings
 * are the measured values plus a small margin. For the guided endpoints, query, write and round-trip ceilings
 * equal the measured deterministic counts, and read ceilings add a small margin over the value measured once the
 * store holds any neighbouring rows (see ADR-004). A new table scan or an extra query fails here before it reaches
 * the Free-plan limits in ADR-004. The measured numbers are printed for that ADR.
 *
 * run-local.mjs runs this file after every other suite, so it measures against their retained population and its
 * fixtures (100 queue reservations, 100 idle starts) cannot perturb their assertions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { client, idToken } from '../support/client.js';
import { assertContract } from '../support/contract.js';
import { tokenHash } from '../../src/auth/session.js';

// Ceilings per request: [queries, rows_read, rows_written, round_trips]. D1 Free allows 50 queries per invocation;
// round trips drive latency (about 150 ms each when the Worker runs far from D1).
const CEILING = {
  // One query listing the dataset cohort. It reads every customers row: 10 in the fixture since the two charge-view
  // customers (ceiling +2, the read margin), about 800 with the cohort loaded (ADR-004).
  identities: [1, 12, 0, 1],
  // Every session start and logout also writes one auth_events row in its existing batch (migration 0012): one query,
  // 1 read and 2 writes (the row and auth_events_time), no round trip; logout's insert also checks the session (ADR-004).
  login: [6, 10, 6, 3],
  list: [2, 25, 0, 2],
  // GET /transactions?lang= (ADR-009): list plus one charge_views insert (row and primary key), one more round trip.
  listView: [3, 26, 2, 3],
  // POST /transactions/displayed: session, then one UPDATE … RETURNING; a replay rewrites the same row (COALESCE).
  displayed: [2, 5, 1, 2],
  logout: [2, 3, 3, 1],
  create: [4, 12, 6, 4],
  agentLogin: [3, 6, 6, 1],
  agentList: [2, 250, 0, 2],
  intakeStart: [6, 8, 11, 2],
  intakeStartReplay: [6, 6, 2, 2],
  // The first acknowledgement queues one "received" email for a customer with a notification target (Task 3.2):
  // one more statement in the acknowledgement batch, 3 writes (row, primary key, email_outbox_recent).
  // One open report per charge (Task 4.4): one more query and round trip that reads only that charge's cases
  // (index cases_customer_transaction, migration 0011), and one more write for that index on the case insert (ADR-004).
  // Urgency lane (Task 5.1, migration 0013): one more query and round trip reads the customer's served purchases
  // (at most 21) to apply the stated policy; a normal charge writes no urgent-index entry (ADR-004).
  intakeConfirm: [21, 74, 27, 10],
  intakeConfirmReplay: [18, 54, 0, 7],
  intakeIncomplete: [15, 55, 18, 7],
  intakeIncompleteReplay: [15, 44, 0, 7],
  // 1 session row + 2 rows per scanned handoff; qualified for a 50-row page behind 50 tied pending reservations.
  // Pending density is not bounded in general, so this is a fixture workload, not a universal scan bound.
  // Open high-urgency reports come first: one more query in the same batch, through the partial index intake_handoffs_urgent.
  intakeQueue: [3, 225, 0, 2],
  // 1 session row + about 2 rows per episode of the customer + the case row (primary key) of a complete report.
  // Measured on a customer with one complete report: 2 queries, 5 rows read, 0 written, 2 round trips (ceiling 7 rows read).
  reports: [2, 7, 0, 2],
  // Session, owned report with its target flag, the outbox insert that checks the 5-minute window itself (row, primary
  // key, email_outbox_recent); the send marks the row from its own store after the response (Task 3.3).
  reportsUpdate: [3, 14, 3, 3],
  // Agent session, then one batch: history row (+ unique index), the customer's email (row, primary key,
  // email_outbox_recent) and the status update; each statement resolves the handoff by its unique keys (ADR-004).
  agentTransition: [5, 26, 6, 2],
  // A high-priority charge (Task 5.1): its confirm writes one more row, the entry in the partial index
  // intake_handoffs_urgent; closing it writes what a normal close writes, since D1 counts no write for leaving that index.
  intakeConfirmHigh: [21, 77, 28, 10],
  agentTransitionHigh: [5, 26, 6, 2],
  completeDetail: [3, 15, 0, 3],
  incompleteDetail: [3, 10, 0, 3],
  // Operator scripts, per store call: one atomic page of 100 due starts, a sweep with nothing due, the due probe.
  idleSweepPage: [2, 1210, 300, 1],
  idleSweepNoop: [2, 10, 0, 1],
  idleDueProbe: [1, 3, 0, 1]
};
// An export page reads about 2 rows per episode (its page entry and the look-ahead that ends its event range) plus
// its events, so the ceiling is computed from the page actually read, with a small fixed slack. A scan of
// intake_episodes or intake_events adds rows per retained episode or event and fails here even on a small store.
// The guided producer writes at most 5 events per episode, so a full page is at most 702 rows.
const EXPORT_SLACK = 2;
const exportCeiling = rows => [1, 2 * rows.length + rows.reduce((n, row) => n + JSON.parse(row.events_json).length, 0) + EXPORT_SLACK, 0, 1];
// Customer requests of one guided episode (login + list?lang= + displayed + start + terminal request), as the client
// sends them from ADR-009 on; ADR-004 sizes capacity on these.
const EPISODE_CEILING = { complete: [37, 97, 46, 20], incomplete: [31, 75, 37, 17] };

function within(name, m, ceiling = CEILING[name]) {
  assert.ok(m, `${name}: X-D1-Metrics header missing (is DEMO_EXPOSE_DB_METRICS set?)`);
  const [q, r, w, t] = ceiling;
  assert.ok(m.queries <= q && m.rows_read <= r && m.rows_written <= w && m.round_trips <= t,
    `${name} exceeded budget: ${JSON.stringify(m)} > queries ${q}, rows_read ${r}, rows_written ${w}, round_trips ${t}`);
  return m;
}
const sum = (measured, keys) => keys.reduce((total, k) => ({ requests: total.requests + 1, queries: total.queries + measured[k].queries,
  rows_read: total.rows_read + measured[k].rows_read, rows_written: total.rows_written + measured[k].rows_written,
  round_trips: total.round_trips + measured[k].round_trips }), { requests: 0, queries: 0, rows_read: 0, rows_written: 0, round_trips: 0 });
/** Native local-D1 store calls report camelCase totals; measure one call as the difference of two snapshots. */
async function storeCall(store, work) {
  const before = store.metrics();
  const result = await work();
  const after = store.metrics();
  return { result, metrics: { queries: after.queries - before.queries, rows_read: after.rowsRead - before.rowsRead,
    rows_written: after.rowsWritten - before.rowsWritten, round_trips: after.roundTrips - before.roundTrips } };
}
const config = () => resolve(process.cwd(), 'wrangler.jsonc');

test('a customer episode and an agent read stay within the D1 budget', async () => {
  const c = client();
  const measured = {};
  measured.identities = within('identities', (await c.call('/demo/identities')).metrics);
  measured.login = within('login', (await c.call('/demo/session', { customer_id: 'demo-ana' })).metrics);
  measured.emailLogin = within('login', (await client({ authorization: 'Bearer ' + await idToken('demo-ana') })
    .call('/auth/session', {})).metrics);
  measured.list = within('list', (await c.call('/transactions')).metrics);
  measured.create = within('create', (await c.call('/cases', { transaction_id: 'demo-tx-001',
    customer_statement: 'Budget probe: I do not recognize this charge.', customer_confirmed: true,
    idempotency_key: crypto.randomUUID() })).metrics);
  measured.logout = within('logout', (await c.call('/auth/logout', {})).metrics);
  const agent = client();
  measured.agentLogin = within('agentLogin', (await agent.call('/demo/agent-session', {})).metrics);
  measured.agentEmailLogin = within('agentLogin', (await client({ authorization: 'Bearer ' + await idToken('agent@test', { groups: ['agent'] }) })
    .call('/demo/agent-session', {})).metrics);
  measured.agentList = within('agentList', (await agent.call('/agent/cases')).metrics);
  const episode = sum(measured, ['login', 'list', 'create']);
  console.log('D1_BUDGET ' + JSON.stringify({ per_request: measured, customer_episode: episode }));
});

const startBody = () => ({ language: 'es', mode: 'guided', report_type: 'unrecognized_charge',
  customer_statement: 'No reconozco este cargo.', idempotency_key: crypto.randomUUID() });

test('guided endpoints and complete and incomplete customer episodes preserve measured D1 budgets', async () => {
  assert.equal((await client({ authorization: 'Bearer ' + await idToken('demo-ana') }).call('/auth/session', {})).status, 200); // target present: worst case
  const c = client(); const measured = {};
  measured.login = within('login', (await c.call('/demo/session', { customer_id: 'demo-ana' })).metrics);
  const list = await c.call('/transactions?lang=es'); assertContract('transactionList', list.body);
  measured.list = within('listView', list.metrics);
  const shown = await c.call('/transactions/displayed', { view_ref: list.body.view_ref });
  assert.equal(shown.status, 200); assertContract('chargeViewDisplayed', shown.body);
  measured.displayed = within('displayed', shown.metrics);
  measured.displayedReplay = within('displayed', (await c.call('/transactions/displayed', { view_ref: list.body.view_ref })).metrics);
  const body = startBody(); const start = await c.call('/intake/start', body);
  assert.equal(start.status, 201); assertContract('intakeStart', start.body);
  measured.start = within('intakeStart', start.metrics);
  const startReplay = await c.call('/intake/start', body); assert.equal(startReplay.status, 200);
  measured.startReplay = within('intakeStartReplay', startReplay.metrics);
  const confirmation = { episode_id: start.body.episode_id, transaction_id: 'demo-tx-005', // never confirmed by an earlier suite
    customer_confirmed: true, idempotency_key: crypto.randomUUID() };
  const complete = await c.call('/intake/confirm', confirmation);
  assert.equal(complete.status, 201); assertContract('intakeReceipt', complete.body);
  measured.confirm = within('intakeConfirm', complete.metrics);
  assert.equal(complete.metrics.rows_written, CEILING.intakeConfirm[2], 'the received email was queued');
  const confirmReplay = await c.call('/intake/confirm', confirmation);
  assert.equal(confirmReplay.status, 200); assert.equal(confirmReplay.body.protocol, complete.body.protocol);
  measured.confirmReplay = within('intakeConfirmReplay', confirmReplay.metrics);
  const open = await c.call('/intake/start', startBody()); assert.equal(open.status, 201);
  measured.start2 = within('intakeStart', open.metrics);
  const handoff = { episode_id: open.body.episode_id, kind: 'incomplete', idempotency_key: crypto.randomUUID() };
  const incomplete = await c.call('/intake/handoff', handoff);
  assert.equal(incomplete.status, 201); assertContract('intakeReceipt', incomplete.body);
  measured.incomplete = within('intakeIncomplete', incomplete.metrics);
  assert.equal(incomplete.metrics.rows_written, CEILING.intakeIncomplete[2], 'the received email was queued');
  const incompleteReplay = await c.call('/intake/handoff', handoff);
  assert.equal(incompleteReplay.status, 200); assert.equal(incompleteReplay.body.protocol, incomplete.body.protocol);
  measured.incompleteReplay = within('intakeIncompleteReplay', incompleteReplay.metrics);
  const agent = client();
  measured.agentLogin = within('agentLogin', (await agent.call('/demo/agent-session', {})).metrics);
  const queue = await agent.call('/agent/intakes'); assert.equal(queue.status, 200); assertContract('agentIntakeList', queue.body);
  measured.queue = within('intakeQueue', queue.metrics);
  for (const [name, receipt] of [['completeDetail', complete.body], ['incompleteDetail', incomplete.body]]) {
    const detail = await agent.call('/agent/intake-detail?protocol=' + receipt.protocol);
    assert.equal(detail.status, 200); assertContract('agentIntakeDetail', detail.body); assert.equal(detail.body.kind, receipt.kind);
    measured[name] = within(name, detail.metrics);
  }
  // CLI-COHORT-2 exists only in the cohort fixture and no other test signs in as it, so its history is this one report.
  // Signed in by email, so it has a notification target and the update request reaches the outbox.
  const cohort = client({ authorization: 'Bearer ' + await idToken('CLI-COHORT-2') });
  assert.equal((await cohort.call('/auth/session', {})).status, 200);
  const cohortStart = await cohort.call('/intake/start', startBody()); assert.equal(cohortStart.status, 201);
  const cohortReceipt = await cohort.call('/intake/handoff', { episode_id: cohortStart.body.episode_id, kind: 'incomplete', idempotency_key: crypto.randomUUID() });
  assert.equal(cohortReceipt.status, 201);
  const reports = await cohort.call('/reports'); assert.equal(reports.status, 200); assertContract('reportList', reports.body);
  assert.equal(reports.body.items.length, 1); assert.equal(reports.body.has_more, false);
  measured.reports = within('reports', reports.metrics);
  const update = await cohort.call('/reports/update', { protocol: cohortReceipt.body.protocol });
  assert.equal(update.status, 202); assertContract('updateQueued', update.body);
  measured.reportsUpdate = within('reportsUpdate', update.metrics);
  const transition = await agent.call('/agent/intake-status', { protocol: cohortReceipt.body.protocol, status: 'in_review' });
  assert.equal(transition.status, 200); assertContract('intakeTransition', transition.body);
  measured.agentTransition = within('agentTransition', transition.metrics);
  assert.equal(transition.metrics.rows_written, CEILING.agentTransition[2], 'the in_review email was queued');
  // A high-priority charge (BRL 3,890.00, above the stated BRL 2,500): urgency.test.js closed its earlier report, so this
  // confirm is new (201, not 409). Ana has a notification target, so both requests queue an email (the worst case).
  const high = await c.call('/intake/confirm', { episode_id: (await c.call('/intake/start', startBody())).body.episode_id,
    transaction_id: 'demo-tx-006', customer_confirmed: true, idempotency_key: crypto.randomUUID() });
  assert.equal(high.status, 201); assertContract('intakeReceipt', high.body); assert.equal(high.body.urgency, 'high');
  measured.confirmHigh = within('intakeConfirmHigh', high.metrics);
  assert.equal(high.metrics.rows_written, CEILING.intakeConfirmHigh[2], 'the urgent index entry and the received email were written');
  assert.equal((await agent.call('/agent/intake-status', { protocol: high.body.protocol, status: 'in_review' })).status, 200);
  const closing = await agent.call('/agent/intake-status', { protocol: high.body.protocol, status: 'closed' });
  assert.equal(closing.status, 200); assertContract('intakeTransition', closing.body);
  measured.agentTransitionHigh = within('agentTransitionHigh', closing.metrics);
  assert.equal(closing.metrics.rows_written, CEILING.agentTransitionHigh[2], 'closing queued the email (D1 counts no write for leaving the partial index)');
  const completeEpisode = sum(measured, ['login', 'list', 'displayed', 'start', 'confirm']);
  const incompleteEpisode = sum({ ...measured, start: measured.start2 }, ['login', 'list', 'displayed', 'start', 'incomplete']);
  within('complete episode', completeEpisode, EPISODE_CEILING.complete);
  within('incomplete episode', incompleteEpisode, EPISODE_CEILING.incomplete);
  console.log('D1_GUIDED_BUDGET ' + JSON.stringify({ per_request: measured, complete_episode: completeEpisode, incomplete_episode: incompleteEpisode }));
});

test('housekeeping and export store calls stay within their page budgets', async () => {
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  // Bounded fixture: 100 starts already past the 10-minute idle deadline; no source data.
  const now = Date.now();
  await withIntakeStore({ config: config() }, async store => {
    for (let i = 0; i < 100; i += 20) await Promise.all(Array.from({ length: 20 }, (_, j) => store.startIntake({ customerId: 'demo-bruno',
      language: 'pt', statement: 'Não reconheço esta cobrança.', key: crypto.randomUUID(), now: now - 600000 - i - j, expiresAt: now + 3600000 })));
    const sweep = await storeCall(store, () => store.closeIdleIntakes({ now, limit: 100 }));
    assert.equal(sweep.result.length, 100, 'exactly the fixture page was due');
    within('idleSweepPage', sweep.metrics);
    const repeat = await storeCall(store, () => store.closeIdleIntakes({ now, limit: 100 }));
    assert.equal(repeat.result.length, 0);
    within('idleSweepNoop', repeat.metrics);
    const probe = await storeCall(store, () => store.hasDueIdleIntakes({ now }));
    assert.equal(probe.result, false);
    within('idleDueProbe', probe.metrics);
    // Neither page is the whole table: the first is followed by more episodes, the second starts after a cursor.
    const page = await storeCall(store, () => store.exportIntakeEvents({ afterEpisode: '', limit: 100 }));
    assert.equal(page.result.length, 100, 'the retained population fills more than one export page');
    within('exportPage', page.metrics, exportCeiling(page.result));
    const later = await storeCall(store, () => store.exportIntakeEvents({ afterEpisode: page.result[49].episode_id, limit: 100 }));
    assert.ok(later.result.length > 50, 'a page after a cursor');
    within('exportPageAfterCursor', later.metrics, exportCeiling(later.result));
    const events = rows => rows.reduce((n, row) => n + JSON.parse(row.events_json).length, 0);
    console.log('D1_HOUSEKEEPING_EXPORT ' + JSON.stringify({ idle_page: { closed: 100, ...sweep.metrics }, idle_noop: repeat.metrics, due_probe: probe.metrics,
      export_page: { episodes: 100, events: events(page.result), ceiling: exportCeiling(page.result)[1], ...page.metrics },
      export_after_cursor: { episodes: later.result.length, events: events(later.result), ceiling: exportCeiling(later.result)[1], ...later.metrics } }));
  });
});

test('50-row queue scan budget is qualified against 50 terminal and 50 pending tied reservations', async () => {
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  // Bounded fixture: no source data, exactly 100 incomplete reservations with identical timestamps, stored with the
  // production evidence/action/question shape. Half are acknowledged (terminal); half stay pending, as after a
  // lost read-back. Timestamps a year ahead of the clock keep them at the head of the newest-first queue.
  const now = Date.now() + 365 * 86400000; const sessionHash = '9'.repeat(64);
  const payloadHash = await tokenHash(JSON.stringify(['incomplete', null]));
  const receipts = [];
  await withIntakeStore({ config: config() }, async store => {
    await store.rotateSession({ now: Date.now(), oldHash: null, newHash: sessionHash, actor: 'customer', customerId: 'demo-ana', expiresAt: now + 3600000, requestId: 'budget-fixture' });
    const reserve = async i => {
      const { episode } = await store.startIntake({ customerId: 'demo-ana', language: 'es', statement: 'No reconozco este cargo.', key: crypto.randomUUID(), now, expiresAt: now + 3600000 });
      const { handoff } = await store.persistIntakeHandoff({ customerId: 'demo-ana', episodeId: episode.episode_id, turnKey: crypto.randomUUID(), payloadHash,
        sessionHash, completeCase: null, kind: 'incomplete', evidence: { transaction: null, tool_status: 'ok' }, actions: [],
        questions: ['matching_transaction', 'customer_confirmation'], usage: { tool_calls: 0, operation_duration_ms: 0 }, now });
      assert.ok(handoff);
      if (i % 2) return;
      const receipt = await store.readIntakeReceipt('demo-ana', episode.episode_id, { sessionHash, now });
      assert.equal((await store.finishIntakeHandoff({ customerId: 'demo-ana', episode, receipt, sessionHash, now, operationDuration: 0, toolCalls: 0 })).acknowledged, true);
      receipts.push(receipt.handoff_id);
    };
    for (let i = 0; i < 100; i += 20) await Promise.all(Array.from({ length: 20 }, (_, j) => reserve(i + j)));
  });
  assert.equal(receipts.length, 50);
  const agent = client(); await agent.call('/demo/agent-session', {});
  const queue = await agent.call('/agent/intakes'); assert.equal(queue.status, 200); assertContract('agentIntakeList', queue.body);
  assert.equal(queue.body.items.length, 50); assert.equal(queue.body.has_more, true);
  assert.deepEqual(new Set(queue.body.items.map(x => x.protocol)), new Set(receipts), 'the page holds exactly the tied terminal receipts, never a pending one');
  within('intakeQueue', queue.metrics);
  const detail = await agent.call('/agent/intake-detail?protocol=' + receipts[0]);
  assert.equal(detail.status, 200); assertContract('agentIntakeDetail', detail.body);
  assert.equal(detail.body.verified_evidence.transaction, null);
  within('incompleteDetail', detail.metrics);
  console.log('D1_FULL_QUEUE ' + JSON.stringify({ terminal: 50, pending: 50, tied: true, ...queue.metrics }));
});
