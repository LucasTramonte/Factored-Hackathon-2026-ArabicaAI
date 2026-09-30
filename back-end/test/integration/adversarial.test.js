/**
 * Attempts to break the gate, sessions, isolation and idempotency against the real local D1.
 * A test passes only when the attack fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertContract } from '../support/contract.js';
import { auth, base, client } from '../support/client.js';

const API = { '/demo/identities': 'GET', '/demo/session': 'POST', '/transactions': 'GET', '/cases': 'POST', '/intake/start': 'POST', '/demo/agent-session': 'POST', '/agent/cases': 'GET' };
const wrong = 'Basic ' + Buffer.from('local-reviewer:wrong').toString('base64');
const uuid = () => crypto.randomUUID();

async function loggedIn(customerId = 'demo-ana') {
  const c = client();
  assert.equal((await c.call('/demo/session', { customer_id: customerId })).status, 200);
  return c;
}

test('gate matrix: no API route answers data without the team credential', async () => {
  for (const path of Object.keys(API)) {
    for (const authorization of [null, wrong, 'Bearer x', 'Basic', 'Basic %%%']) {
      for (const method of ['GET', 'POST', 'HEAD', 'OPTIONS', 'DELETE']) {
        const res = await fetch(base + path, { method, headers: authorization ? { Authorization: authorization } : {} });
        assert.equal(res.status, 401, `${method} ${path} with ${authorization}`);
        assert.equal(res.headers.get('Allow'), null, 'methods are not revealed before the gate');
        assert.equal(res.headers.get('set-cookie'), null);
      }
    }
  }
});

test('with the credential, wrong methods get 405 and unknown API paths get JSON 404', async () => {
  for (const [path, allowed] of Object.entries(API)) {
    const method = allowed === 'GET' ? 'POST' : 'GET';
    const res = await fetch(base + path, { method, headers: { Authorization: auth } });
    assert.equal(res.status, 405, `${method} ${path}`);
    assert.equal(res.headers.get('Allow'), allowed);
  }
  for (const path of ['/cases/', '/cases/x', '/agent/', '/agent/cases/extra', '/demo/other', '/transactions/1']) {
    const res = await fetch(base + path, { headers: { Authorization: auth } });
    assert.equal(res.status, 404, path);
    assertContract('error', await res.json());
  }
});

test('path tricks never reach a handler without the gate or create a case', async () => {
  const ana = await loggedIn();
  const body = JSON.stringify({ transaction_id: 'demo-tx-001', customer_statement: 'I do not recognize this charge.',
    customer_confirmed: true, idempotency_key: uuid() });
  for (const path of ['//cases', '/CASES', '/cases?x=1', '/transactions/../cases', '/./cases', '/cases%2F']) {
    const res = await fetch(base + path, { method: 'POST', headers: { Cookie: ana.cookie, 'Content-Type': 'application/json' }, body });
    assert.notEqual(res.status, 201, path);
    assert.doesNotMatch(await res.text(), /"protocol"/, path);
  }
});

test('health never leaks internals', async () => {
  const text = await (await fetch(base + '/healthz')).text();
  assert.doesNotMatch(text, /sqlite|d1|error|stack/i);
  assert.equal((await fetch(base + '/healthz', { method: 'POST' })).status, 405);
});

test('sessions: actors cannot swap, forged or expired tokens fail, login revokes the old token', async () => {
  const ana = await loggedIn();
  const token = ana.cookie.split('=')[1];
  const asAgent = client();
  asAgent.cookie = `demo_agent_session=${token}`;
  assert.equal((await asAgent.call('/agent/cases')).status, 401, 'customer token used as agent');

  const agent = client();
  await agent.call('/demo/agent-session', {});
  const agentToken = agent.cookie.split('=')[1];
  const asCustomer = client();
  asCustomer.cookie = `demo_session=${agentToken}`;
  assert.equal((await asCustomer.call('/transactions')).status, 401, 'agent token used as customer');

  for (const forged of ['f'.repeat(64), token.slice(0, 63) + (token.at(-1) === 'a' ? 'b' : 'a'), token.toUpperCase(),
    token + '0', `${'f'.repeat(64)}; demo_session=${token}`, process.env.EXPIRED_TOKEN]) {
    const c = client();
    c.cookie = `demo_session=${forged}`;
    assert.equal((await c.call('/transactions')).status, 401, `token ${forged.slice(0, 12)}…`);
  }

  const before = ana.cookie;
  await ana.call('/demo/session', { customer_id: 'demo-ana' });
  assert.notEqual(ana.cookie, before);
  const stale = client();
  stale.cookie = before;
  assert.equal((await stale.call('/transactions')).status, 401, 'old token survives a new login');
  assert.equal((await ana.call('/transactions')).status, 200);
});

test('login rejects identities outside the allowlist, including ones that exist in data', async () => {
  const c = client();
  for (const customer_id of ['demo-carla', 'CLI-OTHER', '', null, 42, ['demo-ana'], "demo-ana' OR '1'='1"]) {
    const res = await c.call('/demo/session', { customer_id });
    assert.equal(res.status, 422, String(customer_id));
    assertContract('error', res.body);
  }
  assert.equal((await c.call('/demo/session', '{bad json')).status, 422);
});

test('isolation: a foreign transaction and a missing one look identical', async () => {
  const bruno = await loggedIn('demo-bruno');
  const make = transaction_id => ({ transaction_id, customer_statement: 'I do not recognize this charge.',
    customer_confirmed: true, idempotency_key: uuid() });
  const foreign = await bruno.call('/cases', make('demo-tx-001'));
  const missing = await bruno.call('/cases', make('demo-tx-999'));
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(foreign.body, missing.body);
  assert.ok(!(await bruno.call('/transactions')).body.items.some(x => x.transaction_id === 'demo-tx-001'));
});

test('hostile input is stored as data or rejected, never executed', async () => {
  const ana = await loggedIn();
  const statement = "'); DELETE FROM cases; DROP TABLE sessions; -- not mine";
  const res = await ana.call('/cases', { transaction_id: 'demo-tx-002', customer_statement: statement,
    customer_confirmed: true, idempotency_key: uuid() });
  assert.equal(res.status, 201);
  const agent = client();
  await agent.call('/demo/agent-session', {});
  const listed = await agent.call('/agent/cases');
  assert.ok(listed.body.items.some(x => x.customer_statement === statement));
  assert.equal((await ana.call('/transactions')).status, 200, 'sessions table still exists');

  const huge = await ana.call('/cases', JSON.stringify({ transaction_id: 'demo-tx-002', customer_statement: 'x'.repeat(20_000),
    customer_confirmed: true, idempotency_key: uuid() }));
  assert.equal(huge.status, 413);
  for (const body of ['{"customer_confirmed": true', '[]', '"text"',
    '{"__proto__": {"customer_confirmed": true}, "transaction_id": "demo-tx-002", "customer_statement": "I do not recognize this charge.", "idempotency_key": "0f8fad5b-d9cb-469f-a165-70867728950e"}']) {
    assert.equal((await ana.call('/cases', body)).status, 422, body.slice(0, 30));
  }
});

test('concurrent submissions with one key create exactly one case', async () => {
  const ana = await loggedIn();
  const request = { transaction_id: 'demo-tx-002', customer_statement: 'Parallel retries of the same report.',
    customer_confirmed: true, idempotency_key: uuid() };
  const results = await Promise.all(Array.from({ length: 10 }, () => fetch(base + '/cases', {
    method: 'POST', headers: { Authorization: auth, Cookie: ana.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(request) }).then(async r => ({ status: r.status, body: await r.json() }))));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
  assert.equal(new Set(results.map(r => r.body.protocol)).size, 1);
  for (const r of results) assertContract('caseReceipt', r.body);
});
