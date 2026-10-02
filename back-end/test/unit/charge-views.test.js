/** GET /transactions?lang= records a charge view; POST /transactions/displayed acknowledges it (ADR-009). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgeDisplay, listTransactions } from '../../src/modules/customer/routes.js';
import { API_ROUTES, ROUTE_ROLES } from '../../src/router.js';
import { assertContract } from '../support/contract.js';

const COOKIE = 'demo_session=' + 'a'.repeat(64);
const VIEW = '0f8fad5b-d9cb-469f-a165-70867728950e';
const row = i => ({ transaction_id: `demo-tx-${i}`, occurred_at: null, source_occurred_at: null, merchant_name: 'M',
  amount: '1.00', currency: 'USD' });

function store({ rows = 3, insert, ack = () => 1700 } = {}) {
  const calls = [];
  return { calls,
    findSession: async () => ({ customer_id: 'demo-ana' }),
    recordAuthEvent: async () => {},
    listTransactions: async () => Array.from({ length: rows }, (_, i) => row(i)),
    insertChargeView: async args => { calls.push(['insert', args]); if (insert) throw insert; },
    acknowledgeChargeView: async (...args) => { calls.push(['ack', ...args]); return ack(); } };
}
async function list(query, s = store()) {
  const res = await listTransactions(new Request('https://d.example/transactions' + query, { headers: { Cookie: COOKIE } }), {}, s);
  return { status: res.status, body: await res.json(), calls: s.calls };
}
async function ack(body, s = store(), cookie = COOKIE) {
  const res = await acknowledgeDisplay(new Request('https://d.example/transactions/displayed', { method: 'POST',
    headers: cookie ? { Cookie: cookie } : {}, body: typeof body === 'string' ? body : JSON.stringify(body) }), {}, s);
  return { status: res.status, body: await res.json(), calls: s.calls };
}

test('without lang nothing is recorded and view_ref is null', async () => {
  const r = await list('');
  assert.equal(r.status, 200);
  assert.equal(r.body.view_ref, null);
  assert.deepEqual(r.calls, []);
});

test('an unsupported lang is 422 and records nothing', async () => {
  for (const q of ['?lang=fr', '?lang=', '?lang=ES', '?lang=es-AR']) {
    const r = await list(q);
    assert.equal(r.status, 422, q);
    assert.deepEqual(r.calls, []);
  }
});

test('a valid lang records the served view and returns its view_ref', async () => {
  const r = await list('?lang=pt', store({ rows: 21 }));
  assert.equal(r.status, 200);
  assertContract('transactionList', r.body);
  const [[name, args]] = r.calls;
  assert.equal(name, 'insert');
  assert.equal(args.viewRef, r.body.view_ref);
  assert.match(args.viewRef, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...args, viewRef: 0, now: 0 }, { viewRef: 0, customerId: 'demo-ana', language: 'pt', rowCount: 20,
    hasMore: true, coverage: 'fictitious_demo_data_only', now: 0 });
  assert.equal(typeof args.now, 'number');
});

test('a failed insert still serves the rows, unrecorded', async () => {
  const r = await list('?lang=en', store({ insert: new Error('d1 down') }));
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 3);
  assert.equal(r.body.view_ref, null);
});

test('acknowledgement needs a customer session', async () => {
  const r = await ack({ view_ref: VIEW }, store(), null);
  assert.equal(r.status, 401);
  assert.deepEqual(r.calls, []);
});

test('acknowledgement body must be exactly { view_ref: uuid }', async () => {
  for (const body of [{ view_ref: VIEW, extra: 1 }, { view_ref: 'nope' }, { view_ref: 1 }, {}, [VIEW], null, VIEW, 'not json']) {
    const r = await ack(body === VIEW ? JSON.stringify(VIEW) : body);
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.deepEqual(r.calls, []);
  }
});

test('an unknown or another customer\'s view is 404', async () => {
  const r = await ack({ view_ref: VIEW }, store({ ack: () => null }));
  assert.equal(r.status, 404);
  assert.deepEqual(r.calls, [['ack', VIEW, 'demo-ana', r.calls[0][3]]]);
});

test('an acknowledged view returns its first displayed_at', async () => {
  const r = await ack({ view_ref: VIEW });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { view_ref: VIEW, displayed_at: 1700 });
  assertContract('chargeViewDisplayed', r.body);
});

test('the route is a customer POST', () => {
  assert.equal(API_ROUTES['/transactions/displayed'].POST, acknowledgeDisplay);
  assert.equal(ROUTE_ROLES['/transactions/displayed'], 'customer');
});
