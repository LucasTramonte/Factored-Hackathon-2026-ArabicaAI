/** Linked follow-ups through the Worker and local D1, including ownership and simultaneous replay. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { client, closeReport } from '../support/client.js';
import { assertContract } from '../support/contract.js';
import { withIntakeStore } from '../../scripts/intake-store.mjs';

const body = previous_protocol => ({ language: 'es', mode: 'guided', report_type: 'unrecognized_charge', reason: 'other',
  customer_statement: 'El problema continúa; solicito otra revisión.', idempotency_key: crypto.randomUUID(),
  ...(previous_protocol && { previous_protocol }) });
async function report(c, closed = true) {
  const start = await c.call('/intake/start', body()); assert.equal(start.status, 201);
  const receipt = await c.call('/intake/handoff', { episode_id: start.body.episode_id, kind: 'incomplete', idempotency_key: crypto.randomUUID() });
  assert.equal(receipt.status, 201); assertContract('intakeReceipt', receipt.body);
  if (closed) await closeReport(receipt.body.protocol);
  return { start: start.body, receipt: receipt.body };
}

test('linked starts replay once and create a new normal handoff without reopening the source on local D1', async () => {
  const ana = client(); await ana.call('/demo/session', { customer_id: 'demo-ana' });
  const original = await report(ana), other = await report(ana);
  const payload = body(original.receipt.protocol);
  const responses = await Promise.all([ana.call('/intake/start', payload), ana.call('/intake/start', payload), ana.call('/intake/start', payload)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 200, 201]);
  assert.equal(new Set(responses.map(r => r.body.episode_id)).size, 1); responses.forEach(r => assertContract('intakeStart', r.body));
  const started = responses.find(r => r.status === 201), episodeId = started.body.episode_id;
  assert.equal((await ana.call('/intake/start', { ...payload, previous_protocol: other.receipt.protocol })).status, 409);
  const finishing = { episode_id: episodeId, kind: 'incomplete', idempotency_key: crypto.randomUUID() };
  const finished = await ana.call('/intake/handoff', finishing); assert.equal(finished.status, 201); assertContract('intakeReceipt', finished.body);
  assert.notEqual(finished.body.protocol, original.receipt.protocol);
  assert.equal((await ana.call('/intake/handoff', finishing)).status, 200);
  await withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, async store => {
    const source = await store.findOwnedIntakeHandoff('demo-ana', original.start.episode_id);
    const episode = await store.findIntake('demo-ana', episodeId);
    assert.equal(source.status, 'closed'); assert.equal(episode.previous_handoff_id, source.handoff_id);
    assert.equal(episode.state, 'incomplete_handoff');
  });
  const ceiling = (m, reads, writes) => assert.ok(m.queries <= 7 && m.rows_read <= reads && m.rows_written <= writes && m.round_trips <= 2,
    'linked start exceeded measured ceiling: ' + JSON.stringify(m));
  ceiling(started.metrics, 19, 12);
  ceiling(responses.find(r => r.status === 200).metrics, 17, 2);
  console.log('D1_LINKED_START ' + JSON.stringify(started.metrics));
  console.log('D1_LINKED_START_REPLAY ' + JSON.stringify(responses.find(r => r.status === 200).metrics));
  await closeReport(finished.body.protocol);
});

test('linked starts reject other customers missing sources open states hostile links and wrong-role sessions without writes', async () => {
  const ana = client(), bruno = client(), agent = client();
  await ana.call('/demo/session', { customer_id: 'demo-ana' }); await bruno.call('/demo/session', { customer_id: 'demo-bruno' });
  await agent.call('/demo/agent-session', {});
  const foreign = await report(bruno), open = await report(ana, false);
  for (const [previous, status] of [[foreign.receipt.protocol, 404], [crypto.randomUUID(), 404], [open.receipt.protocol, 409]]) {
    const rejected = await ana.call('/intake/start', body(previous)); assert.equal(rejected.status, status); assertContract('error', rejected.body);
    assert.equal(rejected.metrics.rows_written, 0);
  }
  for (const previous_protocol of [null, '', 42, "' OR 1=1--", 'AR-AAAA-BBBB']) {
    const rejected = await ana.call('/intake/start', { ...body(), previous_protocol }); assert.equal(rejected.status, 422);
    assert.equal(rejected.metrics.rows_written, 0);
  }
  assert.equal((await agent.call('/intake/start', body(foreign.receipt.protocol))).status, 401);
  await closeReport(open.receipt.protocol);
});
