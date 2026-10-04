/** Authentication audit (Lucas 8d, 8f): what each session path writes to auth_events, read back through the store helper. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { base } from '../support/client.js';
import { tokenHash } from '../../src/auth/session.js';

const events = async () => {
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  return withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, store => store.listAuthEvents(50));
};
/** One request tagged with a fresh ``cf-ray``, which the Worker records as the request id. */
async function call(path, { cookie, body } = {}) {
  const ray = crypto.randomUUID();
  const res = await fetch(base + path, { method: body ? 'POST' : 'GET', body: body && JSON.stringify(body),
    headers: { 'cf-ray': ray, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } });
  return { ray, status: res.status, cookie: res.headers.get('set-cookie')?.split(';', 1)[0] };
}
const ref = async token => (await tokenHash(token)).slice(0, 12);

test('session start, expiry, rejection and logout write one reference-only row each; no cookie writes none', async () => {
  const login = await call('/demo/session', { body: { customer_id: 'demo-ana' } });
  const agent = await call('/demo/agent-session', { body: {} });
  const expired = await call('/transactions', { cookie: `demo_session=${process.env.EXPIRED_TOKEN}` });
  const malformed = await call('/transactions', { cookie: 'demo_session=not-a-token' });
  const anonymous = await call('/transactions');
  const live = await call('/transactions', { cookie: login.cookie });
  const logout = await call('/auth/logout', { cookie: login.cookie, body: {} });
  assert.deepEqual([login, agent, expired, malformed, anonymous, live, logout].map(r => r.status), [200, 200, 401, 401, 401, 200, 204]);

  const rows = await events();
  const of = ({ ray }) => rows.filter(row => row.request_id === ray).map(({ actor, event, session_ref }) => [actor, event, session_ref]);
  const token = login.cookie.split('=')[1];
  assert.deepEqual(of(login), [['customer', 'session_started', await ref(token)]]);
  assert.deepEqual(of(agent), [['agent', 'session_started', await ref(agent.cookie.split('=')[1])]]);
  assert.deepEqual(of(expired), [['customer', 'session_expired', await ref(process.env.EXPIRED_TOKEN)]]);
  assert.deepEqual(of(malformed), [['customer', 'session_rejected', await ref('not-a-token')]]);
  assert.deepEqual(of(anonymous), [], 'no cookie, no write');
  assert.deepEqual(of(live), [], 'a live session writes nothing');
  assert.deepEqual(of(logout), [['customer', 'logged_out', await ref(token)]]);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['actor', 'event', 'id', 'request_id', 'session_ref', 'ts'], 'no customer id, email or token column');
    assert.match(row.session_ref, /^[0-9a-f]{12}$/);
  }
});

test("logout records only a real session of the same actor, and never revokes a token presented under the other actor's cookie", async () => {
  const dead = await call('/auth/logout', { cookie: `demo_session=${'d'.repeat(64)}`, body: {} });
  const agent = await call('/demo/agent-session', { body: {} });
  const crossed = await call('/auth/logout', { cookie: 'demo_session=' + agent.cookie.split('=')[1], body: {} });
  const still = await call('/agent/intakes', { cookie: agent.cookie });
  assert.deepEqual([dead, agent, crossed, still].map(r => r.status), [204, 200, 204, 200], 'the agent session survives a customer logout');
  const rows = await events();
  for (const r of [dead, crossed, still]) assert.deepEqual(rows.filter(row => row.request_id === r.ray), [], 'no audit row');
});
