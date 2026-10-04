/** GET /alerts and POST /alerts/answer (ADR-011): the bank's flag on a customer's own charge, answered once. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertContract } from '../support/contract.js';
import { base, client, closeReport, idToken } from '../support/client.js';

/** A browser holding the customer session a token in ``groups`` opened for ``customerId`` (the token is then dropped). */
async function signedIn(customerId, groups = ['customer']) {
  const token = client({ authorization: 'Bearer ' + await idToken(customerId, { groups }) });
  assert.equal((await token.call('/auth/session', {})).status, 200);
  const browser = client();
  browser.cookie = token.cookie;
  return browser;
}

test('only GET /alerts and POST /alerts/answer exist; other methods are 405 and look-alike paths 404', async () => {
  for (const [path, allow, wrong] of [['/alerts', 'GET', ['POST', 'PUT', 'DELETE']], ['/alerts/answer', 'POST', ['GET', 'PUT', 'DELETE']]]) {
    for (const method of wrong) {
      const res = await fetch(base + path, { method });
      assert.equal(res.status, 405, `${method} ${path}`); assert.equal(res.headers.get('Allow'), allow);
    }
  }
  for (const path of ['/alerts/', '/alerts/x', '/alerts/Answer', '/alerts/answer/']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 404, path); assertContract('error', await res.json());
  }
});

test('no session, an agent cookie, an expired or malformed cookie are 401 on both routes', async () => {
  const agent = client(); assert.equal((await agent.call('/demo/agent-session', {})).status, 200);
  const expired = client(); expired.cookie = 'demo_session=' + process.env.EXPIRED_TOKEN;
  const malformed = client(); malformed.cookie = 'demo_session=not-a-token';
  for (const c of [client(), agent, expired, malformed]) {
    for (const [path, body] of [['/alerts', undefined], ['/alerts/answer', { transaction_id: 'demo-tx-015', answer: 'mine' }]]) {
      const res = await c.call(path, body);
      assert.equal(res.status, 401, path); assertContract('error', res.body);
    }
  }
});

test("a customer sees only their own newest flagged charge; a customer without one sees none; no query is accepted", async () => {
  const diego = await signedIn('demo-diego');
  const res = await diego.call('/alerts');
  assert.equal(res.status, 200); assertContract('proactiveAlert', res.body);
  assert.deepEqual([res.body.alert.transaction_id, res.body.alert.amount, res.body.alert.currency], ['demo-tx-015', '19.90', 'BRL']);
  assert.ok(!res.text.includes('score') && !res.text.includes('bank_flagged'), 'the score and the flag column never reach the client');
  for (const id of ['demo-bruno', 'demo-ana']) {
    const none = await (await signedIn(id)).call('/alerts');
    assert.equal(none.status, 200); assert.deepEqual(none.body, { alert: null }, id);
  }
  for (const query of ['?customer_id=demo-elena', '?x=1']) assert.equal((await diego.call('/alerts' + query)).status, 422, query);
});

test('answers take exactly one own flagged charge; anything else is 422 or 404 and changes nothing', async () => {
  const bruno = await signedIn('demo-bruno');
  const diego = await signedIn('demo-diego');
  for (const body of [{}, [], 'x', null, { transaction_id: 'demo-tx-015' }, { answer: 'mine' }, { transaction_id: 'demo-tx-015', answer: 'yes' },
    { transaction_id: 'demo-tx-015', answer: 'mine', customer_id: 'demo-diego' }, { transaction_id: '', answer: 'mine' },
    { transaction_id: 'x'.repeat(101), answer: 'mine' }, { transaction_id: 7, answer: 'mine' }]) {
    const res = await diego.call('/alerts/answer', body);
    assert.equal(res.status, 422, JSON.stringify(body).slice(0, 50)); assertContract('error', res.body);
  }
  // Another customer's flagged charge, an own unflagged charge and a missing one look the same: 404.
  for (const [who, transaction_id] of [[bruno, 'demo-tx-015'], [diego, 'demo-tx-012'], [diego, 'demo-tx-999']]) {
    const res = await who.call('/alerts/answer', { transaction_id, answer: 'mine' });
    assert.equal(res.status, 404, transaction_id); assertContract('error', res.body);
  }
  assert.equal((await diego.call('/alerts')).body.alert.transaction_id, 'demo-tx-015', 'refused answers silence nothing');
});

test('the first answer stands, silences the alert, and concurrent answers store one', async () => {
  const diego = await signedIn('demo-diego');
  const results = await Promise.all(['mine', 'report', 'mine', 'report', 'mine'].map(answer => diego.call('/alerts/answer', { transaction_id: 'demo-tx-015', answer })));
  for (const r of results) { assert.equal(r.status, 200); assertContract('alertAnswer', r.body); }
  assert.equal(new Set(results.map(r => r.body.answer + r.body.answered_at)).size, 1, 'every caller reads the same stored answer');
  assert.deepEqual((await diego.call('/alerts')).body, { alert: null });
  const replay = await diego.call('/alerts/answer', { transaction_id: 'demo-tx-015', answer: results[0].body.answer === 'mine' ? 'report' : 'mine' });
  assert.equal(replay.body.answer, results[0].body.answer, 'a later different answer returns the stored one');
});

test("an admin acting as the customer sees the alert, but the admin's answer never silences it for the customer", async () => {
  const admin = await signedIn('demo-diego', ['admin']);
  assert.equal((await admin.call('/admin/act-as', { customer_id: 'demo-elena' })).status, 200);
  assert.equal((await admin.call('/alerts')).body.alert.transaction_id, 'demo-tx-020');
  assert.equal((await admin.call('/alerts/answer', { transaction_id: 'demo-tx-020', answer: 'mine' })).status, 200);
  assert.deepEqual((await admin.call('/alerts')).body, { alert: null }, 'silenced for the admin');
  const elena = await signedIn('demo-elena');
  assert.equal((await elena.call('/alerts')).body.alert.transaction_id, 'demo-tx-020', 'still shown to the customer');
});

test('a report on a flagged charge is high urgency and ends the alert', async () => {
  const marco = await signedIn('demo-marco');
  assert.equal((await marco.call('/alerts')).body.alert.transaction_id, 'demo-tx-025');
  const start = await marco.call('/intake/start', { language: 'es', mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
    customer_statement: 'No reconozco este cargo de Jornal Demo.', idempotency_key: crypto.randomUUID() });
  assert.equal(start.status, 201);
  const receipt = await marco.call('/intake/confirm', { episode_id: start.body.episode_id, transaction_id: 'demo-tx-025', customer_confirmed: true,
    idempotency_key: crypto.randomUUID() });
  assert.equal(receipt.status, 201);
  assert.equal(receipt.body.urgency, 'high', 'a 15.90 BRL charge is high because the bank flagged it, not because of its amount');
  assert.deepEqual((await marco.call('/alerts')).body, { alert: null }, 'a reported charge never alerts');
  // Close it, as the other suites do with high reports, so the shared queue-scan fixture keeps its head.
  await closeReport(receipt.body.protocol);
  assert.deepEqual((await marco.call('/alerts')).body, { alert: null }, 'a closed report still ends the alert');
});
