/** Exercise the same-origin Worker against an isolated local Wrangler D1 fixture. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.WORKER_TEST_URL || 'http://127.0.0.1:8787';
const auth = 'Basic ' + Buffer.from('local-reviewer:local-test-password').toString('base64');

function client() {
  let cookie = '';
  return {
    async call(path, body) {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: auth, Cookie: cookie,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const received = response.headers.get('set-cookie');
      if (received) cookie = received.split(';', 1)[0];
      return { status: response.status, body: await response.json() };
    }
  };
}

test('gate, customer isolation, confirmation, replay, and agent handoff', async () => {
  const denied = await fetch(base + '/');
  assert.equal(denied.status, 401);
  const page = await fetch(base + '/', { headers: { Authorization: auth } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /ArabicaDemoUi/);
  const ana = client();
  const bruno = client();
  assert.equal((await ana.call('/transactions')).status, 401);
  assert.equal((await ana.call('/demo/session', { customer_id: 'demo-ana' })).status, 200);
  assert.equal((await bruno.call('/demo/session', { customer_id: 'demo-bruno' })).status, 200);
  assert.deepEqual(new Set((await ana.call('/transactions')).body.items.map(x => x.transaction_id)),
    new Set(['demo-tx-001', 'demo-tx-002']));
  assert.deepEqual((await bruno.call('/transactions')).body.items.map(x => x.transaction_id),
    ['demo-tx-003']);
  const request = { transaction_id: 'demo-tx-001',
    customer_statement: 'I do not recognize this charge.',
    customer_confirmed: true, idempotency_key: crypto.randomUUID() };
  assert.equal((await ana.call('/cases', { ...request, customer_confirmed: false })).status, 422);
  assert.equal((await ana.call('/cases', { ...request, customer_confirmed: 'true' })).status, 422);
  assert.equal((await bruno.call('/cases', request)).status, 404);
  const first = await ana.call('/cases', request);
  assert.equal(first.status, 201);
  assert.equal(first.body.status, 'accepted');
  const retry = await ana.call('/cases', request);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.protocol, first.body.protocol);
  assert.equal(retry.body.replayed, true);
  assert.equal((await ana.call('/cases', { ...request, customer_statement: 'A changed statement.' })).status, 409);
  const agent = client();
  assert.equal((await agent.call('/agent/cases')).status, 401);
  assert.equal((await agent.call('/demo/agent-session', {})).status, 200);
  const cases = (await agent.call('/agent/cases')).body.items;
  assert.ok(cases.some(x => x.protocol === first.body.protocol && x.customer_confirmed === true));
});

test('sample fixture preserves source wall time and original amount', async () => {
  const sample = client();
  assert.equal((await sample.call('/demo/session', { customer_id: 'CLI-U53R5AZVLET0' })).status, 200);
  const rows = (await sample.call('/transactions')).body.items;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].occurred_at, null);
  assert.equal(rows[0].source_occurred_at, '2026-02-26T13:21:51');
  assert.equal(rows[0].amount, '29763.49');
  assert.equal(rows[0].currency, 'ARS');
});
