/**
 * GET /intake/service-times against the real local D1 (migration 0027): the reviewed historical baseline, served only to
 * a live customer session, with its population and exclusions, and never as a prediction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertContract } from '../support/contract.js';
import { base, client } from '../support/client.js';

async function loggedIn(customerId = 'demo-ana') {
  const c = client();
  assert.equal((await c.call('/demo/session', { customer_id: customerId })).status, 200);
  return c;
}

test('a customer gets the reviewed baseline: first response 25/44 h on 6,045 of 10,370, resolution marked resolved-only', async () => {
  const ana = await loggedIn();
  const res = await ana.call('/intake/service-times');
  assert.equal(res.status, 200);
  assertContract('serviceTimes', res.body);
  assert.equal(res.body.basis, 'bank_history');
  assert.deepEqual(res.body.population, { subcategory: 'Cargo no reconocido', window_start: '2023-06-17',
    window_end_exclusive: '2026-01-01', complaints: 10370, source: 'silver.fact_complaints' });
  const metric = Object.fromEntries(res.body.metrics.map(m => [m.metric, m]));
  assert.deepEqual(metric.first_response, { metric: 'first_response', unit: 'hours', p50: 25, p90: 44, n: 6045, missing: 4325, negative: 0, covers: 'responded' });
  assert.equal(metric.creation_to_resolution.covers, 'resolved_only');
  assert.equal(metric.creation_to_resolution.n, 2414);
  for (const m of res.body.metrics) assert.equal(m.n + m.missing + m.negative, res.body.population.complaints, m.metric);
});

test('the same baseline for every customer, and identical under 20 concurrent reads', async () => {
  const [ana, bruno] = [await loggedIn('demo-ana'), await loggedIn('demo-bruno')];
  const reads = await Promise.all([...Array(20)].map((_, i) => (i % 2 ? ana : bruno).call('/intake/service-times')));
  assert.ok(reads.every(r => r.status === 200));
  assert.equal(new Set(reads.map(r => JSON.stringify(r.body))).size, 1);
});

test('no customer session, an agent session or a forged cookie: 401; any query or other method is refused', async () => {
  for (const headers of [{}, { Cookie: 'demo_session=' + '0'.repeat(64) }, { Authorization: 'Bearer forged' }]) {
    const res = await fetch(base + '/intake/service-times', { headers });
    assert.equal(res.status, 401, JSON.stringify(headers));
  }
  const ana = await loggedIn();
  const agentCookie = ana.cookie.replace('demo_session', 'demo_agent_session');
  assert.equal((await fetch(base + '/intake/service-times', { headers: { Cookie: agentCookie } })).status, 401);
  for (const query of ['?x=1', '?version=0000000000000000', "?metric=first_response'--", '?']) {
    const res = await fetch(base + '/intake/service-times' + query, { headers: { Cookie: ana.cookie } });
    assert.equal(res.status, query === '?' ? 200 : 422, query);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await fetch(base + '/intake/service-times', { method, headers: { Cookie: ana.cookie } });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('Allow'), 'GET');
  }
  for (const path of ['/intake/service-times/', '/intake/service-times/x', '/intake/Service-Times', '/intake/service%2Dtimes']) {
    assert.equal((await fetch(base + path, { headers: { Cookie: ana.cookie } })).status, 404, path);
  }
});
