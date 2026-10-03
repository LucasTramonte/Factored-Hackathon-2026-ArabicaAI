/** GET /admin/customers and POST /admin/act-as (ADR-007, decision 10): only a customer session an admin token opened. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { assertContract } from '../support/contract.js';
import { base, client, idToken } from '../support/client.js';
import { tokenHash } from '../../src/auth/session.js';

const store = fn => import('../../scripts/intake-store.mjs')
  .then(({ withIntakeStore }) => withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, fn));
const ref = async cookie => (await tokenHash(cookie.split('=')[1])).slice(0, 12);

/** A browser holding the customer session that a token in ``groups`` opened (the token is then dropped). */
async function signedIn(groups, customerId = 'demo-diego') {
  const token = client({ authorization: 'Bearer ' + await idToken(customerId, { groups }) });
  assert.equal((await token.call('/auth/session', {})).status, 200);
  const browser = client();
  browser.cookie = token.cookie;
  return browser;
}

test('only GET /admin/customers and POST /admin/act-as exist; other methods are 405 and look-alike paths 404', async () => {
  for (const [path, allow, wrong] of [['/admin/customers', 'GET', ['POST', 'PUT', 'DELETE']], ['/admin/act-as', 'POST', ['GET', 'PUT', 'DELETE']]]) {
    for (const method of wrong) {
      const res = await fetch(base + path, { method });
      assert.equal(res.status, 405, `${method} ${path}`); assert.equal(res.headers.get('Allow'), allow);
    }
  }
  for (const path of ['/admin', '/admin/', '/admin/customers/x', '/admin/Customers', '/admin/act_as', '/admin/act-as/']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 404, path); assertContract('error', await res.json());
  }
});

test('no session, a bearer token alone, an agent cookie, an expired or malformed cookie are 401; a non-admin customer session is 403', async () => {
  const bearerOnly = client({ authorization: 'Bearer ' + await idToken('demo-diego', { groups: ['admin'] }) });
  const agent = client(); assert.equal((await agent.call('/demo/agent-session', {})).status, 200);
  const expired = client(); expired.cookie = 'demo_session=' + process.env.EXPIRED_TOKEN;
  const malformed = client(); malformed.cookie = 'demo_session=not-a-token';
  const picker = client(); assert.equal((await picker.call('/demo/session', { customer_id: 'demo-ana' })).status, 200);
  const customers = [picker, await signedIn(['customer'], 'demo-ana'), await signedIn(['customer', 'agent', 'auditor'], 'demo-ana')];
  for (const [path, body] of [['/admin/customers', undefined], ['/admin/act-as', { customer_id: 'CLI-COHORT-1' }]]) {
    for (const c of [client(), bearerOnly, agent, expired, malformed]) {
      const res = await c.call(path, body);
      assert.equal(res.status, 401, path); assertContract('error', res.body);
    }
    for (const c of customers) {
      const res = await c.call(path, body);
      assert.equal(res.status, 403, path); assertContract('error', res.body);
      for (const name of ['CLI-COHORT', 'Zoë', 'demo-bruno']) assert.ok(!res.text.includes(name), `a customer learns nothing of ${name}`);
    }
  }
  const after = await customers[1].call('/transactions');
  assert.equal(after.status, 200, 'a refused admin call leaves the customer session as it was');
});

test("an admin lists the committed identities and the loaded cohort, never a D1 row that isn't one of them", async () => {
  const admin = await signedIn(['admin']);
  const res = await admin.call('/admin/customers');
  assert.equal(res.status, 200); assertContract('identityList', res.body);
  const ids = res.body.items.map(i => i.customer_id);
  for (const id of ['demo-ana', 'demo-diego', 'CLI-COHORT-1', 'CLI-COHORT-4']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('demo-hidden'), 'a fictitious D1 row outside identities.json is never offered');
  assert.equal(res.body.items.find(i => i.customer_id === 'CLI-COHORT-3').country, 'Brasil');
});

test('act-as takes exactly one allowed customer_id; anything else is 422 and changes nothing', async () => {
  const admin = await signedIn(['admin']);
  const before = admin.cookie;
  for (const body of [{}, [], 'x', null, 7, { customer_id: 1 }, { customer_id: '' }, { customer_id: 'demo-ana', extra: 1 }, { id: 'demo-ana' },
    { customer_id: "' OR 1=1--" }, { customer_id: 'demo-hidden' }, { customer_id: 'CLI-NOPE-0' }, { customer_id: 'x'.repeat(5000) }]) {
    const res = await admin.call('/admin/act-as', body);
    assert.equal(res.status, 422, JSON.stringify(body).slice(0, 40)); assertContract('error', res.body);
  }
  const res = await admin.call('/admin/act-as', '{not json');
  assert.ok(res.status >= 400 && res.status < 500, 'malformed JSON is a client error');
  assert.equal(admin.cookie, before, 'a refused act-as sets no cookie');
  assert.equal((await admin.call('/admin/customers')).status, 200, 'and the admin session is still live');
});

test('act-as swaps the session to that customer, keeps the admin mark, revokes the old one and records references only', async () => {
  const admin = await signedIn(['admin']);
  const old = admin.cookie;
  const res = await admin.call('/admin/act-as', { customer_id: 'CLI-COHORT-1' });
  assert.equal(res.status, 200); assertContract('actAsSession', res.body);
  assert.deepEqual([res.body.customer_id, res.body.mode, res.body.roles], ['CLI-COHORT-1', 'admin_act_as', ['admin']]);
  assert.notEqual(admin.cookie, old);
  const stale = client(); stale.cookie = old;
  assert.equal((await stale.call('/transactions')).status, 401, 'the admin session presented is revoked');
  const charges = await admin.call('/transactions');
  assert.equal(charges.status, 200);
  assert.deepEqual(charges.body.items.map(t => t.transaction_id), ['cohort-tx-1'], 'identity now comes from the new session');
  const [row] = await store(s => s.listAdminActions(1));
  assert.deepEqual([row.action, row.admin_session_ref, row.session_ref], ['act_as', await ref(old), await ref(admin.cookie)]);
  assert.ok(!JSON.stringify(row).includes('CLI-COHORT-1'), 'the audit row carries references, never the customer id');
  const again = await admin.call('/admin/act-as', { customer_id: 'demo-ana' });
  assert.equal(again.status, 200, 'the act-as session keeps the admin mark, so the admin can switch again');
  assert.equal((await admin.call('/admin/customers')).status, 200);
});

test("act-as never stores the admin's email for another customer, and leaves that customer's own address untouched", async () => {
  const owner = await signedIn(['customer'], 'demo-elena');
  assert.equal((await owner.call('/transactions')).status, 200);
  const elena = await store(s => s.findNotificationTarget('demo-elena'));
  assert.ok(elena, 'an email sign-in stores the customer\'s own encrypted address');
  const admin = await signedIn(['admin']);
  assert.equal((await admin.call('/admin/act-as', { customer_id: 'CLI-COHORT-2' })).status, 200);
  assert.equal((await admin.call('/admin/act-as', { customer_id: 'demo-elena' })).status, 200);
  assert.equal(await store(s => s.findNotificationTarget('CLI-COHORT-2')), null);
  assert.deepEqual(await store(s => s.findNotificationTarget('demo-elena')), elena);
});

test('concurrent act-as calls on one admin session never fail open or error', async () => {
  const admin = await signedIn(['admin']);
  const cookie = admin.cookie;
  const results = await Promise.all(['CLI-COHORT-1', 'CLI-COHORT-2', 'CLI-COHORT-3', 'demo-ana'].map(customer_id => {
    const c = client(); c.cookie = cookie;
    return c.call('/admin/act-as', { customer_id });
  }));
  for (const r of results) assert.ok([200, 401].includes(r.status), String(r.status));
  assert.ok(results.some(r => r.status === 200));
  for (const r of results.filter(r => r.status === 200)) assertContract('actAsSession', r.body);
});
