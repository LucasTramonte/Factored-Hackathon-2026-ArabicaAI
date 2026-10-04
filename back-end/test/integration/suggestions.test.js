/**
 * AI suggestions on real local D1 (ADR-012): the Worker runs with the switch on against run-local's mocked Google, so an
 * incomplete handoff with details schedules the extraction in ctx.waitUntil. These tests attack the new routes (gate,
 * methods, sessions, isolation, hostile input, concurrency, contracts) and check every recorded outcome kind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { assertContract } from '../support/contract.js';
import { base, client, closeReport } from '../support/client.js';

const uuid = () => crypto.randomUUID();
const config = () => resolve(process.cwd(), 'wrangler.jsonc');

async function customer(id = 'demo-ana') {
  const c = client();
  assert.equal((await c.call('/demo/session', { customer_id: id })).status, 200);
  return c;
}
async function agent() {
  const a = client();
  assert.equal((await a.call('/demo/agent-session', {})).status, 200);
  return a;
}
/** A start and an incomplete handoff with ``details``; returns the receipt (incomplete, acknowledged). */
async function handoff(c, details) {
  const start = await c.call('/intake/start', { language: 'pt', mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
    customer_statement: 'Não reconheço esta cobrança.', idempotency_key: uuid() });
  assert.equal(start.status, 201);
  const res = await c.call('/intake/handoff', { episode_id: start.body.episode_id, kind: 'incomplete', idempotency_key: uuid(), ...(details && { details }) });
  assert.equal(res.status, 201); assertContract('intakeReceipt', res.body);
  return res.body;
}
const path = (receipt, suffix = '') => `/intake/handoff/${receipt.protocol}/suggestions${suffix}`;
/** Poll the customer's suggestions as the client does, until the run is no longer pending (the timeout case takes ~10 s). */
async function settled(c, receipt, limitMs = 20000) {
  for (const until = Date.now() + limitMs; ;) {
    const res = await c.call(path(receipt));
    assert.equal(res.status, 200); assertContract('suggestionList', res.body);
    if (res.body.status !== 'pending' || Date.now() > until) return res.body;
    await new Promise(done => setTimeout(done, 250));
  }
}
/** The recorded run of an episode, read from its events (references and counts only). */
async function recorded(episodeId) {
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  const events = await withIntakeStore({ config: config() }, store => store.listIntakeHistory(episodeId));
  return events.map(e => JSON.parse(e.event_json)).find(e => e.event === 'suggestion_recorded') ?? null;
}
const SUGGEST = 'Lembro só do mercado. FACTS={"merchant":"Mercado Demo"}';

test('the new routes answer only their method; look-alike paths are JSON 404; no session or the other actor is 401', async () => {
  const id = uuid();
  for (const [route, allowed] of [[`/intake/handoff/${id}/suggestions`, 'GET'], [`/intake/handoff/${id}/suggestions/confirm`, 'POST'], ['/agent/suggestion-mark', 'POST']]) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(base + route, { method });
      const label = `${method} ${route}`;
      if (method === allowed) {
        assert.equal(res.status, 401, label);
        assert.equal(res.headers.get('set-cookie'), null, label);
      } else {
        assert.equal(res.status, 405, label); assert.equal(res.headers.get('Allow'), allowed, label);
      }
      assertContract('error', await res.json());
    }
  }
  for (const route of [`/intake/handoff/${id}`, `/intake/handoff/${id}/suggestions/`, `/intake/handoff/${id}/Suggestions`, `/intake/handoff/${id}/suggestions/x`,
    `/intake/handoff/${id}/x/suggestions`, '/intake/handoff//suggestions', '/agent/suggestion-mark/x', '/intake/suggestions']) {
    const res = await fetch(base + route);
    assert.equal(res.status, 404, route); assertContract('error', await res.json());
  }
  const a = await agent();
  const asCustomer = client(); asCustomer.cookie = a.cookie.replace('demo_agent_session', 'demo_session');
  const ana = await customer();
  const asAgent = client(); asAgent.cookie = ana.cookie.replace('demo_session', 'demo_agent_session');
  const expired = client(); expired.cookie = 'demo_session=' + process.env.EXPIRED_TOKEN;
  const forged = client(); forged.cookie = 'demo_session=' + 'f'.repeat(64);
  const malformed = client(); malformed.cookie = 'demo_session=not-a-token';
  for (const c of [a, asCustomer, expired, forged, malformed]) {
    assert.equal((await c.call(`/intake/handoff/${id}/suggestions`)).status, 401);
    assert.equal((await c.call(`/intake/handoff/${id}/suggestions/confirm`, { none: true })).status, 401);
  }
  for (const c of [ana, asAgent, client()]) assert.equal((await c.call('/agent/suggestion-mark', { protocol: id, mark: 'correct' })).status, 401);
});

test("waitUntil with mocked Vertex: the customer's own charge is suggested; another customer sees nothing", async () => {
  const ana = await customer();
  const receipt = await handoff(ana, SUGGEST);
  const shown = await settled(ana, receipt);
  assert.deepEqual(shown, { status: 'suggested', choice: null, chosen_transaction_id: null, answerable: true, items: [{ transaction_id: 'demo-tx-001',
    merchant_name: 'Mercado Demo', amount: '125.50', currency: 'BRL', occurred_at: '2026-09-25T14:00:00+00:00', source_occurred_at: null }] },
    "Carla's Mercado Demo charge is never Ana's suggestion");
  const run = await recorded(receipt.episode_id);
  assert.deepEqual([run.result, run.arm, run.llm_calls, run.known_input_tokens, run.usage_unavailable_calls, run.suggestions], ['suggested', 'B', 1, 1840, 0, 1]);
  assert.match(run.producer, /^extractor-v2@[0-9a-f]{12}$/);
  const byShort = await ana.call(`/intake/handoff/${receipt.reference_short}/suggestions`);
  assert.deepEqual(byShort.body, shown);
  const sent = await (await fetch(process.env.VERTEX_MOCK_URL + '/__vertex')).json();
  const turn = sent.find(u => u.message === SUGGEST);
  assert.deepEqual(Object.keys(turn).sort(), ['as_of', 'message', 'session_language', 'vocabulary']);
  assert.equal(turn.session_language, 'pt');
  assert.match(turn.as_of, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, "the Worker's UTC time in the harness form");
  assert.ok(Math.abs(Date.parse(turn.as_of + 'Z') - Date.now()) < 120000);
  for (const leak of ['demo-ana', 'demo-tx', receipt.protocol, receipt.episode_id, 'Não reconheço']) assert.ok(!JSON.stringify(turn).includes(leak), leak);
  // Isolation oracle: Bruno can neither read nor answer Ana's suggestions, by protocol or short reference.
  const bruno = await customer('demo-bruno');
  for (const route of [path(receipt), `/intake/handoff/${receipt.reference_short}/suggestions`]) assert.equal((await bruno.call(route)).status, 404, route);
  for (const body of [{ transaction_id: 'demo-tx-001' }, { none: true }, { transaction_id: 'demo-tx-003' }]) {
    const res = await bruno.call(path(receipt, '/confirm'), body);
    assert.equal(res.status, 404, JSON.stringify(body)); assertContract('error', res.body);
  }
  assert.equal((await ana.call(path(receipt))).body.choice, null, 'refused answers store nothing');
  await closeReport(receipt.protocol);
});

test('a charge that was not suggested is never accepted; hostile bodies and paths are refused and change nothing', async () => {
  const ana = await customer();
  const receipt = await handoff(ana, SUGGEST);
  assert.equal((await settled(ana, receipt)).status, 'suggested');
  for (const transaction_id of ['demo-tx-002', 'demo-tx-003', 'demo-tx-999', "demo-tx-001' OR '1'='1"]) {
    const res = await ana.call(path(receipt, '/confirm'), { transaction_id });
    assert.equal(res.status, 422, transaction_id); assertContract('error', res.body);
  }
  for (const body of [{}, [], null, 'x', 7, { transaction_id: '' }, { transaction_id: 'x'.repeat(101) }, { transaction_id: 7 }, { transaction_id: 'a\u0000b' },
    { none: false }, { none: 'true' }, { none: true, transaction_id: 'demo-tx-001' }, { transaction_id: 'demo-tx-001', customer_id: 'demo-bruno' },
    { transaction_id: 'demo-tx-001', protocol: receipt.protocol }]) {
    const res = await ana.call(path(receipt, '/confirm'), typeof body === 'string' ? JSON.stringify(body) : body);
    assert.equal(res.status, 422, JSON.stringify(body)); assertContract('error', res.body);
  }
  assert.equal((await ana.call(path(receipt, '/confirm'), '{bad')).status, 422);
  assert.equal((await ana.call(path(receipt, '/confirm'), JSON.stringify({ transaction_id: 'x'.repeat(20000) }))).status, 413);
  for (const segment of ["' OR 1=1--", '%27%20OR%201%3D1', 'AR-0000-000O', '00000000-0000-0000-0000-000000000000', receipt.protocol + 'x']) {
    assert.equal((await ana.call(`/intake/handoff/${segment}/suggestions`)).status, 404, segment);
    assert.equal((await ana.call(`/intake/handoff/${segment}/suggestions/confirm`, { none: true })).status, 404, segment);
  }
  assert.equal((await ana.call(path(receipt) + '?customer_id=demo-bruno')).status, 422);
  assert.equal((await ana.call(path(receipt))).body.choice, null, 'still unanswered');
  await closeReport(receipt.protocol);
});

test('concurrent identical confirms store one answer; a different answer later is 409; the agent marks it once', async () => {
  const ana = await customer();
  const receipt = await handoff(ana, SUGGEST);
  assert.equal((await settled(ana, receipt)).status, 'suggested');
  const results = await Promise.all(Array.from({ length: 10 }, () => ana.call(path(receipt, '/confirm'), { transaction_id: 'demo-tx-001' })));
  for (const r of results) { assert.equal(r.status, 200); assertContract('suggestionChoice', r.body); }
  assert.equal(new Set(results.map(r => JSON.stringify(r.body))).size, 1, 'every caller reads the same stored answer');
  assert.equal(results[0].body.choice, 'confirmed');
  const upper = await ana.call(`/intake/handoff/${receipt.protocol.toUpperCase()}/suggestions/confirm`, { transaction_id: 'demo-tx-001' });
  assert.deepEqual(upper.body, results[0].body, 'the protocol is case-insensitive and the replay is idempotent');
  assert.equal((await ana.call(path(receipt, '/confirm'), { none: true })).status, 409);
  const shown = await ana.call(path(receipt));
  assert.deepEqual([shown.body.choice, shown.body.chosen_transaction_id], ['confirmed', 'demo-tx-001']);
  const a = await agent();
  const detail = await a.call('/agent/intake-detail?protocol=' + receipt.protocol);
  assert.equal(detail.status, 200); assertContract('agentIntakeDetail', detail.body);
  assert.equal(detail.body.verified_evidence.transaction, null, 'a confirmed suggestion is not bank-verified evidence');
  assert.deepEqual(detail.body.customer_suggestion, { choice: 'confirmed', verified_by_bank: false, mark: null, transaction: { transaction_id: 'demo-tx-001',
    occurred_at: '2026-09-25T14:00:00+00:00', source_occurred_at: null, merchant_name: 'Mercado Demo', amount: '125.50', currency: 'BRL' } });
  assert.equal(detail.body.model_reading.mode, 'suggestion');
  for (const body of [{}, { protocol: receipt.protocol }, { protocol: receipt.protocol, mark: 'right' }, { protocol: 'x', mark: 'correct' },
    { protocol: receipt.protocol, mark: 'correct', status: 'closed' }]) {
    assert.equal((await a.call('/agent/suggestion-mark', body)).status, 422, JSON.stringify(body));
  }
  const marks = await Promise.all(Array.from({ length: 5 }, () => a.call('/agent/suggestion-mark', { protocol: receipt.protocol, mark: 'wrong' })));
  for (const m of marks) { assert.equal(m.status, 200); assertContract('suggestionMark', m.body); }
  assert.equal(new Set(marks.map(m => m.body.marked_at)).size, 1);
  assert.equal((await a.call('/agent/suggestion-mark', { protocol: receipt.protocol, mark: 'correct' })).status, 409);
  assert.equal((await a.call('/agent/intake-detail?protocol=' + receipt.protocol)).body.customer_suggestion.mark, 'wrong');
  assert.equal((await a.call('/agent/suggestion-mark', { protocol: uuid(), mark: 'correct' })).status, 404);
  assert.equal((await a.call('/agent/intake-detail?protocol=' + receipt.protocol)).body.status, 'received', 'marking moves no status');
  await closeReport(receipt.protocol);
});

test('"none of these" is stored once; a report without suggestions has none to confirm', async () => {
  const ana = await customer();
  const receipt = await handoff(ana, SUGGEST);
  assert.equal((await settled(ana, receipt)).status, 'suggested');
  const none = await ana.call(path(receipt, '/confirm'), { none: true });
  assert.equal(none.status, 200); assertContract('suggestionChoice', none.body);
  assert.deepEqual([none.body.choice, none.body.transaction_id], ['none', null]);
  assert.equal((await ana.call(path(receipt, '/confirm'), { none: true })).status, 200);
  assert.equal((await ana.call(path(receipt, '/confirm'), { transaction_id: 'demo-tx-001' })).status, 409);
  const a = await agent();
  assert.equal((await a.call('/agent/suggestion-mark', { protocol: receipt.protocol, mark: 'correct' })).status, 404, 'nothing confirmed to mark');
  const plain = await handoff(ana, null);
  const nothing = await ana.call(path(plain));
  assert.deepEqual(nothing.body, { status: 'none', items: [], choice: null, chosen_transaction_id: null, answerable: false });
  assert.equal((await ana.call(path(plain, '/confirm'), { none: true })).status, 404);
  for (const r of [receipt, plain]) await closeReport(r.protocol);
});

test('waitUntil with mocked Vertex: timeout, invalid output, provider error and no match all leave today\'s handoff and suggest nothing', async () => {
  const ana = await customer();
  const cases = [['Não lembro, MOCK-TIMEOUT aqui.', 'timeout', [1, 1]], ['Não lembro, MOCK-INVALID aqui.', 'invalid_output', [2, 0]],
    ['Não lembro, MOCK-PROVIDER aqui.', 'provider_error', [1, 1]], ['Não lembro de nada mesmo.', 'no_match', [1, 0]],
    ['Era uma loja qualquer. FACTS={"currency":"BRL"}', 'ambiguous', [1, 0]]];
  const receipts = await Promise.all(cases.map(([details]) => handoff(ana, details)));
  for (const [i, [details, kind, [calls, unknown]]] of cases.entries()) {
    const shown = await settled(ana, receipts[i]);
    assert.deepEqual(shown, { status: 'none', items: [], choice: null, chosen_transaction_id: null, answerable: false }, details);
    const run = await recorded(receipts[i].episode_id);
    assert.deepEqual([run.result, run.llm_calls, run.usage_unavailable_calls, run.suggestions], [kind, calls, unknown, 0], details);
    assert.equal((await ana.call(path(receipts[i], '/confirm'), { none: true })).status, 404, details);
    const replay = await ana.call(path(receipts[i]));
    assert.equal(replay.body.status, 'none');
  }
  for (const r of receipts) await closeReport(r.protocol);
});

test('once an agent opens the report, the customer can no longer answer: 409 already_in_review, nothing stored', async () => {
  const ana = await customer();
  const receipt = await handoff(ana, SUGGEST);
  assert.equal((await settled(ana, receipt)).answerable, true);
  const a = await agent();
  assert.equal((await a.call('/agent/intake-detail?protocol=' + receipt.protocol)).status, 200);
  const late = await ana.call(path(receipt));
  assert.deepEqual([late.body.status, late.body.answerable, late.body.choice], ['suggested', false, null]);
  for (const body of [{ transaction_id: 'demo-tx-001' }, { none: true }]) {
    const res = await ana.call(path(receipt, '/confirm'), body);
    assert.equal(res.status, 409, JSON.stringify(body)); assertContract('error', res.body);
    assert.equal(res.body.code, 'already_in_review');
  }
  assert.equal((await ana.call(path(receipt))).body.choice, null, 'nothing stored');
  const detail = await a.call('/agent/intake-detail?protocol=' + receipt.protocol);
  assert.equal(detail.body.customer_suggestion, null);
  await closeReport(receipt.protocol);
});
