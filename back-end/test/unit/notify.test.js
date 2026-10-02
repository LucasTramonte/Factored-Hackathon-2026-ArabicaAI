/** Notification email: address encryption, three-language templates and the SES sender. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, sendEmail } from '../../src/notify/email.js';
import { STATUS_TEXT, render } from '../../src/notify/templates.js';

const env = { EMAIL_KEY: Buffer.alloc(32, 7).toString('base64') };
const ses = { SES_ACCESS_KEY_ID: 'AKIDEXAMPLE', SES_SECRET_ACCESS_KEY: 'secret', SES_REGION: 'us-east-2', SES_FROM: 'Demo <from@example.com>' };
const mail = { to: 'ana@example.com', subject: 'Hola', text: 'Cuerpo' };

test('an address round-trips, and each encryption uses a fresh IV', async () => {
  const a = await encrypt('ana@example.com', env), b = await encrypt('ana@example.com', env);
  assert.notEqual(a, b);
  assert.equal(await decrypt(a, env), 'ana@example.com');
});

test('a tampered blob, a wrong key or a missing or malformed key throws', async () => {
  const blob = await encrypt('ana@example.com', env);
  const [iv, ct] = blob.split('.');
  const flipped = Buffer.from(ct, 'base64'); flipped[0] ^= 1;
  await assert.rejects(decrypt(`${iv}.${flipped.toString('base64')}`, env));
  await assert.rejects(decrypt(blob, { EMAIL_KEY: Buffer.alloc(32, 8).toString('base64') }));
  for (const key of [undefined, '', 'not base64!', Buffer.alloc(16).toString('base64')]) {
    await assert.rejects(encrypt('x', { EMAIL_KEY: key }), String(key));
    await assert.rejects(decrypt(blob, { EMAIL_KEY: key }), String(key));
  }
});

const NO_REFUND = { es: 'No se ha iniciado ningún reembolso.', pt: 'Nenhum reembolso foi iniciado.', en: 'No refund has been started.' };
test('every template in every language names the reference, says no refund started and fills every slot', () => {
  for (const lang of ['es', 'pt', 'en']) for (const template of ['received', 'in_review', 'closed', 'update']) {
    for (const urgent of [false, true]) {
      const { subject, text } = render(template, lang, { reference: 'AR-ABCD-1234', urgent, status: 'X-STATUS',
        customer_statement: 'SECRET STATEMENT', statement: 'SECRET STATEMENT' });
      const where = `${template}/${lang}/${urgent}`;
      assert.ok(subject && text.includes('AR-ABCD-1234'), where);
      assert.ok(text.includes(NO_REFUND[lang]), where);
      assert.doesNotMatch(subject + text, /[{}]/, where);
      assert.doesNotMatch(subject + text, /SECRET STATEMENT|resolved|resuelt|resolvid|\bdone\b|denúncia/i, where);
      if (template === 'update') assert.ok(text.includes('X-STATUS'), where);
    }
  }
  assert.ok(render('received', 'es', { reference: 'R', urgent: true }).text.includes('Este servicio no bloquea tarjetas.'));
  assert.ok(!render('received', 'es', { reference: 'R' }).text.includes('bloquea tarjetas'));
  assert.throws(() => render('received', 'fr', { reference: 'R' }));
  assert.equal(STATUS_TEXT.in_review.en, 'In review by a person'); // the client shows "in review" + "by a person"
});

test('a send is one signed SES v2 POST with the specified body', async () => {
  const calls = [];
  const result = await sendEmail({ ...env, ...ses }, mail, async req => { calls.push(req); return Response.json({ MessageId: 'm-1' }); });
  assert.deepEqual(result, { ok: true, messageId: 'm-1' });
  assert.equal(calls.length, 1);
  const [req] = calls;
  assert.ok(req instanceof Request);
  assert.equal(req.url, 'https://email.us-east-2.amazonaws.com/v2/email/outbound-emails');
  assert.equal(req.method, 'POST');
  assert.match(req.headers.get('Authorization'), /^AWS4-HMAC-SHA256 /);
  assert.deepEqual(await req.json(), { FromEmailAddress: ses.SES_FROM, Destination: { ToAddresses: [mail.to] },
    Content: { Simple: { Subject: { Data: 'Hola', Charset: 'UTF-8' }, Body: { Text: { Data: 'Cuerpo', Charset: 'UTF-8' } } } } });
});

test('a send never throws: non-2xx and network errors fail, missing config skips without a call', async () => {
  assert.deepEqual(await sendEmail(ses, mail, async () => new Response('no', { status: 400 })), { ok: false });
  assert.deepEqual(await sendEmail(ses, mail, async () => { throw new Error('down'); }), { ok: false });
  for (const name of Object.keys(ses)) {
    let called = false;
    const partial = { ...ses, [name]: undefined };
    assert.deepEqual(await sendEmail(partial, mail, async () => { called = true; }), { ok: false, skipped: true }, name);
    assert.equal(called, false);
  }
});
