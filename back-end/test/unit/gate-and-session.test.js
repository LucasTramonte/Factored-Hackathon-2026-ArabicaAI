/** Access gate, session tokens and cookie handling. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAccessGate } from '../../src/auth/access-gate.js';
import { COOKIE, newToken, tokenHash } from '../../src/auth/session.js';
import { cookieHeader, readCookies } from '../../src/http.js';

const env = { DEMO_ACCESS_USERNAME: 'reviewer', DEMO_ACCESS_PASSWORD: 'pa:ss wörd' };
const basic = value => ({ headers: { Authorization: value } });
const req = (headers = {}, url = 'https://demo.example.workers.dev/cases') => new Request(url, { headers });
const encode = text => 'Basic ' + Buffer.from(text, 'utf8').toString('base64');

test('gate fails closed when it is not configured', async () => {
  for (const partial of [{}, { DEMO_ACCESS_USERNAME: 'reviewer' }, { DEMO_ACCESS_PASSWORD: 'x' }]) {
    const res = checkAccessGate(req(basic(encode('reviewer:x')).headers), partial);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { detail: 'Demo access gate is not configured' });
  }
});

test('gate rejects every malformed or wrong credential', () => {
  for (const value of [undefined, '', 'Bearer abc', 'Basic', 'Basic !!!not-base64', encode('reviewer'),
    encode(':pa:ss wörd'), encode('Reviewer:pa:ss wörd'), encode('reviewer:pa:ss'), encode('reviewer:pa:ss wörd ')]) {
    const res = checkAccessGate(req(value === undefined ? {} : { Authorization: value }), env);
    assert.equal(res.status, 401, String(value));
    assert.match(res.headers.get('WWW-Authenticate'), /^Basic realm=/);
  }
});

test('gate accepts the exact credential, including colons and non-ASCII in the password', () => {
  assert.equal(checkAccessGate(req({ Authorization: encode('reviewer:pa:ss wörd') }), env), null);
});

test('tokens are 256-bit hex and hashes are stable SHA-256', async () => {
  const tokens = new Set(Array.from({ length: 50 }, newToken));
  assert.equal(tokens.size, 50);
  for (const token of tokens) assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(await tokenHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('cookie header pins its attributes and is Secure off localhost', () => {
  const remote = cookieHeader(COOKIE.customer, 'f'.repeat(64), req());
  assert.equal(remote, `${COOKIE.customer}=${'f'.repeat(64)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600; Secure`);
  for (const host of ['http://localhost:8787/x', 'http://127.0.0.1:8787/x']) {
    assert.doesNotMatch(cookieHeader(COOKIE.customer, 'f'.repeat(64), req({}, host)), /Secure/);
  }
});

test('cookie parsing ignores junk and keeps the first value of a name', () => {
  const parsed = readCookies(req({ Cookie: ` junk; a=1; b = 2; a=3; c=x=y; =empty` }));
  assert.equal(parsed.a, '1');
  assert.equal(parsed.c, 'x=y');
  assert.equal(parsed.junk, undefined);
});
