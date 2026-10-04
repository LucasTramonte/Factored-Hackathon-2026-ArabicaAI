/** GET /auth/me (ADR-013, phase 0): a reload restores the signed-in state from the cookies, never more than that. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertContract } from '../support/contract.js';
import { base, client, idToken } from '../support/client.js';

const me = c => c.call('/auth/me');

test('only GET /auth/me exists; other methods are 405 and look-alike paths 404', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await fetch(base + '/auth/me', { method });
    assert.equal(res.status, 405, method); assert.equal(res.headers.get('Allow'), 'GET');
  }
  for (const path of ['/auth/me/', '/auth/me/x', '/auth/Me']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 404, path); assertContract('error', await res.json());
  }
});

test('no cookie, an expired, malformed or swapped cookie restore nothing; a query is refused', async () => {
  const none = await me(client());
  assert.equal(none.status, 200); assertContract('sessionState', none.body); assert.deepEqual(none.body, { customer: null, agent: false });
  const agent = client(); assert.equal((await agent.call('/demo/agent-session', {})).status, 200);
  const swapped = client(); swapped.cookie = agent.cookie.replace('demo_agent_session=', 'demo_session='); // an agent token in the customer slot
  const expired = client(); expired.cookie = 'demo_session=' + process.env.EXPIRED_TOKEN;
  const malformed = client(); malformed.cookie = 'demo_session=not-a-token';
  for (const c of [swapped, expired, malformed]) assert.deepEqual((await me(c)).body, { customer: null, agent: false });
  const ana = client(); assert.equal((await ana.call('/demo/session', { customer_id: 'demo-ana' })).status, 200);
  for (const query of ['?customer_id=demo-bruno', '?x=1']) assert.equal((await ana.call('/auth/me' + query)).status, 422, query);
});

test("a customer gets only their own id and card; an admin's session says admin, also after act-as", async () => {
  const ana = client(); assert.equal((await ana.call('/demo/session', { customer_id: 'demo-ana' })).status, 200);
  const own = await me(ana);
  assert.equal(own.status, 200); assertContract('sessionState', own.body);
  assert.deepEqual([own.body.customer.customer_id, own.body.customer.roles, own.body.agent], ['demo-ana', ['customer'], false]);
  for (const secret of [ana.cookie.split('=')[1], 'expires', 'token_hash']) assert.ok(!own.text.includes(secret), secret);
  const token = client({ authorization: 'Bearer ' + await idToken('demo-diego', { groups: ['admin'] }) });
  assert.equal((await token.call('/auth/session', {})).status, 200);
  const admin = client(); admin.cookie = token.cookie;
  assert.deepEqual((await me(admin)).body.customer.roles, ['admin']);
  assert.equal((await admin.call('/admin/act-as', { customer_id: 'CLI-COHORT-1' })).status, 200);
  const acting = await me(admin);
  assertContract('sessionState', acting.body);
  assert.deepEqual([acting.body.customer.customer_id, acting.body.customer.roles], ['CLI-COHORT-1', ['admin']]);
});

test('customer and agent sessions are reported separately, each from its own cookie', async () => {
  const ana = client(); await ana.call('/demo/session', { customer_id: 'demo-ana' });
  const agent = client(); await agent.call('/demo/agent-session', {});
  assert.deepEqual((await me(agent)).body, { customer: null, agent: true });
  const both = client(); both.cookie = `${ana.cookie}; ${agent.cookie}`;
  const res = await me(both);
  assertContract('sessionState', res.body);
  assert.deepEqual([res.body.customer.customer_id, res.body.agent], ['demo-ana', true]);
  await ana.call('/auth/logout', {});
  const after = client(); after.cookie = `${ana.cookie}; ${agent.cookie}`;
  assert.equal((await me(after)).body.customer, null, 'a logged-out customer session restores nothing');
});
