/** Real local-D1 guided starts: concurrent replay, session isolation, hostile input and contract. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, base, auth } from '../support/client.js';
import { assertContract } from '../support/contract.js';

const startBody = (language = 'es') => ({ language, mode: 'guided', report_type: 'unrecognized_charge',
  customer_statement: language === 'es' ? 'No reconozco este cargo.' : 'Não reconheço esta cobrança.',
  idempotency_key: crypto.randomUUID() });

async function customer(id = 'demo-ana') {
  const c = client();
  const login = await c.call('/demo/session', { customer_id: id });
  assert.equal(login.status, 200);
  assertContract('customerSession', login.body);
  assert.equal(login.body.expires_at, undefined, 'trusted expiry is internal only');
  return c;
}

test('guided_start_is_owned_and_idempotent against local D1', async () => {
  const ana = await customer();
  const body = startBody();
  const results = await Promise.all(Array.from({ length: 10 }, () => fetch(base + '/intake/start', {
    method: 'POST', headers: { Authorization: auth, Cookie: ana.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }))));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
  assert.equal(new Set(results.map(r => r.body.episode_id)).size, 1);
  for (const result of results) { assertContract('intakeStart', result.body); assert.equal(result.body.protocol, undefined); }
  for (const change of [{ customer_statement: 'Otro cargo que no reconozco.' }, { language: 'pt' }]) {
    const conflict = await ana.call('/intake/start', { ...body, ...change });
    assert.equal(conflict.status, 409);
    assertContract('error', conflict.body);
  }
  const stale = client();
  stale.cookie = ana.cookie;
  await ana.call('/demo/session', { customer_id: 'demo-ana' });
  assert.equal((await stale.call('/intake/start', body)).status, 401);
  const replay = await ana.call('/intake/start', body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, { ...results.find(r => r.status === 201).body, replayed: true });
  const bruno = await customer('demo-bruno');
  const other = await bruno.call('/intake/start', body);
  assert.equal(other.status, 201);
  assert.notEqual(other.body.episode_id, replay.body.episode_id, 'same key is scoped to authenticated owner');
  assert.equal((await bruno.call('/intake/start', { ...body, episode_id: replay.body.episode_id })).status, 422);
  console.log('D1_INTAKE_START_REPLAY ' + JSON.stringify(replay.metrics));
});

test('guided start gate, path, session-role and malformed-input boundaries', async () => {
  for (const path of ['/intake/start', '/intake', '/intake/', '/intake/unknown', '/intake/start/extra']) {
    for (const method of ['GET', 'POST', 'HEAD', 'OPTIONS', 'DELETE', 'PUT']) {
      const denied = await fetch(base + path, { method });
      assert.equal(denied.status, 401, `${method} ${path}`);
      assert.equal(denied.headers.get('Allow'), null);
      const gated = await fetch(base + path, { method, headers: { Authorization: auth } });
      assert.equal(gated.status, path === '/intake/start' ? (method === 'POST' ? 401 : 405) : 404, `${method} ${path}`);
    }
  }
  const agent = client();
  await agent.call('/demo/agent-session', {});
  agent.cookie = agent.cookie.replace('demo_agent_session=', 'demo_session=');
  assert.equal((await agent.call('/intake/start', startBody())).status, 401);
  for (const token of ['f'.repeat(64), process.env.EXPIRED_TOKEN]) {
    const c = client(); c.cookie = `demo_session=${token}`;
    assert.equal((await c.call('/intake/start', startBody())).status, 401);
  }
  const ana = await customer();
  const body = startBody();
  for (const invalid of ['{bad', '[]', 'null', { ...body, customer_id: 'demo-bruno' }, { ...body, language: 'en' },
    { ...body, mode: 'ai' }, { ...body, report_type: 'recognized_charge' }, { ...body, extra: true },
    { ...body, customer_statement: 'x'.repeat(2001) }, { ...body, customer_statement: '\ud800'.repeat(10) }]) {
    const rejected = await ana.call('/intake/start', invalid);
    assert.equal(rejected.status, 422);
    assertContract('error', rejected.body);
  }
  assert.equal((await ana.call('/intake/start', 'x'.repeat(20_000))).status, 413);
  const hostile = await ana.call('/intake/start', { ...startBody('pt'), customer_statement: "'); DROP TABLE sessions; -- cobrança" });
  assert.equal(hostile.status, 201);
  assertContract('intakeStart', hostile.body);
  assert.equal((await ana.call('/transactions')).status, 200);
});

test('new guided start reports local D1 work without altering existing route budgets', async () => {
  const ana = await customer();
  const result = await ana.call('/intake/start', startBody('pt'));
  assert.equal(result.status, 201);
  assertContract('intakeStart', result.body);
  assert.ok(result.metrics, 'local harness exposes measured D1 counters');
  console.log('D1_INTAKE_START ' + JSON.stringify(result.metrics));
});

test('U+0000 guided statements return 422 on local D1 and leave their key reusable', async () => {
  const ana = await customer();
  const body = startBody();
  for (const statement of ['a\u0000bbbbbbbbbb', 'No reconozco este cargo.\u0000']) {
    const rejected = await ana.call('/intake/start', { ...body, customer_statement: statement });
    assert.equal(rejected.status, 422);
    assertContract('error', rejected.body);
  }
  assert.equal((await ana.call('/intake/start', body)).status, 201);
});
