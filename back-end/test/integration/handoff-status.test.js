/** A person moves a handoff received → in_review → closed; each first step queues one email to the customer. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { client, idToken } from '../support/client.js';
import { assertContract } from '../support/contract.js';

const config = () => resolve(process.cwd(), 'wrangler.jsonc');
async function signedInReport() {
  const ana = client({ authorization: 'Bearer ' + await idToken('demo-ana') });
  assert.equal((await ana.call('/auth/session', {})).status, 200);
  const episode = (await ana.call('/intake/start', { language: 'es', mode: 'guided', report_type: 'unrecognized_charge',
    customer_statement: 'No reconozco este cargo.', idempotency_key: crypto.randomUUID() })).body.episode_id;
  const receipt = await ana.call('/intake/handoff', { episode_id: episode, kind: 'incomplete', idempotency_key: crypto.randomUUID() });
  assert.equal(receipt.status, 201);
  const agent = client(); assert.equal((await agent.call('/demo/agent-session', {})).status, 200);
  return { ana, agent, receipt: receipt.body };
}
async function rows(receipt) {
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  return withIntakeStore({ config: config() }, async store => ({
    history: await store.listStatusHistory(receipt.protocol),
    emails: (await store.findEmails('demo-ana', receipt.reference_short)).filter(r => r.template !== 'received').map(r => r.template) }));
}

test('received → in_review → closed, once each, with history, emails and the customer and agent views', async () => {
  const { ana, agent, receipt } = await signedInReport();
  const move = status => agent.call('/agent/intake-status', { protocol: receipt.protocol, status });
  assert.equal((await move('closed')).status, 409, 'received → closed skips a step');
  const first = await move('in_review');
  assert.equal(first.status, 200); assertContract('intakeTransition', first.body);
  assert.equal(first.body.status, 'in_review');
  let seen = await rows(receipt);
  assert.equal(seen.history.length, 1); assert.deepEqual(seen.emails, ['in_review']);
  const replay = await move('in_review');
  assert.equal(replay.status, 200); assert.deepEqual(replay.body, first.body);
  seen = await rows(receipt);
  assert.equal(seen.history.length, 1, 'a replay adds no history'); assert.deepEqual(seen.emails, ['in_review'], 'nor an email');
  const queue = await agent.call('/agent/intakes'); assertContract('agentIntakeList', queue.body);
  assert.equal(queue.body.items.find(x => x.protocol === receipt.protocol).status, 'in_review');
  const closed = await move('closed');
  assert.equal(closed.status, 200); assertContract('intakeTransition', closed.body);
  assert.equal((await move('in_review')).status, 409, 'never backwards');
  seen = await rows(receipt);
  assert.deepEqual(seen.history.map(r => r.status), ['in_review', 'closed']); assert.deepEqual(seen.emails, ['in_review', 'closed']);
  assert.ok(seen.history.every(r => /^[0-9a-f]{12}$/.test(r.agent_session_ref)));
  const detail = await agent.call('/agent/intake-detail?protocol=' + receipt.protocol);
  assertContract('agentIntakeDetail', detail.body); assert.equal(detail.body.status, 'closed');
  const reports = await ana.call('/reports'); assertContract('reportList', reports.body);
  const mine = reports.body.items.find(x => x.protocol === receipt.protocol);
  assert.equal(mine.status, 'closed'); assert.equal(mine.next_step, 'closed_by_person');
});

test('intake-status refuses unknown protocols, customer sessions, no session and extra keys', async () => {
  const { ana, agent, receipt } = await signedInReport();
  const missing = await agent.call('/agent/intake-status', { protocol: crypto.randomUUID(), status: 'in_review' });
  assert.equal(missing.status, 404); assertContract('error', missing.body);
  const asCustomer = client(); asCustomer.cookie = ana.cookie.replace('demo_session=', 'demo_agent_session=');
  assert.equal((await asCustomer.call('/agent/intake-status', { protocol: receipt.protocol, status: 'in_review' })).status, 401);
  assert.equal((await ana.call('/agent/intake-status', { protocol: receipt.protocol, status: 'in_review' })).status, 401);
  for (const body of [{ protocol: receipt.protocol, status: 'in_review', customer_id: 'demo-ana' }, { protocol: receipt.protocol, status: 'refunded' }, { protocol: receipt.protocol }]) {
    const res = await agent.call('/agent/intake-status', body); assert.equal(res.status, 422, JSON.stringify(body)); assertContract('error', res.body);
  }
  assert.deepEqual((await rows(receipt)).history, []);
});

test('ten concurrent identical transitions record one history row and queue one email', async () => {
  const { agent, receipt } = await signedInReport();
  const results = await Promise.all(Array.from({ length: 10 }, () => agent.call('/agent/intake-status', { protocol: receipt.protocol, status: 'in_review' })));
  assert.deepEqual(results.map(r => r.status), Array(10).fill(200));
  assert.equal(new Set(results.map(r => r.body.changed_at)).size, 1);
  const seen = await rows(receipt);
  assert.equal(seen.history.length, 1); assert.deepEqual(seen.emails, ['in_review']);
});
