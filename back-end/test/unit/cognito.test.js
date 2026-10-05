/** Cognito ID-token verification: only a correctly signed, unexpired, verified-email ID token for our pool and client passes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { verifyIdToken } from '../../src/auth/cognito.js';

const issuer = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_test';
const clientId = 'test-client';
const keyPair = async kid => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256' } };
};
const ours = await keyPair('k1');
const other = await keyPair('k1'); // same kid, different key
const opts = { jwks: createLocalJWKSet({ keys: [ours.jwk] }), issuer, clientId };
const claims = { token_use: 'id', email: 'ana@example.com', email_verified: true,
  'cognito:groups': ['customer'], 'custom:customer_id': 'demo-ana' };

function sign(overrides = {}, { key = ours.privateKey, iss = issuer, aud = clientId, exp = '1h' } = {}) {
  return new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject('sub-1').setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(key);
}

test('a valid ID token yields the trusted claims', async () => {
  assert.deepEqual(await verifyIdToken(await sign(), opts),
    { sub: 'sub-1', email: 'ana@example.com', groups: ['customer'], customerId: 'demo-ana' });
});

test('missing groups become [] and a malformed customer id becomes null', async () => {
  const r = await verifyIdToken(await sign({ 'cognito:groups': undefined, 'custom:customer_id': 'a b' }), opts);
  assert.deepEqual(r.groups, []);
  assert.equal(r.customerId, null);
});

test('wrong audience is rejected', async () => {
  await assert.rejects(verifyIdToken(await sign({}, { aud: 'other-client' }), opts));
});
test('wrong issuer is rejected', async () => {
  await assert.rejects(verifyIdToken(await sign({}, { iss: 'https://cognito-idp.us-east-2.amazonaws.com/other' }), opts));
});
test('an access token is rejected', async () => {
  await assert.rejects(verifyIdToken(await sign({ token_use: 'access' }), opts));
});
test('a token expired beyond the 30 s tolerance is rejected', async () => {
  await assert.rejects(verifyIdToken(await sign({}, { exp: Math.floor(Date.now() / 1000) - 60 }), opts));
});
test('an unverified email is rejected', async () => {
  await assert.rejects(verifyIdToken(await sign({ email_verified: false }), opts));
});
test('a token signed by another key is rejected', async () => {
  await assert.rejects(verifyIdToken(await sign({}, { key: other.privateKey }), opts));
});
test('an unsigned alg:none token is rejected', async () => {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, sub: 'sub-1', iss: issuer, aud: clientId, iat: now, exp: now + 3600 })}.`;
  await assert.rejects(verifyIdToken(token, opts));
});
test('a validly signed token without exp or sub is rejected', async () => {
  const base = () => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience(clientId).setIssuedAt();
  await assert.rejects(verifyIdToken(await base().setSubject('sub-1').sign(ours.privateKey), opts));
  await assert.rejects(verifyIdToken(await base().setExpirationTime('1h').sign(ours.privateKey), opts));
});

test('explicit locale audiences pass but another client in the same pool does not', async () => {
  const localized = { ...opts, clientId: ['test-client', 'test-en', 'test-pt'] };
  for (const aud of localized.clientId) assert.equal((await verifyIdToken(await sign({}, { aud }), localized)).customerId, 'demo-ana');
  await assert.rejects(verifyIdToken(await sign({}, { aud: 'unlisted-client' }), localized));
  await assert.rejects(verifyIdToken(await sign({ token_use: 'access' }, { aud: 'test-en' }), localized));
});
