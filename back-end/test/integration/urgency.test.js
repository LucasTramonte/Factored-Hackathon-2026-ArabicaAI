/** Urgency lane (stated policy, config/urgency.json): a high charge is flagged on the receipt, queued first and emailed with the call-your-bank line. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { client, idToken, closeReport } from '../support/client.js';
import { assertContract } from '../support/contract.js';
import policy from '../../src/config/urgency.json' with { type: 'json' };

const start = async (c, reason = 'not_mine') => {
  const r = await c.call('/intake/start', { language: 'es', mode: 'guided', report_type: 'unrecognized_charge', reason,
    customer_statement: 'No reconozco este cargo.', idempotency_key: crypto.randomUUID() });
  assert.equal(r.status, 201); return r.body.episode_id;
};
const confirm = async (c, transaction_id, reason) => c.call('/intake/confirm',
  { episode_id: await start(c, reason), transaction_id, customer_confirmed: true, idempotency_key: crypto.randomUUID() });

test('a charge above the stated threshold gets a high receipt with the block line, heads the queue and queues the email', async () => {
  const ana = client({ authorization: 'Bearer ' + await idToken('demo-ana') });
  assert.equal((await ana.call('/auth/session', {})).status, 200); // a notification target, so "received" is queued
  const high = await confirm(ana, 'demo-tx-006'); // BRL 3,890.00, above the BRL 2,500 policy amount
  assert.equal(high.status, 201); assertContract('intakeReceipt', high.body);
  assert.equal(high.body.urgency, 'high'); assert.equal(high.body.block_card_line, policy.demo_block_line);
  const normal = await confirm(ana, 'demo-tx-004');
  assert.equal(normal.status, 201); assertContract('intakeReceipt', normal.body);
  assert.equal(normal.body.urgency, 'normal'); assert.ok(!('block_card_line' in normal.body));
  const incomplete = await ana.call('/intake/handoff', { episode_id: await start(ana), kind: 'incomplete', idempotency_key: crypto.randomUUID() });
  assert.equal(incomplete.status, 201); assert.equal(incomplete.body.urgency, 'normal'); assert.ok(!('block_card_line' in incomplete.body));

  const agent = client(); assert.equal((await agent.call('/demo/agent-session', {})).status, 200);
  const queue = await agent.call('/agent/intakes'); assert.equal(queue.status, 200); assertContract('agentIntakeList', queue.body);
  assert.equal(queue.body.items[0].protocol, high.body.protocol, 'the open high report heads the queue, though newer reports exist');
  assert.equal(queue.body.items[0].urgency, 'high');
  assert.equal(queue.body.items.find(x => x.protocol === normal.body.protocol).urgency, 'normal');
  const detail = await agent.call('/agent/intake-detail?protocol=' + high.body.protocol);
  assert.equal(detail.status, 200); assertContract('agentIntakeDetail', detail.body); assert.equal(detail.body.urgency, 'high');

  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  await withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, async store => {
    const rows = await store.findEmails('demo-ana', high.body.reference_short);
    assert.equal(rows.length, 1); assert.equal(rows[0].template, 'received');
  });
  await closeReport(high.body.protocol); await closeReport(normal.body.protocol);
  const after = await agent.call('/agent/intakes');
  assert.notEqual(after.body.items[0].protocol, high.body.protocol, 'a closed high report leaves the head of the queue');
});

test('a lost or stolen card is high on a confirmed charge below every threshold and on an incomplete handoff', async () => {
  const ana = client({ authorization: 'Bearer ' + await idToken('demo-ana') });
  assert.equal((await ana.call('/auth/session', {})).status, 200);
  const high = await confirm(ana, 'demo-tx-004', 'card_lost_or_stolen'); // BRL 47.30, below the BRL policy amount and Ana's p95
  assert.equal(high.status, 201); assertContract('intakeReceipt', high.body);
  assert.equal(high.body.urgency, 'high'); assert.equal(high.body.block_card_line, policy.demo_block_line);
  // The "?" entry: a lost card on a charge that isn't in the list still gets the call-your-bank line (ADR-010, decision 3).
  const lost = await ana.call('/intake/handoff', { episode_id: await start(ana, 'card_lost_or_stolen'), kind: 'incomplete', idempotency_key: crypto.randomUUID() });
  assert.equal(lost.status, 201); assertContract('intakeReceipt', lost.body);
  assert.equal(lost.body.urgency, 'high'); assert.equal(lost.body.block_card_line, policy.demo_block_line);
  const other = await ana.call('/intake/handoff', { episode_id: await start(ana, 'duplicate'), kind: 'incomplete', idempotency_key: crypto.randomUUID() });
  assert.equal(other.status, 201); assert.equal(other.body.urgency, 'normal'); assert.ok(!('block_card_line' in other.body));

  const agent = client(); assert.equal((await agent.call('/demo/agent-session', {})).status, 200);
  const queue = await agent.call('/agent/intakes'); assertContract('agentIntakeList', queue.body);
  assert.deepEqual(queue.body.items.slice(0, 2).map(x => x.protocol).sort(), [high.body.protocol, lost.body.protocol].sort(), 'both lost-card reports head the queue');
  assert.ok(queue.body.items.slice(0, 2).every(x => x.reason === 'card_lost_or_stolen' && x.urgency === 'high'));

  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  await withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, async store => {
    const rows = await store.findEmails('demo-ana', high.body.reference_short);
    assert.equal(rows.length, 1); assert.equal(rows[0].template, 'received');
  });
  await closeReport(high.body.protocol); await closeReport(lost.body.protocol);
});
