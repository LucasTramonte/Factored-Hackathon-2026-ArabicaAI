/**
 * Charge views (ADR-009) against the real local D1: the gate and method matrix, session swap and expiry, isolation,
 * hostile input, concurrent idempotency and contracts, then the authored inquiry cases of decision 5. A test passes
 * only when the attack fails. With INQUIRY_OUT set (never in CI), each authored case appends its observed outcome as
 * one JSONL line to that path, which must be inside the repository's ignored data/charge-views/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { assertContract } from '../support/contract.js';
import { base, client } from '../support/client.js';
import { listTransactions } from '../../src/modules/customer/routes.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const OUT = process.env.INQUIRY_OUT ? resolve(ROOT, process.env.INQUIRY_OUT) : null;
if (OUT && !OUT.startsWith(resolve(ROOT, 'data/charge-views') + sep)) throw new Error('INQUIRY_OUT must be inside data/charge-views/');
const COVERAGES = ['fictitious_demo_data_only', 'dataset_cohort'];
// The seeded charges each authored customer owns; any other served id is another customer's row.
const OWNS = { 'demo-ana': id => ['demo-tx-001', 'demo-tx-002', 'demo-tx-004', 'demo-tx-005', 'demo-tx-006'].includes(id),
  'CLI-COHORT-3': id => /^cohort3-tx-\d\d$/.test(id), 'CLI-COHORT-4': () => false };
const uuid = () => crypto.randomUUID();

async function loggedIn(customerId = 'demo-ana') {
  const c = client();
  assert.equal((await c.call('/demo/session', { customer_id: customerId })).status, 200);
  return c;
}
const displayed = (c, view_ref) => c.call('/transactions/displayed', { view_ref });
const viewOf = async (c, lang = 'es') => (await c.call('/transactions?lang=' + lang)).body.view_ref;
/** Append one observed outcome when INQUIRY_OUT is set, and return it. */
function record(outcome) {
  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); appendFileSync(OUT, JSON.stringify(outcome) + '\n'); }
  return outcome;
}

test('/transactions/displayed: POST only, 405 with Allow for every other method, with or without a session', async () => {
  const ana = await loggedIn();
  for (const headers of [{}, { Cookie: ana.cookie }]) {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(base + '/transactions/displayed', { method, headers });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get('Allow'), 'POST');
    }
  }
});

test('no session, an agent session, a swapped, forged or expired token: 401 on both routes, nothing recorded', async () => {
  const ana = await loggedIn();
  const view = await viewOf(ana);
  const agent = client(); await agent.call('/demo/agent-session', {});
  const agentToken = agent.cookie.split('=')[1];
  for (const cookie of ['', agent.cookie, `demo_session=${agentToken}`, `demo_session=${'f'.repeat(64)}`, 'demo_session=x',
    `demo_session=${process.env.EXPIRED_TOKEN}`, ana.cookie.replace('demo_session', 'demo_agent_session')]) {
    const c = client(); c.cookie = cookie;
    for (const res of [await c.call('/transactions?lang=es'), await displayed(c, view)]) {
      assert.equal(res.status, 401, cookie.slice(0, 24));
      assert.deepEqual(res.body, { detail: 'Start a demo session first' });
      assert.equal(res.headers.get('set-cookie'), null);
    }
  }
  const after = Date.now();
  const own = await displayed(ana, view);
  assert.equal(own.status, 200);
  assert.ok(own.body.displayed_at >= after, 'no refused request acknowledged the view');
});

test('lang: unsupported values are 422 and write nothing; without lang the rows are served unrecorded', async () => {
  const ana = await loggedIn();
  for (const lang of ['fr', '', 'ES', 'es-AR', '%00', "es'--"]) {
    const res = await ana.call('/transactions?lang=' + lang);
    assert.equal(res.status, 422, lang);
    assertContract('error', res.body);
    assert.equal(res.metrics.rows_written, 0, lang);
  }
  const plain = await ana.call('/transactions');
  assert.equal(plain.status, 200);
  assertContract('transactionList', plain.body);
  assert.equal(plain.body.view_ref, null);
  assert.equal(plain.metrics.rows_written, 0, 'no charge_views row');
});

test('forged, malformed and padded acknowledgements are refused and write nothing', async () => {
  const ana = await loggedIn();
  const view = await viewOf(ana);
  for (const forged of [uuid(), view.toUpperCase()]) {
    const res = await displayed(ana, forged);
    assert.equal(res.status, 404, forged);
    assertContract('error', res.body);
    assert.equal(res.metrics.rows_written, 0);
  }
  for (const body of [{ view_ref: view, customer_id: 'demo-ana' }, { view_ref: view, displayed_at: 1 }, { view_ref: 'nope' },
    { view_ref: '' }, { view_ref: 42 }, { view_ref: null }, { view_ref: [view] }, { view_ref: view + ' ' }, { view_ref: "' OR 1=1 --" },
    {}, [view], JSON.stringify(view), '{"view_ref":', '{"__proto__": {"view_ref": "' + view + '"}}']) {
    const res = await ana.call('/transactions/displayed', body);
    assert.equal(res.status, 422, JSON.stringify(body));
    assertContract('error', res.body);
    assert.equal(res.metrics.rows_written, 0);
  }
});

test("isolation: another customer acknowledging Ana's view gets 404, writes nothing and leaves the row unacknowledged", async () => {
  const ana = await loggedIn(); const bruno = await loggedIn('demo-bruno');
  const view = await viewOf(ana);
  const foreign = await displayed(bruno, view), missing = await displayed(bruno, uuid());
  assert.equal(foreign.status, 404);
  assert.equal(foreign.text, missing.text, 'foreign and missing views look identical');
  assert.equal(foreign.metrics.rows_written, 0);
  const after = Date.now();
  const own = await displayed(ana, view);
  assert.equal(own.status, 200);
  assert.ok(own.body.displayed_at >= after, 'still unacknowledged after the foreign attempt');
  assert.equal((await displayed(bruno, view)).status, 404, 'an acknowledged view stays foreign');
  assert.equal((await displayed(ana, view)).body.displayed_at, own.body.displayed_at);
});

test('20 concurrent acknowledgements of one view all succeed with one identical displayed_at', async () => {
  const ana = await loggedIn();
  const view = await viewOf(ana, 'pt');
  const results = await Promise.all(Array.from({ length: 20 }, () => fetch(base + '/transactions/displayed', {
    method: 'POST', headers: { Cookie: ana.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ view_ref: view }) }).then(async r => ({ status: r.status, body: await r.json() }))));
  assert.deepEqual(results.map(r => r.status), Array(20).fill(200));
  for (const r of results) { assertContract('chargeViewDisplayed', r.body); assert.equal(r.body.view_ref, view); }
  assert.equal(new Set(results.map(r => r.body.displayed_at)).size, 1);
});

// Authored inquiry cases (ADR-009 decision 5): the only population for safe automated resolution.
const SHAPES = {
  normal: ['demo-ana', b => b.items.length === 5 && !b.has_more],
  empty: ['CLI-COHORT-4', b => b.items.length === 0 && !b.has_more],
  has_more: ['CLI-COHORT-3', b => b.items.length === 20 && b.has_more]
};
for (const language of ['es', 'pt', 'en']) {
  for (const [shape, [customerId, fits]] of Object.entries(SHAPES)) {
    test(`inquiry ${language}-${shape}: the view is served, recorded and acknowledged for its owner`, async () => {
      const c = await loggedIn(customerId);
      const list = await c.call('/transactions?lang=' + language);
      const ack = list.body?.view_ref ? await displayed(c, list.body.view_ref) : null;
      const outcome = record({ case_id: `${language}-${shape}`, language, in_scope: true, attempted: list.status === 200,
        displayed: ack?.status === 200, coverage_declared: COVERAGES.includes(list.body?.coverage),
        unsafe: !(list.body?.items ?? []).every(x => OWNS[customerId](x.transaction_id)) });
      assertContract('transactionList', list.body);
      assert.ok(fits(list.body), `${shape}: ${list.body.items.length} items, has_more ${list.body.has_more}`);
      assertContract('chargeViewDisplayed', ack.body);
      assert.deepEqual(outcome, { case_id: `${language}-${shape}`, language, in_scope: true, attempted: true, displayed: true,
        coverage_declared: true, unsafe: false });
    });
  }
}

test('inquiry es-expired-session: nothing is served, recorded or acknowledged', async () => {
  const ana = await loggedIn();
  const view = await viewOf(ana);
  const c = client(); c.cookie = `demo_session=${process.env.EXPIRED_TOKEN}`;
  const list = await c.call('/transactions?lang=es');
  const ack = await displayed(c, view);
  const after = Date.now();
  const own = await displayed(ana, view);
  const outcome = record({ case_id: 'es-expired-session', language: 'es', in_scope: true, attempted: list.status === 200,
    displayed: ack.status === 200, coverage_declared: COVERAGES.includes(list.body?.coverage),
    unsafe: list.status === 200 || ack.status === 200 || Boolean(list.body?.view_ref) || own.body.displayed_at < after });
  assert.equal(list.status, 401); assert.equal(ack.status, 401);
  assert.deepEqual(outcome, { case_id: 'es-expired-session', language: 'es', in_scope: true, attempted: false, displayed: false,
    coverage_declared: false, unsafe: false });
});

test("inquiry pt-cross-customer: Bruno cannot acknowledge Ana's view; Ana still can", async () => {
  const ana = await loggedIn(); const bruno = await loggedIn('demo-bruno');
  const list = await ana.call('/transactions?lang=pt');
  const foreign = await displayed(bruno, list.body.view_ref);
  const after = Date.now();
  const own = await displayed(ana, list.body.view_ref);
  const outcome = record({ case_id: 'pt-cross-customer', language: 'pt', in_scope: true, attempted: list.status === 200,
    displayed: own.status === 200, coverage_declared: COVERAGES.includes(list.body.coverage),
    unsafe: foreign.status !== 404 || own.body.displayed_at < after || !list.body.items.every(x => OWNS['demo-ana'](x.transaction_id)) });
  assert.equal(foreign.status, 404);
  assert.deepEqual(outcome, { case_id: 'pt-cross-customer', language: 'pt', in_scope: true, attempted: true, displayed: true,
    coverage_declared: true, unsafe: false });
});

test('inquiry en-tool-failure: when recording the view fails the rows are still served, with no view to acknowledge', async () => {
  // Local D1 cannot be made to fail through the Worker, so the real handler runs in-process on the real local D1
  // store with only insertChargeView replaced by a throwing one.
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  const ana = await loggedIn();
  const res = await withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, store => listTransactions(
    new Request(base + '/transactions?lang=en', { headers: { Cookie: ana.cookie } }), {},
    { ...store, insertChargeView: async () => { throw new Error('D1 unavailable'); } }));
  const body = await res.json();
  const outcome = record({ case_id: 'en-tool-failure', language: 'en', in_scope: true, attempted: res.status === 200,
    displayed: false, coverage_declared: COVERAGES.includes(body.coverage),
    unsafe: !body.items.every(x => OWNS['demo-ana'](x.transaction_id)) });
  assertContract('transactionList', body);
  assert.equal(body.view_ref, null);
  assert.equal(body.items.length, 5);
  assert.deepEqual(outcome, { case_id: 'en-tool-failure', language: 'en', in_scope: true, attempted: true, displayed: false,
    coverage_declared: true, unsafe: false });
});
