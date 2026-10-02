/** Session tokens and cookie handling. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COOKIE, newToken, tokenHash } from '../../src/auth/session.js';
import { cookieHeader, readCookies } from '../../src/http.js';

const req = (headers = {}, url = 'https://demo.example.workers.dev/cases') => new Request(url, { headers });

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

test('starting a session is one atomic store call that revokes the old token and purges expired ones', async () => {
  const { startSession, tokenHash: hash } = await import('../../src/auth/session.js');
  const calls = [];
  const store = { rotateSession: async args => { calls.push(args); } };
  const old = 'b'.repeat(64);
  const request = new Request('https://d.example/demo/session', { headers: { Cookie: `demo_session=${old}` } });
  const cookie = await startSession(request, store, 'customer', 'demo-ana');
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.oldHash, await hash(old));
  assert.equal(call.actor, 'customer');
  assert.equal(call.customerId, 'demo-ana');
  assert.ok(call.expiresAt > call.now && call.expiresAt - call.now === 3600_000);
  assert.equal(call.newHash, await hash(cookie.split(';')[0].split('=')[1]));
  const fresh = await startSession(new Request('https://d.example/demo/session'), store, 'agent');
  assert.equal(calls[1].oldHash, null);
  assert.ok(fresh.startsWith('demo_agent_session='));
});

test('ending a session deletes exactly the presented token hash and clears the cookie', async () => {
  const { endSession } = await import('../../src/auth/session.js');
  const calls = [];
  const store = { revokeSession: async hash => { calls.push(hash); } };
  const token = 'a'.repeat(64);
  const header = await endSession(new Request('http://localhost:8787/auth/logout', { headers: { Cookie: `${COOKIE.customer}=${token}` } }), store, 'customer'); // localhost: no Secure attribute
  assert.equal(calls.length, 1);
  assert.equal(calls[0], await tokenHash(token));
  assert.match(header, new RegExp(`^${COOKIE.customer}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`));
});

test('ending a session with no or a malformed cookie revokes nothing and still clears the cookie', async () => {
  const { endSession } = await import('../../src/auth/session.js');
  const calls = [];
  const store = { revokeSession: async hash => { calls.push(hash); } };
  for (const headers of [{}, { Cookie: `${COOKIE.customer}=not-a-token` }]) {
    const header = await endSession(new Request('http://localhost:8787/auth/logout', { headers }), store, 'customer');
    assert.match(header, /Max-Age=0/);
  }
  assert.equal(calls.length, 0);
});
