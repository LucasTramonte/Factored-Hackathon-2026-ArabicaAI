/** Outbox and notification target store methods against local D1. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

test('a target upserts, and an outbox row is queued, marked and counted per customer and reference', async () => {
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  await withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, async store => {
    const now = Date.now(); const reference = 'AR-' + crypto.randomUUID();
    await store.upsertNotificationTarget({ customerId: 'demo-ana', emailEnc: 'iv.one', now });
    await store.upsertNotificationTarget({ customerId: 'demo-ana', emailEnc: 'iv.two', now: now + 1 });
    assert.deepEqual(await store.findNotificationTarget('demo-ana'), { email_enc: 'iv.two', updated_at: now + 1 });
    assert.equal(await store.findNotificationTarget('demo-bruno'), null);
    const messageId = crypto.randomUUID();
    await store.enqueueEmail({ messageId, now, customerId: 'demo-ana', template: 'received', language: 'es', reference });
    await store.markEmail(messageId, 'skipped', null);
    await store.enqueueEmail({ messageId: crypto.randomUUID(), now: now - 120000, customerId: 'demo-ana', template: 'update', language: 'es', reference });
    assert.equal(await store.recentEmails('demo-ana', reference, now - 60000), 1);
    assert.equal(await store.recentEmails('demo-ana', reference, now - 600000), 2);
    assert.equal(await store.recentEmails('demo-bruno', reference, 0), 0);
    await assert.rejects(store.markEmail(messageId, 'delivered', null));
    await assert.rejects(store.enqueueEmail({ messageId: crypto.randomUUID(), now, customerId: 'demo-ana', template: 'refund', language: 'es', reference }));
  });
});

test('an email sign-in stores ciphertext; each handoff queues one "received" email, delivered after the response', async () => {
  const { client, idToken } = await import('../support/client.js');
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  const startBody = language => ({ language, mode: 'guided', report_type: 'unrecognized_charge',
    customer_statement: 'No reconozco este cargo.', idempotency_key: crypto.randomUUID() });
  const ana = client({ authorization: 'Bearer ' + await idToken('demo-ana') });
  assert.equal((await ana.call('/auth/session', {})).status, 200);
  const episode = (await ana.call('/intake/start', startBody('es'))).body.episode_id;
  const handoff = { episode_id: episode, kind: 'incomplete', idempotency_key: crypto.randomUUID() };
  const receipt = await ana.call('/intake/handoff', handoff);
  assert.equal(receipt.status, 201); assert.ok(receipt.body.reference_short);
  assert.equal((await ana.call('/intake/handoff', handoff)).status, 200, 'replay');
  const bruno = client(); assert.equal((await bruno.call('/demo/session', { customer_id: 'demo-bruno' })).status, 200);
  const brunoEpisode = (await bruno.call('/intake/start', startBody('pt'))).body.episode_id;
  const other = await bruno.call('/intake/handoff', { episode_id: brunoEpisode, kind: 'incomplete', idempotency_key: crypto.randomUUID() });
  assert.equal(other.status, 201);
  await withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, async store => {
    const target = await store.findNotificationTarget('demo-ana');
    assert.ok(target.email_enc); assert.doesNotMatch(target.email_enc, /@/);
    let rows = [];
    for (let i = 0; i < 40; i++) {
      rows = await store.findEmails('demo-ana', receipt.body.reference_short);
      if (rows.length && rows.every(r => r.provider_status !== 'queued')) break;
      await new Promise(done => setTimeout(done, 100));
    }
    assert.deepEqual(rows, [{ template: 'received', language: 'es', provider_status: 'skipped' }]);
    assert.deepEqual(await store.findEmails('demo-bruno', other.body.reference_short), []);
    assert.equal(await store.findNotificationTarget('demo-bruno'), null);
  });
});
