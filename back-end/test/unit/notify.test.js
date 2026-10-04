/** Notification email: address encryption, three-language templates and the SES sender. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { encrypt, decrypt, mime, sendEmail } from '../../src/notify/email.js';
import { LOGO_CID, LOGO_PNG_BASE64 } from '../../src/notify/logo.js';
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
      const { subject, text, html } = render(template, lang, { reference: 'AR-ABCD-1234', urgent, status: 'X-STATUS',
        appUrl: 'https://demo.example/', customer_statement: 'SECRET STATEMENT', statement: 'SECRET STATEMENT' });
      const where = `${template}/${lang}/${urgent}`;
      assert.ok(subject && text.includes('AR-ABCD-1234') && html.includes('AR-ABCD-1234'), where);
      assert.ok(text.includes(NO_REFUND[lang]) && html.includes(NO_REFUND[lang]), where);
      assert.ok(html.includes(text.split('\n').at(-1)) && !html.includes('>--<'), where); // the demo disclaimer, not the text separator
      assert.doesNotMatch(subject + text + html, /[{}]/, where);
      assert.doesNotMatch(subject + text + html, /SECRET STATEMENT|resolved|resuelt|resolvid|\bdone\b|denúncia/i, where);
      if (template === 'update') assert.ok(text.includes('X-STATUS') && html.includes('X-STATUS'), where);
      // The HTML version carries the same sentences as the text, the logo and one button to the app, with no trailing slash doubled.
      for (const sentence of text.split('\n\n')[0].split('. ')) assert.ok(html.includes(sentence.replace(/\.$/, '').replace(/'/g, '&#39;')), `${where}: ${sentence}`);
      assert.ok(html.includes(`src="cid:${LOGO_CID}"`) && html.includes('href="https://demo.example"'), where);
      assert.equal(html.includes('bloquea tarjetas') || html.includes('bloqueia cartões') || html.includes('does not block cards'), urgent, where);
    }
  }
  // Without an app URL there is no button, the inline logo stays; the reference is escaped like any other value.
  const bare = render('received', 'en', { reference: 'AR-<X>&"1"' }).html;
  assert.ok(bare.includes(`cid:${LOGO_CID}`) && !bare.includes('<a ') && bare.includes('AR-&lt;X&gt;&amp;&quot;1&quot;'));
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

test('an HTML part is sent beside the text when given, and only then', async () => {
  const calls = [];
  await sendEmail({ ...env, ...ses }, { ...mail, html: '<p>Cuerpo</p>' }, async req => { calls.push(await req.json()); return Response.json({ MessageId: 'm-2' }); });
  assert.deepEqual(calls[0].Content.Simple.Body, { Text: { Data: 'Cuerpo', Charset: 'UTF-8' }, Html: { Data: '<p>Cuerpo</p>', Charset: 'UTF-8' } });
});

test('the embedded logo is the PNG the client serves, byte for byte', async () => {
  const served = await readFile(new URL('../../../front-end/public/arabicaai-logo.png', import.meta.url));
  assert.equal(Buffer.from(LOGO_PNG_BASE64, 'base64').equals(served), true);
  assert.equal(served.subarray(0, 4).toString('hex'), '89504e47');
});

test('with an inline image the message goes as raw MIME: text, html and the cid part, subject RFC 2047 encoded', async () => {
  const calls = [];
  const inline = [{ cid: LOGO_CID, type: 'image/png', base64: LOGO_PNG_BASE64 }];
  await sendEmail({ ...env, ...ses }, { ...mail, subject: 'Recibimos tu reporte AR-1', html: `<img src="cid:${LOGO_CID}">`, inline },
    async req => { calls.push(await req.json()); return Response.json({ MessageId: 'm-3' }); });
  assert.deepEqual(Object.keys(calls[0].Content), ['Raw']);
  const raw = Buffer.from(calls[0].Content.Raw.Data, 'base64').toString('utf8');
  assert.ok(raw.startsWith(`From: ${ses.SES_FROM}\r\nTo: ${mail.to}\r\nSubject: =?UTF-8?B?${Buffer.from('Recibimos tu reporte AR-1').toString('base64')}?=\r\n`));
  assert.match(raw, /Content-Type: multipart\/related; boundary="rel-arabicaai"/);
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="alt-arabicaai"/);
  const decoded = (type) => Buffer.from(raw.split(`Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`)[1].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.equal(decoded('text/plain'), 'Cuerpo');
  assert.equal(decoded('text/html'), `<img src="cid:${LOGO_CID}">`);
  assert.match(raw, new RegExp(`Content-Type: image/png\\r\\nContent-ID: <${LOGO_CID}>\\r\\nContent-Disposition: inline`));
  assert.equal(raw.split(`Content-ID: <${LOGO_CID}>`)[1].split('\r\n--rel-arabicaai--')[0].split('\r\n\r\n')[1].replace(/\r\n/g, ''), LOGO_PNG_BASE64);
  for (const line of raw.split('\r\n')) assert.ok(line.length <= 998, 'line length');
  assert.ok(mime({ from: 'a', to: 'b', subject: 'ñ', text: 'ñ', html: null, inline: [] }).endsWith('--rel-arabicaai--\r\n'));
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
