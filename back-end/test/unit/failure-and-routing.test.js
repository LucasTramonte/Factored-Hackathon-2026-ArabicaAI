/** Failure injection through a fake store, request-body limits and route dispatch. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { withMetrics } from '../../src/index.js';
import { route } from '../../src/router.js';
import { listIdentities, startCustomerSession } from '../../src/modules/customer/routes.js';
import { readJsonBody, MAX_BODY_BYTES } from '../../src/http.js';
import { tokenHash } from '../../src/auth/session.js';
import { assertContract } from '../support/contract.js';

const env = { DEMO_ACCESS_USERNAME: 'u', DEMO_ACCESS_PASSWORD: 'p', DEMO_PICKER: '1' };
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

test('known paths answer 405 with Allow, unknown API paths 404', async () => {
  const store = await fakeStore();
  const get = path => new Request('https://d.example' + path, { headers: { Authorization: auth } });
  const wrong = await route(get('/cases'), env, store);
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('Allow'), 'POST');
  assert.equal((await route(get('/agent/unknown'), env, store)).status, 404);
  const anonymous = await route(new Request('https://d.example/agent/cases', { method: 'OPTIONS' }), env, store);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('Allow'), null, 'team paths reveal no methods before the gate');
});

test('the team gate covers only /agent, /agent/* and /demo/*; customer paths reach routing and their session check', async () => {
  const served = [];
  const assetsEnv = { ...env, ASSETS: { fetch: async r => { served.push(new URL(r.url).pathname); return new Response('<app-root>'); } } };
  const store = await fakeStore({ findSession: async () => null });
  const anon = (path, method = 'GET') => route(new Request('https://d.example' + path, { method }), assetsEnv, store);
  const gated = res => res.status === 401 && res.headers.get('WWW-Authenticate') !== null;
  for (const [method, path, status] of [['GET', '/', 200], ['GET', '/index.html', 200], ['GET', '/transactions', 401],
    ['POST', '/intake/start', 401], ['POST', '/auth/logout', 204], ['POST', '/auth/session', 422], ['GET', '/cases/nope', 404], ['GET', '/intake', 404],
    ['DELETE', '/transactions', 405]]) {
    const res = await anon(path, method);
    assert.equal(gated(res), false, `${method} ${path}`);
    assert.equal(res.status, status, `${method} ${path}`);
  }
  assert.deepEqual(served, ['/', '/index.html']);
  for (const [method, path] of [['GET', '/agent'], ['GET', '/demo/identities'], ['POST', '/demo/session'], ['POST', '/demo/agent-session'],
    ['GET', '/agent/intakes'], ['GET', '/agent/cases'], ['OPTIONS', '/agent/cases'], ['POST', '/agent']]) {
    assert.ok(gated(await anon(path, method)), `${method} ${path}`);
  }
  // Case and encoding tricks never reach an agent handler: they fall to the static app shell.
  const agentStore = new Proxy({}, { get: (_, name) => { throw new Error(`store.${String(name)} touched`); } });
  for (const path of ['/AGENT', '/%61gent/intakes', '//agent/intakes', '/Agent/cases']) {
    const res = await route(new Request('https://d.example' + path), assetsEnv, agentStore);
    assert.equal(await res.text(), '<app-root>', path);
  }
  const page = await route(new Request('https://d.example/agent', { headers: { Authorization: auth } }), assetsEnv, store);
  assert.equal(page.status, 200);
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

test('the demo picker exists only when DEMO_PICKER=1 and otherwise never touches the store', async () => {
  const store = new Proxy({}, { get: (_, name) => { throw new Error(`store.${String(name)} touched`); } });
  for (const picker of [{}, { DEMO_PICKER: '0' }, { DEMO_PICKER: 1 }]) {
    for (const res of [await listIdentities(new Request('https://d.example/demo/identities'), picker, store),
      await startCustomerSession(post('/demo/session', { customer_id: 'demo-ana' }, ''), picker, store)]) {
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { detail: 'Not found' });
    }
  }
});

test('identity list joins the committed fictitious identities with dataset customers loaded in D1', async () => {
  let asked = null;
  const store = { metrics: () => ({ queries: 0, rowsRead: 0, rowsWritten: 0 }),
    listDatasetIdentities: async limit => { asked = limit; return [
      { customer_id: 'CLI-COHORT-1', display_name: 'Zoë O.', country: 'México' },
      { customer_id: 'demo-ana', display_name: 'Shadow of a committed identity', country: 'México' }]; } };
  const req = headers => new Request('https://d.example/demo/identities', { headers });
  assert.equal((await route(req({}), env, store)).status, 401);
  const res = await route(req({ Authorization: auth }), env, store);
  assert.equal(res.status, 200);
  const body = await res.json();
  assertContract('identityList', body);
  assert.equal(asked, 1000);
  // Committed identities come first and win over a D1 row with the same id; D1 rows add the cohort.
  assert.deepEqual(body.items, [
    { customer_id: 'demo-ana', display_name: 'Ana (demo)', country: null },
    { customer_id: 'demo-bruno', display_name: 'Bruno (demo)', country: null },
    { customer_id: 'CLI-U53R5AZVLET0', display_name: 'Dataset customer (synthetic)', country: null },
    { customer_id: 'CLI-COHORT-1', display_name: 'Zoë O.', country: 'México' }]);
});

test('identity list fails closed when D1 cannot list the cohort', async () => {
  const store = { metrics: () => ({ queries: 0, rowsRead: 0, rowsWritten: 0 }),
    listDatasetIdentities: async () => { throw new Error('D1 down'); } };
  const res = await route(new Request('https://d.example/demo/identities', { headers: { Authorization: auth } }), env, store);
  assert.equal(res.status, 503);
  assertContract('error', await res.json());
});

test('login accepts committed identities and D1 dataset customers only, checking the id before any query', async () => {
  const sources = { 'demo-ana': 'fictitious', 'CLI-COHORT-1': 'dataset', 'demo-hidden': 'fictitious' };
  let queried = [];
  const store = { metrics: () => ({ queries: 0, rowsRead: 0, rowsWritten: 0 }), rotateSession: async () => {},
    customerSource: async id => { queried.push(id); return sources[id] ?? null; }, findContextCard: async () => null };
  const login = customer_id => route(post('/demo/session', { customer_id }, ''), env, store);
  assert.equal((await login('demo-ana')).status, 200);
  assert.equal((await login('CLI-COHORT-1')).status, 200, 'a dataset customer loaded in D1');
  assert.equal((await login('demo-hidden')).status, 422, 'a D1 row that is neither committed nor dataset');
  assert.equal((await login('CLI-NOT-LOADED')).status, 422);
  assert.equal((await login('demo-bruno')).status, 503, 'a committed identity whose rows are not loaded');
  queried = [];
  for (const bad of ['', 'x'.repeat(65), "demo-ana' OR '1'='1", 'CLI-1;DROP', 'ána', null, 42, ['demo-ana']]) {
    assert.equal((await login(bad)).status, 422, String(bad));
  }
  assert.deepEqual(queried, [], 'malformed ids never reach the store');
});

test('the transaction list says whether it shows fictitious or dataset rows', async () => {
  for (const [customer_id, coverage] of [['demo-ana', 'fictitious_demo_data_only'], ['CLI-U53R5AZVLET0', 'dataset_cohort'],
    ['CLI-COHORT-1', 'dataset_cohort']]) {
    const hash = await tokenHash(token);
    const store = { metrics: () => ({ queries: 0, rowsRead: 0, rowsWritten: 0 }), listTransactions: async () => [],
      findSession: async (h, actor) => (h === hash && actor === 'customer' ? { customer_id } : null) };
    const res = await route(new Request('https://d.example/transactions',
      { headers: { Authorization: auth, Cookie: `demo_session=${token}` } }), env, store);
    const payload = await res.json();
    assertContract('transactionList', payload);
    assert.equal(payload.coverage, coverage, customer_id);
  }
});

test('a malformed stored context card degrades to null and login still works', async () => {
  const login = card_json => route(post('/demo/session', { customer_id: 'demo-ana' }, ''), env, {
    customerSource: async () => 'fictitious', rotateSession: async () => {},
    findContextCard: async () => ({ card_version: 1, snapshot_at: '2026-09-29T00:00:00+00:00', card_json }),
    metrics: () => ({ queries: 0, rowsRead: 0, rowsWritten: 0 }) });
  const valid = { first_name: 'Ana', locale_hint: 'es-AR', products: [] };
  const product = { product_type: 'Credit card', last4: '4444', currency: 'ARS' };
  const invalid = [{ ...valid, products: [null] }, { ...valid, products: ['x'] }, { ...valid, products: [[]] },
    { ...valid, products: [{ ...product, last4: '22223333' }] }, { ...valid, products: [{ ...product, currency: 'ars' }] },
    { ...valid, products: [{ ...product, product_number: '4111222233334444' }] },
    { ...valid, products: [(({ currency, ...rest }) => rest)(product)] }, { ...valid, products: [{ ...product, product_type: 7 }] },
    { ...valid, first_name: 7 }, { ...valid, first_name: '' }, { ...valid, locale_hint: 'estonian' }];
  for (const stored of ['null', '[]', '"Ana"', '7', '{broken', ...invalid.map(x => JSON.stringify(x))]) {
    const res = await login(stored);
    assert.equal(res.status, 200, stored);
    const payload = await res.json();
    assert.equal(payload.context_card, null, stored);
    assertContract('customerSession', payload);
  }
  const ok = await (await login(JSON.stringify({ ...valid, products: [product, { product_type: 'Account', last4: null, currency: null }] }))).json();
  assertContract('customerSession', ok);
  assert.equal(ok.context_card.products.length, 2);
  const res = await login(JSON.stringify({ first_name: 'Ana', locale_hint: 'es-AR', products: [],
    version: 9, snapshot_at: 'forged', product_number: '4111222233334444' }));
  const { context_card: card } = await res.json();
  assert.deepEqual(card, { version: 1, snapshot_at: '2026-09-29T00:00:00+00:00', first_name: 'Ana',
    locale_hint: 'es-AR', products: [] });
});

test('public API paths are limited per IP before any store call; documents and team paths are not', async () => {
  const keys = [];
  const limiter = success => ({ limit: async ({ key }) => { keys.push(key); return { success }; } });
  const untouched = new Proxy({}, { get: (_, name) => { throw new Error(`store.${String(name)} touched`); } });
  const req = (path, method = 'GET', headers = {}) => new Request('https://d.example' + path,
    { method, headers: { 'CF-Connecting-IP': '203.0.113.7', ...headers } });
  const limited = { ...env, API_LIMIT: limiter(false), ASSETS: { fetch: async () => new Response('<app-root>') } };
  for (const [method, path] of [['GET', '/transactions'], ['POST', '/auth/session'], ['POST', '/intake/start'], ['GET', '/cases/nope']]) {
    const res = await route(req(path, method), limited, untouched);
    assert.equal(res.status, 429, `${method} ${path}`);
    assert.equal(res.headers.get('Retry-After'), '60');
    assertContract('error', await res.json());
  }
  assert.deepEqual(keys, Array(4).fill('203.0.113.7'));
  keys.length = 0;
  assert.equal((await route(req('/'), limited, untouched)).status, 200);
  const agentStore = await fakeStore({ findSession: async () => null });
  assert.equal((await route(req('/agent/intakes', 'GET', { Authorization: auth }), limited, agentStore)).status, 401, 'reaches the agent session check');
  assert.deepEqual(keys, [], 'documents and team-gated paths never call the limiter');
  const store = await fakeStore({ findSession: async () => null });
  for (const e of [{ ...env, API_LIMIT: limiter(true) }, env]) {
    const res = await route(new Request('https://d.example/transactions'), e, store);
    assert.equal(res.status, 401);
  }
  assert.deepEqual(keys, ['unknown']);
});
