/** Failure injection through a fake store, request-body limits and route dispatch. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { withMetrics } from '../../src/index.js';
import { route } from '../../src/router.js';
import { readJsonBody, MAX_BODY_BYTES } from '../../src/http.js';
import { tokenHash } from '../../src/auth/session.js';
import { assertContract } from '../support/contract.js';

const env = { DEMO_ACCESS_USERNAME: 'u', DEMO_ACCESS_PASSWORD: 'p' };
const auth = 'Basic ' + Buffer.from('u:p').toString('base64');
const token = 'a'.repeat(64);
const body = { transaction_id: 'tx-1', customer_statement: 'I do not recognize this charge.',
  customer_confirmed: true, idempotency_key: '0f8fad5b-d9cb-469f-a165-70867728950e' };

function post(path, payload, cookie = `demo_session=${token}`) {
  return new Request('https://demo.example.workers.dev' + path, { method: 'POST',
    headers: { Authorization: auth, Cookie: cookie, 'Content-Type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
}

async function fakeStore(overrides = {}) {
  const hash = await tokenHash(token);
  return {
    findSession: async (h, actor) => (h === hash && actor === 'customer' ? { customer_id: 'ana' } : null),
    ownsTransaction: async () => true,
    insertCase: async () => 'new-case-id',
    findCaseByKey: async () => ({ case_id: '11111111-2222-4333-8444-555555555555', transaction_id: 'tx-1',
      customer_statement: body.customer_statement, status: 'accepted', accepted_at: '2026-09-29T12:00:00Z' }),
    metrics: () => ({ queries: 0, rowsRead: 0, rowsWritten: 0 }),
    ...overrides
  };
}

test('insert failure returns 503 and no protocol', async () => {
  const res = await route(post('/cases', body), env, await fakeStore({ insertCase: async () => { throw new Error('D1 down'); } }));
  assert.equal(res.status, 503);
  const payload = await res.json();
  assert.equal(payload.protocol, undefined);
  assert.match(payload.detail, /retry with the same idempotency key/);
});

test('a missing re-read never produces a receipt', async () => {
  const res = await route(post('/cases', body), env, await fakeStore({ findCaseByKey: async () => null }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).protocol, undefined);
});

test('unexpected store errors become a generic 503 without internals', async () => {
  const brokenDb = { prepare() { throw new Error('SQLITE_BUSY: secret internal detail'); } };
  const res = await worker.fetch(post('/cases', body), { ...env, DB: brokenDb });
  assert.equal(res.status, 503);
  const text = await res.text();
  assert.doesNotMatch(text, /SQLITE|secret|stack/i);
});

test('oversized and non-JSON bodies are rejected before any store call', async () => {
  let touched = false;
  const store = await fakeStore({ ownsTransaction: async () => { touched = true; return true; } });
  const big = JSON.stringify({ ...body, customer_statement: 'x'.repeat(MAX_BODY_BYTES) });
  assert.equal((await route(post('/cases', big), env, store)).status, 413);
  assert.equal((await route(post('/cases', '{not json'), env, store)).status, 422);
  assert.equal(touched, false);
  const small = await readJsonBody(post('/cases', body));
  assert.deepEqual(small.value, body);
});

test('known paths answer 405 with Allow after the gate, unknown API paths 404', async () => {
  const store = await fakeStore();
  const get = path => new Request('https://d.example' + path, { headers: { Authorization: auth } });
  const wrong = await route(get('/cases'), env, store);
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('Allow'), 'POST');
  assert.equal((await route(get('/agent/unknown'), env, store)).status, 404);
  const anonymous = await route(new Request('https://d.example/cases', { method: 'OPTIONS' }), env, store);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('Allow'), null);
});

test('HTML documents require the gate before assets are served', async () => {
  const served = [];
  const assetsEnv = { ...env, ASSETS: { fetch: async r => { served.push(new URL(r.url).pathname); return new Response('<app-root>'); } } };
  const store = await fakeStore();
  for (const path of ['/', '/index.html', '/agent']) {
    assert.equal((await route(new Request('https://d.example' + path), assetsEnv, store)).status, 401);
    assert.equal((await route(new Request('https://d.example' + path, { headers: { Authorization: auth } }), assetsEnv, store)).status, 200);
  }
  assert.deepEqual(served, ['/', '/index.html', '/agent']);
});

test('database metrics are exposed only when explicitly enabled', () => {
  const store = { metrics: () => ({ queries: 2, rowsRead: 5, rowsWritten: 1, roundTrips: 1 }) };
  assert.equal(withMetrics(new Response('{}'), env, store).headers.get('X-D1-Metrics'), null);
  const shown = withMetrics(new Response('{}'), { ...env, DEMO_EXPOSE_DB_METRICS: '1' }, store);
  assert.equal(shown.headers.get('X-D1-Metrics'), 'queries=2;rows_read=5;rows_written=1;round_trips=1');
});

test('the body limit stops reading a stream without Content-Length', async () => {
  let pulled = 0;
  const chunk = new TextEncoder().encode('x'.repeat(1024));
  const stream = new ReadableStream({ pull(controller) { pulled += 1; controller.enqueue(chunk); if (pulled > 200) controller.close(); } });
  const request = new Request('https://d.example/cases', { method: 'POST', body: stream, duplex: 'half' });
  const result = await readJsonBody(request);
  assert.equal(result.error.status, 413);
  assert.ok(pulled <= 20, `read ${pulled} KB before stopping`);
});

test('identity list is served behind the gate from the shared config, without D1', async () => {
  const store = { metrics: () => ({ queries: 0, rowsRead: 0, rowsWritten: 0 }) };
  const req = headers => new Request('https://d.example/demo/identities', { headers });
  assert.equal((await route(req({}), env, store)).status, 401);
  const res = await route(req({ Authorization: auth }), env, store);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.items.map(x => x.customer_id), ['demo-ana', 'demo-bruno', 'CLI-U53R5AZVLET0']);
  assert.ok(body.items.every(x => Object.keys(x).sort().join() === 'customer_id,display_name'));
});

test('a malformed stored context card degrades to null and login still works', async () => {
  const login = card_json => route(post('/demo/session', { customer_id: 'demo-ana' }, ''), env, {
    customerExists: async () => true, rotateSession: async () => {},
    findContextCard: async () => ({ card_version: 1, snapshot_at: '2026-09-29T00:00:00+00:00', card_json }),
    metrics: () => ({ queries: 0, rowsRead: 0, rowsWritten: 0 }) });
  for (const stored of ['null', '[]', '"Ana"', '7', '{broken']) {
    const res = await login(stored);
    assert.equal(res.status, 200, stored);
    const payload = await res.json();
    assert.equal(payload.context_card, null, stored);
    assertContract('customerSession', payload);
  }
  const res = await login(JSON.stringify({ first_name: 'Ana', locale_hint: 'es-AR', products: [],
    version: 9, snapshot_at: 'forged', product_number: '4111222233334444' }));
  const { context_card: card } = await res.json();
  assert.deepEqual(card, { version: 1, snapshot_at: '2026-09-29T00:00:00+00:00', first_name: 'Ana',
    locale_hint: 'es-AR', products: [] });
});
