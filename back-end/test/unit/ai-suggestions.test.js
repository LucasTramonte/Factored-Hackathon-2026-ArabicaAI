/**
 * AI suggestions on "I can't find the charge" (ADR-012; Docs/Plans/ai-suggestion-plan.md), with Google mocked: no test
 * reaches a network. With the switch off, the handoff and its D1 work are today's and ``fetch`` is never called.
 * On, the extraction runs after the response (ctx.waitUntil), every guard and fallback is recorded as one outcome kind,
 * and only the customer's own charges are ever suggested. Keys are generated here; nothing is a real credential.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { createStore } from '../../src/store/d1.js';
import { route } from '../../src/router.js';
import { EXTRACTION_TIMEOUT_MS, MODEL, VOCABULARY, producers, registeredVersion, vertexUrl } from '../../src/modules/intake/ai-transport.js';
import { PROMPT } from '../../src/modules/intake/extractor-prompt.js';
import { BREAKER_WINDOW_MS, DEFAULT_RETIRES, OUTCOMES, asOfAt, newArm, retired, runSuggestion, shareB, testOrigin } from '../../src/modules/intake/suggestions.js';
import { EXCHANGE_MS, accessToken, audience, credentialConfig, resetTokenCache, workerJwt } from '../../src/modules/intake/vertex-auth.js';
import { tokenHash } from '../../src/auth/session.js';
import { assertContract } from '../support/contract.js';
import { readWranglerConfig } from '../../scripts/predeploy.mjs';
import { exportIntakeEvents } from '../../scripts/export-intake-events.mjs';
import { scorerPython } from '../../scripts/scorer-python.mjs';
import { close } from '../support/close.js';

const SOURCE_PROMPT = readFileSync(new URL('../../../intake_agent/extractor/prompt.md', import.meta.url), 'utf8');
const VERSION = 'extractor-v2@' + createHash('sha256').update(SOURCE_PROMPT).digest('hex').slice(0, 12);
const ANA = 'a'.repeat(64), BRUNO = 'b'.repeat(64), AGENT = 'c'.repeat(64);
const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
const PEM = await exportPKCS8(privateKey);
const CREDS = { VERTEX_PROJECT: 'factored-hackathon-arabica-ai', VERTEX_PROJECT_NUMBER: '92397500240',
  VERTEX_SERVICE_ACCOUNT: 'arabica-worker-vertex@factored-hackathon-arabica-ai.iam.gserviceaccount.com',
  VERTEX_WIF_ISSUER: 'https://worker.example', VERTEX_WIF_KID: 'test-kid', VERTEX_WIF_SIGNING_KEY: PEM, VERTEX_MODEL_RETIRES: '2099-01-01' };
const ON = { ...CREDS, INTAKE_AI_ENABLED: '1' };
/** On, with the local test origin and arm B forced (the integration Worker's settings). */
const ON_B = { ...ON, VERTEX_TEST_ORIGIN: 'http://127.0.0.1:9', INTAKE_AI_TEST_ARM: 'B' };
const DETAILS = 'Fue en la Farmacia Salud, 32 pesos, no sé la fecha.';
const report = facts => ({ intent: 'report', stated_facts: facts, invalid: null, demand: null, injection: false });
const FARMACIA = report({ merchant: 'Farmacia Salud', amount: { value: '32', approx: false } });

// D1 binds integral numbers as INTEGER; node:sqlite binds every number as REAL, which JSON functions print as 1.0.
const asD1 = v => Number.isInteger(v) ? BigInt(v) : v;
async function setup(t) {
  resetTokenCache();
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.exec("INSERT INTO customers(customer_id,display_name,country) VALUES('ana','Ana','Argentina'),('bruno','Bruno','Argentina');"
    + 'INSERT INTO transactions(transaction_id,customer_id,occurred_at,source_occurred_at,merchant_name,amount,currency) VALUES'
    + "('tx-ana','ana',NULL,'2026-06-17 12:00:00','Shop','10.00','ARS'),('tx-a1','ana',NULL,'2026-06-10T12:00:00','Farmacia Salud','32.00','ARS'),"
    + "('tx-u1','ana',NULL,'2026-06-11T12:00:00','Uber','5.00','ARS'),('tx-u2','ana',NULL,'2026-06-12T12:00:00','Uber','5.00','ARS'),"
    + "('tx-u3','ana',NULL,'2026-06-13T12:00:00','Uber','5.00','ARS'),('tx-u4','ana',NULL,'2026-06-14T12:00:00','Uber','5.00','ARS'),"
    + "('tx-bruno','bruno',NULL,'2026-06-10T12:00:00','Farmacia Salud','32.00','ARS')");
  for (const [token, actor, owner] of [[ANA, 'customer', 'ana'], [BRUNO, 'customer', 'bruno'], [AGENT, 'agent', null]])
    db.prepare('INSERT INTO sessions(token_hash,actor,customer_id,expires_at) VALUES(?,?,?,?)').run(await tokenHash(token), actor, owner, Date.now() + 3600000);
  const d1 = { prepare: sql => ({ bind: (...p) => ({ all: () => ({ results: db.prepare(sql).all(...p.map(asD1)) }) }) }),
    batch: async statements => { db.exec('BEGIN'); try { const results = statements.map(s => s.all()); db.exec('COMMIT'); return results; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  const store = () => createStore(d1);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const rows = (sql, ...p) => db.prepare(sql).all(...p);
  const events = episode => rows('SELECT event_json FROM intake_events WHERE episode_id=? ORDER BY seq', episode).map(r => JSON.parse(r.event_json));
  return { db, d1, store, one, rows, events };
}

const req = (path, { body, token = ANA, cookie = `demo_session=${token}`, method = body === undefined ? 'GET' : 'POST' } = {}) =>
  new Request('https://demo.example' + path, { method, headers: { Cookie: cookie }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
const startBody = () => ({ language: 'es', mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
  customer_statement: 'No reconozco este cargo.', idempotency_key: crypto.randomUUID() });

/** Start, then an incomplete handoff (with ``details`` unless null); waitUntil work is collected, never awaited here. */
async function handoff({ d1, store }, env, { details = DETAILS, token = ANA, ctx = true } = {}) {
  env = { ...env, DB: d1 };
  const started = await route(req('/intake/start', { body: startBody(), token }), env, store());
  assert.equal(started.status, 201);
  const { episode_id } = await started.json();
  const pending = [];
  const s = store();
  const res = await route(req('/intake/handoff', { token, body: { episode_id, kind: 'incomplete', idempotency_key: crypto.randomUUID(),
    ...(details === null ? {} : { details }) } }), env, s, ctx ? { waitUntil: work => pending.push(work) } : undefined);
  assert.equal(res.status, 201);
  const text = await res.text();
  return { episode_id, text, receipt: JSON.parse(text), metrics: s.metrics(), pending, env };
}
/** The response without its fresh ids and times: equal bytes otherwise. */
const normalized = text => text.replace(/[0-9a-f]{8}-[0-9a-f-]{27}|AR-[0-9A-Z]{4}-[0-9A-Z]{4}|"accepted_at":"[^"]+"/g, 'x');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const answer = (extraction, usage = [1840, 84]) => json({ choices: [{ message: { content: JSON.stringify(extraction) } }],
  ...(usage && { usage: { prompt_tokens: usage[0], completion_tokens: usage[1] } }) });
/** Google, mocked: STS, IAM Credentials and Vertex, each replaceable; every call is recorded. */
function google({ sts, iam, vertex = () => answer(FARMACIA) } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const call = { url: String(url), init, body: init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : init.body };
    calls.push(call);
    if (call.url.endsWith('/v1/token')) return sts ? sts(call) : json({ access_token: 'federated-token', token_type: 'Bearer', expires_in: 3600 });
    if (call.url.endsWith(':generateAccessToken')) return iam ? iam(call) : json({ accessToken: 'vertex-token', expireTime: new Date(Date.now() + 3600000).toISOString() });
    if (call.url.endsWith('/chat/completions')) return vertex(call, calls.filter(c => c.url.endsWith('/chat/completions')).length);
    throw new Error('unexpected URL ' + call.url);
  };
  return { fetcher, calls, vertexCalls: () => calls.filter(c => c.url.endsWith('/chat/completions')) };
}
const noFetch = () => { throw new Error('fetch must not be called'); };

test('the committed prompt copy is byte-identical to the evaluated prompt, and the producer pins its hash', async () => {
  assert.equal(PROMPT, SOURCE_PROMPT, 'regenerate back-end/src/modules/intake/extractor-prompt.js from intake_agent/extractor/prompt.md; never edit it by hand');
  assert.equal(await registeredVersion(), VERSION);
  assert.deepEqual([...producers()], ['guided-0.1']);
});

test('wrangler.jsonc supports either switch setting, the demo share of arm B, and non-secret Vertex vars without a key, binding or test seam', async () => {
  const config = await readWranglerConfig();
  assert.equal(config.ai, undefined, 'no Workers AI binding: the evaluated host is Vertex AI');
  assert.ok(['1', '0'].includes(config.vars.INTAKE_AI_ENABLED));
  for (const enabled of ['1', '0']) {
    const vars = { ...config.vars, INTAKE_AI_ENABLED: enabled };
    assert.equal(shareB(vars), 1, 'the demo share stays configured even when the switch is off');
    assert.equal(newArm(vars), enabled === '1' ? 'B' : undefined, `switch ${enabled}`);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(config.vars).filter(([k]) => k.startsWith('VERTEX_'))), {
    VERTEX_PROJECT: 'factored-hackathon-arabica-ai', VERTEX_LOCATION: 'us', VERTEX_PROJECT_NUMBER: '92397500240',
    VERTEX_SERVICE_ACCOUNT: 'arabica-worker-vertex@factored-hackathon-arabica-ai.iam.gserviceaccount.com',
    VERTEX_WIF_ISSUER: 'https://factored-hackathon-2026-arabicaai.lucas-tramonte.workers.dev', VERTEX_WIF_KID: '9095f0228830804a',
    VERTEX_MODEL_RETIRES: DEFAULT_RETIRES });
  for (const name of ['VERTEX_WIF_SIGNING_KEY', 'VERTEX_TEST_ORIGIN', 'INTAKE_AI_TEST_ARM']) assert.equal(name in config.vars, false, name);
});

test("switch off: fetch is never called and the handoff, its response and its D1 work are today's", async t => {
  const ctx = await setup(t);
  t.mock.method(globalThis, 'fetch', noFetch);
  const today = await handoff(ctx, {});
  for (const env of [{ ...CREDS }, { ...CREDS, INTAKE_AI_ENABLED: '0' }, { ...CREDS, INTAKE_AI_ENABLED: 'true' }, { ...CREDS, INTAKE_AI_ENABLED: 1 }]) {
    const off = await handoff(ctx, env);
    assert.equal(normalized(off.text), normalized(today.text), JSON.stringify(env.INTAKE_AI_ENABLED));
    assert.deepEqual(off.metrics, today.metrics);
    assertContract('intakeReceipt', off.receipt);
    await Promise.all(off.pending);
    assert.equal(off.pending.length, 0);
    assert.equal(ctx.one('SELECT count(*) n FROM handoff_suggestion_runs WHERE handoff_id=?', off.receipt.protocol).n, 0);
    assert.deepEqual(ctx.events(off.episode_id).map(e => e.event), ['intake_started', 'handoff_created', 'intake_ended']);
  }
  await Promise.all(today.pending);
  assert.deepEqual(ctx.events(today.episode_id).map(e => e.event), ['intake_started', 'handoff_created', 'intake_ended']);
  const plain = await handoff(ctx, { ...ON_B }, { details: null });
  assert.equal(plain.pending.length, 0, 'a handoff without details is never read');
  assert.equal(ctx.one('SELECT count(*) n FROM handoff_suggestion_runs WHERE handoff_id=?', plain.receipt.protocol).n, 0);
  assert.deepEqual(ctx.events(plain.episode_id).map(e => e.event), ['intake_started', 'handoff_created', 'intake_ended']);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("on: the same response and request D1 work; after it, one extraction suggests only the customer's own charge", async t => {
  const ctx = await setup(t);
  const g = google();
  t.mock.method(globalThis, 'fetch', g.fetcher);
  const off = await handoff(ctx, {});
  await Promise.all(off.pending);
  const on = await handoff(ctx, ON_B);
  assert.equal(normalized(on.text), normalized(off.text), 'the response does not depend on the switch');
  assert.deepEqual(
    on.metrics,
    { ...off.metrics, queries: off.metrics.queries + 1 },
    'only the pending AI run is recorded in the request; extraction remains waitUntil work',
  );
  assert.equal(g.calls.length, 0, 'no model call inside the request');
  assert.equal(on.pending.length, 1);
  assert.equal(await on.pending[0], 'suggested');
  assert.deepEqual(g.calls.map(c => c.url), ['http://127.0.0.1:9/v1/token',
    'http://127.0.0.1:9/v1/projects/-/serviceAccounts/arabica-worker-vertex@factored-hackathon-arabica-ai.iam.gserviceaccount.com:generateAccessToken',
    'http://127.0.0.1:9/v1/projects/factored-hackathon-arabica-ai/locations/global/endpoints/openapi/chat/completions']);
  const [vertex] = g.vertexCalls();
  assert.equal(vertex.init.headers.Authorization, 'Bearer vertex-token');
  assert.equal(vertex.init.redirect, 'manual');
  const body = JSON.parse(vertex.body);
  assert.deepEqual([body.model, body.temperature, body.max_tokens, body.reasoning_effort], [MODEL, 0, 2048, 'minimal']);
  assert.equal(body.messages[0].content, PROMPT);
  const user = JSON.parse(body.messages[1].content);
  assert.match(user.as_of, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, 'the harness form: UTC wall time, no offset');
  assert.ok(Math.abs(Date.parse(user.as_of + 'Z') - Date.now()) < 60000, 'the Worker\'s current UTC time');
  assert.deepEqual(user, { message: DETAILS, session_language: 'es', as_of: user.as_of, vocabulary: VOCABULARY }, 'only the details, language, as_of and vocabulary');
  for (const secret of ['"ana"', 'tx-a1', 'tx-bruno', on.episode_id, on.receipt.protocol, ANA, 'No reconozco este cargo']) assert.ok(!vertex.body.includes(secret), secret);
  assert.deepEqual(ctx.rows('SELECT rank,transaction_id,producer FROM handoff_suggestions WHERE handoff_id=?', on.receipt.protocol).map(r => ({ ...r })),
    [{ rank: 1, transaction_id: 'tx-a1', producer: VERSION }], "Bruno's identical charge is never suggested to Ana");
  assert.deepEqual({ ...ctx.one('SELECT arm,outcome,producer,llm_calls,known_input_tokens,known_output_tokens,usage_unavailable_calls FROM handoff_suggestion_runs WHERE handoff_id=?', on.receipt.protocol) },
    { arm: 'B', outcome: 'suggested', producer: VERSION, llm_calls: 1, known_input_tokens: 1840, known_output_tokens: 84, usage_unavailable_calls: 0 });
  const recorded = ctx.events(on.episode_id).at(-1);
  assert.deepEqual(recorded, { event: 'suggestion_recorded', version: '2', case_id: on.episode_id, ts: recorded.ts, seq: 3, session_ref: recorded.session_ref,
    language: 'es', model_version: 'guided-0.1', case_ref: on.receipt.protocol, arm: 'B', result: 'suggested', producer: VERSION, llm_calls: 1,
    known_input_tokens: 1840, known_output_tokens: 84, usage_unavailable_calls: 0, injection_flagged: false, suggestions: 1 });
  assert.ok(!JSON.stringify(ctx.events(on.episode_id)).includes('Farmacia'), 'events carry references and counts, never text');
  // The customer sees the suggestion and confirms it; the agent sees it as a suggestion, never as bank-verified, and marks it.
  const env = { ...ON_B, DB: ctx.d1 };
  const shown = await route(req(`/intake/handoff/${on.receipt.protocol}/suggestions`), env, ctx.store());
  assert.equal(shown.status, 200);
  const list = await shown.json(); assertContract('suggestionList', list);
  assert.deepEqual(list, { status: 'suggested', choice: null, chosen_transaction_id: null, answerable: true, items: [{ transaction_id: 'tx-a1', merchant_name: 'Farmacia Salud',
    amount: '32.00', currency: 'ARS', occurred_at: null, source_occurred_at: '2026-06-10T12:00:00' }] });
  const byShort = await route(req(`/intake/handoff/${on.receipt.reference_short}/suggestions`), env, ctx.store());
  assert.deepEqual(await byShort.json(), list, 'the short reference names the same report');
  const confirmed = await route(req(`/intake/handoff/${on.receipt.protocol}/suggestions/confirm`, { body: { transaction_id: 'tx-a1' } }), env, ctx.store());
  assert.equal(confirmed.status, 200); assertContract('suggestionChoice', await confirmed.clone().json());
  const detail = await route(req('/agent/intake-detail?protocol=' + on.receipt.protocol, { cookie: `demo_agent_session=${AGENT}` }), env, ctx.store());
  const d = await detail.json(); assertContract('agentIntakeDetail', d);
  assert.deepEqual(d.model_reading, { mode: 'suggestion', model_version: VERSION, llm_calls: 1 });
  assert.deepEqual(d.customer_suggestion, { choice: 'confirmed', verified_by_bank: false, mark: null, transaction: { transaction_id: 'tx-a1',
    occurred_at: null, source_occurred_at: '2026-06-10T12:00:00', merchant_name: 'Farmacia Salud', amount: '32.00', currency: 'ARS' } });
  assert.equal(d.verified_evidence.transaction, null, 'a confirmed suggestion is not verified evidence');
  assert.equal(d.history.at(-1).event, 'suggestion_recorded');
  const mark = markBody => route(req('/agent/suggestion-mark', { cookie: `demo_agent_session=${AGENT}`, body: markBody }), env, ctx.store());
  const marked = await mark({ protocol: on.receipt.protocol, mark: 'correct' });
  assert.equal(marked.status, 200); assertContract('suggestionMark', await marked.json());
  assert.equal((await mark({ protocol: on.receipt.protocol, mark: 'correct' })).status, 200, 'the same mark again');
  assert.equal((await mark({ protocol: on.receipt.protocol, mark: 'wrong' })).status, 409);
  assert.equal((await mark({ protocol: off.receipt.protocol, mark: 'wrong' })).status, 404, 'no confirmed suggestion');
  assert.equal(ctx.one('SELECT agent_session_ref FROM handoff_suggestion_marks').agent_session_ref, (await tokenHash(AGENT)).slice(0, 12));
  assert.equal(ctx.one('SELECT status FROM intake_handoffs WHERE handoff_id=?', on.receipt.protocol).status, 'received', 'nothing closes or moves');
  // The retention reset deletes the suggestion tables in foreign-key order.
  ctx.db.exec(readFileSync(new URL('../../scripts/reset-demo-activity.sql', import.meta.url), 'utf8'));
  for (const table of ['handoff_suggestion_marks', 'handoff_suggestion_choices', 'handoff_suggestions', 'handoff_suggestion_runs', 'ai_daily_calls', 'intake_handoffs'])
    assert.equal(ctx.one(`SELECT count(*) n FROM ${table}`).n, 0, table);
  assert.equal(ctx.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

/** A pending run for Ana (switch on, nothing scheduled), then ``runSuggestion`` with ``env`` and a mocked Google. */
async function run(t, env, mocked = google(), { arm = 'B', now } = {}) {
  const ctx = await setup(t);
  const { receipt, episode_id } = await handoff(ctx, { ...ON_B, INTAKE_AI_TEST_ARM: arm }, { ctx: false });
  const outcome = await runSuggestion(env, ctx.store(), { handoffId: receipt.protocol, customerId: 'ana', details: DETAILS, language: 'es' },
    { fetcher: mocked.fetcher, ...(now && { now }) });
  const row = ctx.one('SELECT * FROM handoff_suggestion_runs WHERE handoff_id=?', receipt.protocol);
  const suggested = ctx.rows('SELECT transaction_id FROM handoff_suggestions WHERE handoff_id=? ORDER BY rank', receipt.protocol).map(r => r.transaction_id);
  const recorded = ctx.events(episode_id).at(-1);
  assert.equal(recorded.event, 'suggestion_recorded');
  assert.equal(recorded.result, outcome);
  return { ctx, outcome, row, suggested, recorded, calls: mocked.calls, vertexCalls: mocked.vertexCalls() };
}

test('guards that stop before any call: off (switch, control arm, credential), retired, capped; no fetch', async t => {
  const silent = { fetcher: noFetch, calls: [], vertexCalls: () => [] };
  for (const [label, env, opts, expected] of [
    ['switch off', { ...CREDS, INTAKE_AI_ENABLED: '0' }, {}, 'off'],
    ['control arm A', ON, { arm: 'A' }, 'off'],
    ['retired', { ...ON, VERTEX_MODEL_RETIRES: '2026-01-01' }, {}, 'retired'],
    ['unreadable retirement date', { ...ON, VERTEX_MODEL_RETIRES: 'soon' }, {}, 'retired'],
    ...Object.keys(CREDS).filter(k => k !== 'VERTEX_MODEL_RETIRES').map(k => [`missing ${k}`, { ...ON, [k]: '' }, {}, 'off'])
  ]) {
    const r = await run(t, env, silent, opts);
    assert.equal(r.outcome, expected, label);
    assert.deepEqual([r.row.llm_calls, r.row.producer, r.suggested.length, r.recorded.llm_calls], [0, null, 0, 0], label);
  }
});

test('zero or invalid daily caps stop extraction after authentication', async t => {
  for (const cap of ['0', 'many']) {
    const r = await run(t, { ...ON, INTAKE_AI_DAILY_CAP: cap });
    assert.equal(r.outcome, 'capped', cap);
    assert.equal(r.calls.length, 2, 'STS and IAM exchange succeed before checking the cap');
    assert.equal(r.vertexCalls.length, 0);
    assert.deepEqual([r.row.llm_calls, r.row.producer, r.suggested.length, r.recorded.llm_calls], [0, null, 0, 0]);
  }
});

test('circuit breaker: 3 of the last 5 model-calling runs failing in 5 minutes skips the call until they age out', async t => {
  const ctx = await setup(t);
  const t0 = Date.now();
  const once = async (vertex, at) => {
    const { receipt } = await handoff(ctx, ON_B, { ctx: false });
    const mocked = google({ vertex });
    const outcome = await runSuggestion(ON, ctx.store(), { handoffId: receipt.protocol, customerId: 'ana', details: DETAILS, language: 'es' },
      { fetcher: mocked.fetcher, now: () => at });
    return [outcome, mocked.vertexCalls().length, ctx.one('SELECT llm_calls FROM handoff_suggestion_runs WHERE handoff_id=?', receipt.protocol).llm_calls];
  };
  const down = () => json({}, 503);
  assert.deepEqual(await once(down, t0), ['provider_error', 1, 1]);
  assert.deepEqual(await once(undefined, t0 + 1), ['suggested', 1, 1], 'one failure and a success: closed');
  assert.deepEqual(await once(down, t0 + 2), ['provider_error', 1, 1], 'two failures: still closed');
  assert.deepEqual(await once(down, t0 + 3), ['provider_error', 1, 1]);
  assert.deepEqual(await once(undefined, t0 + 4), ['provider_error', 0, 0], 'three of four failed: open, no call, no usage');
  assert.deepEqual(await once(undefined, t0 + 5), ['provider_error', 0, 0], 'a skipped run made no call, so it never counts');
  assert.deepEqual(await once(undefined, t0 + 2 + BREAKER_WINDOW_MS), ['suggested', 1, 1], 'the failures aged out: the next run probes');
});

test('the daily cap is kept in D1 per UTC day and counts each extraction once', async t => {
  const ctx = await setup(t);
  const env = { ...ON, INTAKE_AI_DAILY_CAP: '1' };
  const outcomes = [];
  for (let i = 0; i < 2; i++) {
    const { receipt } = await handoff(ctx, ON_B, { ctx: false });
    outcomes.push(await runSuggestion(env, ctx.store(), { handoffId: receipt.protocol, customerId: 'ana', details: DETAILS, language: 'es' }, { fetcher: google().fetcher }));
  }
  assert.deepEqual(outcomes, ['suggested', 'capped']);
  assert.deepEqual(ctx.rows('SELECT day,calls FROM ai_daily_calls').map(r => ({ ...r })), [{ day: new Date().toISOString().slice(0, 10), calls: 1 }]);
});

test('the retirement guard can only move earlier than 2027-01-31, the built-in review date for the model', async t => {
  assert.equal(DEFAULT_RETIRES, '2027-01-31');
  assert.equal(retired({}, Date.parse('2027-01-30T23:59:59Z')), false);
  assert.equal(retired({}, Date.parse('2027-01-31T00:00:00Z')), true);
  assert.equal(retired({ VERTEX_MODEL_RETIRES: '2026-10-10' }, Date.parse('2026-10-10T00:00:00Z')), true, 'an earlier date applies');
  for (const at of ['2027-01-31T00:00:00Z', '2027-12-31T00:00:00Z']) assert.equal(retired({ VERTEX_MODEL_RETIRES: '2099-01-01' }, Date.parse(at)), true, at);
  const late = await run(t, ON, { fetcher: noFetch, calls: [], vertexCalls: () => [] }, { now: () => Date.parse('2027-02-01T09:00:00Z') });
  assert.equal(late.outcome, 'retired', 'ON says 2099, the Worker still refuses after 2027-01-31');
  assert.equal(asOfAt(Date.parse('2026-10-05T23:30:12.345Z')), '2026-10-05T23:30:12');
});

test('token exchange failures are auth_error, with no model call and nothing cached', async t => {
  for (const [label, mocked] of [
    ['STS 403', google({ sts: () => json({ error: 'denied' }, 403) })],
    ['STS unreachable', google({ sts: () => { throw new TypeError('network'); } })],
    ['STS without a token', google({ sts: () => json({ token_type: 'Bearer' }) })],
    ['IAM 500', google({ iam: () => json({}, 500) })],
    ['IAM not JSON', google({ iam: () => new Response('<html>', { status: 200 }) })],
    ['IAM without expiry', google({ iam: () => json({ accessToken: 'x' }) })],
    ['STS redirect', google({ sts: () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example' } }) })]
  ]) {
    const r = await run(t, ON, mocked);
    assert.equal(r.outcome, 'auth_error', label);
    assert.equal(r.vertexCalls.length, 0, label);
    assert.equal(r.row.llm_calls, 0, label);
    assert.equal(r.ctx.one('SELECT count(*) n FROM ai_daily_calls').n, 0, label);
  }
  const malformed = await run(t, { ...ON, VERTEX_SERVICE_ACCOUNT: 'someone@evil.example/../x' }, google());
  assert.equal(malformed.outcome, 'auth_error');
  assert.equal(malformed.calls.length, 0, 'a malformed account never reaches a Google path');
});

test('model failures fall back with honest usage: config_error, provider_error (only a 429 retried, once), invalid_output (one retry)', async t => {
  const invalid = () => answer({ intent: 'report' });
  for (const [label, vertex, expected, calls, usage] of [
    ['401', () => json({}, 401), 'config_error', 1, [1, 0, 0, 1]],
    ['403', () => json({}, 403), 'config_error', 1, [1, 0, 0, 1]],
    ['404', () => json({}, 404), 'config_error', 1, [1, 0, 0, 1]],
    ['500', () => json({}, 500), 'provider_error', 1, [1, 0, 0, 1]],
    ['429 twice', () => json({}, 429), 'provider_error', 2, [2, 0, 0, 2]],
    ['429 then valid', (call, n) => n === 1 ? json({}, 429) : answer(FARMACIA), 'suggested', 2, [2, 1840, 84, 1]],
    ['network', () => { throw new TypeError('reset'); }, 'provider_error', 1, [1, 0, 0, 1]],
    ['error envelope', () => json({ error: { message: 'x' } }), 'provider_error', 1, [1, 0, 0, 1]],
    ['invalid twice', invalid, 'invalid_output', 2, [2, 3680, 168, 0]],
    ['invalid then valid', (call, n) => n === 1 ? invalid() : answer(FARMACIA, null), 'suggested', 2, [2, 1840, 84, 1]],
    ['no match', () => answer(report({ merchant: 'Tienda General' })), 'no_match', 1, [1, 1840, 84, 0]],
    ['out of scope', () => answer({ ...report({}), intent: 'out_of_scope:balance' }), 'no_match', 1, [1, 1840, 84, 0]],
    ['more than three', () => answer(report({ merchant: 'Uber' })), 'ambiguous', 1, [1, 1840, 84, 0]],
    ['injection and a demand still only suggest', () => answer({ ...FARMACIA, injection: true, demand: 'refund' }), 'suggested', 1, [1, 1840, 84, 0]]
  ]) {
    const r = await run(t, ON, google({ vertex }));
    assert.equal(r.outcome, expected, label);
    assert.equal(r.vertexCalls.length, calls, label);
    assert.deepEqual([r.row.llm_calls, r.row.known_input_tokens, r.row.known_output_tokens, r.row.usage_unavailable_calls], usage, label);
    assert.deepEqual([r.recorded.llm_calls, r.recorded.usage_unavailable_calls], [usage[0], usage[3]], label);
    assert.deepEqual(r.suggested, expected === 'suggested' ? ['tx-a1'] : [], label);
    assert.equal(r.row.producer, VERSION, label);
  }
  const project = await run(t, { ...ON, VERTEX_PROJECT: 'Not A Project' }, google());
  assert.equal(project.outcome, 'config_error');
  assert.equal(project.vertexCalls.length, 0);  const nowhere = await run(t, { ...ON, VERTEX_LOCATION: 'us-central1' }, google());
  assert.deepEqual([nowhere.outcome, nowhere.vertexCalls.length], ['config_error', 0], 'an unknown location fails closed');
  const us = await run(t, { ...ON, VERTEX_LOCATION: 'us' }, google());
  assert.equal(us.outcome, 'suggested');
  assert.equal(us.vertexCalls[0].url, 'https://aiplatform.us.rep.googleapis.com/v1/projects/factored-hackathon-arabica-ai/locations/us/endpoints/openapi/chat/completions');
});

test('timeout: the 10 s deadline abandons a hung call; the call was counted as unknown before it ran', async t => {
  const ctx = await setup(t);
  const { receipt, episode_id } = await handoff(ctx, ON_B, { ctx: false });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reached;
  const called = new Promise(r => { reached = r; });
  const mocked = google({ vertex: () => { reached(); return new Promise(() => {}); } });
  const pending = runSuggestion(ON, ctx.store(), { handoffId: receipt.protocol, customerId: 'ana', details: DETAILS, language: 'es' }, { fetcher: mocked.fetcher });
  await called;
  assert.deepEqual({ ...ctx.one('SELECT outcome,producer,llm_calls,usage_unavailable_calls FROM handoff_suggestion_runs WHERE handoff_id=?', receipt.protocol) },
    { outcome: null, producer: VERSION, llm_calls: 1, usage_unavailable_calls: 1 }, 'pre-recorded: a Worker stopped now leaves it unknown, never free');
  const shown = await route(req(`/intake/handoff/${receipt.protocol}/suggestions`), { DB: ctx.d1 }, ctx.store());
  assert.equal((await shown.json()).status, 'pending');
  t.mock.timers.tick(EXTRACTION_TIMEOUT_MS);
  assert.equal(await pending, 'timeout');
  assert.equal(mocked.vertexCalls().length, 1, 'no retry after a timeout');
  assert.deepEqual({ ...ctx.one('SELECT outcome,llm_calls,usage_unavailable_calls FROM handoff_suggestion_runs WHERE handoff_id=?', receipt.protocol) },
    { outcome: 'timeout', llm_calls: 1, usage_unavailable_calls: 1 });
  const recorded = ctx.events(episode_id).at(-1);
  assert.deepEqual([recorded.result, recorded.llm_calls, recorded.usage_unavailable_calls], ['timeout', 1, 1]);
});

test('a run is recorded once; a second run or a storage failure changes nothing and never throws', async t => {
  const ctx = await setup(t);
  const { receipt, episode_id } = await handoff(ctx, ON_B, { ctx: false });
  const args = { handoffId: receipt.protocol, customerId: 'ana', details: DETAILS, language: 'es' };
  assert.equal(await runSuggestion(ON, ctx.store(), args, { fetcher: google().fetcher }), 'suggested');
  await runSuggestion(ON, ctx.store(), args, { fetcher: google({ vertex: () => answer(report({ merchant: 'Uber' })) }).fetcher });
  assert.equal(ctx.one('SELECT outcome FROM handoff_suggestion_runs WHERE handoff_id=?', receipt.protocol).outcome, 'suggested');
  assert.equal(ctx.events(episode_id).filter(e => e.event === 'suggestion_recorded').length, 1);
  const broken = { ...ctx.store(), recordSuggestionOutcome: async () => { throw new Error('D1 down'); } };
  assert.equal(await runSuggestion({ ...CREDS }, broken, args, { fetcher: noFetch }), null);
});

test('the Worker JWT, the STS exchange and IAM impersonation follow Workload Identity Federation; the token is cached', async () => {
  resetTokenCache();
  const config = credentialConfig(ON);
  const now = Date.parse('2026-10-05T12:00:00Z');
  const jwt = await workerJwt(config, now);
  const { payload } = await jwtVerify(jwt, publicKey, { issuer: 'https://worker.example', subject: 'arabica-intake-worker',
    audience: '//iam.googleapis.com/projects/92397500240/locations/global/workloadIdentityPools/arabica-worker/providers/cloudflare-worker', currentDate: new Date(now) });
  assert.equal(payload.exp - payload.iat, 300);
  assert.equal(payload.iat, now / 1000);
  assert.deepEqual(decodeProtectedHeader(jwt), { alg: 'RS256', typ: 'JWT', kid: 'test-kid' });
  assert.equal(audience('92397500240'), payload.aud);
  let clock = now;
  const expires = now + 3600000;
  const mocked = google({ iam: () => json({ accessToken: 'vertex-token', expireTime: new Date(expires).toISOString() }) });
  assert.equal(await accessToken(config, { fetcher: mocked.fetcher, now: () => clock }), 'vertex-token');
  const [sts, iam] = mocked.calls;
  assert.equal(sts.url, 'https://sts.googleapis.com/v1/token');
  const exchange = JSON.parse(sts.body);
  assert.deepEqual({ ...exchange, subject_token: 'jwt' }, { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', audience: payload.aud,
    scope: 'https://www.googleapis.com/auth/cloud-platform', requested_token_type: 'urn:ietf:params:oauth:token-type:access_token', subject_token: 'jwt',
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt' });
  await jwtVerify(exchange.subject_token, publicKey, { currentDate: new Date(now) });
  assert.equal(iam.url, 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/arabica-worker-vertex@factored-hackathon-arabica-ai.iam.gserviceaccount.com:generateAccessToken');
  assert.equal(iam.init.headers.Authorization, 'Bearer federated-token');
  assert.deepEqual(JSON.parse(iam.body), { scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '3600s' });
  clock = expires - 5 * 60000 - 1;
  assert.equal(await accessToken(config, { fetcher: mocked.fetcher, now: () => clock }), 'vertex-token');
  assert.equal(mocked.calls.length, 2, 'cached until 5 minutes before expiry');
  clock = expires - 5 * 60000;
  await accessToken(config, { fetcher: mocked.fetcher, now: () => clock });
  assert.equal(mocked.calls.length, 4, 'renewed 5 minutes before expiry');
  resetTokenCache();
  const failing = google({ sts: () => json({}, 500) });
  assert.equal(await accessToken(config, { fetcher: failing.fetcher }), null);
  assert.equal(await accessToken(config, { fetcher: failing.fetcher }), null);
  assert.equal(failing.calls.length, 2, 'a failed exchange is retried on the next report, never cached');
  assert.equal(credentialConfig({ ...ON, VERTEX_WIF_KID: '  ' }), null);
});

test('the endpoint is the global OpenAI-compatible one; the test origin is honoured only on loopback; arms split 50/50', () => {
  assert.equal(vertexUrl('factored-hackathon-arabica-ai'), 'https://aiplatform.googleapis.com/v1/projects/factored-hackathon-arabica-ai/locations/global/endpoints/openapi/chat/completions');
  for (const bad of ['', 'UPPER-case', 'a', 'x/../y', null]) assert.equal(vertexUrl(bad), null, String(bad));
  // ADR-006 amendment 10: the deployed Worker uses the ``us`` multi-region; an unknown location never builds a URL.
  assert.equal(vertexUrl('factored-hackathon-arabica-ai', undefined, 'us'), 'https://aiplatform.us.rep.googleapis.com/v1/projects/factored-hackathon-arabica-ai/locations/us/endpoints/openapi/chat/completions');
  assert.equal(vertexUrl('factored-hackathon-arabica-ai', undefined, 'eu'), 'https://aiplatform.eu.rep.googleapis.com/v1/projects/factored-hackathon-arabica-ai/locations/eu/endpoints/openapi/chat/completions');
  for (const bad of ['us-central1', 'US', '', 'evil.example/x', 'constructor', '__proto__']) assert.equal(vertexUrl('factored-hackathon-arabica-ai', undefined, bad), null, bad);
  for (const origin of ['http://127.0.0.1:8787', 'http://localhost:1']) assert.equal(testOrigin({ VERTEX_TEST_ORIGIN: origin }), origin);
  for (const origin of ['https://evil.example', 'http://127.0.0.1.evil.example:1', 'http://127.0.0.1:1/path', 'https://127.0.0.1:1', undefined])
    assert.equal(testOrigin({ VERTEX_TEST_ORIGIN: origin }), null, String(origin));
  assert.equal(newArm({ INTAKE_AI_ENABLED: '0', INTAKE_AI_TEST_ARM: 'B', VERTEX_TEST_ORIGIN: 'http://127.0.0.1:1' }), undefined);
  assert.equal(newArm({ ...ON_B, INTAKE_AI_TEST_ARM: 'A' }), 'A');
  const arms = Array.from({ length: 400 }, () => newArm({ ...ON, INTAKE_AI_TEST_ARM: 'B' }));
  const b = arms.filter(a => a === 'B').length;
  assert.ok(arms.every(a => a === 'A' || a === 'B'));
  assert.ok(b > 140 && b < 260, `without the loopback test origin the arm is random: ${b} of 400 were B`);
});

test('INTAKE_AI_SHARE_B sets the share of arm B; anything but a number from 0 to 1 keeps the pilot\'s 50/50', () => {
  for (const [value, share] of [[undefined, 0.5], ['', 0.5], ['x', 0.5], ['-0.1', 0.5], ['1.5', 0.5], ['0', 0], ['0.25', 0.25], ['1', 1]])
    assert.equal(shareB({ INTAKE_AI_SHARE_B: value }), share, String(value));
  const draw = share => Array.from({ length: 200 }, () => newArm({ ...ON, INTAKE_AI_SHARE_B: share }));
  assert.ok(draw('1').every(a => a === 'B'));
  assert.ok(draw('0').every(a => a === 'A'));
  assert.equal(newArm({ INTAKE_AI_ENABLED: '0', INTAKE_AI_SHARE_B: '1' }), undefined, 'the switch still decides first');
});

test('suggestion runs export with references and counts only, and the scorer summarises them by arm', async t => {
  const ctx = await setup(t);
  t.mock.method(globalThis, 'fetch', google().fetcher);
  for (const env of [ON_B, { ...ON_B, INTAKE_AI_TEST_ARM: 'A' }]) await Promise.all((await handoff(ctx, env)).pending);
  const dir = resolve(import.meta.dirname, '../../../data/intake-events', crypto.randomUUID());
  await mkdir(dir, { recursive: true }); t.after(() => rm(dir, { recursive: true, force: true }));
  const output = resolve(dir, 'events.jsonl');
  const result = await exportIntakeEvents(ctx.store(), { output, python: scorerPython() });
  assert.equal(result.summary.all.suggestions.runs, 2);
  assert.deepEqual(result.summary.all.suggestions.by_arm, { A: { off: 1 }, B: { suggested: 1 } });
  assert.equal(result.summary.all.suggestions.llm_calls, 1);
  const text = await readFile(output, 'utf8');
  for (const leak of [DETAILS, 'Farmacia', 'tx-a1', '"ana"', 'stated_facts']) assert.ok(!text.includes(leak), leak);
  await assert.rejects(exportIntakeEvents(ctx.store(), { output, python: scorerPython(), extractors: new Set(['extractor-v1@000000000000']) }),
    e => e.cause?.message === 'Unreviewed producer');
});

test('the start and the complete flow never call a model, and their events stay guided-0.1', async t => {
  const ctx = await setup(t);
  t.mock.method(globalThis, 'fetch', noFetch);
  const env = { ...ON_B, DB: ctx.d1 };
  const started = await route(req('/intake/start', { body: startBody() }), env, ctx.store(), { waitUntil: () => assert.fail('nothing scheduled') });
  const { episode_id } = await started.json();
  const confirmed = await route(req('/intake/confirm', { body: { episode_id, transaction_id: 'tx-ana', customer_confirmed: true, idempotency_key: crypto.randomUUID() } }),
    env, ctx.store(), { waitUntil: () => {} });
  assert.equal(confirmed.status, 201);
  await close(ctx.store(), (await confirmed.json()).protocol);
  const events = ctx.events(episode_id);
  assert.deepEqual(events.map(e => e.event), ['intake_started', 'transaction_confirmed', 'handoff_created', 'handoff_accepted', 'intake_ended']);
  for (const e of events) assert.equal(e.model_version, 'guided-0.1');
  assert.equal(ctx.one('SELECT count(*) n FROM handoff_suggestion_runs').n, 0);
});

test("agent detail: model_reading and customer_suggestion carry versions, counts and the customer's answer only", async t => {
  const ctx = await setup(t);
  const env = { DB: ctx.d1 };
  const off = await handoff(ctx, {});
  await Promise.all(off.pending);
  const detail = await route(req('/agent/intake-detail?protocol=' + off.receipt.protocol, { cookie: `demo_agent_session=${AGENT}` }), env, ctx.store());
  const body = await detail.json(); assertContract('agentIntakeDetail', body);
  assert.deepEqual([body.model_reading, body.customer_suggestion], [{ mode: 'off', model_version: null, llm_calls: 0 }, null]);
  assert.throws(() => assertContract('agentIntakeDetail', { ...body, model_reading: { ...body.model_reading, stated_facts: {} } }), /violated/);
  assert.throws(() => assertContract('agentIntakeDetail', { ...body, model_reading: { ...body.model_reading, mode: 'decided' } }), /violated/);
  assert.throws(() => assertContract('agentIntakeDetail', { ...body, customer_suggestion: { choice: 'confirmed', verified_by_bank: true, mark: null, transaction: null } }), /violated/);
});

test('one runner per run: concurrent runs and a replay call the model once; an unclaimed run is finished by its replay', async t => {
  const ctx = await setup(t);
  const { receipt } = await handoff(ctx, ON_B, { ctx: false });
  const mocked = google();
  const args = { handoffId: receipt.protocol, customerId: 'ana', details: DETAILS, language: 'es' };
  const outcomes = await Promise.all(Array.from({ length: 4 }, () => runSuggestion(ON, ctx.store(), args, { fetcher: mocked.fetcher })));
  assert.deepEqual(outcomes.sort(), [null, null, null, 'suggested']);
  assert.equal(mocked.vertexCalls().length, 1);
  // A first request whose run never started (no ctx here): its same-key replay schedules it, and only once.
  t.mock.method(globalThis, 'fetch', google().fetcher);
  const env = { ...ON_B, DB: ctx.d1 };
  const started = await route(req('/intake/start', { body: startBody() }), env, ctx.store());
  const { episode_id } = await started.json();
  const body = { episode_id, kind: 'incomplete', idempotency_key: crypto.randomUUID(), details: DETAILS };
  const first = await route(req('/intake/handoff', { body }), env, ctx.store());
  const protocol = (await first.json()).protocol;
  assert.equal(ctx.one('SELECT outcome,claimed_at FROM handoff_suggestion_runs WHERE handoff_id=?', protocol).claimed_at, null);
  const pending = [];
  const replay = await route(req('/intake/handoff', { body }), env, ctx.store(), { waitUntil: w => pending.push(w) });
  assert.equal(replay.status, 200);
  assert.deepEqual(await Promise.all(pending), ['suggested']);
  const again = [];
  await route(req('/intake/handoff', { body }), env, ctx.store(), { waitUntil: w => again.push(w) });
  assert.deepEqual(await Promise.all(again), [null], 'a finished run is never read again');
  assert.equal(ctx.events(episode_id).filter(e => e.event === 'suggestion_recorded').length, 1);
});

test('the idle sweep closes runs pending over 10 minutes as abandoned, keeping a pre-recorded call unknown', async t => {
  const ctx = await setup(t);
  const fresh = await handoff(ctx, ON_B, { ctx: false });
  const stale = await handoff(ctx, ON_B, { ctx: false });
  const started = await handoff(ctx, ON_B, { ctx: false });
  const now = Date.now();
  ctx.db.prepare('UPDATE handoff_suggestion_runs SET created_at=? WHERE handoff_id IN (?,?)').run(now - 700000, stale.receipt.protocol, started.receipt.protocol);
  ctx.db.prepare('UPDATE handoff_suggestion_runs SET claimed_at=?,producer=?,llm_calls=1,usage_unavailable_calls=1 WHERE handoff_id=?').run(now - 690000, VERSION, started.receipt.protocol);
  const { closeIdleIntakes } = await import('../../scripts/close-idle-intakes.mjs');
  const swept = await closeIdleIntakes(ctx.store(), { now });
  assert.equal(swept.suggestions_abandoned, 2);
  const row = id => ({ ...ctx.one('SELECT outcome,llm_calls,usage_unavailable_calls FROM handoff_suggestion_runs WHERE handoff_id=?', id) });
  assert.deepEqual(row(fresh.receipt.protocol), { outcome: null, llm_calls: 0, usage_unavailable_calls: 0 });
  assert.deepEqual(row(stale.receipt.protocol), { outcome: 'abandoned', llm_calls: 0, usage_unavailable_calls: 0 });
  assert.deepEqual(row(started.receipt.protocol), { outcome: 'abandoned', llm_calls: 1, usage_unavailable_calls: 1 });
  const recorded = ctx.events(started.episode_id).at(-1);
  assert.deepEqual([recorded.event, recorded.result, recorded.llm_calls, recorded.usage_unavailable_calls, recorded.injection_flagged], ['suggestion_recorded', 'abandoned', 1, 1, null]);
  assert.equal((await closeIdleIntakes(ctx.store(), { now })).suggestions_abandoned, 0, 'once only');
  assert.equal(await runSuggestion(ON, ctx.store(), { handoffId: stale.receipt.protocol, customerId: 'ana', details: DETAILS, language: 'es' }, { fetcher: noFetch }), null,
    'a closed run is never read later');
});

test('the injection flag is recorded, and changes no outcome', async t => {
  for (const injection of [true, false]) {
    const r = await run(t, ON, google({ vertex: () => answer({ ...FARMACIA, injection }) }));
    assert.equal(r.outcome, 'suggested');
    assert.equal(r.row.injection_flagged, injection ? 1 : 0);
    assert.equal(r.recorded.injection_flagged, injection);
  }
  const failed = await run(t, ON, google({ vertex: () => json({}, 500) }));
  assert.deepEqual([failed.row.injection_flagged, failed.recorded.injection_flagged], [null, null], 'unknown when the model did not answer');
});

test('suggestions are shown once (shown_at), answerable only until an agent opens the report, and summarised for the pilot', async t => {
  const ctx = await setup(t);
  t.mock.method(globalThis, 'fetch', google().fetcher);
  const env = { ...ON_B, DB: ctx.d1 };
  const reports = [];
  for (let i = 0; i < 3; i++) { const h = await handoff(ctx, ON_B); await Promise.all(h.pending); reports.push(h.receipt.protocol); }
  const [answered, opened, unseen] = reports;
  const get = protocol => route(req(`/intake/handoff/${protocol}/suggestions`), env, ctx.store());
  const shownAt = protocol => ctx.one('SELECT shown_at FROM handoff_suggestion_runs WHERE handoff_id=?', protocol).shown_at;
  await get(answered); const first = shownAt(answered); await get(answered);
  assert.ok(first > 0); assert.equal(shownAt(answered), first, 'stamped once');
  assert.equal((await route(req(`/intake/handoff/${answered}/suggestions/confirm`, { body: { none: true } }), env, ctx.store())).status, 200);
  await get(opened);
  const agentDetail = await route(req('/agent/intake-detail?protocol=' + opened, { cookie: `demo_agent_session=${AGENT}` }), env, ctx.store());
  assert.equal(agentDetail.status, 200);
  const late = await (await get(opened)).json();
  assertContract('suggestionList', late);
  assert.deepEqual([late.status, late.answerable, late.items, late.choice], ['suggested', false, [], null], 'nothing is served once a review started');
  for (const body of [{ transaction_id: 'tx-a1' }, { none: true }]) {
    const refused = await route(req(`/intake/handoff/${opened}/suggestions/confirm`, { body }), env, ctx.store());
    assert.equal(refused.status, 409);
    const payload = await refused.json(); assertContract('error', payload);
    assert.equal(payload.code, 'already_in_review');
  }
  assert.equal((await route(req(`/intake/handoff/${opened}/suggestions/confirm`, { body: { transaction_id: 'tx-u1' } }), env, ctx.store())).status, 422,
    'a charge that was not suggested is still 422');
  assert.equal(ctx.one('SELECT count(*) n FROM handoff_suggestion_choices WHERE handoff_id=?', opened).n, 0, 'nothing stored');
  assert.equal(shownAt(unseen), null);
  // An agent opens the never-shown report first: a later GET serves nothing and does not stamp shown_at.
  assert.equal((await route(req('/agent/intake-detail?protocol=' + unseen, { cookie: `demo_agent_session=${AGENT}` }), env, ctx.store())).status, 200);
  const afterOpen = await (await get(unseen)).json();
  assert.deepEqual([afterOpen.items, afterOpen.answerable], [[], false]);
  assert.equal(shownAt(unseen), null, 'not shown, so still not_shown');
  const summary = await ctx.store().suggestionPilotSummary({ sinceMs: 0, untilMs: Date.now() + 1000 });
  assert.equal(summary.length, 1);
  const { arm, outcome, runs, shown, not_shown, confirmed, rejected, not_answered, awaiting, llm_calls } = summary[0];
  assert.deepEqual({ arm, outcome, runs, shown, not_shown, confirmed, rejected, not_answered, awaiting, llm_calls },
    { arm: 'B', outcome: 'suggested', runs: 3, shown: 2, not_shown: 1, confirmed: 0, rejected: 1, not_answered: 1, awaiting: 0, llm_calls: 3 });
  // With the answer given, the charges are served even after the review started.
  assert.equal((await (await get(answered)).json()).items.length, 1);
  for (const leak of ['tx-a1', 'ana', answered]) assert.ok(!JSON.stringify(summary).includes(leak), leak);
});

test('the whole token exchange (STS and IAM together) has one 5 s deadline', async t => {
  resetTokenCache();
  assert.equal(EXCHANGE_MS, 5000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reached;
  const atIam = new Promise(r => { reached = r; });
  // STS answers at once; IAM hangs: the deadline covers both calls, not each one.
  const mocked = google({ iam: () => { reached(); return new Promise(() => {}); } });
  const pending = accessToken(credentialConfig(ON), { fetcher: mocked.fetcher });
  await atIam;
  t.mock.timers.tick(EXCHANGE_MS - 1);
  let settled = false; pending.then(() => { settled = true; });
  await new Promise(r => setImmediate(r));
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.equal(await pending, null);
  assert.equal(mocked.calls.at(-1).init.signal.aborted, true, 'the hung call is aborted');
});

test('the outcome kinds are the same in the Worker, migration 0024 and the scorer', () => {
  const sql = readFileSync(new URL('../../migrations/0024_ai_suggestions.sql', import.meta.url), 'utf8');
  const check = /outcome IN \(([^)]*)\)/.exec(sql)[1].match(/'([a-z_]+)'/g).map(x => x.slice(1, -1));
  const py = readFileSync(new URL('../../../evals/intake/episodes.py', import.meta.url), 'utf8');
  const results = /RESULTS = \(([^)]*)\)/.exec(py)[1].match(/'([a-z_]+)'/g).map(x => x.slice(1, -1));
  assert.deepEqual(check, OUTCOMES);
  assert.deepEqual(results, OUTCOMES);
});

test('"none of these", like a pick, needs at least one stored suggestion', async t => {
  const ctx = await setup(t);
  const { receipt } = await handoff(ctx, ON_B, { ctx: false });
  // A suggested run without stored charges (only reachable by hand): nothing to refuse, so nothing is stored.
  ctx.db.prepare("UPDATE handoff_suggestion_runs SET outcome='suggested',finished_at=1 WHERE handoff_id=?").run(receipt.protocol);
  const res = await route(req(`/intake/handoff/${receipt.protocol}/suggestions/confirm`, { body: { none: true } }), { DB: ctx.d1 }, ctx.store());
  assert.equal(res.status, 404);
  assert.equal(ctx.one('SELECT count(*) n FROM handoff_suggestion_choices').n, 0);
});

test('the sweep closes only runs of acknowledged handoffs, so each abandoned run gets its event', async t => {
  const ctx = await setup(t);
  const acked = await handoff(ctx, ON_B, { ctx: false });
  const pendingReservation = await handoff(ctx, ON_B, { ctx: false });
  const old = Date.now() - 700000;
  ctx.db.prepare('UPDATE handoff_suggestion_runs SET created_at=?').run(old);
  ctx.db.prepare("UPDATE intake_episodes SET state='handoff_pending' WHERE episode_id=?").run(pendingReservation.episode_id);
  const closed = await ctx.store().closeStaleSuggestionRuns({ now: Date.now() });
  assert.deepEqual(closed, [acked.receipt.protocol]);
  assert.equal(ctx.one('SELECT outcome FROM handoff_suggestion_runs WHERE handoff_id=?', pendingReservation.receipt.protocol).outcome, null);
  assert.equal(ctx.events(acked.episode_id).at(-1).result, 'abandoned');
});
