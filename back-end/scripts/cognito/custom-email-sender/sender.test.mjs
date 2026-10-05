import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, createHandler } from './sender.mjs';
const event = (source = 'Authentication', locale = 'pt') => ({ userPoolId: 'pool', callerContext: { clientId: 'client-pt' }, triggerSource: `CustomEmailSender_${source}`, request: { type: 'customEmailSenderRequestV1', code: 'encrypted', clientMetadata: { locale, email: 'attacker@example.com' }, userAttributes: { email: 'recipient@example.com' } } });
test('each locale has its own sign-in subject and invalid locale defaults to Spanish', () => {
  for (const [lang, subject] of [['es','Tu código ArabicaAI'],['pt','Seu código ArabicaAI'],['en','Your ArabicaAI code']]) assert.equal(render('CustomEmailSender_Authentication', lang).subject, subject);
  for (const lang of [undefined, 'fr', '__proto__']) assert.equal(render('CustomEmailSender_Authentication', lang).lang, 'es');
});
test('all native categories render truthful copy and escape secrets without URLs', () => {
  for (const source of ['Authentication','SignUp','ResendCode','ForgotPassword','UpdateUserAttribute','VerifyUserAttribute','AdminCreateUser','AccountTakeOverNotification']) {
    for (const lang of ['es','pt','en']) {
      const result = render(`CustomEmailSender_${source}`, lang, '<b>&"');
      assert.ok(!result.html.includes('<b>')); assert.ok(!result.html.includes('12345678?')); assert.ok(!result.html.includes('href=')); assert.ok(result.subject);
    }
  }
  assert.ok(render('CustomEmailSender_AdminCreateUser', 'en', '&lt;x&gt;').text.includes('<x>'));
  assert.throws(() => render('CustomEmailSender_Unknown', 'en'));
});
test('recipient only comes from event, successful diagnostic is bounded, event unchanged', async () => {
  const e = event(); const original = structuredClone(e); const sends = []; const logs = [];
  await createHandler({ poolId:'pool',from:'sender',clientLocales:{'client-pt':'pt'},decrypt:async ()=>'12345678',send:async i=>sends.push(i),log:i=>logs.push(i) })(e);
  assert.deepEqual(e,original); assert.deepEqual(sends[0].Destination.ToAddresses,['recipient@example.com']);
  assert.equal(logs[0],'{"locale":"pt","template":"auth","status":"sent"}');
});
test('unknown source, wrong pool, bad recipient, decryption and SES errors fail closed and sanitized', async () => {
  for (const change of [e=>e.userPoolId='other',e=>e.triggerSource='CustomEmailSender_Unknown',e=>e.request.userAttributes.email='bad',e=>e.request.code='']) {
    const e=event();change(e);let sent=false;
    await assert.rejects(createHandler({poolId:'pool',decrypt:async()=> 'code',send:async()=>{sent=true}})(e),/^Error: Cognito email delivery failed$/); assert.equal(sent,false);
  }
  for (const failure of ['decrypt','send']) await assert.rejects(createHandler({poolId:'pool',decrypt:async()=>{if(failure==='decrypt')throw Error('secret');return 'code'},send:async()=>{throw Error('recipient secret')}})(event()),/^Error: Cognito email delivery failed$/);
});
test('takeover notification needs no encrypted code',async()=>{
  const e=event('AccountTakeOverNotification');delete e.request.code;let sent;
  await createHandler({poolId:'pool',clientLocales:{'client-pt':'pt'},decrypt:()=>{throw Error()},send:async i=>{sent=i}})(e);assert.ok(sent.Message.Subject.Data.includes('segurança'));
});

test('trusted caller client selects language; request metadata cannot override it', async () => {
  for (const lang of ['es','pt','en']) {
    const e=event('Authentication','es'); e.callerContext.clientId='client-'+lang;
    let sent;
    await createHandler({poolId:'pool',from:'sender',clientLocales:{['client-'+lang]:lang},decrypt:async()=>'12345678',send:async i=>{sent=i}})(e);
    assert.equal(sent.Message.Subject.Data,render('CustomEmailSender_Authentication',lang).subject);
    assert.ok(sent.Message.Body.Html.Data.includes('arabicaai-logo.png'));
  }
});
