/** The main customer and agent flow against local D1; every JSON body is checked against the contracts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertContract } from '../support/contract.js';
import { base, client, closeReport } from '../support/client.js';
import { resolve } from 'node:path';
import { withIntakeStore } from '../../scripts/intake-store.mjs';
import { route } from '../../src/router.js';
import { tokenHash } from '../../src/auth/session.js';

test('pages are public; customers are isolated; replay and handoff work', async () => {
  for (const path of ['/', '/index.html', '/agent']) {
    const page = await fetch(base + path);
    assert.equal(page.status, 200, path);
    assert.match(await page.text(), /<app-root/);
  }
  const favicon = await fetch(base + '/favicon.svg');
  assert.equal(favicon.status, 200, 'static files are served without the Worker');
  assert.match(favicon.headers.get('content-type') ?? '', /image\/svg\+xml/i);
  assert.match(await favicon.text(), /<svg(?:\s|>)/i, 'the asset is SVG, not the SPA fallback');
  assert.equal((await client().call('/transactions')).status, 401);

  const ids = await client().call('/demo/identities');
  assert.equal(ids.status, 200);
  assertContract('identityList', ids.body);

  const ana = client();
  const bruno = client();
  const noSession = await ana.call('/transactions');
  assert.equal(noSession.status, 401);
  assertContract('error', noSession.body);
  const login = await ana.call('/demo/session', { customer_id: 'demo-ana' });
  assert.equal(login.status, 200);
  assertContract('customerSession', login.body);
  assert.equal((await bruno.call('/demo/session', { customer_id: 'demo-bruno' })).status, 200);

  const anaRows = await ana.call('/transactions');
  assertContract('transactionList', anaRows.body);
  assert.deepEqual(new Set(anaRows.body.items.map(x => x.transaction_id)), new Set(['demo-tx-001', 'demo-tx-002', 'demo-tx-004', 'demo-tx-005', 'demo-tx-006']));
  assert.deepEqual((await bruno.call('/transactions')).body.items.map(x => x.transaction_id), ['demo-tx-003']);

  const request = { transaction_id: 'demo-tx-001', customer_statement: 'I do not recognize this charge.',
    customer_confirmed: true, idempotency_key: crypto.randomUUID() };
  assert.equal((await ana.call('/cases', { ...request, customer_confirmed: false })).status, 422);
  assert.equal((await ana.call('/cases', { ...request, customer_confirmed: 'true' })).status, 422);
  assert.equal((await bruno.call('/cases', request)).status, 404);
  const first = await ana.call('/cases', request);
  assert.equal(first.status, 201);
  assertContract('caseReceipt', first.body);
  assert.equal(first.body.replayed, false);
  const retry = await ana.call('/cases', request);
  assert.equal(retry.status, 200);
  assertContract('caseReceipt', retry.body);
  assert.equal(retry.body.protocol, first.body.protocol);
  assert.equal(retry.body.replayed, true);
  assert.equal((await ana.call('/cases', { ...request, customer_statement: 'A changed statement.' })).status, 409);

  const agent = client();
  assert.equal((await agent.call('/agent/intakes')).status, 401);
  const agentLogin = await agent.call('/demo/agent-session', {});
  assert.equal(agentLogin.status, 200);
  assertContract('agentSession', agentLogin.body);
  // Agents read only the approved queue of acknowledged guided handoffs (issue #69); a legacy case is not in it.
  const queue = await agent.call('/agent/intakes');
  assertContract('agentIntakeList', queue.body);
  assert.ok(!queue.body.items.some(x => x.protocol === first.body.protocol));
});

test('dataset sample keeps the source wall time and original amount', async () => {
  const sample = client();
  const login = await sample.call('/demo/session', { customer_id: 'CLI-U53R5AZVLET0' });
  assert.equal(login.status, 200);
  assertContract('customerSession', login.body);
  assert.deepEqual(login.body.context_card.products[0],
    { product_type: 'Credit card', last4: '4444', currency: 'ARS' });
  assert.equal(login.body.context_card.snapshot_at, '2026-09-29T00:00:00+00:00');
  const list = await sample.call('/transactions');
  assertContract('transactionList', list.body);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].occurred_at, null);
  assert.equal(list.body.items[0].source_occurred_at, '2026-02-26T13:21:51');
  assert.equal(list.body.items[0].amount, '29763.49');
  assert.equal(list.body.items[0].currency, 'ARS');
});

test('health check is public and reveals nothing else', async () => {
  const res = await fetch(base + '/healthz');
  assert.equal(res.status, 200);
  const body = await res.json();
  assertContract('health', body);
});

test('all handoff kinds survive logout and fresh owner sessions with their original reference, content, messages and progress', async () => {
  const ana = client();
  assert.equal((await ana.call('/demo/session', { customer_id: 'demo-ana' })).status, 200);
  const agent = client();
  assert.equal((await agent.call('/demo/agent-session', {})).status, 200);
  const saved = [];
  for (const kind of ['complete', 'incomplete', 'technical']) {
    const started = await ana.call('/intake/start', { language: 'es', mode: 'guided', report_type: 'unrecognized_charge',
      reason: 'duplicate', customer_statement: 'Veo dos cargos por la misma compra.', idempotency_key: crypto.randomUUID() });
    assert.equal(started.status, 201); assertContract('intakeStart', started.body);
    const episode_id = started.body.episode_id;
    const path = kind === 'incomplete' ? '/intake/handoff' : '/intake/confirm';
    const request = kind === 'incomplete'
      ? { episode_id, kind, details: 'Fue en Mercado el martes.', idempotency_key: crypto.randomUUID() }
      : { episode_id, transaction_id: 'demo-tx-001', customer_confirmed: true, idempotency_key: crypto.randomUUID() };
    // Inject only the failed lookup, through the existing bridge into the same real local D1. Customers cannot request technical kind.
    const accepted = kind === 'technical'
      ? await withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, async store => {
        const res = await route(new Request(base + path, { method: 'POST', headers: { Cookie: ana.cookie }, body: JSON.stringify(request) }), {},
          { ...store, findOwnedTransaction: async () => { throw new Error('test lookup outage'); } });
        return { status: res.status, body: await res.json() };
      }) : await ana.call(path, request);
    assert.equal(accepted.status, 201); assertContract('intakeReceipt', accepted.body);
    assert.equal(accepted.body.kind, kind);
    const receipt = accepted.body;
    const message = await ana.call(`/intake/handoff/${receipt.protocol}/messages`, { body: 'Puedo aportar el comprobante.', idempotency_key: crypto.randomUUID() });
    assert.equal(message.status, 201); assertContract('reportMessage', message.body);
    assert.equal((await agent.call('/agent/intake-status', { protocol: receipt.protocol, status: 'in_review' })).status, 200);
    saved.push({ receipt, path, request, message: message.body });
    if (kind === 'complete') await closeReport(receipt.protocol);
  }
  const revoked = client(); revoked.cookie = ana.cookie;
  assert.equal((await ana.call('/auth/logout', {})).status, 204);
  assert.equal((await revoked.call('/reports')).status, 401);
  const fresh = client();
  assert.equal((await fresh.call('/demo/session', { customer_id: 'demo-ana' })).status, 200);
  const listed = await fresh.call('/reports');
  assertContract('reportList', listed.body);
  for (const { receipt, path, request, message } of saved) {
    const status = receipt.kind === 'complete' ? 'closed' : 'in_review';
    const row = listed.body.items.find(r => r.protocol === receipt.protocol);
    assert.ok(row); assert.equal(row.reference_short, receipt.reference_short);
    assert.equal(row.status, status); assert.equal(row.kind, receipt.kind);
    assert.equal(row.transaction_id, receipt.kind === 'complete' ? 'demo-tx-001' : null);
    const retry = await fresh.call(path, request);
    assert.equal(retry.status, 200); assert.deepEqual(retry.body, { ...receipt, replayed: true });
    const thread = await fresh.call(`/intake/handoff/${receipt.reference_short}/messages`);
    assert.equal(thread.status, 200); assertContract('messageThread', thread.body);
    assert.equal(thread.body.status, status); assert.deepEqual(thread.body.items, [message]);
    const detail = await agent.call('/agent/intake-detail?protocol=' + receipt.protocol);
    assertContract('agentIntakeDetail', detail.body);
    assert.equal(detail.body.reason, 'duplicate');
    assert.equal(detail.body.customer_statement, 'Veo dos cargos por la misma compra.' + (receipt.kind === 'incomplete' ? '\nFue en Mercado el martes.' : ''));
  }
  const bruno = client(); await bruno.call('/demo/session', { customer_id: 'demo-bruno' });
  const foreign = await bruno.call('/reports'); assertContract('reportList', foreign.body);
  for (const { receipt } of saved) {
    assert.ok(!foreign.body.items.some(r => r.protocol === receipt.protocol));
    for (const ref of [receipt.protocol, receipt.reference_short]) {
      const denied = await bruno.call(`/intake/handoff/${ref}/messages`);
      const missing = await bruno.call(`/intake/handoff/${crypto.randomUUID()}/messages`);
      assert.equal(denied.status, 404); assert.deepEqual(denied.body, missing.body);
    }
  }
});

test('concurrent incomplete and technical retries acknowledge one stored handoff on local D1', async () => {
  const ana = client(); await ana.call('/demo/session', { customer_id: 'demo-ana' });
  for (const kind of ['incomplete', 'technical']) {
    const episode_id = (await ana.call('/intake/start', { language: 'pt', mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
      customer_statement: 'Não reconheço esta cobrança.', idempotency_key: crypto.randomUUID() })).body.episode_id;
    const path = kind === 'incomplete' ? '/intake/handoff' : '/intake/confirm';
    const body = kind === 'incomplete' ? { episode_id, kind, idempotency_key: crypto.randomUUID() }
      : { episode_id, transaction_id: 'demo-tx-001', customer_confirmed: true, idempotency_key: crypto.randomUUID() };
    await withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, async store => {
      const scoped = kind === 'technical' ? { ...store, findOwnedTransaction: async () => { throw new Error('test lookup outage'); } } : store;
      const responses = await Promise.all(Array.from({ length: 6 }, () => route(new Request(base + path, {
        method: 'POST', headers: { Cookie: ana.cookie }, body: JSON.stringify(body) }), {}, scoped)));
      assert.deepEqual(responses.map(r => r.status).sort(), [200, 200, 200, 200, 200, 201]);
      const receipts = await Promise.all(responses.map(r => r.json()));
      for (const receipt of receipts) { assertContract('intakeReceipt', receipt); assert.equal(receipt.kind, kind); }
      assert.equal(new Set(receipts.map(r => r.protocol)).size, 1);
      const stored = await store.findOwnedIntakeHandoff('demo-ana', episode_id);
      assert.equal(stored.handoff_id, receipts[0].protocol);
      const chain = await store.listIntakeHistory(episode_id);
      assert.deepEqual(chain.map(e => JSON.parse(e.event_json).event), ['intake_started', 'handoff_created', 'intake_ended']);
      assert.equal((await store.listCustomerHandoffs('demo-ana', 100)).filter(r => r.protocol === receipts[0].protocol).length, 1);
    });
  }
});

test('a report outside the recent twenty is retained with its scoped content and thread', async () => {
  const elena = client(); await elena.call('/demo/session', { customer_id: 'demo-elena' });
  let original;
  for (let i = 0; i < 22; i++) {
    const start = await elena.call('/intake/start', { language: 'es', mode: 'guided', report_type: 'unrecognized_charge', reason: 'subscription',
      customer_statement: 'No esperaba este cobro de suscripción.', idempotency_key: crypto.randomUUID() });
    assert.equal(start.status, 201);
    const handoff = await elena.call('/intake/handoff', { episode_id: start.body.episode_id, kind: 'incomplete', idempotency_key: crypto.randomUUID() });
    assert.equal(handoff.status, 201);
    if (i === 0) {
      original = handoff.body;
      assert.equal((await elena.call(`/intake/handoff/${original.protocol}/messages`, { body: 'Conservo el recibo.', idempotency_key: crypto.randomUUID() })).status, 201);
    }
  }
  const recent = await elena.call('/reports');
  assertContract('reportList', recent.body);
  assert.equal(recent.body.items.length, 20); assert.equal(recent.body.has_more, true);
  assert.ok(!recent.body.items.some(r => r.protocol === original.protocol));
  await withIntakeStore({ config: resolve(process.cwd(), 'wrangler.jsonc') }, async store => {
    const episode = await store.findIntake('demo-elena', original.episode_id);
    assert.equal(episode.customer_statement, 'No esperaba este cobro de suscripción.'); assert.equal(episode.reason, 'subscription');
    const retained = await store.readIntakeReceipt('demo-elena', original.episode_id, { sessionHash: await tokenHash(elena.cookie.split('=')[1]), now: Date.now() });
    assert.equal(retained.handoff_id, original.protocol); assert.equal(retained.reference_short, original.reference_short); assert.equal(retained.status, 'received');
    assert.equal(await store.findIntake('demo-bruno', original.episode_id), null);
  });
  const thread = await elena.call(`/intake/handoff/${original.reference_short}/messages`);
  assert.equal(thread.status, 200); assert.equal(thread.body.items[0].body, 'Conservo el recibo.');
});
