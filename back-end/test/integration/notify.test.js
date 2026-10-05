/** Outbox and notification target store methods against local D1. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

test('an email sign-in upserts the target, and an outbox row is queued, marked and counted per customer and reference', async () => {
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  await withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, async store => {
    const now = Date.now(); const reference = 'AR-' + crypto.randomUUID();
    const signIn = (emailEnc, at) => store.rotateSession({ now: at, oldHash: null, newHash: crypto.randomUUID().replaceAll('-', '').repeat(2),
      actor: 'customer', customerId: 'demo-ana', expiresAt: at + 3600000, emailEnc, requestId: 'notify-fixture' });
    await signIn('iv.one', now); await signIn('iv.two', now + 1);
    assert.deepEqual(await store.findNotificationTarget('demo-ana'), { email_enc: 'iv.two', updated_at: now + 1 });
    assert.equal(await store.findNotificationTarget('demo-bruno'), null);
    const messageId = crypto.randomUUID();
    await store.enqueueEmail({ messageId, now, customerId: 'demo-ana', template: 'received', language: 'es', reference });
    await store.markEmail(messageId, 'skipped', null);
    const failedId = crypto.randomUUID();
    assert.equal((await store.enqueueEmail({ messageId: failedId, now: now - 120000, customerId: 'demo-ana', template: 'update', language: 'es', reference })).length, 1);
    assert.deepEqual(await store.enqueueEmail({ messageId: crypto.randomUUID(), now, customerId: 'demo-ana', template: 'update', language: 'es', reference }), [], 'inside the window');
    await store.markEmail(failedId, 'failed', null);
    const retryId = crypto.randomUUID();
    assert.equal((await store.enqueueEmail({ messageId: retryId, now, customerId: 'demo-ana', template: 'update', language: 'es', reference })).length, 1,
      'a recorded failure never suppresses a retry');
    await store.markEmail(retryId, 'sent', 'ses-accepted');
    assert.deepEqual(await store.enqueueEmail({ messageId: crypto.randomUUID(), now: now + 1, customerId: 'demo-ana', template: 'update', language: 'es', reference }), [],
      'an SES-accepted request keeps the suppression window');
    assert.deepEqual(await store.recentEmails('demo-ana', reference, now - 60000, 'update'), { count: 1, latest: now });
    assert.deepEqual(await store.recentEmails('demo-ana', reference, now - 600000, 'update'), { count: 2, latest: now });
    assert.deepEqual(await store.recentEmails('demo-ana', reference, now - 600000, 'received'), { count: 1, latest: now });
    assert.equal((await store.recentEmails('demo-bruno', reference, 0, 'update')).count, 0);
    await assert.rejects(store.markEmail(messageId, 'delivered', null));
    await assert.rejects(store.enqueueEmail({ messageId: crypto.randomUUID(), now, customerId: 'demo-ana', template: 'refund', language: 'es', reference }));
  });
});

test('an email sign-in stores ciphertext; each handoff queues one "received" email, delivered after the response', async () => {
  const { client, idToken } = await import('../support/client.js');
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  const startBody = language => ({ language, mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
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

test('POST /reports/update: the owner gets one "update" email per report per 5 minutes; everyone else is refused', async () => {
  const { client, idToken } = await import('../support/client.js');
  const { assertContract } = await import('../support/contract.js');
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  const startBody = language => ({ language, mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
    customer_statement: 'No reconozco este cargo.', idempotency_key: crypto.randomUUID() });
  const ana = client({ authorization: 'Bearer ' + await idToken('demo-ana') });
  assert.equal((await ana.call('/auth/session', {})).status, 200);
  const episode = (await ana.call('/intake/start', startBody('es'))).body.episode_id;
  const receipt = (await ana.call('/intake/handoff', { episode_id: episode, kind: 'incomplete', idempotency_key: crypto.randomUUID() })).body;
  const first = await ana.call('/reports/update', { protocol: receipt.protocol.toUpperCase(), language: 'en' });
  assert.equal(first.status, 202); assert.deepEqual(first.body, { queued: true }); assertContract('updateQueued', first.body);
  const again = await ana.call('/reports/update', { protocol: receipt.protocol, language: 'pt' });
  assert.equal(again.status, 429); assert.deepEqual(again.body, { detail: 'An update request is already in progress or was accepted recently' });
  const wait = Number(again.headers.get('Retry-After'));
  assert.ok(wait > 0 && wait <= 300, String(wait));
  await withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, async store => {
    let rows = [];
    for (let i = 0; i < 40; i++) {
      rows = (await store.findEmails('demo-ana', receipt.reference_short)).filter(r => r.template === 'update');
      if (rows.length && rows.every(r => r.provider_status !== 'queued')) break;
      await new Promise(done => setTimeout(done, 100));
    }
    assert.deepEqual(rows, [{ template: 'update', language: 'en', provider_status: 'skipped' }]);
  });

  const bruno = client(); assert.equal((await bruno.call('/demo/session', { customer_id: 'demo-bruno' })).status, 200);
  const foreign = await bruno.call('/reports/update', { protocol: receipt.protocol });
  const missing = await bruno.call('/reports/update', { protocol: crypto.randomUUID() });
  assert.equal(foreign.status, 404); assert.equal(missing.status, 404);
  assert.deepEqual(foreign.body, { detail: 'Report not found' }); assert.equal(foreign.text, missing.text);
  const brunoEpisode = (await bruno.call('/intake/start', startBody('pt'))).body.episode_id;
  const own = (await bruno.call('/intake/handoff', { episode_id: brunoEpisode, kind: 'incomplete', idempotency_key: crypto.randomUUID() })).body;
  const noTarget = await bruno.call('/reports/update', { protocol: own.protocol });
  assert.equal(noTarget.status, 409); assert.deepEqual(noTarget.body, { detail: 'No email on file for this sign-in' });

  for (const body of ['{bad', [], {}, { protocol: 'x' }, { protocol: 42 }, { protocol: receipt.protocol, extra: 1 }, { reference: receipt.protocol },
    ...[null, '', 'fr', 'EN', 1, {}, ['en']].map(language => ({ protocol: receipt.protocol, language })),
    { protocol: receipt.protocol, language: 'en', customer_id: 'demo-bruno' }]) {
    assert.equal((await ana.call('/reports/update', body)).status, 422, JSON.stringify(body));
  }
  const get = await ana.call('/reports/update');
  assert.equal(get.status, 405); assert.equal(get.headers.get('Allow'), 'POST');
  const none = await client().call('/reports/update', { protocol: receipt.protocol });
  assert.equal(none.status, 401); assert.deepEqual(none.body, { detail: 'Start a demo session first' });
});

test('two concurrent update requests for one report queue exactly one email', async () => {
  const { client, idToken } = await import('../support/client.js');
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  const ana = client({ authorization: 'Bearer ' + await idToken('demo-ana') });
  assert.equal((await ana.call('/auth/session', {})).status, 200);
  const episode = (await ana.call('/intake/start', { language: 'es', mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
    customer_statement: 'No reconozco este cargo.', idempotency_key: crypto.randomUUID() })).body.episode_id;
  const receipt = (await ana.call('/intake/handoff', { episode_id: episode, kind: 'incomplete', idempotency_key: crypto.randomUUID() })).body;
  const results = await Promise.all(['es', 'en'].map(language => ana.call('/reports/update', { protocol: receipt.protocol, language })));
  assert.deepEqual(results.map(r => r.status).sort(), [202, 429]);
  assert.ok(Number(results.find(r => r.status === 429).headers.get('Retry-After')) > 0);
  await withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, async store => {
    assert.equal((await store.findEmails('demo-ana', receipt.reference_short)).filter(r => r.template === 'update').length, 1);
  });
});

test('queued and SES-accepted updates wait five minutes; audited failed/skipped rows allow retry at ten seconds', async () => {
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  await withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, async store => {
    for (const status of ['queued', 'sent', 'failed', 'skipped']) {
      const reference = 'AR-' + crypto.randomUUID(), now = Date.now(), messageId = crypto.randomUUID();
      const enqueue = at => store.enqueueEmail({ messageId: crypto.randomUUID(), now: at, customerId: 'demo-ana', template: 'update', language: 'pt', reference });
      await store.enqueueEmail({ messageId, now, customerId: 'demo-ana', template: 'update', language: 'pt', reference });
      if (status !== 'queued') await store.markEmail(messageId, status, status === 'sent' ? 'ses-mock' : null);
      const delay = status === 'failed' || status === 'skipped' ? 10000 : 300000;
      assert.equal(await store.recentEmailRetryAt('demo-ana', reference, now - 1), now + delay);
      assert.deepEqual(await enqueue(now + delay - 1), [], status + ' suppressed before eligibility');
      assert.equal((await enqueue(now + delay)).length, 1, status + ' eligible at boundary');
      const rows = await store.findEmails('demo-ana', reference);
      assert.deepEqual(rows.map(r => r.provider_status), [status, 'queued'], 'the previous outcome stays auditable');
    }
  });
});

test('admin act-as queues the requested customer report only in the admin notification outbox', async () => {
  const { client, idToken } = await import('../support/client.js');
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  const bruno = client(); await bruno.call('/demo/session', { customer_id: 'demo-bruno' });
  const episode = (await bruno.call('/intake/start', { language: 'pt', mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
    customer_statement: 'Não reconheço esta cobrança.', idempotency_key: crypto.randomUUID() })).body.episode_id;
  const receipt = (await bruno.call('/intake/handoff', { episode_id: episode, kind: 'incomplete', idempotency_key: crypto.randomUUID() })).body;
  const admin = client({ authorization: 'Bearer ' + await idToken('demo-ana', { groups: ['admin'] }) });
  assert.equal((await admin.call('/auth/session', {})).status, 200);
  assert.equal((await admin.call('/admin/act-as', { customer_id: 'demo-bruno' })).status, 200);
  const queued = await admin.call('/reports/update', { protocol: receipt.protocol });
  assert.equal(queued.status, 202); assert.deepEqual(queued.body, { queued: true });
  const duplicate = await admin.call('/reports/update', { protocol: receipt.protocol }); assert.equal(duplicate.status, 429);
  assert.ok(Number(duplicate.headers.get('Retry-After')) > 0);
  await withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, async store => {
    let rows = [];
    for (let i = 0; i < 40; i++) {
      rows = (await store.findEmails('demo-ana', receipt.reference_short)).filter(row => row.template === 'update');
      if (rows.length && rows[0].provider_status !== 'queued') break;
      await new Promise(done => setTimeout(done, 100));
    }
    assert.deepEqual(rows, [{ template: 'update', language: 'pt', provider_status: 'skipped' }], 'missing SES stays skipped, never delivered');
    assert.deepEqual((await store.findEmails('demo-bruno', receipt.reference_short)).filter(row => row.template === 'update'), []);
  });
});
