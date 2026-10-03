/** English reports end to end (ADR-008): start, confirm, receipt, stored language, "received" email and agent detail. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { client, idToken, closeReport } from '../support/client.js';
import { assertContract } from '../support/contract.js';

test('an English report is stored, emailed and shown to the agent in English', async () => {
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  const ana = client({ authorization: 'Bearer ' + await idToken('demo-ana') });
  assert.equal((await ana.call('/auth/session', {})).status, 200);
  const start = await ana.call('/intake/start', { language: 'en', mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
    customer_statement: 'I do not recognize this charge.', idempotency_key: crypto.randomUUID() });
  assert.equal(start.status, 201); assertContract('intakeStart', start.body); assert.equal(start.body.language, 'en');
  const receipt = await ana.call('/intake/confirm', { episode_id: start.body.episode_id, transaction_id: 'demo-tx-001',
    customer_confirmed: true, idempotency_key: crypto.randomUUID() });
  assert.equal(receipt.status, 201); assertContract('intakeReceipt', receipt.body);
  await withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, async store => {
    assert.equal((await store.findIntake('demo-ana', start.body.episode_id)).language, 'en');
    let rows = [];
    for (let i = 0; i < 40; i++) {
      rows = await store.findEmails('demo-ana', receipt.body.reference_short);
      if (rows.length && rows.every(r => r.provider_status !== 'queued')) break;
      await new Promise(done => setTimeout(done, 100));
    }
    assert.deepEqual(rows, [{ template: 'received', language: 'en', provider_status: 'skipped' }]);
  });
  const agent = client(); await agent.call('/demo/agent-session', {});
  const detail = await agent.call('/agent/intake-detail?protocol=' + receipt.body.protocol);
  assert.equal(detail.status, 200); assertContract('agentIntakeDetail', detail.body); assert.equal(detail.body.language, 'en');
  await closeReport(receipt.body.protocol); // later suites report the same charge
});
