/** Real local-D1 guided starts: concurrent replay, session isolation, hostile input and contract. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, base, auth } from '../support/client.js';
import { assertContract } from '../support/contract.js';

const startBody = (language = 'es') => ({ language, mode: 'guided', report_type: 'unrecognized_charge',
  customer_statement: language === 'es' ? 'No reconozco este cargo.' : 'Não reconheço esta cobrança.',
  idempotency_key: crypto.randomUUID() });

async function customer(id = 'demo-ana') {
  const c = client();
  const login = await c.call('/demo/session', { customer_id: id });
  assert.equal(login.status, 200);
  assertContract('customerSession', login.body);
  assert.equal(login.body.expires_at, undefined, 'trusted expiry is internal only');
  return c;
}

test('guided_start_is_owned_and_idempotent against local D1', async () => {
  const ana = await customer();
  const body = startBody();
  const results = await Promise.all(Array.from({ length: 10 }, () => fetch(base + '/intake/start', {
    method: 'POST', headers: { Authorization: auth, Cookie: ana.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }))));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
  assert.equal(new Set(results.map(r => r.body.episode_id)).size, 1);
  for (const result of results) { assertContract('intakeStart', result.body); assert.equal(result.body.protocol, undefined); }
  for (const change of [{ customer_statement: 'Otro cargo que no reconozco.' }, { language: 'pt' }]) {
    const conflict = await ana.call('/intake/start', { ...body, ...change });
    assert.equal(conflict.status, 409);
    assertContract('error', conflict.body);
  }
  const stale = client();
  stale.cookie = ana.cookie;
  await ana.call('/demo/session', { customer_id: 'demo-ana' });
  assert.equal((await stale.call('/intake/start', body)).status, 401);
  const replay = await ana.call('/intake/start', body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, { ...results.find(r => r.status === 201).body, replayed: true });
  const bruno = await customer('demo-bruno');
  const other = await bruno.call('/intake/start', body);
  assert.equal(other.status, 201);
  assert.notEqual(other.body.episode_id, replay.body.episode_id, 'same key is scoped to authenticated owner');
  assert.equal((await bruno.call('/intake/start', { ...body, episode_id: replay.body.episode_id })).status, 422);
  console.log('D1_INTAKE_START_REPLAY ' + JSON.stringify(replay.metrics));
});

test('guided start gate, path, session-role and malformed-input boundaries', async () => {
  for (const path of ['/intake/start', '/intake', '/intake/', '/intake/unknown', '/intake/start/extra']) {
    for (const method of ['GET', 'POST', 'HEAD', 'OPTIONS', 'DELETE', 'PUT']) {
      const denied = await fetch(base + path, { method });
      assert.equal(denied.status, 401, `${method} ${path}`);
      assert.equal(denied.headers.get('Allow'), null);
      const gated = await fetch(base + path, { method, headers: { Authorization: auth } });
      assert.equal(gated.status, path === '/intake/start' ? (method === 'POST' ? 401 : 405) : 404, `${method} ${path}`);
    }
  }
  const agent = client();
  await agent.call('/demo/agent-session', {});
  agent.cookie = agent.cookie.replace('demo_agent_session=', 'demo_session=');
  assert.equal((await agent.call('/intake/start', startBody())).status, 401);
  for (const token of ['f'.repeat(64), process.env.EXPIRED_TOKEN]) {
    const c = client(); c.cookie = `demo_session=${token}`;
    assert.equal((await c.call('/intake/start', startBody())).status, 401);
  }
  const ana = await customer();
  const body = startBody();
  for (const invalid of ['{bad', '[]', 'null', { ...body, customer_id: 'demo-bruno' }, { ...body, language: 'en' },
    { ...body, mode: 'ai' }, { ...body, report_type: 'recognized_charge' }, { ...body, extra: true },
    { ...body, customer_statement: 'x'.repeat(2001) }, { ...body, customer_statement: '\ud800'.repeat(10) }]) {
    const rejected = await ana.call('/intake/start', invalid);
    assert.equal(rejected.status, 422);
    assertContract('error', rejected.body);
  }
  assert.equal((await ana.call('/intake/start', 'x'.repeat(20_000))).status, 413);
  const hostile = await ana.call('/intake/start', { ...startBody('pt'), customer_statement: "'); DROP TABLE sessions; -- cobrança" });
  assert.equal(hostile.status, 201);
  assertContract('intakeStart', hostile.body);
  assert.equal((await ana.call('/transactions')).status, 200);
});

test('new guided start reports local D1 work without altering existing route budgets', async () => {
  const ana = await customer();
  const result = await ana.call('/intake/start', startBody('pt'));
  assert.equal(result.status, 201);
  assertContract('intakeStart', result.body);
  assert.ok(result.metrics, 'local harness exposes measured D1 counters');
  console.log('D1_INTAKE_START ' + JSON.stringify(result.metrics));
});

test('U+0000 guided statements return 422 on local D1 and leave their key reusable', async () => {
  const ana = await customer();
  const body = startBody();
  for (const statement of ['a\u0000bbbbbbbbbb', 'No reconozco este cargo.\u0000']) {
    const rejected = await ana.call('/intake/start', { ...body, customer_statement: statement });
    assert.equal(rejected.status, 422);
    assertContract('error', rejected.body);
  }
  assert.equal((await ana.call('/intake/start', body)).status, 201);
});

// Native binding bridge shares the harness's local D1; scripts never handle raw D1 CLI responses.
test('idle_close_and_export_keep_pending_and_unknown_visible on local D1',async t=>{
  const {withIntakeStore}=await import('../../scripts/intake-store.mjs');
  const {exportIntakeEvents}=await import('../../scripts/export-intake-events.mjs');
  const {closeIdleIntakes}=await import('../../scripts/close-idle-intakes.mjs');
  const {resolve}=await import('node:path');const {mkdir,rm,readFile}=await import('node:fs/promises');
  const root=resolve(import.meta.dirname,'../../..');const output=resolve(root,'data/intake-events',crypto.randomUUID(),'events.jsonl');await mkdir(resolve(output,'..'),{recursive:true});t.after(()=>rm(resolve(output,'..'),{recursive:true,force:true}));
  const ana=await customer();const start=await ana.call('/intake/start',startBody());
  const complete=await ana.call('/intake/confirm',{episode_id:start.body.episode_id,transaction_id:'demo-tx-001',customer_confirmed:true,idempotency_key:crypto.randomUUID()});assert.equal(complete.status,201);
  const incompleteStart=await ana.call('/intake/start',startBody());assert.equal((await ana.call('/intake/handoff',{episode_id:incompleteStart.body.episode_id,kind:'incomplete',idempotency_key:crypto.randomUUID()})).status,201);
  await withIntakeStore({config:resolve(process.cwd(),'wrangler.jsonc')},async store=>{
    const now=Date.now();const expired=(await store.startIntake({customerId:'demo-ana',language:'es',statement:'No reconozco este cargo.',key:crypto.randomUUID(),now:now-600000,expiresAt:now+100000})).episode;
    const closed=await closeIdleIntakes(store,{now,limit:100});assert.ok(closed.closed>=1);assert.equal((await store.findIntake('demo-ana',expired.episode_id)).state,'abandoned');
    const repeated=await closeIdleIntakes(store,{now,limit:100});assert.equal(repeated.closed,0);console.log('D1_IDLE_TWO_SWEEPS '+JSON.stringify(store.metrics()));
  });
  await withIntakeStore({config:resolve(process.cwd(),'wrangler.jsonc')},async store=>{
    const result=await exportIntakeEvents(store,{output,python:process.env.INTAKE_PYTHON,limit:100});
    assert.ok(result.summary.all.eligible_started>=3);assert.ok(result.summary.all.outcomes.accepted>=1);assert.ok(result.summary.all.outcomes.routed>=1);assert.ok(result.summary.all.outcomes.pending>=1);assert.ok(result.summary.all.usage_unknown_episodes>=1);assert.equal(result.summary.all.safe_accepted,0);
    const text=await readFile(output,'utf8');for(const forbidden of ['"customer_id"','No reconozco','demo-tx-001','"customer_statement"'])assert.ok(!text.includes(forbidden));
    const m=result.metrics;assert.ok(m.queries===1&&m.roundTrips===1&&m.rowsWritten===0);console.log('D1_EXPORT_PAGE '+JSON.stringify({episodes:result.episodes,...m}));
  });
});
