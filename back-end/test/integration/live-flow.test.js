/** The main customer and agent flow against local D1; every JSON body is checked against the contracts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertContract } from '../support/contract.js';
import { base, client } from '../support/client.js';

test('pages are public; customers are isolated; replay and handoff work', async () => {
  for (const path of ['/', '/index.html', '/agent']) {
    const page = await fetch(base + path);
    assert.equal(page.status, 200, path);
    assert.match(await page.text(), /<app-root/);
  }
  assert.equal((await fetch(base + '/favicon.ico')).status, 200, 'static files are served without the Worker');
  assert.equal((await client().call('/transactions')).status, 401);

  const ids = await client().call('/demo/identities');
  assert.equal(ids.status, 200);
  assertContract('identityList', ids.body);

  const ana = client();
  const bruno = client();
  const noSession = await ana.call('/transactions');
  assert.equal(noSession.status, 401);
  assertContract('error', noSession.body);
  const login = await ana.call('/demo/session', { customer_id: 'demo-ana' });
  assert.equal(login.status, 200);
  assertContract('customerSession', login.body);
  assert.equal((await bruno.call('/demo/session', { customer_id: 'demo-bruno' })).status, 200);

  const anaRows = await ana.call('/transactions');
  assertContract('transactionList', anaRows.body);
  assert.deepEqual(new Set(anaRows.body.items.map(x => x.transaction_id)), new Set(['demo-tx-001', 'demo-tx-002', 'demo-tx-004', 'demo-tx-005', 'demo-tx-006']));
  assert.deepEqual((await bruno.call('/transactions')).body.items.map(x => x.transaction_id), ['demo-tx-003']);

  const request = { transaction_id: 'demo-tx-001', customer_statement: 'I do not recognize this charge.',
    customer_confirmed: true, idempotency_key: crypto.randomUUID() };
  assert.equal((await ana.call('/cases', { ...request, customer_confirmed: false })).status, 422);
  assert.equal((await ana.call('/cases', { ...request, customer_confirmed: 'true' })).status, 422);
  assert.equal((await bruno.call('/cases', request)).status, 404);
  const first = await ana.call('/cases', request);
  assert.equal(first.status, 201);
  assertContract('caseReceipt', first.body);
  assert.equal(first.body.replayed, false);
  const retry = await ana.call('/cases', request);
  assert.equal(retry.status, 200);
  assertContract('caseReceipt', retry.body);
  assert.equal(retry.body.protocol, first.body.protocol);
  assert.equal(retry.body.replayed, true);
  assert.equal((await ana.call('/cases', { ...request, customer_statement: 'A changed statement.' })).status, 409);

  const agent = client();
  assert.equal((await agent.call('/agent/intakes')).status, 401);
  const agentLogin = await agent.call('/demo/agent-session', {});
  assert.equal(agentLogin.status, 200);
  assertContract('agentSession', agentLogin.body);
  // Agents read only the approved queue of acknowledged guided handoffs (issue #69); a legacy case is not in it.
  const queue = await agent.call('/agent/intakes');
  assertContract('agentIntakeList', queue.body);
  assert.ok(!queue.body.items.some(x => x.protocol === first.body.protocol));
});

test('dataset sample keeps the source wall time and original amount', async () => {
  const sample = client();
  const login = await sample.call('/demo/session', { customer_id: 'CLI-U53R5AZVLET0' });
  assert.equal(login.status, 200);
  assertContract('customerSession', login.body);
  assert.deepEqual(login.body.context_card.products[0],
    { product_type: 'Credit card', last4: '4444', currency: 'ARS' });
  assert.equal(login.body.context_card.snapshot_at, '2026-09-29T00:00:00+00:00');
  const list = await sample.call('/transactions');
  assertContract('transactionList', list.body);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].occurred_at, null);
  assert.equal(list.body.items[0].source_occurred_at, '2026-02-26T13:21:51');
  assert.equal(list.body.items[0].amount, '29763.49');
  assert.equal(list.body.items[0].currency, 'ARS');
});

test('health check is public and reveals nothing else', async () => {
  const res = await fetch(base + '/healthz');
  assert.equal(res.status, 200);
  const body = await res.json();
  assertContract('health', body);
});
