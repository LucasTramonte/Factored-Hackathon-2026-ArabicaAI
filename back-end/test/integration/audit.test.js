/** GET /audit/events (issue #69): the auditor's read-only view of sign-in and review-status events, references only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertContract } from '../support/contract.js';
import { base, client, idToken } from '../support/client.js';

const as = async groups => client({ authorization: 'Bearer ' + await idToken('demo-ana', { groups }) });
/** A token signed with run-local's key but with chosen claims, for expiry and audience checks. */
async function signed({ exp = '5m', audience = process.env.COGNITO_TEST_CLIENT_ID, groups = ['auditor'], key } = {}) {
  const { SignJWT, importJWK, generateKeyPair } = await import('jose');
  const jwk = JSON.parse(process.env.COGNITO_TEST_PRIVATE_JWK);
  const signer = key ?? await importJWK(jwk, 'RS256');
  return new SignJWT({ token_use: 'id', email: 'auditor@example.com', email_verified: true, 'cognito:groups': groups })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setSubject('sub-auditor').setIssuer(process.env.COGNITO_TEST_ISSUER)
    .setAudience(audience).setIssuedAt(Math.floor(Date.now() / 1000) - 7200).setExpirationTime(exp).sign(signer);
}

test('only GET /audit/events exists; other methods are 405 and look-alike paths 404', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const res = await fetch(base + '/audit/events', { method });
    assert.equal(res.status, 405, method); assert.equal(res.headers.get('Allow'), 'GET');
  }
  for (const path of ['/audit', '/audit/', '/audit/events/x', '/audit/Events', '/agent/cases']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 404, path); assertContract('error', await res.json());
  }
});

test('a session is never enough: no, malformed, forged, expired or foreign-audience tokens are refused', async () => {
  const ana = client(); assert.equal((await ana.call('/demo/session', { customer_id: 'demo-ana' })).status, 200);
  const agent = client(); assert.equal((await agent.call('/demo/agent-session', {})).status, 200);
  for (const c of [client(), ana, agent]) assert.equal((await c.call('/audit/events')).status, 422, 'a cookie session carries no auditor role');
  assert.equal((await client({ authorization: 'Bearer x' }).call('/audit/events')).status, 422);
  const { generateKeyPair } = await import('jose');
  const { privateKey } = await generateKeyPair('RS256');
  for (const token of [await signed({ key: privateKey }), await signed({ exp: Math.floor(Date.now() / 1000) - 3600 }), await signed({ audience: 'another-client' })]) {
    const res = await client({ authorization: 'Bearer ' + token }).call('/audit/events');
    assert.equal(res.status, 401); assertContract('error', res.body);
  }
});

test('customer and agent tokens are 403; auditor and admin read references only, and the read writes nothing', async () => {
  for (const groups of [['customer'], ['agent'], ['customer', 'agent'], []]) {
    const res = await (await as(groups)).call('/audit/events');
    assert.equal(res.status, 403, groups.join() || 'no group'); assertContract('error', res.body);
  }
  // A customer sign-in writes one session_started row, which the auditor then sees.
  assert.equal((await (await as(['customer'])).call('/auth/session', {})).status, 200);
  const auditor = await as(['auditor']);
  const first = await auditor.call('/audit/events');
  assert.equal(first.status, 200); assertContract('auditEvents', first.body);
  assert.equal(first.body.auth_events[0].event, 'session_started');
  for (const secret of ['demo-ana', 'test@example.com', 'Bearer', 'customer_id', 'statement']) assert.ok(!first.text.includes(secret), secret);
  const again = await auditor.call('/audit/events');
  assert.deepEqual(again.body.auth_events[0], first.body.auth_events[0], 'reading the audit adds no audit row');
  const admin = await (await as(['admin'])).call('/audit/events');
  assert.equal(admin.status, 200); assertContract('auditEvents', admin.body);
});

test('limit is one integer from 1 to 100; anything else is 422', async () => {
  const auditor = await as(['auditor']);
  for (const query of ['?limit=0', '?limit=101', '?limit=-1', '?limit=1e2', '?limit=abc', '?limit=', '?limit=05', '?limit=1&limit=2', '?other=1', "?limit=1'--"]) {
    const res = await auditor.call('/audit/events' + query);
    assert.equal(res.status, 422, query); assertContract('error', res.body);
  }
  const one = await auditor.call('/audit/events?limit=1');
  assert.equal(one.status, 200); assertContract('auditEvents', one.body);
  assert.ok(one.body.auth_events.length <= 1 && one.body.status_changes.length <= 1);
  const results = await Promise.all(Array.from({ length: 8 }, () => auditor.call('/audit/events?limit=5')));
  assert.ok(results.every(r => r.status === 200), 'concurrent reads all succeed');
});
