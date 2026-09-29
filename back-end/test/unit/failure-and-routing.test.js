/** Failure injection through a fake store, request-body limits and route dispatch. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { withMetrics } from '../../src/index.js';
import { route } from '../../src/router.js';
import { readJsonBody, MAX_BODY_BYTES } from '../../src/http.js';
import { tokenHash } from '../../src/auth/session.js';

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
  const store = { metrics: () => ({ queries: 2, rowsRead: 5, rowsWritten: 1 }) };
  assert.equal(withMetrics(new Response('{}'), env, store).headers.get('X-D1-Metrics'), null);
  const shown = withMetrics(new Response('{}'), { ...env, DEMO_EXPOSE_DB_METRICS: '1' }, store);
  assert.equal(shown.headers.get('X-D1-Metrics'), 'queries=2;rows_read=5;rows_written=1');
});
