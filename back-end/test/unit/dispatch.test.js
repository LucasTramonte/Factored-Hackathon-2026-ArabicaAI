/** deliver: read the target, send "received", mark the outbox row; never throws. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliver } from '../../src/notify/dispatch.js';
import { encrypt } from '../../src/notify/email.js';

const env = { EMAIL_KEY: Buffer.alloc(32, 7).toString('base64') };
const job = { messageId: 'm1', customerId: 'ana', language: 'pt', reference: 'AR-ABCD-1234' };
async function run(send, blob) {
  const marks = [], sent = [];
  const store = { findNotificationTarget: async () => ({ email_enc: blob ?? await encrypt('ana@example.com', env) }),
    markEmail: async (...args) => { marks.push(args); } };
  await deliver(env, store, job, async (e, mail) => { sent.push(mail); return send(); });
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
