/**
 * The instrumentation test set (Docs/deliverables/BUSINESS_OUTCOMES.md, measurement plan item 3): before any real KPI is
 * trusted, authored journeys with hand-counted expected values (test/fixtures/kpi-journeys.json) run over HTTP against
 * local D1, and the store's ``intakeKpis`` must reproduce every value exactly. A second, independent path (the exported
 * events scored by evals/intake/episodes.py) must agree on every KPI the two share. It tests the measurement, not the
 * customers.
 *
 * Window: the suites run one file at a time, so [start of this test, end of its journeys) holds only these episodes and
 * alert answers. Time seams are the store's own ``now`` parameters, as the other suites use them: the idle sweep runs
 * 11 minutes ahead (``maxNow``), and one agent's first open is stamped 25 hours after acceptance.
 * Determinism: spans are wall-clock, so their expected values come from the scorer; the exact 90-day and 24-hour boundaries
 * are proven in test/unit/intake-kpis.test.js, where every time is set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { base, client, closeReport } from '../support/client.js';
import { assertContract } from '../support/contract.js';
import { scorerPython } from '../../scripts/scorer-python.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/kpi-journeys.json', import.meta.url), 'utf8'));
const config = () => resolve(process.cwd(), 'wrangler.jsonc');
const uuid = () => crypto.randomUUID();
const STATEMENT = { es: 'No reconozco este cargo.', pt: 'Não reconheço esta cobrança.', en: "I don't recognize this charge." };
const HOUR = 3600 * 1000;

async function withStore(work) {
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  return withIntakeStore({ config: config() }, work);
}

/** Drive one journey; returns ``{ episodeId, protocol, status }`` (null fields where the journey made none). */
async function drive(journey, sessions, agent, done) {
  const c = sessions[journey.customer] ??= await (async () => {
    const browser = client();
    assert.equal((await browser.call('/demo/session', { customer_id: journey.customer })).status, 200, journey.customer);
    return browser;
  })();
  const out = { episodeId: null, protocol: null, status: 'received' };
  done.push(out); // before any step, so the cleanup closes even a journey that fails halfway
  for (const step of journey.steps) {
    const label = `${journey.id} ${step.do}`;
    if (step.do === 'start') {
      const res = await c.call('/intake/start', { language: journey.language, mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
        customer_statement: STATEMENT[journey.language], idempotency_key: uuid() });
      assert.equal(res.status, 201, label); out.episodeId = res.body.episode_id;
    } else if (step.do === 'view_charges') {
      const list = await c.call('/transactions?lang=' + journey.language);
      assert.equal(list.status, 200, label);
      assert.equal((await c.call('/transactions/displayed', { view_ref: list.body.view_ref })).status, 200, label);
    } else if (step.do === 'idle') {
      // Nothing to send: the customer leaves; the sweep after phase 1 closes the start.
    } else if (step.do === 'confirm') {
      const res = await c.call('/intake/confirm', { episode_id: out.episodeId, transaction_id: step.transaction, customer_confirmed: true, idempotency_key: uuid() });
      assert.equal(res.status, 201, label + ' ' + JSON.stringify(res.body)); assert.equal(res.body.kind, 'complete'); out.protocol = res.body.protocol;
    } else if (step.do === 'cant_find') {
      const res = await c.call('/intake/handoff', { episode_id: out.episodeId, kind: 'incomplete', idempotency_key: uuid(), ...(step.details && { details: step.details }) });
      assert.equal(res.status, 201, label); out.protocol = res.body.protocol;
    } else if (step.do === 'technical') {
      // The lookup fails inside the confirm, as the unit suites force it (intake-handoff.test.js): the same route and
      // the same local D1, with a store whose charge lookup throws.
      const { route } = await import('../../src/router.js');
      const res = await withStore(async store => route(new Request(base + '/intake/confirm', { method: 'POST',
        headers: { Cookie: c.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ episode_id: out.episodeId, transaction_id: step.transaction, customer_confirmed: true, idempotency_key: uuid() }) }),
      {}, { ...store, findOwnedTransaction: async () => { throw new Error('unavailable'); } }));
      assert.equal(res.status, 201, label); const body = await res.json(); assert.equal(body.kind, 'technical'); out.protocol = body.protocol;
    } else if (step.do === 'alert') {
      const res = await c.call('/alerts/answer', { transaction_id: step.transaction, answer: step.answer });
      assert.equal(res.status, 200, label); assert.equal(res.body.answer, step.answer, label);
    } else if (step.do === 'await_suggestions') {
      let body;
      for (const until = Date.now() + 20000; ;) {
        body = (await c.call(`/intake/handoff/${out.protocol}/suggestions`)).body;
        if (body.status !== 'pending' || Date.now() > until) break;
        await new Promise(done => setTimeout(done, 250));
      }
      assert.equal(body.status, step.expect, label);
    } else if (step.do === 'suggestion_answer') {
      const res = await c.call(`/intake/handoff/${out.protocol}/suggestions/confirm`, step.none ? { none: true } : { transaction_id: step.transaction });
      assert.equal(res.status, 200, label); assertContract('suggestionChoice', res.body);
    } else if (step.do === 'agent_open') {
      assert.equal((await agent.call('/agent/intake-detail?protocol=' + out.protocol)).status, 200, label);
    } else if (step.do === 'agent_open_late') {
      assert.ok(await withStore(store => store.findIntakeHandoff(out.protocol, Date.now() + step.hours * HOUR)), label);
    } else if (step.do === 'agent_status') {
      assert.equal((await agent.call('/agent/intake-status', { protocol: out.protocol, status: step.status })).status, 200, label); out.status = step.status;
    } else if (step.do === 'agent_mark') {
      assert.equal((await agent.call('/agent/suggestion-mark', { protocol: out.protocol, mark: step.mark })).status, 200, label);
    } else {
      throw new Error('Unknown step ' + label);
    }
  }
  return out;
}

/** The scorer's view, in the store's vocabulary, of the KPIs both paths measure. */
function scorerShared(scored) {
  const outcomes = { accepted: 'complete_handoff', routed: 'incomplete_handoff', technical_failure: 'technical_handoff', abandoned: 'abandoned', pending: 'pending' };
  return { started: scored.eligible_started,
    outcomes: Object.fromEntries(Object.entries(scored.outcomes).map(([k, v]) => [outcomes[k], v])),
    clarifications_per_episode: scored.clarifications_per_episode, span: [scored.latency_p50_ms, scored.latency_p95_ms],
    by_arm: Object.fromEntries(Object.entries(scored.suggestions.by_arm).map(([arm, results]) => [arm === 'None' ? 'none' : arm, results])) };
}
function storeShared(block) {
  return { started: block.reports.started, outcomes: Object.fromEntries(Object.entries(block.reports.outcomes).filter(([, v]) => v)),
    clarifications_per_episode: block.friction.clarifications_per_episode.rate, span: [block.friction.span_ms.p50, block.friction.span_ms.p95],
    by_arm: block.suggestions.by_arm };
}

test('authored journeys: intakeKpis reproduces every hand-counted KPI, and the scored events agree on every shared one', async t => {
  const sinceMs = Date.now();
  const sessions = {};
  const agent = client(); assert.equal((await agent.call('/demo/agent-session', {})).status, 200);
  const done = [];
  // Registered first, so a failing step can't leave open reports in the shared D1 for the suites after this one.
  t.after(async () => { for (const { protocol, status } of done) if (protocol && status !== 'closed') await closeReport(protocol); });
  for (const phase of [1, 2]) {
    for (const journey of fixture.journeys.filter(j => j.phase === phase)) await drive(journey, sessions, agent, done);
    if (phase === 1) {
      // The idle-close path, 11 minutes ahead (``maxNow`` is the store's fake-clock seam): every start left open is due.
      const now = Date.now() + 11 * 60 * 1000;
      await withStore(async store => { while ((await store.closeIdleIntakes({ now, maxNow: now })).length === 100); });
    }
  }
  const untilMs = Date.now() + 1;
  const kpis = await withStore(store => store.intakeKpis({ sinceMs, untilMs }));

  // Path 2: export every episode, keep this test's, and score them with the episode scorer.
  const { exportIntakeEvents } = await import('../../scripts/export-intake-events.mjs');
  const root = resolve(import.meta.dirname, '../../..');
  const dir = resolve(root, 'data/intake-events', uuid());
  await mkdir(dir, { recursive: true }); t.after(() => rm(dir, { recursive: true, force: true }));
  await withStore(store => exportIntakeEvents(store, { output: resolve(dir, 'all.jsonl'), python: process.env.INTAKE_PYTHON }));
  const mine = new Set(done.map(d => d.episodeId).filter(Boolean));
  const lines = (await readFile(resolve(dir, 'all.jsonl'), 'utf8')).trim().split('\n').filter(line => mine.has(JSON.parse(line).case_id));
  await writeFile(resolve(dir, 'mine.jsonl'), lines.join('\n') + '\n');
  const scored = JSON.parse(execFileSync(scorerPython(), ['-m', 'evals.intake.episodes', resolve(dir, 'mine.jsonl')], { cwd: root, encoding: 'utf8' }));

  for (const lang of ['all', 'es', 'pt', 'en']) assert.deepEqual(storeShared(kpis.by_language[lang]), scorerShared(scored[lang]), lang);

  // Path 1, exactly: the wall-clock spans are the only values not counted by hand, and they come from the scorer.
  const expected = structuredClone(fixture.expected);
  for (const lang of Object.keys(expected.by_language)) {
    const span = expected.by_language[lang].friction.span_ms;
    Object.assign(span, { p50: scored[lang].latency_p50_ms, p95: scored[lang].latency_p95_ms });
  }
  assert.deepEqual(kpis.by_language, expected.by_language);
  assert.deepEqual(kpis.alerts, expected.alerts);
  assert.deepEqual(kpis.window, { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() });
  const text = JSON.stringify(kpis);
  for (const leak of ['demo-', 'kpi-tx', 'reconozco', 'reconheço', 'recognize this', ...mine]) assert.ok(!text.includes(leak), leak);
  console.log('KPI_INSTRUMENTATION ' + JSON.stringify({ episodes: mine.size, span_all: kpis.by_language.all.friction.span_ms }));
});

test('the KPI script prints the aggregates as JSON with no identifier, local by default, and refuses a bad window without opening the store', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = resolve(import.meta.dirname, '../../scripts/intake-kpis.mjs');
  const cli = args => spawnSync(process.execPath, [script, '--config', config(), ...args], { encoding: 'utf8', timeout: 120000 });
  const ok = cli(['--since', '2026-01-01']);
  assert.equal(ok.status, 0, ok.stderr);
  const printed = JSON.parse(ok.stdout);
  assert.deepEqual(Object.keys(printed), ['window', 'by_language', 'alerts', 'metrics']);
  assert.equal(printed.metrics.rowsWritten, 0); assert.equal(printed.metrics.roundTrips, 1);
  for (const leak of ['demo-', 'kpi-tx', 'customer_id', 'transaction_id']) assert.ok(!ok.stdout.includes(leak), leak);
  for (const args of [['--since', 'yesterday'], ['--since', '2026-10-02', '--until', '2026-10-01'], ['--until', '2026-13-01']]) {
    const bad = cli(args);
    assert.equal(bad.status, 1, args.join(' ')); assert.equal(bad.stdout, ''); assert.equal(bad.stderr, 'KPI read failed\n');
  }
});
