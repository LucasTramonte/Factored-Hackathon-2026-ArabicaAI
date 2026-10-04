/**
 * Messages between the agent and the customer on one report (ADR-015), against the real local D1: the thread, its
 * idempotency, isolation between customers, the closed report, hostile input, and no message text in any event.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base, client, idToken } from '../support/client.js';
import { assertContract } from '../support/contract.js';

const uuid = () => crypto.randomUUID();

async function signedInReport(customerId = 'demo-ana') {
  const customer = client({ authorization: 'Bearer ' + await idToken(customerId) });
  assert.equal((await customer.call('/auth/session', {})).status, 200);
  const episode = (await customer.call('/intake/start', { language: 'es', mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
    customer_statement: 'No reconozco este cargo.', idempotency_key: uuid() })).body.episode_id;
  const receipt = await customer.call('/intake/handoff', { episode_id: episode, kind: 'incomplete', idempotency_key: uuid() });
  assert.equal(receipt.status, 201);
  const agent = client(); assert.equal((await agent.call('/demo/agent-session', {})).status, 200);
  return { customer, agent, receipt: receipt.body, episode };
}
const thread = receipt => `/intake/handoff/${receipt.reference_short}/messages`;

test('the agent and the customer write on one report; both read the same thread, oldest first, by protocol or reference', async () => {
  const { customer, agent, receipt } = await signedInReport();
  const empty = await customer.call(thread(receipt));
  assert.equal(empty.status, 200); assertContract('messageThread', empty.body);
  assert.deepEqual(empty.body, { status: 'received', can_post: true, items: [] });
  const asked = await agent.call('/agent/intake-messages', { protocol: receipt.protocol, body: '  ¿Recuerdas el comercio y la fecha?  ', idempotency_key: uuid() });
  assert.equal(asked.status, 201); assertContract('reportMessage', asked.body);
  assert.equal(asked.body.body, '¿Recuerdas el comercio y la fecha?', 'trimmed');
  const answered = await customer.call(`/intake/handoff/${receipt.protocol}/messages`, { body: 'Fue en Mercado Central, el martes.', idempotency_key: uuid() });
  assert.equal(answered.status, 201);
  const mine = await customer.call(thread(receipt));
  const theirs = await agent.call('/agent/intake-messages?protocol=' + receipt.protocol);
  assertContract('messageThread', mine.body); assertContract('messageThread', theirs.body);
  assert.deepEqual(mine.body, theirs.body);
  assert.deepEqual(mine.body.items.map(m => m.author), ['agent', 'customer']);
  assert.ok(!JSON.stringify(theirs.body).includes('session'), 'no agent session reference is served');
});

test('a retried post stores one message; the same key with another body is 409; concurrent identical posts store one', async () => {
  const { customer, agent, receipt } = await signedInReport();
  const key = uuid();
  const first = await customer.call(thread(receipt), { body: 'Hola', idempotency_key: key });
  const replay = await customer.call(thread(receipt), { body: 'Hola', idempotency_key: key });
  assert.equal(first.status, 201); assert.equal(replay.status, 200); assert.deepEqual(replay.body, first.body);
  assert.equal((await customer.call(thread(receipt), { body: 'Otra cosa', idempotency_key: key })).status, 409);
  const same = uuid();
  const burst = await Promise.all([...Array(10)].map(() => agent.call('/agent/intake-messages', { protocol: receipt.protocol, body: 'Revisando', idempotency_key: same })));
  assert.deepEqual(burst.map(r => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
  assert.equal(new Set(burst.map(r => r.body.message_id)).size, 1);
  const items = (await agent.call('/agent/intake-messages?protocol=' + receipt.protocol)).body.items;
  assert.deepEqual(items.map(m => m.body), ['Hola', 'Revisando']);
});

test('isolation: another customer reads and writes nothing on a report that is not theirs, and it looks missing', async () => {
  const { receipt } = await signedInReport('demo-ana');
  // The local picker session: an email sign-in would give Bruno a notification target that notify.test.js expects absent.
  const bruno = client(); assert.equal((await bruno.call('/demo/session', { customer_id: 'demo-bruno' })).status, 200);
  for (const ref of [receipt.reference_short, receipt.protocol]) {
    const read = await bruno.call(`/intake/handoff/${ref}/messages`);
    const missing = await bruno.call(`/intake/handoff/${uuid()}/messages`);
    assert.deepEqual([read.status, read.body], [missing.status, missing.body]);
    assert.equal((await bruno.call(`/intake/handoff/${ref}/messages`, { body: 'x', idempotency_key: uuid() })).status, 404);
  }
  assert.equal((await bruno.call('/agent/intake-messages?protocol=' + receipt.protocol)).status, 401, 'a customer session is not an agent session');
});

test('a closed report is read-only for both sides', async () => {
  const { customer, agent, receipt } = await signedInReport();
  assert.equal((await agent.call('/agent/intake-messages', { protocol: receipt.protocol, body: 'Te escribimos por el canal del banco.', idempotency_key: uuid() })).status, 201);
  for (const status of ['in_review', 'closed']) assert.equal((await agent.call('/agent/intake-status', { protocol: receipt.protocol, status })).status, 200);
  const closed = await customer.call(thread(receipt));
  assert.equal(closed.body.status, 'closed'); assert.equal(closed.body.can_post, false); assert.equal(closed.body.items.length, 1);
  assert.equal((await customer.call(thread(receipt), { body: 'Gracias', idempotency_key: uuid() })).status, 409);
  assert.equal((await agent.call('/agent/intake-messages', { protocol: receipt.protocol, body: 'Otra', idempotency_key: uuid() })).status, 409);
});

test('hostile input is refused or stored as data, never executed; sessions, methods and paths are checked', async () => {
  const { customer, agent, receipt } = await signedInReport();
  const bad = [{}, { body: 'x' }, { body: 'x', idempotency_key: 'nope' }, { body: '', idempotency_key: uuid() }, { body: '   ', idempotency_key: uuid() },
    { body: 'a'.repeat(2001), idempotency_key: uuid() }, { body: 'a\u0000b', idempotency_key: uuid() }, { body: 7, idempotency_key: uuid() },
    { body: 'x', idempotency_key: uuid(), author: 'agent' }, { body: 'x', idempotency_key: uuid(), protocol: receipt.protocol }];
  for (const payload of bad) assert.equal((await customer.call(thread(receipt), payload)).status, 422, JSON.stringify(payload).slice(0, 60));
  assert.equal((await customer.call(thread(receipt), 'not json')).status, 422, 'readJsonBody refuses a non-JSON body');
  assert.equal((await agent.call('/agent/intake-messages', { body: 'x', idempotency_key: uuid() })).status, 422, 'the agent names the report');
  const markup = "<img src=x onerror=alert(1)> '); DROP TABLE handoff_messages; --";
  assert.equal((await customer.call(thread(receipt), { body: markup, idempotency_key: uuid() })).status, 201);
  assert.equal((await agent.call('/agent/intake-messages?protocol=' + receipt.protocol)).body.items.at(-1).body, markup, 'stored as text');
  assert.equal((await customer.call(thread(receipt) + '?x=1')).status, 422);
  assert.equal((await agent.call('/agent/intake-messages?protocol=' + receipt.protocol + '&x=1')).status, 422);
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    assert.equal((await fetch(base + thread(receipt), { method, headers: { Cookie: customer.cookie } })).status, 405, method);
    assert.equal((await fetch(base + '/agent/intake-messages', { method, headers: { Cookie: agent.cookie } })).status, 405, method);
  }
  for (const headers of [{}, { Cookie: 'demo_session=' + '0'.repeat(64) }, { Cookie: customer.cookie.replace('demo_session', 'demo_agent_session') }]) {
    assert.equal((await fetch(base + thread(receipt), { headers })).status, 401, JSON.stringify(headers).slice(0, 40));
    assert.equal((await fetch(base + '/agent/intake-messages?protocol=' + receipt.protocol, { headers })).status, 401);
  }
  assert.equal((await customer.call('/intake/handoff/AR-0000/messages')).status, 404, 'a malformed reference looks missing');
});

test('a message never reaches the event log; the thread stops at 50 messages', async () => {
  const { customer, agent, receipt, episode } = await signedInReport();
  const secret = 'Mi tarjeta termina en 4821 y vivo en la calle Falsa 123';
  assert.equal((await customer.call(thread(receipt), { body: secret, idempotency_key: uuid() })).status, 201);
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  const { resolve } = await import('node:path');
  const events = await withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, store => store.listIntakeHistory(episode));
  assert.ok(events.length > 0 && events.every(e => !e.event_json.includes('4821') && !e.event_json.includes('Falsa')));
  for (let i = 1; i < 50; i++) assert.equal((await agent.call('/agent/intake-messages', { protocol: receipt.protocol, body: 'm' + i, idempotency_key: uuid() })).status, 201);
  const full = await customer.call(thread(receipt));
  assert.equal(full.body.items.length, 50); assert.equal(full.body.can_post, false);
  assert.equal((await customer.call(thread(receipt), { body: 'una más', idempotency_key: uuid() })).status, 409);
});
