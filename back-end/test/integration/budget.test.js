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
import { close } from '../support/close.js';
import { assertContract } from '../support/contract.js';
import { tokenHash } from '../../src/auth/session.js';
import { exportPKCS8, generateKeyPair } from 'jose';
import { readWranglerConfig } from '../../scripts/predeploy.mjs';
import { runSuggestion } from '../../src/modules/intake/suggestions.js';

// Ceilings per request: [queries, rows_read, rows_written, round_trips]. D1 Free allows 50 queries per invocation;
// round trips drive latency (about 150 ms each when the Worker runs far from D1).
const CEILING = {
  // Dedicated support paths; reservation reads scale only with the shared <=200/day bounded probe.
  customerAssist: [10, 300, 6, 9],
  customerAssistFull: [10, 550, 6, 9],
  customerAssistDuplicate: [5, 40, 0, 4],
  transactionDiscovery: [8, 300, 6, 7],
  transactionDiscoveryDuplicate: [5, 40, 0, 4],
  reviewerAssist: [7, 225, 6, 6],
  reviewerAssistFull: [7, 500, 6, 6],
  reviewerAssistDuplicate: [4, 20, 0, 3],
  assistedMessagePost: [3, 16, 4, 2],
  // One query listing the dataset cohort. It reads every customers row: 16 rows_read measured with the four evaluator
  // identities; no margin. About 800 with the cohort loaded (ADR-004).
  identities: [1, 16, 0, 1],
  // Every session start and logout also writes one auth_events row in its existing batch (migration 0012): one query,
  // 1 read and 2 writes (the row and auth_events_time), no round trip; logout's insert also checks the session (ADR-004).
  login: [6, 10, 6, 3],
  // First email sign-in inserts notification_targets row + TEXT primary-key index; a warm upsert writes one row.
  // Existing-cost fixture qualification, not a production change (ADR-004, 2026-10-04 Task 4a note).
  emailLoginCold: [6, 10, 7, 3],
  list: [2, 25, 0, 2],
  // GET /transactions?lang= (ADR-009): list plus one charge_views insert (row and primary key), one more round trip.
  listView: [3, 26, 2, 3],
  // POST /transactions/displayed: session, then one UPDATE … RETURNING; a replay rewrites the same row (COALESCE).
  displayed: [2, 5, 1, 2],
  logout: [2, 3, 3, 1],
  // An admin's logout with both cookies: one revoke batch per presented session (customer and agent). Measured, no margin.
  logoutBoth: [4, 6, 6, 2],
  create: [4, 12, 6, 4],
  agentLogin: [3, 6, 6, 1],
  // GET /audit/events (issue #69): no session read; one batch of two reads by primary key/rowid, at most limit + 1 rows each.
  audit: [2, 102, 0, 1],
  // GET /auth/me (ADR-013 phase 0), one customer cookie: its session read and the context-card read; no write. A second
  // (agent) cookie adds one session read. Measured, no margin.
  authMe: [2, 1, 0, 2],
  // GET /admin/customers (ADR-007, decision 10): the session read, then the identities query above (every customers row:
  // 16 measured here, about 800 with the cohort loaded). POST /admin/act-as: session, customerSource and context card
  // reads, then actAsSession's single-use batch: its inserts each check a session by primary key (the presented admin
  // session, then the new one twice), which adds 4 reads over a plain rotation. Measured, no margin (ADR-004).
  adminCustomers: [2, 17, 0, 2],
  adminActAs: [8, 9, 8, 4],
  // ADR-011. GET /alerts: the session read, then one read over the customer's own flagged charges (each checked against
  // proactive_answers and cases by key). POST /alerts/answer: session, then one batch (a guarded insert and its read-back);
  // the row and its primary key are the two writes, none on a replay. Measured, no margin.
  alert: [2, 3, 0, 2],
  // Migration 0025's index proactive_answers_time adds one write to the answer (2 -> 3; ADR-004, 2026-10-04 KPI note).
  alertAnswer: [3, 3, 3, 2],
  // The CHECK on intake_episodes.reason (migration 0016, ADR-010) adds one counted read to each statement that writes an
  // episode row, as 0004's CHECKs did: start 8 -> 9 and replay 6 -> 7 rows read, measured with and without it (ADR-004).
  // Migration 0018's index intake_episodes_owner_recent adds one write to the episode insert (11 -> 12), and migration
  // 0025's intake_episodes_created one more (12 -> 13), for the KPI window (ADR-004, 2026-10-04 KPI note).
  intakeStart: [6, 9, 13, 2],
  intakeStartReplay: [6, 7, 2, 2],
  // The first acknowledgement queues one "received" email for a customer with a notification target (Task 3.2):
  // one more statement in the acknowledgement batch, 3 writes (row, primary key, email_outbox_recent).
  // One open report per charge (Task 4.4): one more query and round trip that reads only that charge's cases
  // (index cases_customer_transaction, migration 0011), and one more write for that index on the case insert (ADR-004).
  // Urgency lane (Task 5.1, migration 0013): one more query and round trip reads the customer's served purchases
  // (at most 21) to apply the stated policy; a normal charge writes no urgent-index entry (ADR-004).
  // Seven acknowledgement writes exclude newer or still-open same-charge reports: +28 reads in this fixture (ADR-004).
  intakeConfirm: [21, 102, 27, 10],
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
  // Session, then the newest reviewed timing baseline (migration 0027): one statement over two rows, no write.
  // Measured 2026-10-04: 2 queries, 7 rows read, 0 written, 2 round trips.
  serviceTimes: [2, 7, 0, 2],
  // ADR-015: the session, then one batch. A post inserts guarded by the report's state and count, then reads back the
  // key; both statements revalidate the live customer session (12–13 rows read; ceiling 13). A read returns the report status and at
  // most 51 messages through handoff_messages_thread (7/8 rows read alone/in the full suite; ceiling 8).
  messagePost: [3, 13, 4, 2],
  messageThread: [3, 8, 0, 2],
  // Session, owned report with its target flag, the outbox insert that checks the 5-minute window itself (row, primary
  // key, email_outbox_recent); the send marks the row from its own store after the response (Task 3.3).
  reportsUpdate: [3, 14, 3, 3],
  // POST /reports/feedback (migration 0019): session, then one batch that inserts the first answer (row + primary key)
  // and reads it back; a repeated answer inserts nothing. Outside the episode ceilings: the customer may never answer.
  reportFeedback: [3, 10, 2, 2],
  // Agent session, then one batch: history row (+ unique index), the customer's email (row, primary key,
  // email_outbox_recent) and the status update; each statement resolves the handoff by its unique keys (ADR-004).
  agentTransition: [5, 26, 6, 2],
  // A high-priority charge (Task 5.1): its confirm writes one more row, the entry in the partial index
  // intake_handoffs_urgent; closing it writes what a normal close writes, since D1 counts no write for leaving that index.
  // The confirm batch repeats the one-open-report check atomically (NOT EXISTS over cases_customer_transaction): +1 read.
  // Its earlier closed same-charge report makes those seven guards cost +42 reads (ADR-004).
  // 120 -> 129 rows read (ADR-011): the proactive suite leaves one more closed high-urgency report in the shared store, and the
  // urgent partial index grows with it. Measured on the same code with and without that suite (120 / 129); queries, writes
  // and round trips are unchanged (ADR-004, 2026-10-04 note).
  intakeConfirmHigh: [21, 129, 28, 10],
  agentTransitionHigh: [5, 26, 6, 2],
  // The detail batch (migration 0018): stamp the first open (1 write, once), the row, and the customer's newest 21
  // episodes (index intake_episodes_owner_recent) with at most 20 other reports, so reads are bounded by window size.
  // The raw window also keeps null pending/current slots internally so has_more cannot under-report a full window.
  // Linked follow-up fixtures fill more acknowledged slots: complete detail measures 82 reads (ADR-004).
  // Migration 0024 (ADR-012): the detail row also joins the suggestion run, the customer's answer, its charge and the
  // agent's mark, each by primary key, in the same statement: +1 read on the complete detail (82 -> 83; ADR-004, 2026-10-04 note).
  completeDetail: [5, 83, 1, 3],
  incompleteDetail: [5, 80, 1, 3],
  // AI suggestions (ADR-012, migration 0024); measured, no margin (ADR-004, 2026-10-04 note). An incomplete handoff with
  // details inserts its suggestion run (row and primary key) in the reservation batch: one more query, no round trip,
  // whatever the switch, plus its entry in the pending-run partial index (20 -> 21 writes). GET suggestions: the session,
  // then one batch: the first read that serves suggested charges stamps shown_at (1 write, once), and one owner-scoped read
  // of the run, answer and at most three charges. Confirm and mark: the session, then one batch (a guarded insert and its
  // read-back); a replay writes nothing. The after-response run (ctx.waitUntil, its own store): the atomic claim, the cap
  // slot, the pre-recorded call, the customer's purchases (one batch of two reads, at most 200 charges) and the outcome
  // batch (run, at most three suggestions, one event). Review fixes, 2026-10-04: claim and shown_at (ADR-004 note).
  // Circuit breaker, 2026-10-04 (ADR-006 amendment 10): one read of the last five model-calling outcomes through migration
  // 0026's partial index (+1 query, +1 round trip, +5 rows read), and that index's entry when the run finishes (+1 write).
  intakeIncompleteDetails: [16, 52, 21, 7],
  suggestions: [3, 14, 1, 2],
  suggestionConfirm: [3, 10, 2, 2],
  suggestionDetail: [5, 83, 1, 3],
  suggestionMark: [3, 7, 2, 2],
  suggestionRun: [9, 36, 10, 6],
  // The idle sweep's suggestion part (ADR-012): one atomic batch per page of at most 100 stale runs of acknowledged
  // handoffs, both statements picking the page through the pending-run partial index: one event per run (its episode's
  // next seq and a check that it has none yet: about 23 reads a run), then the update. Nothing due reads 7 rows.
  // Measured on 100 fixture runs, no margin (ADR-004, 2026-10-04 note).
  suggestionSweepPage: [2, 2300, 300, 1],
  suggestionSweepNoop: [2, 7, 0, 1],
  // Operator scripts, per store call: one atomic page of 100 due starts, a sweep with nothing due, the due probe.
  idleSweepPage: [2, 1210, 300, 1],
  idleSweepNoop: [2, 10, 0, 1],
  idleDueProbe: [1, 3, 0, 1],
  // The dispute managers' KPI read (intakeKpis, scripts/intake-kpis.mjs): one batch of seven reads, one round trip, no
  // write. The window is found through migration 0025's indexes, so an empty one costs a constant 32 rows (index probes and
  // the empty intermediate results of the ranking and alert statements), whatever the store holds. KPI_FIXTURE acknowledged
  // handoffs, one complete report and three alert answers cost 1,034 (about 46 an episode: each of five statements reads the
  // episode's index entry, row, handoff and events, and the span and repeat statements count their materialized and ranked
  // rows again; the alert statements read each answer, its charge and its charge's reports). Measured, no margin (ADR-004).
  kpisEmpty: [7, 32, 0, 1],
  kpisFixture: [7, 1034, 0, 1]
};
const KPI_FIXTURE = 20;
// An export page reads about 2 rows per episode (its page entry and the look-ahead that ends its event range) plus
// its events, so the ceiling is computed from the page actually read, with a small fixed slack. A scan of
// intake_episodes or intake_events adds rows per retained episode or event and fails here even on a small store.
// The guided producer writes at most 5 events per episode, so a full page is at most 702 rows.
const EXPORT_SLACK = 2;
const exportCeiling = rows => [1, 2 * rows.length + rows.reduce((n, row) => n + JSON.parse(row.events_json).length, 0) + EXPORT_SLACK, 0, 1];
// Customer requests of one guided episode (login + list?lang= + displayed + start + terminal request), as the client
// sends them from ADR-009 on; ADR-004 sizes capacity on these.
// Migration 0018's episode index adds one write to each episode's start (complete 46 -> 47, incomplete 37 -> 38), and
// migration 0025's one more (complete 47 -> 48, incomplete 38 -> 39).
const EPISODE_CEILING = { complete: [37, 125, 48, 20], incomplete: [31, 75, 39, 17] };

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
  // This bounded cohort identity has no email sign-in in earlier suites; admin act-as never stores its address.
  // Assert absence so a warm fixture cannot silently hide the first-login write. The demo login above already
  // purges the expired seed session; neither measured email login sends a prior cookie.
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  await withIntakeStore({ config: config() }, async store => assert.equal(await store.findNotificationTarget('CLI-COHORT-2'), null));
  const emailLogin = async () => client({ authorization: 'Bearer ' + await idToken('CLI-COHORT-2') }).call('/auth/session', {});
  const cold = await emailLogin(); assert.equal(cold.status, 200);
  measured.emailLoginCold = within('emailLoginCold', cold.metrics);
  assert.equal(cold.metrics.rows_written, 7, 'first notification target writes its row and primary-key index');
  await withIntakeStore({ config: config() }, async store => assert.ok(await store.findNotificationTarget('CLI-COHORT-2')));
  const warm = await emailLogin(); assert.equal(warm.status, 200);
  measured.emailLoginWarm = within('login', warm.metrics);
  assert.equal(warm.metrics.rows_written, 6, 'existing notification target rewrites only its row');
  measured.list = within('list', (await c.call('/transactions')).metrics);
  measured.create = within('create', (await c.call('/cases', { transaction_id: 'demo-tx-001',
    customer_statement: 'Budget probe: I do not recognize this charge.', customer_confirmed: true,
    idempotency_key: crypto.randomUUID() })).metrics);
  measured.logout = within('logout', (await c.call('/auth/logout', {})).metrics);
  const adminToken = 'Bearer ' + await idToken('demo-diego', { groups: ['admin'] });
  const adminCustomer = client({ authorization: adminToken }); const adminAgent = client({ authorization: adminToken });
  assert.equal((await adminCustomer.call('/auth/session', {})).status, 200);
  assert.equal((await adminAgent.call('/demo/agent-session', {})).status, 200);
  const both = client(); both.cookie = `${adminCustomer.cookie}; ${adminAgent.cookie}`;
  const loggedOut = await both.call('/auth/logout', {});
  assert.equal(loggedOut.status, 204); measured.logoutBoth = within('logoutBoth', loggedOut.metrics);
  const agent = client();
  measured.agentLogin = within('agentLogin', (await agent.call('/demo/agent-session', {})).metrics);
  measured.agentEmailLogin = within('agentLogin', (await client({ authorization: 'Bearer ' + await idToken('agent@test', { groups: ['agent'] }) })
    .call('/demo/agent-session', {})).metrics);
  const audit = await client({ authorization: 'Bearer ' + await idToken('auditor@test', { groups: ['auditor'] }) }).call('/audit/events');
  assert.equal(audit.status, 200); measured.audit = within('audit', audit.metrics);
  // ADR-013 phase 0: a reload with a live customer session restores it.
  const reloaded = client(); assert.equal((await reloaded.call('/demo/session', { customer_id: 'demo-ana' })).status, 200);
  const restored = await reloaded.call('/auth/me');
  assert.equal(restored.status, 200); measured.authMe = within('authMe', restored.metrics);
  const admin = client({ authorization: 'Bearer ' + await idToken('demo-diego', { groups: ['admin'] }) });
  assert.equal((await admin.call('/auth/session', {})).status, 200);
  const customers = await admin.call('/admin/customers');
  assert.equal(customers.status, 200); measured.adminCustomers = within('adminCustomers', customers.metrics);
  const actAs = await admin.call('/admin/act-as', { customer_id: 'demo-ana' });
  assert.equal(actAs.status, 200); measured.adminActAs = within('adminActAs', actAs.metrics);
  // ADR-011: Elena's flagged charge (the proactive suite answers it only as an admin, so it is still shown to her).
  const elena = client({ authorization: 'Bearer ' + await idToken('demo-elena') });
  assert.equal((await elena.call('/auth/session', {})).status, 200);
  const alert = await elena.call('/alerts');
  assert.equal(alert.status, 200); measured.alert = within('alert', alert.metrics);
  const answer = await elena.call('/alerts/answer', { transaction_id: 'demo-tx-020', answer: 'mine' });
  assert.equal(answer.status, 200); measured.alertAnswer = within('alertAnswer', answer.metrics);
  const episode = sum(measured, ['login', 'list', 'create']);
  console.log('D1_BUDGET ' + JSON.stringify({ per_request: measured, customer_episode: episode }));
});

const startBody = () => ({ language: 'es', mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
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
  const feedback = await c.call('/reports/feedback', { protocol: complete.body.protocol, easy: true });
  assert.equal(feedback.status, 200); assertContract('reportFeedback', feedback.body);
  measured.feedback = within('reportFeedback', feedback.metrics);
  measured.feedbackReplay = within('reportFeedback', (await c.call('/reports/feedback', { protocol: complete.body.protocol, easy: true })).metrics);
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
  const times = await cohort.call('/intake/service-times'); assert.equal(times.status, 200); assertContract('serviceTimes', times.body);
  measured.serviceTimes = within('serviceTimes', times.metrics);
  const posted = await cohort.call(`/intake/handoff/${cohortReceipt.body.protocol}/messages`, { body: 'Fue el martes.', idempotency_key: crypto.randomUUID() });
  assert.equal(posted.status, 201); assertContract('reportMessage', posted.body);
  measured.messagePost = within('messagePost', posted.metrics);
  const thread = await cohort.call(`/intake/handoff/${cohortReceipt.body.protocol}/messages`); assert.equal(thread.status, 200);
  assertContract('messageThread', thread.body);
  measured.messageThread = within('messageThread', thread.metrics);
  const update = await cohort.call('/reports/update', { protocol: cohortReceipt.body.protocol });
  assert.equal(update.status, 202); assertContract('updateQueued', update.body);
  measured.reportsUpdate = within('reportsUpdate', update.metrics);
  // An admin acting as that customer asks too: same three statements, the target read is the admin's own (ADR-007, decision 10).
  const admin = client({ authorization: 'Bearer ' + await idToken('demo-diego', { groups: ['admin'] }) });
  assert.equal((await admin.call('/auth/session', {})).status, 200);
  assert.equal((await admin.call('/admin/act-as', { customer_id: 'CLI-COHORT-2' })).status, 200);
  const acting = await admin.call('/reports/update', { protocol: cohortReceipt.body.protocol });
  assert.equal(acting.status, 202); measured.reportsUpdateActing = within('reportsUpdate', acting.metrics);
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
  const closing = await agent.call('/agent/intake-status', { protocol: high.body.protocol, status: 'closed', closing_note: 'Review finished; contact the bank for help.' });
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
      language: 'pt', statement: 'Não reconheço esta cobrança.', reason: 'not_mine', key: crypto.randomUUID(), now: now - 600000 - i - j, expiresAt: now + 3600000 })));
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
      const { episode } = await store.startIntake({ customerId: 'demo-ana', language: 'es', statement: 'No reconozco este cargo.', reason: 'not_mine', key: crypto.randomUUID(), now, expiresAt: now + 3600000 });
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
  assert.equal(detail.body.customer_history.has_more, true, 'the newest 21 episodes fill the window even with pending slots');
  assert.ok(detail.body.customer_history.reports <= 20);
  within('incompleteDetail', detail.metrics);
  console.log('D1_FULL_QUEUE ' + JSON.stringify({ terminal: 50, pending: 50, tied: true, ...queue.metrics }));
  console.log('D1_FULL_HISTORY ' + JSON.stringify({ ...detail.metrics, customer_history: detail.body.customer_history }));
});


test('a dense acknowledged history qualifies detail reads with the current report outside the window', async () => {
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  const now = Date.now() + 366 * 86400000, sessionHash = await tokenHash('dense-history-' + crypto.randomUUID()); // unique: fixed hashes collide with other fixtures
  const payloadHash = await tokenHash(JSON.stringify(['incomplete', null]));
  let protocol;
  // Bounded 22-report synthetic fixture, newer than the mixed queue fixture; the oldest report is outside LIMIT21.
  await withIntakeStore({ config: config() }, async store => {
    await store.rotateSession({ now: Date.now(), oldHash: null, newHash: sessionHash, actor: 'customer', customerId: 'demo-ana', expiresAt: now + 3600000, requestId: 'dense-history-fixture' });
    for (let i = 0; i < 22; i++) {
      const at = now + i;
      const { episode } = await store.startIntake({ customerId: 'demo-ana', language: 'es', statement: 'No reconozco este cargo.', reason: 'not_mine', key: crypto.randomUUID(), now: at, expiresAt: now + 3600000 });
      await store.persistIntakeHandoff({ customerId: 'demo-ana', episodeId: episode.episode_id, turnKey: crypto.randomUUID(), payloadHash, sessionHash,
        completeCase: null, kind: 'incomplete', evidence: { transaction: null, tool_status: 'ok' }, actions: [], questions: ['matching_transaction', 'customer_confirmation'], usage: { tool_calls: 0, operation_duration_ms: 0 }, now: at });
      const receipt = await store.readIntakeReceipt('demo-ana', episode.episode_id, { sessionHash, now: at });
      assert.equal((await store.finishIntakeHandoff({ customerId: 'demo-ana', episode, receipt, sessionHash, now: at, operationDuration: 0, toolCalls: 0 })).acknowledged, true);
      if (!i) protocol = receipt.handoff_id;
    }
  });
  const agent = client(); await agent.call('/demo/agent-session', {});
  const first = await agent.call('/agent/intake-detail?protocol=' + protocol);
  assert.equal(first.status, 200); assertContract('agentIntakeDetail', first.body);
  assert.equal(first.body.customer_history.reports, 20); assert.equal(first.body.customer_history.has_more, true);
  const replay = await agent.call('/agent/intake-detail?protocol=' + protocol);
  assert.equal(replay.status, 200); assert.equal(replay.metrics.rows_written, 0);
  console.log('D1_DENSE_HISTORY ' + JSON.stringify({ first: first.metrics, replay: replay.metrics }));
});

test('AI suggestion routes and the after-response run stay within their D1 budgets', async () => {
  const measured = {};
  const c = client(); assert.equal((await c.call('/demo/session', { customer_id: 'demo-ana' })).status, 200);
  const start = await c.call('/intake/start', startBody()); assert.equal(start.status, 201);
  const details = 'Lembro só do mercado. FACTS={"merchant":"Mercado Demo"}';
  const handoff = await c.call('/intake/handoff', { episode_id: start.body.episode_id, kind: 'incomplete', idempotency_key: crypto.randomUUID(), details });
  assert.equal(handoff.status, 201); assertContract('intakeReceipt', handoff.body);
  measured.incompleteDetails = within('intakeIncompleteDetails', handoff.metrics);
  const path = `/intake/handoff/${handoff.body.protocol}/suggestions`;
  let shown;
  for (const until = Date.now() + 15000; ;) {
    shown = await c.call(path);
    if (shown.body.status !== 'pending' || Date.now() > until) break;
    await new Promise(done => setTimeout(done, 200));
  }
  assert.equal(shown.body.status, 'suggested'); assertContract('suggestionList', shown.body);
  measured.suggestions = within('suggestions', shown.metrics);
  const confirm = await c.call(path + '/confirm', { transaction_id: 'demo-tx-001' });
  assert.equal(confirm.status, 200); measured.suggestionConfirm = within('suggestionConfirm', confirm.metrics);
  measured.suggestionConfirmReplay = within('suggestionConfirm', (await c.call(path + '/confirm', { transaction_id: 'demo-tx-001' })).metrics);
  const agent = client(); await agent.call('/demo/agent-session', {});
  const detail = await agent.call('/agent/intake-detail?protocol=' + handoff.body.protocol);
  assert.equal(detail.status, 200); assert.equal(detail.body.customer_suggestion.choice, 'confirmed');
  measured.suggestionDetail = within('suggestionDetail', detail.metrics);
  const mark = await agent.call('/agent/suggestion-mark', { protocol: handoff.body.protocol, mark: 'correct' });
  assert.equal(mark.status, 200); measured.suggestionMark = within('suggestionMark', mark.metrics);
  measured.suggestionMarkReplay = within('suggestionMark', (await agent.call('/agent/suggestion-mark', { protocol: handoff.body.protocol, mark: 'correct' })).metrics);
  for (const status of ['in_review', 'closed']) assert.equal((await agent.call('/agent/intake-status', { protocol: handoff.body.protocol, status, ...(status === 'closed' ? { closing_note: 'Review finished; contact the bank for help.' } : {}) })).status, 200);
  // The after-response run (ctx.waitUntil) uses a store of its own, so it is measured here on a store-built pending run,
  // with Google faked in process: cap slot, pre-recorded call, the customer's purchases, and the outcome batch.
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  const { vars } = await readWranglerConfig(config());
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const env = { ...vars, INTAKE_AI_ENABLED: '1', VERTEX_MODEL_RETIRES: '2099-01-01', VERTEX_WIF_SIGNING_KEY: await exportPKCS8(privateKey) };
  const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const fetcher = async url => String(url).endsWith('/v1/token') ? reply({ access_token: 'f' })
    : String(url).endsWith(':generateAccessToken') ? reply({ accessToken: 'v', expireTime: new Date(Date.now() + 3600000).toISOString() })
      : reply({ choices: [{ message: { content: JSON.stringify({ intent: 'report', stated_facts: { merchant: 'Mercado Demo' }, invalid: null, demand: null, injection: false }) } }],
        usage: { prompt_tokens: 1840, completion_tokens: 84 } });
  const now = Date.now(); const sessionHash = await tokenHash('suggestion-budget-' + crypto.randomUUID());
  await withIntakeStore({ config: config() }, async store => {
    await store.rotateSession({ now, oldHash: null, newHash: sessionHash, actor: 'customer', customerId: 'demo-ana', expiresAt: now + 3600000, requestId: 'suggestion-budget' });
    const { episode } = await store.startIntake({ customerId: 'demo-ana', language: 'pt', statement: 'Não reconheço esta cobrança.', reason: 'not_mine', key: crypto.randomUUID(), now, expiresAt: now + 3600000 });
    const { handoff: reserved } = await store.persistIntakeHandoff({ customerId: 'demo-ana', episodeId: episode.episode_id, turnKey: crypto.randomUUID(),
      payloadHash: await tokenHash(JSON.stringify(['incomplete', null, details])), sessionHash, details, completeCase: null, kind: 'incomplete',
      evidence: { transaction: null, tool_status: 'ok' }, actions: [], questions: ['matching_transaction', 'customer_confirmation'],
      usage: { tool_calls: 0, operation_duration_ms: 0 }, now, suggestionArm: 'B' });
    const receipt = await store.readIntakeReceipt('demo-ana', episode.episode_id, { sessionHash, now });
    assert.equal((await store.finishIntakeHandoff({ customerId: 'demo-ana', episode, receipt, sessionHash, now, operationDuration: 0, toolCalls: 0 })).acknowledged, true);
    const run = await storeCall(store, () => runSuggestion(env, store, { handoffId: reserved.handoff_id, customerId: 'demo-ana', arm: 'B', details, language: 'pt' }, { fetcher }));
    assert.equal(run.result, 'suggested');
    measured.suggestionRun = within('suggestionRun', run.metrics);
    await close(store, reserved.handoff_id);
  });
  console.log('D1_AI_SUGGESTIONS ' + JSON.stringify(measured));
});

test('the idle sweep closes a page of 100 stale suggestion runs, and a sweep with nothing due, within their budgets', async () => {
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  // Bounded fixture: 100 acknowledged incomplete handoffs with details whose runs were never started, 11 minutes old.
  const now = Date.now(); const old = now - 660000; const sessionHash = await tokenHash('suggestion-sweep-' + crypto.randomUUID());
  const details = 'Não lembro de nada, só que foi cobrado.';
  const payloadHash = await tokenHash(JSON.stringify(['incomplete', null, details]));
  const measured = {};
  await withIntakeStore({ config: config() }, async store => {
    await store.rotateSession({ now, oldHash: null, newHash: sessionHash, actor: 'customer', customerId: 'demo-bruno', expiresAt: now + 3600000, requestId: 'suggestion-sweep' });
    const reserve = async () => {
      const { episode } = await store.startIntake({ customerId: 'demo-bruno', language: 'pt', statement: 'Não reconheço esta cobrança.', reason: 'not_mine', key: crypto.randomUUID(), now: old, expiresAt: now + 3600000 });
      await store.persistIntakeHandoff({ customerId: 'demo-bruno', episodeId: episode.episode_id, turnKey: crypto.randomUUID(), payloadHash, sessionHash, details,
        completeCase: null, kind: 'incomplete', evidence: { transaction: null, tool_status: 'ok' }, actions: [], questions: ['matching_transaction', 'customer_confirmation'],
        usage: { tool_calls: 0, operation_duration_ms: 0 }, now: old, suggestionArm: 'B' });
      const receipt = await store.readIntakeReceipt('demo-bruno', episode.episode_id, { sessionHash, now });
      assert.equal((await store.finishIntakeHandoff({ customerId: 'demo-bruno', episode, receipt, sessionHash, now, operationDuration: 0, toolCalls: 0 })).acknowledged, true);
    };
    for (let i = 0; i < 100; i += 20) await Promise.all(Array.from({ length: 20 }, reserve));
    const page = await storeCall(store, () => store.closeStaleSuggestionRuns({ now, limit: 100 }));
    assert.equal(page.result.length, 100, 'exactly the fixture page was due');
    measured.page = within('suggestionSweepPage', page.metrics);
    const noop = await storeCall(store, () => store.closeStaleSuggestionRuns({ now, limit: 100 }));
    assert.equal(noop.result.length, 0);
    measured.noop = within('suggestionSweepNoop', noop.metrics);
  });
  console.log('D1_SUGGESTION_SWEEP ' + JSON.stringify(measured));
});

test("the dispute managers' KPI read stays bounded by its window: a constant for an empty one, a fixed cost per episode in it", async () => {
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  // Bounded fixture: 20 acknowledged incomplete handoffs started two years ago, a window no other suite writes to, then three
  // alert answers by demo-carla on kpi_seed.sql's budget charges ("mine" later reported, "mine", "not mine") and that one
  // complete report, so the alert statements are costed too. Runs last in this file, so its starts never meet the idle
  // sweeps above (they are acknowledged, never due anyway).
  const old = Date.now() - 2 * 365 * 86400000; const sessionHash = await tokenHash('kpi-budget-' + crypto.randomUUID());
  const payloadHash = await tokenHash(JSON.stringify(['incomplete', null]));
  const measured = {};
  await withIntakeStore({ config: config() }, async store => {
    await store.rotateSession({ now: Date.now(), oldHash: null, newHash: sessionHash, actor: 'customer', customerId: 'demo-bruno', expiresAt: Date.now() + 3600000, requestId: 'kpi-budget' });
    for (let i = 0; i < KPI_FIXTURE; i++) {
      const at = old + i;
      const { episode } = await store.startIntake({ customerId: 'demo-bruno', language: 'pt', statement: 'Não reconheço esta cobrança.', reason: 'not_mine', key: crypto.randomUUID(), now: at, expiresAt: at + 3600000 });
      await store.persistIntakeHandoff({ customerId: 'demo-bruno', episodeId: episode.episode_id, turnKey: crypto.randomUUID(), payloadHash, sessionHash,
        completeCase: null, kind: 'incomplete', evidence: { transaction: null, tool_status: 'ok' }, actions: [], questions: ['matching_transaction', 'customer_confirmation'],
        usage: { tool_calls: 0, operation_duration_ms: 0 }, now: at });
      const receipt = await store.readIntakeReceipt('demo-bruno', episode.episode_id, { sessionHash, now: at });
      assert.equal((await store.finishIntakeHandoff({ customerId: 'demo-bruno', episode, receipt, sessionHash, now: at, operationDuration: 0, toolCalls: 0 })).acknowledged, true);
    }
    const carlaHash = await tokenHash('kpi-budget-carla-' + crypto.randomUUID());
    await store.rotateSession({ now: Date.now(), oldHash: null, newHash: carlaHash, actor: 'customer', customerId: 'demo-carla', expiresAt: Date.now() + 3600000, requestId: 'kpi-budget' });
    for (const [i, transactionId, answer] of [[0, 'kpi-tx-04', 'mine'], [1, 'kpi-tx-05', 'mine'], [2, 'kpi-tx-06', 'report']])
      assert.ok(await store.answerProactiveAlert({ customerId: 'demo-carla', transactionId, answeredBy: 'customer', answer, now: old + KPI_FIXTURE + i }));
    const at = old + KPI_FIXTURE + 3;
    const { episode } = await store.startIntake({ customerId: 'demo-carla', language: 'es', statement: 'No reconozco este cargo.', reason: 'not_mine', key: crypto.randomUUID(), now: at, expiresAt: at + 3600000 });
    await store.persistIntakeHandoff({ customerId: 'demo-carla', episodeId: episode.episode_id, turnKey: crypto.randomUUID(), payloadHash: await tokenHash(JSON.stringify(['complete', 'kpi-tx-04'])),
      sessionHash: carlaHash, completeCase: { transaction_id: 'kpi-tx-04' }, kind: 'complete', evidence: { transaction: null, tool_status: 'ok' }, actions: [], questions: [],
      usage: { tool_calls: 0, operation_duration_ms: 0 }, now: at });
    const receipt = await store.readIntakeReceipt('demo-carla', episode.episode_id, { sessionHash: carlaHash, now: at });
    assert.equal((await store.finishIntakeHandoff({ customerId: 'demo-carla', episode, receipt, sessionHash: carlaHash, now: at, operationDuration: 0, toolCalls: 0 })).acknowledged, true);
    const empty = await storeCall(store, () => store.intakeKpis({ sinceMs: old - 86400000, untilMs: old - 1 }));
    assert.equal(empty.result.by_language.all.reports.started, 0);
    measured.empty = within('kpisEmpty', empty.metrics);
    const fixture = await storeCall(store, () => store.intakeKpis({ sinceMs: old, untilMs: at + 1 }));
    assert.equal(fixture.result.by_language.all.reports.started, KPI_FIXTURE + 1, 'exactly the fixture is in the window');
    assert.deepEqual([fixture.result.alerts.answered, fixture.result.alerts.recognized_then_reported, fixture.result.alerts.deflected], [3, 1, 1]);
    await close(store, receipt.complete_case_id);
    measured.fixture = within('kpisFixture', fixture.metrics);
  });
  console.log('D1_INTAKE_KPIS ' + JSON.stringify({ episodes: KPI_FIXTURE + 1, answers: 3, ...measured }));
});

test('reviewer assistance and atomic assisted sends stay within separate complete API budgets', async () => {
  const customer = client(); await customer.call('/demo/session', { customer_id: 'demo-ana' });
  const start = await customer.call('/intake/start', startBody()); assert.equal(start.status, 201);
  const receipt = await customer.call('/intake/handoff', { episode_id: start.body.episode_id, kind: 'incomplete', idempotency_key: crypto.randomUUID() }); assert.equal(receipt.status, 201);
  const agent = client(); await agent.call('/demo/agent-session', {});
  const body = { protocol: receipt.body.protocol, language: 'es', request_id: crypto.randomUUID() };
  const generated = await agent.call('/agent/intake-assist', body); assert.equal(generated.status, 200); assertContract('reviewerAssist', generated.body);
  within('reviewerAssist', generated.metrics);
  const duplicate = await agent.call('/agent/intake-assist', body); assert.equal(duplicate.status, 409); within('reviewerAssistDuplicate', duplicate.metrics);
  const message = { protocol: receipt.body.protocol, body: 'Pregunta revisada', idempotency_key: crypto.randomUUID(), expected_snapshot: generated.body.snapshot };
  const sent = await agent.call('/agent/intake-messages', message); assert.equal(sent.status, 201); within('assistedMessagePost', sent.metrics);
  const replay = await agent.call('/agent/intake-messages', message); assert.equal(replay.status, 200); within('assistedMessagePost', replay.metrics);
  const stale = await agent.call('/agent/intake-messages', { ...message, idempotency_key: crypto.randomUUID() }); assert.equal(stale.status, 409); within('assistedMessagePost', stale.metrics);
  for (let i = 1; i < 50; i++) assert.equal((await customer.call(`/intake/handoff/${receipt.body.protocol}/messages`, { body: 'Dato ' + i, idempotency_key: crypto.randomUUID() })).status, 201);
  const full = await agent.call('/agent/intake-assist', { ...body, request_id: crypto.randomUUID() }); assert.equal(full.status, 200); within('reviewerAssistFull', full.metrics);
  console.log('D1_REVIEWER_ASSIST ' + JSON.stringify({ generation: generated.metrics, full: full.metrics, duplicate: duplicate.metrics, send: sent.metrics, replay: replay.metrics, stale: stale.metrics }));
});


test('customer classification stays within its own complete API budgets for short and full threads',async()=>{
 const customer=client();await customer.call('/demo/session',{customer_id:'demo-ana'});const start=await customer.call('/intake/start',startBody());const receipt=await customer.call('/intake/handoff',{episode_id:start.body.episode_id,kind:'incomplete',idempotency_key:crypto.randomUUID()});assert.equal(receipt.status,201);
 const path=`/intake/handoff/${receipt.body.protocol}/assist`,body={question:'Status?',language:'en',request_id:crypto.randomUUID()};
 const generated=await customer.call(path,body);assert.equal(generated.status,200);assertContract('customerAssist',generated.body);within('customerAssist',generated.metrics);
 const duplicate=await customer.call(path,body);assert.equal(duplicate.status,409);within('customerAssistDuplicate',duplicate.metrics);
 for(let i=0;i<50;i++)assert.equal((await customer.call(`/intake/handoff/${receipt.body.protocol}/messages`,{body:'Synthetic detail '+i,idempotency_key:crypto.randomUUID()})).status,201);
 const full=await customer.call(path,{...body,request_id:crypto.randomUUID()});assert.equal(full.status,200);within('customerAssistFull',full.metrics);
 console.log('D1_CUSTOMER_ASSIST '+JSON.stringify({generation:generated.metrics,duplicate:duplicate.metrics,full:full.metrics}));
});

test('transaction discovery stays within its own complete API budget', async () => {
 const customer=client();await customer.call('/demo/session',{customer_id:'demo-ana'});const start=await customer.call('/intake/start',startBody());assert.equal(start.status,201);
 const body={description:'Mercado this week DISCOVER={"merchant_hint":"Mercado"}',language:'es',request_id:crypto.randomUUID(),episode_id:start.body.episode_id};
 const found=await customer.call('/intake/transaction-discovery',body);assert.equal(found.status,200);assertContract('transactionDiscovery',found.body);within('transactionDiscovery',found.metrics);
 const duplicate=await customer.call('/intake/transaction-discovery',body);assert.equal(duplicate.status,409);within('transactionDiscoveryDuplicate',duplicate.metrics);
 console.log('D1_TRANSACTION_DISCOVERY '+JSON.stringify({found:found.metrics,duplicate:duplicate.metrics}));
});
