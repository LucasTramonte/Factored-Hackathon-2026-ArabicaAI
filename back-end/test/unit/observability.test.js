/** Structured logs (src/log.js): one JSON line per request and per unexpected error, with references only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/index.js';
import { routeLabel } from '../../src/router.js';

function captured(t) {
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(JSON.parse(line)));
  return lines;
}
const env = { ASSETS: { fetch: async () => new Response('<html>') } };

test('route labels are route-table keys or fixed words, never a raw path or reference', () => {
  assert.equal(routeLabel('/intake/handoff/AR-ABCD-EFGH/messages'), '/intake/handoff/{reference}/messages');
  assert.equal(routeLabel('/intake/handoff/99999999-8888-4777-8666-555555555555/suggestions'), '/intake/handoff/{reference}/suggestions');
  assert.equal(routeLabel('/agent/intake-detail'), '/agent/intake-detail');
  assert.equal(routeLabel('/healthz'), 'healthz');
  assert.equal(routeLabel('/'), 'document');
  assert.equal(routeLabel('/intake/nope'), 'unknown_api');
  assert.equal(routeLabel('/main-ABC123.js'), 'asset');
});

test('each request writes one request line with route, status, latency, ray and D1 counters', async t => {
  const lines = captured(t);
  const response = await worker.fetch(new Request('https://w.example/', { headers: { 'cf-ray': '8c1-GRU' } }), env, {});
  assert.equal(response.status, 200);
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.deepEqual(Object.keys(line).sort(), ['d1_queries', 'd1_rows_read', 'd1_rows_written', 'event', 'method', 'ms', 'ray', 'route', 'status']);
  assert.deepEqual([line.event, line.route, line.method, line.status, line.ray, line.d1_queries], ['request', 'document', 'GET', 200, '8c1-GRU', 0]);
  assert.ok(Number.isInteger(line.ms) && line.ms >= 0);
});

test('an unexpected error logs its class only, then the 503 request line; no path, query or reference leaks', async t => {
  const lines = captured(t);
  // No D1 binding: the store's first query throws inside the route.
  const response = await worker.fetch(new Request('https://w.example/intake/handoff/AR-ABCD-EFGH/messages?q=secret-text',
    { headers: { Cookie: 'demo_session=' + 'a'.repeat(64) } }), env, {});
  assert.equal(response.status, 503);
  assert.deepEqual(lines.map(l => l.event), ['unhandled_error', 'request']);
  assert.equal(lines[0].error, 'TypeError');
  assert.equal(lines[1].status, 503);
  const text = JSON.stringify(lines);
  for (const secret of ['AR-ABCD-EFGH', 'secret-text', 'aaaaaaaa', 'demo_session']) assert.ok(!text.includes(secret), secret);
});


test('a closing failure logs neither explanation, statement, protocol nor provider error text', async t => {
  const lines = captured(t);
  const protocol = crypto.randomUUID(), secret = 'SECRET CLOSING EXPLANATION';
  const DB = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ actor: 'agent', customer_id: null, expires_at: Date.now() + 60000 }] }) }) }),
    batch: async () => { throw new Error(secret); } };
  const response = await worker.fetch(new Request('https://w.example/agent/intake-status', {
    method: 'POST', headers: { Cookie: 'demo_agent_session=' + 'a'.repeat(64) },
    body: JSON.stringify({ protocol, status: 'closed', closing_note: secret })
  }), { ...env, DB }, {});
  assert.equal(response.status, 503);
  assert.deepEqual(lines.map(line => line.event), ['unhandled_error', 'request']);
  assert.equal(lines[0].error, 'Error');
  assert.doesNotMatch(JSON.stringify(lines), /SECRET CLOSING EXPLANATION|closing_note|aaaaaaaa/);
  assert.ok(!JSON.stringify(lines).includes(protocol));
});
