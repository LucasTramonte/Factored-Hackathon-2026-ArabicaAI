/** Real local-D1 guided starts: concurrent replay, session isolation, hostile input and contract. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, base, closeReport } from '../support/client.js';
import { assertContract } from '../support/contract.js';
import { scorerPython } from '../../scripts/scorer-python.mjs';

const startBody = (language = 'es') => ({ language, mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
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
    method: 'POST', headers: { Cookie: ana.cookie, 'Content-Type': 'application/json' },
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
      for (const headers of [{}, { Authorization: 'Basic eDp5' }]) {
        const res = await fetch(base + path, { method, headers });
        assert.equal(res.status, path === '/intake/start' ? (method === 'POST' ? 401 : 405) : 404, `${method} ${path}`);
        assert.equal(res.headers.get('WWW-Authenticate'), null, 'no team gate on customer paths');
      }
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
  for (const invalid of ['{bad', '[]', 'null', { ...body, customer_id: 'demo-bruno' }, { ...body, language: 'fr' },
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
  const {resolve}=await import('node:path');const {mkdir,rm,readFile}=await import('node:fs/promises');const {execFileSync}=await import('node:child_process');
  const root=resolve(import.meta.dirname,'../../..');const dir=resolve(root,'data/intake-events',crypto.randomUUID());const output=resolve(dir,'events.jsonl');
  await mkdir(dir,{recursive:true});t.after(()=>rm(dir,{recursive:true,force:true}));
  const config=resolve(process.cwd(),'wrangler.jsonc');
  const ana=await customer();const start=await ana.call('/intake/start',startBody());
  const complete=await ana.call('/intake/confirm',{episode_id:start.body.episode_id,transaction_id:'demo-tx-001',customer_confirmed:true,idempotency_key:crypto.randomUUID()});assert.equal(complete.status,201);await closeReport(complete.body.protocol);
  const incompleteStart=await ana.call('/intake/start',startBody());assert.equal((await ana.call('/intake/handoff',{episode_id:incompleteStart.body.episode_id,kind:'incomplete',idempotency_key:crypto.randomUUID()})).status,201);
  const open=await ana.call('/intake/start',startBody('pt'));assert.equal(open.status,201);
  let expired;
  await withIntakeStore({config},async store=>{
    const now=Date.now();expired=(await store.startIntake({customerId:'demo-ana',language:'es',statement:'No reconozco este cargo.',key:crypto.randomUUID(),now:now-600000,expiresAt:now+100000})).episode;
    const closed=await closeIdleIntakes(store,{now,limit:100});assert.ok(closed.closed>=1);assert.equal(closed.complete,true);assert.equal((await store.findIntake('demo-ana',expired.episode_id)).state,'abandoned');
    const repeated=await closeIdleIntakes(store,{now,limit:100});assert.equal(repeated.closed,0);console.log('D1_IDLE_TWO_SWEEPS '+JSON.stringify(store.metrics()));
  });
  let result;
  await withIntakeStore({config},async store=>{
    // Small pages force the keyset cursor through several pages of the shared population; nothing is omitted.
    result=await exportIntakeEvents(store,{output,python:process.env.INTAKE_PYTHON,limit:7});
    assert.equal(result.complete,true);assert.ok(result.pages>1);
    const m=result.metrics;assert.equal(m.queries,result.pages);assert.equal(m.roundTrips,result.pages);assert.equal(m.rowsWritten,0);
    console.log('D1_EXPORT_RUN '+JSON.stringify({episodes:result.episodes,pages:result.pages,...m}));
  });
  const text=await readFile(output,'utf8');for(const forbidden of ['"customer_id"','No reconozco','Não reconheço','demo-tx-001','demo-ana','"customer_statement"'])assert.ok(!text.includes(forbidden),forbidden);
  const events=text.trim().split('\n').map(line=>JSON.parse(line));const byEpisode=new Map();
  for(const e of events){if(!byEpisode.has(e.case_id))byEpisode.set(e.case_id,[]);byEpisode.get(e.case_id).push(e);}
  assert.equal(byEpisode.size,result.episodes,'one group per exported episode');
  const names=id=>byEpisode.get(id).map(e=>e.event);const end=id=>byEpisode.get(id).at(-1);
  assert.deepEqual(names(start.body.episode_id),['intake_started','transaction_confirmed','handoff_created','handoff_accepted','intake_ended']);
  assert.equal(end(start.body.episode_id).outcome,'accepted');assert.equal(end(start.body.episode_id).safety,'not_assessed');
  assert.deepEqual(names(incompleteStart.body.episode_id),['intake_started','handoff_created','intake_ended']);assert.equal(end(incompleteStart.body.episode_id).outcome,'routed');
  assert.deepEqual(names(open.body.episode_id),['intake_started'],'an open episode stays pending in the denominator');
  assert.deepEqual(names(expired.episode_id),['intake_started','intake_ended']);assert.equal(end(expired.episode_id).outcome,'abandoned');
  // Reconcile the published artifact with the scorer CLI directly: every exported episode is an eligible start.
  const python=scorerPython();
  const scored=JSON.parse(execFileSync(python,['-m','evals.intake.episodes',output],{cwd:root,encoding:'utf8'}));
  assert.deepEqual(scored,result.summary);
  const pending=[...byEpisode.values()].filter(seq=>seq.at(-1).event!=='intake_ended').length;
  assert.equal(scored.all.eligible_started,result.episodes);assert.equal(scored.all.outcomes.pending,pending);
  assert.equal(scored.all.safe_accepted,0,'production safety stays not_assessed');assert.equal(scored.all.not_assessed,result.episodes);
  // Guided episodes call no model: usage is measured zero, and only pending episodes have unknown usage.
  assert.equal(scored.all.usage_unknown_episodes,pending);assert.equal(scored.all.llm_calls,0);assert.equal(scored.all.input_tokens,0);assert.equal(scored.all.usage_unavailable_calls,0);
  console.log('D1_SCORER_RECONCILED '+JSON.stringify({episodes:result.episodes,pending,outcomes:scored.all.outcomes}));
});

test('export CLI on the shared local D1 never relays scorer output or partial artifacts', async t => {
  const {resolve}=await import('node:path');const {mkdir,rm,readdir,writeFile}=await import('node:fs/promises');const {spawnSync}=await import('node:child_process');
  const root=resolve(import.meta.dirname,'../../..');const dir=resolve(root,'data/intake-events',crypto.randomUUID());
  await mkdir(dir,{recursive:true});t.after(()=>rm(dir,{recursive:true,force:true}));
  // The fake scorer echoes the artifact it was given (opaque references) and customer-looking text to both streams.
  const scorer=resolve(dir,'scorer.sh');
  await writeFile(scorer,'#!/bin/sh\necho "SENTINEL No reconozco demo-ana"; cat "$3"; echo SENTINEL_STDERR >&2; cat "$3" >&2; exit 3\n',{mode:0o755});
  const run=spawnSync(process.execPath,[resolve(root,'back-end/scripts/export-intake-events.mjs'),'--config',resolve(process.cwd(),'wrangler.jsonc'),
    '--output',resolve(dir,'events.jsonl'),'--python',scorer],{encoding:'utf8',timeout:120000});
  assert.equal(run.status,1);assert.equal(run.stdout,'');assert.equal(run.stderr,'Export failed\n');
  assert.deepEqual(await readdir(dir),['scorer.sh'],'no temporary or partial artifact remains');
  // The same database exports when the options are valid, so the failures below come from option validation.
  const cli=(script,args)=>spawnSync(process.execPath,[resolve(root,'back-end/scripts',script),'--config',resolve(process.cwd(),'wrangler.jsonc'),...args],{encoding:'utf8',timeout:120000});
  const python=scorerPython();const output=resolve(dir,'events.jsonl');
  const ok=cli('export-intake-events.mjs',['--output',output,'--python',python,'--max-pages','100']);
  assert.equal(ok.status,0,ok.stderr);const exported=JSON.parse(ok.stdout);assert.equal(exported.complete,true);assert.ok(exported.started_at);assert.equal('cutoff' in exported,false);
  for(const args of [['--max-pages','0'],['--max-pages','101'],['--limit','0'],['--limit','1.5']]){
    const bad=cli('export-intake-events.mjs',['--output',output,'--python',python,...args]);assert.equal(bad.status,1,args.join(' '));assert.equal(bad.stderr,'Export failed\n');
  }
  const swept=cli('close-idle-intakes.mjs',['--now',String(Date.now())]);assert.equal(swept.status,0,swept.stderr);assert.equal(JSON.parse(swept.stdout).complete,true);
  for(const now of [String(Date.now()+3600000),'','-1','12.5']){
    const bad=cli('close-idle-intakes.mjs',['--now',now]);assert.equal(bad.status,1,now);assert.equal(bad.stdout,'');assert.equal(bad.stderr,'Idle closure failed\n');
  }
});
