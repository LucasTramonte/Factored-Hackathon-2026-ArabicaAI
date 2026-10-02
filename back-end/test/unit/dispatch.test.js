/** deliver: read the target, send the row's template, mark the outbox row; never throws. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliver } from '../../src/notify/dispatch.js';
import { encrypt } from '../../src/notify/email.js';

const env = { EMAIL_KEY: Buffer.alloc(32, 7).toString('base64') };
const job = { messageId: 'm1', customerId: 'ana', language: 'pt', reference: 'AR-ABCD-1234' };
async function run(send, blob, extra = {}) {
  const marks = [], sent = [];
  const store = { findNotificationTarget: async () => ({ email_enc: blob ?? await encrypt('ana@example.com', env) }),
    markEmail: async (...args) => { marks.push(args); } };
  await deliver(env, store, { ...job, ...extra }, async (e, mail) => { sent.push(mail); return send(); });
  return { marks, sent };
}

test('sent, skipped and failed sends are marked; nothing throws', async () => {
  const ok = await run(() => ({ ok: true, messageId: 'ses-1' }));
  assert.deepEqual(ok.marks, [['m1', 'sent', 'ses-1']]);
  assert.equal(ok.sent[0].to, 'ana@example.com'); assert.match(ok.sent[0].subject, /AR-ABCD-1234/); assert.match(ok.sent[0].text, /Recebemos/);
  assert.deepEqual((await run(() => ({ ok: false, skipped: true }))).marks, [['m1', 'skipped', null]]);
  assert.deepEqual((await run(() => ({ ok: false }))).marks, [['m1', 'failed', null]]);
  assert.deepEqual((await run(() => { throw new Error('boom'); })).marks, [['m1', 'failed', null]]);
  const bad = await run(() => ({ ok: true }), 'not.ciphertext');
  assert.deepEqual(bad.marks, [['m1', 'failed', null]]); assert.equal(bad.sent.length, 0);
});

test('the row\'s template is rendered, with the status text for "update"', async () => {
  const { sent } = await run(() => ({ ok: true }), undefined, { template: 'update', status: 'Recebido; uma pessoa vai analisá-lo' });
  assert.match(sent[0].subject, /Status do seu relato AR-ABCD-1234/);
  assert.match(sent[0].text, /Status atual do seu relato AR-ABCD-1234: Recebido; uma pessoa vai analisá-lo/);
});
