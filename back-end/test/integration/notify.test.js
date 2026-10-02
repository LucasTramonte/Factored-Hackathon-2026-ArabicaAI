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
