/** POST /auth/session: only a verified Cognito ID token for an enrolled, loaded customer starts a session. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { errors } from 'jose';
import { startEmailSession } from '../../src/modules/customer/routes.js';
import { startAgentSession } from '../../src/modules/agent/routes.js';
import { assertContract } from '../support/contract.js';

const env = { COGNITO_REGION: 'us-east-2', COGNITO_USER_POOL_ID: 'us-east-2_x', COGNITO_CLIENT_ID: 'client',
  COGNITO_TEST_JWKS: '{"keys":[]}' };
const jwt = 'aaa.bbb.ccc';
const claims = { sub: 's', email: 'ana@example.com', groups: ['customer'], customerId: 'demo-ana' };
const req = (authorization, body) => new Request('https://d.example/auth/session', { method: 'POST',
  headers: authorization ? { Authorization: authorization } : {}, body });

function store(source = 'fictitious') {
  const calls = [];
  const s = { calls,
    customerSource: async id => { calls.push(['customerSource', id]); return source; },
    findContextCard: async () => null,
    rotateSession: async args => { calls.push(['rotateSession', args.customerId, args.actor]); s.emailEnc = args.emailEnc; } };
  return s;
}
async function call(authorization, verify, s = store(), body) {
  const res = await startEmailSession(req(authorization, body), env, s, {}, verify);
  return { status: res.status, body: await res.json(), cookie: res.headers.get('Set-Cookie'), calls: s.calls };
}

test('a verified enrolled customer gets a session; identity comes from the claims, the body is ignored', async () => {
  let seen;
  const r = await call('Bearer ' + jwt, async (t, opts) => { seen = { t, opts }; return claims; }, store(),
    JSON.stringify({ customer_id: 'demo-carla' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { customer_id: 'demo-ana', mode: 'email_otp', context_card: null, roles: ['customer'] });
  assertContract('emailSession', r.body);
  assert.match(r.cookie, /^demo_session=[0-9a-f]{64};/);
  assert.deepEqual(r.calls, [['customerSource', 'demo-ana'], ['rotateSession', 'demo-ana', 'customer']]);
  assert.equal(seen.t, jwt);
  assert.equal(seen.opts.issuer, 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_x');
  assert.equal(seen.opts.clientId, 'client');
  assert.doesNotMatch(JSON.stringify(r.body), /ana@example|aaa\.bbb/);
});

test('an admin with its own customer id is also a customer; roles carry only known groups', async () => {
  const r = await call('Bearer ' + jwt, async () => ({ ...claims, groups: ['admin', 'weird'] }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.roles, ['admin']);
  assertContract('emailSession', r.body);
  assert.match(r.cookie, /^demo_session=/);
});

test('a token without customer or admin, or without a loaded customer, is 403 with no cookie and no session write', async () => {
  for (const [groups, source] of [[['agent'], 'fictitious'], [['auditor'], 'fictitious'], [['customer'], null], [['admin'], null]]) {
    const r = await call('Bearer ' + jwt, async () => ({ ...claims, groups }), store(source));
    assert.equal(r.status, 403, groups.join() + ' ' + source);
    assert.deepEqual(r.body, { detail: 'This account is not enrolled in the demo' });
    assert.equal(r.cookie, null);
    assert.ok(!r.calls.some(c => c[0] === 'rotateSession'));
  }
});

test('a missing, malformed or oversized token is 422 and is never verified', async () => {
  const never = async () => assert.fail('verified');
  const long = 'a'.repeat(4000) + '.' + 'b'.repeat(50) + '.' + 'c'.repeat(50);
  for (const h of [null, 'Basic dTpw', 'Bearer', 'Bearer ', 'bearer ' + jwt, 'Bearer a.b', 'Bearer a.b.c.d', 'Bearer a.b.',
    'Bearer a+b.c.d', 'Bearer  ' + jwt, 'Bearer ' + long]) {
    const r = await call(h, never);
    assert.equal(r.status, 422, String(h).slice(0, 20));
    assert.deepEqual(r.body, { detail: 'Provide the sign-in token' });
    assert.deepEqual(r.calls, []);
  }
});

test('verification failures are 401, JWKS outages 503, and neither reaches the store', async () => {
  const cases = [
    [new errors.JWSSignatureVerificationFailed(), 401], [new errors.JWTExpired('exp', {}), 401],
    [new errors.JWTClaimValidationFailed('aud', {}), 401], [new errors.JWKSNoMatchingKey(), 401],
    [new errors.JWSInvalid(), 401], [new Error('email not verified'), 401],
    [new errors.JWKSTimeout(), 503], [new errors.JWKSInvalid(), 503],
    [new errors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response'), 503], [new TypeError('fetch failed'), 503]];
  for (const [error, status] of cases) {
    const r = await call('Bearer ' + jwt, async () => { throw error; });
    assert.equal(r.status, status, error.constructor.name);
    assert.deepEqual(r.body, { detail: status === 503 ? 'Sign-in is unavailable' : 'Sign-in could not be verified' });
    assert.deepEqual(r.calls, []);
  }
});

test('not in the customer group, no customer id, or not loaded in D1: one indistinguishable 403', async () => {
  const detail = { detail: 'This account is not enrolled in the demo' };
  for (const c of [{ ...claims, groups: [] }, { ...claims, groups: ['agent'] }, { ...claims, customerId: null }]) {
    const r = await call('Bearer ' + jwt, async () => c);
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, detail);
    assert.equal(r.cookie, null);
    assert.deepEqual(r.calls, []);
  }
  const r = await call('Bearer ' + jwt, async () => claims, store(null));
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, detail);
  assert.deepEqual(r.calls, [['customerSource', 'demo-ana']]);
});

test('with EMAIL_KEY the address is stored encrypted in the session batch; without it sign-in still succeeds', async () => {
  const { decrypt } = await import('../../src/notify/email.js');
  const keyed = { ...env, EMAIL_KEY: Buffer.alloc(32, 7).toString('base64') };
  const s = store();
  const res = await startEmailSession(req('Bearer ' + jwt), keyed, s, {}, async () => claims);
  assert.equal(res.status, 200);
  assert.doesNotMatch(s.emailEnc, /@/);
  assert.equal(await decrypt(s.emailEnc, keyed), 'ana@example.com');
  for (const bad of [undefined, 'short']) {
    const t = store();
    assert.equal((await startEmailSession(req('Bearer ' + jwt), { ...env, EMAIL_KEY: bad }, t, {}, async () => claims)).status, 200);
    assert.equal(t.emailEnc, null);
  }
});

describe('POST /demo/agent-session', () => {
  const agentReq = (authorization, body) => new Request('https://d.example/demo/agent-session', { method: 'POST',
    headers: authorization ? { Authorization: authorization } : {}, body });
  async function agent(authorization, verify, e = env, body) {
    const s = store();
    const res = await startAgentSession(agentReq(authorization, body), e, s, {}, verify);
    return { status: res.status, body: await res.json(), cookie: res.headers.get('Set-Cookie'), calls: s.calls };
  }

  test('an agent-group token gets an agent session; the body is ignored', async () => {
    const r = await agent('Bearer ' + jwt, async () => ({ ...claims, groups: ['agent'], customerId: null }), env, '{"role":"x"}');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { role: 'agent', mode: 'email_otp', roles: ['agent'] });
    assertContract('agentSession', r.body);
    assert.match(r.cookie, /^demo_agent_session=[0-9a-f]{64};/);
    assert.deepEqual(r.calls, [['rotateSession', null, 'agent']]);
  });

  test('an admin token gets an agent session too', async () => {
    const r = await agent('Bearer ' + jwt, async () => ({ ...claims, groups: ['admin'], customerId: null }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { role: 'agent', mode: 'email_otp', roles: ['admin'] });
    assertContract('agentSession', r.body);
  });

  test('any other group is one 403 and writes nothing', async () => {
    for (const groups of [['customer'], [], ['auditor'], ['Agent']]) {
      const r = await agent('Bearer ' + jwt, async () => ({ ...claims, groups }));
      assert.equal(r.status, 403, groups.join());
      assert.deepEqual(r.body, { detail: 'This account is not an agent in the demo' });
      assert.equal(r.cookie, null);
      assert.deepEqual(r.calls, []);
    }
  });

  test('no, malformed or unverifiable tokens are 422 or 401, a JWKS outage 503, and none reach the store', async () => {
    for (const [h, verify, status] of [[null, null, 422], ['Basic dTpw', null, 422], ['Bearer a.b', null, 422],
      ['Bearer ' + jwt, async () => { throw new errors.JWSSignatureVerificationFailed(); }, 401],
      ['Bearer ' + jwt, async () => { throw new errors.JWKSTimeout(); }, 503],
      ['Bearer ' + jwt, async () => { throw new TypeError('fetch failed'); }, 503]]) {
      const r = await agent(h, verify ?? (async () => assert.fail('verified')));
      assert.equal(r.status, status, String(h));
      assert.equal(r.cookie, null);
      assert.deepEqual(r.calls, []);
    }
  });

  test('only with DEMO_PICKER=1 does a request without Authorization get the local one-click session', async () => {
    const never = async () => assert.fail('verified');
    const local = await agent(null, never, { ...env, DEMO_PICKER: '1' });
    assert.equal(local.status, 200);
    assert.deepEqual(local.body, { role: 'agent', mode: 'simulated_login', roles: ['agent'] });
    assertContract('agentSession', local.body);
    for (const picker of [{}, { DEMO_PICKER: '0' }, { DEMO_PICKER: 1 }]) {
      assert.equal((await agent(null, never, { ...env, ...picker })).status, 422);
    }
    // A presented token is always verified, even locally.
    assert.equal((await agent('Bearer ' + jwt, async () => claims, { ...env, DEMO_PICKER: '1' })).status, 403);
  });
});
