/** GET /reports: the session customer's own acknowledged handoffs, never another customer's and never a pending one. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { client, closeReport } from '../support/client.js';
import { assertContract } from '../support/contract.js';
import { tokenHash } from '../../src/auth/session.js';

async function customer(id = 'demo-ana') { const c = client(); assert.equal((await c.call('/demo/session', { customer_id: id })).status, 200); return c; }
async function start(c) {
  const r = await c.call('/intake/start', { language: 'pt', mode: 'guided', report_type: 'unrecognized_charge',
    customer_statement: 'Não reconheço esta cobrança.', idempotency_key: crypto.randomUUID() });
  assert.equal(r.status, 201); return r.body.episode_id;
}

test('a customer lists only their own acknowledged reports, newest first, without statements', async () => {
  const ana = await customer();
  const complete = await ana.call('/intake/confirm', { episode_id: await start(ana), transaction_id: 'demo-tx-001', customer_confirmed: true, idempotency_key: crypto.randomUUID() });
  assert.equal(complete.status, 201);
  const incomplete = await ana.call('/intake/handoff', { episode_id: await start(ana), kind: 'incomplete', idempotency_key: crypto.randomUUID() });
  assert.equal(incomplete.status, 201);
  const listed = await ana.call('/reports');
  assert.equal(listed.status, 200); assertContract('reportList', listed.body);
  assert.deepEqual(listed.body.items.slice(0, 2), [incomplete.body, complete.body].map(r => ({ protocol: r.protocol, reference_short: r.reference_short,
    kind: r.kind, status: 'received', next_step: 'review_pending', accepted_at: r.accepted_at })));
  assert.ok(listed.body.items.length <= 20);
  assert.doesNotMatch(listed.text, /customer_statement|reconheço|demo-ana|episode_id/);

  const bruno = await customer('demo-bruno');
  const foreign = await bruno.call('/reports');
  assert.equal(foreign.status, 200); assertContract('reportList', foreign.body);
  const anas = new Set(listed.body.items.map(x => x.protocol));
  assert.ok(!foreign.body.items.some(x => anas.has(x.protocol)), "bruno never sees ana's reports");
  await closeReport(complete.body.protocol);
});

test('reports require a live customer session and take no parameters or other methods', async () => {
  const none = await client().call('/reports');
  assert.equal(none.status, 401); assert.deepEqual(none.body, { detail: 'Start a demo session first' });
  for (const token of ['f'.repeat(64), process.env.EXPIRED_TOKEN]) {
    const c = client(); c.cookie = `demo_session=${token}`;
    assert.equal((await c.call('/reports')).status, 401);
  }
  const agent = client(); await agent.call('/demo/agent-session', {}); agent.cookie = agent.cookie.replace('demo_agent_session=', 'demo_session=');
  assert.equal((await agent.call('/reports')).status, 401, 'agent token used as customer');
  const ana = await customer();
  for (const query of ['?x=1', '?limit=100', '?customer_id=demo-bruno', '?']) {
    const r = await ana.call('/reports' + query);
    if (query === '?') { assert.equal(r.status, 200); continue; } // an empty query string carries no parameter
    assert.equal(r.status, 422, query); assert.deepEqual(r.body, { detail: 'Unexpected parameters' });
  }
  const post = await ana.call('/reports', {});
  assert.equal(post.status, 405); assert.equal(post.headers.get('Allow'), 'GET');
  for (const path of ['/reports/', '/reports/x']) assert.equal((await ana.call(path)).status, 404, path);
});

test('a reservation whose receipt was never read back does not appear', async () => {
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  const now = Date.now(); const sessionHash = '8'.repeat(64);
  let pending;
  await withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, async store => {
    await store.rotateSession({ now, oldHash: null, newHash: sessionHash, actor: 'customer', customerId: 'demo-ana', expiresAt: now + 3600000 });
    const { episode } = await store.startIntake({ customerId: 'demo-ana', language: 'es', statement: 'No reconozco este cargo.', key: crypto.randomUUID(), now, expiresAt: now + 3600000 });
    ({ handoff: pending } = await store.persistIntakeHandoff({ customerId: 'demo-ana', episodeId: episode.episode_id, turnKey: crypto.randomUUID(),
      payloadHash: await tokenHash(JSON.stringify(['incomplete', null])), sessionHash, completeCase: null, kind: 'incomplete',
      evidence: { transaction: null, tool_status: 'ok' }, actions: [], questions: ['matching_transaction', 'customer_confirmation'],
      usage: { tool_calls: 0, operation_duration_ms: 0 }, now }));
  });
  assert.ok(pending);
  const listed = await (await customer()).call('/reports');
  assert.equal(listed.status, 200);
  assert.ok(!listed.body.items.some(x => x.protocol === pending.handoff_id), 'pending reservation is hidden');
});
