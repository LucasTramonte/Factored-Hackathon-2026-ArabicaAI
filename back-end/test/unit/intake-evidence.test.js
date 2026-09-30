/** Real storage and scorer checks: idle closure never converts unknown persistence into abandonment. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, readdir, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStore } from '../../src/store/d1.js';
import { tokenHash } from '../../src/auth/session.js';

const root = resolve(import.meta.dirname, '../../..');
const python = process.env.INTAKE_PYTHON ?? resolve(root, '.venv/bin/python');
const cli = name => resolve(root, 'back-end/scripts', name);
async function setup(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.exec("INSERT INTO customers VALUES('ana','Ana'),('bruno','Bruno'); INSERT INTO transactions VALUES('tx-ana','ana',NULL,'2026-06-17 12:00:00','Shop','10.00','ARS')");
  const store = createStore({ prepare: sql => ({ bind: (...p) => ({ all: () => ({ results: db.prepare(sql).all(...p) }) }) }),
    batch: async statements => { db.exec('BEGIN'); try { const result = statements.map(s => s.all()); db.exec('COMMIT'); return result; } catch(e) { db.exec('ROLLBACK'); throw e; } } });
  const start = async (now,expiresAt,customerId='ana') => (await store.startIntake({customerId,language:'es',statement:'No reconozco este cargo.',key:crypto.randomUUID(),now,expiresAt})).episode;
  return {db,store,start};
}
async function artifactDir(t) {
  const dir = resolve(root,'data/intake-events',crypto.randomUUID()); await mkdir(dir,{recursive:true}); t.after(()=>rm(dir,{recursive:true,force:true}));
  return dir;
}
const lines = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('idle_close_and_export_keep_pending_and_unknown_visible', async t => {
  const {db,store,start}=await setup(t); const now=Date.parse('2026-09-30T12:00:00.000Z');
  const idle=await start(now-600000,now+3600000), expired=await start(now-100,now), active=await start(now-599999,now+3600000), pending=await start(now-700000,now-1);
  db.prepare("UPDATE intake_episodes SET state='handoff_pending' WHERE episode_id=?").run(pending.episode_id);
  assert.equal(typeof store.closeIdleIntakes,'function','bounded idle closure is missing');
  assert.equal((await store.closeIdleIntakes({now,limit:1})).length,1);
  assert.equal((await store.closeIdleIntakes({now,limit:100})).length,1);
  assert.equal((await store.closeIdleIntakes({now,limit:100})).length,0);
  assert.equal((await store.findIntake('ana',active.episode_id)).state,'selection_required');
  assert.equal((await store.findIntake('ana',pending.episode_id)).state,'handoff_pending');
  const rows=await store.exportIntakeEvents({afterEpisode:'',limit:1}); assert.equal(rows.length,1);
  const all=[];let cursor=''; do {const page=await store.exportIntakeEvents({afterEpisode:cursor,limit:1});if(!page.length)break;all.push(...page);cursor=page.at(-1).episode_id;}while(true);
  assert.equal(all.length,4);assert.deepEqual(new Set(all.map(r=>r.episode_id)),new Set([idle,expired,active,pending].map(e=>e.episode_id)));
  const {exportIntakeEvents}=await import('../../scripts/export-intake-events.mjs');
  const dir=await artifactDir(t);
  const output=resolve(dir,'events.jsonl'); const result=await exportIntakeEvents(store,{output,python,limit:100});
  assert.equal(result.summary.all.eligible_started,4);assert.equal(result.summary.all.outcomes.abandoned,2);assert.equal(result.summary.all.outcomes.pending,2);assert.equal(result.summary.all.usage_unknown_episodes,2);
  assert.equal(result.complete,true); assert.equal(result.pages,1);
  const text=await readFile(output,'utf8');assert.ok(!text.includes('No reconozco'));assert.ok(!text.includes('"customer_id"'));
  const before=text; const row=db.prepare('SELECT event_json FROM intake_events WHERE episode_id=? AND seq=0').get(active.episode_id);
  db.prepare('UPDATE intake_events SET event_json=? WHERE episode_id=? AND seq=0').run(JSON.stringify({...JSON.parse(row.event_json),customer_id:'SECRET_ID'}),active.episode_id);
  await assert.rejects(exportIntakeEvents(store,{output,python}),/Export failed/);
  assert.equal(await readFile(output,'utf8'),before,'failed page cannot replace a validated artifact');assert.deepEqual(await readdir(dir),['events.jsonl']);
});

test('abandonment is recorded at the idle or session-expiry deadline, independent of sweep time', async t => {
  const {db,store,start} = await setup(t);
  const created = Date.parse('2026-09-30T12:00:00.123Z');
  const idle = await start(created, created + 3600000), expiring = await start(created, created + 240007);
  const sweep = created + 5 * 3600000;
  assert.equal((await store.closeIdleIntakes({now:sweep,limit:100})).length,2);
  const end = id => JSON.parse(db.prepare('SELECT event_json FROM intake_events WHERE episode_id=? AND seq=1').get(id).event_json);
  assert.equal(end(idle.episode_id).ts,'2026-09-30T12:10:00.123Z'); assert.equal(end(idle.episode_id).duration_ms,600000);
  assert.equal(end(expiring.episode_id).ts,'2026-09-30T12:04:00.130Z'); assert.equal(end(expiring.episode_id).duration_ms,240007);
  assert.equal(end(idle.episode_id).outcome,'abandoned'); assert.equal(end(idle.episode_id).safety,'not_assessed');
});

test('a real pending reservation is never abandoned and only a live same-owner session acknowledges it', async t => {
  const {db,store,start} = await setup(t);
  const now = Date.now();
  const episode = await start(now - 3600000, now - 3000000);
  const owner = await tokenHash('o'.repeat(64)), other = await tokenHash('b'.repeat(64));
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?),(?,?,?,?)').run(owner,'customer','ana',now + 3600000, other,'customer','bruno',now + 3600000);
  const reserved = await store.persistIntakeHandoff({ customerId:'ana', episodeId:episode.episode_id, turnKey:crypto.randomUUID(), payloadHash:'h',
    sessionHash:owner, completeCase:{transaction_id:'tx-ana'}, kind:'complete', evidence:{transaction:null,tool_status:'ok'}, actions:[], questions:[],
    usage:{tool_calls:0,operation_duration_ms:0}, now });
  assert.ok(reserved.handoff, 'reservation committed; read-back/acknowledgment then failed');
  for (const sweep of [now, now + 86400000]) assert.equal((await store.closeIdleIntakes({now:sweep,limit:100})).length,0);
  assert.equal((await store.findIntake('ana',episode.episode_id)).state,'handoff_pending');
  assert.equal(db.prepare('SELECT count(*) n FROM intake_events WHERE episode_id=?').get(episode.episode_id).n,1,'no end event without authority');
  const receipt = await store.readIntakeReceipt('ana',episode.episode_id,{sessionHash:owner,now});
  assert.equal(await store.finishIntakeHandoff({customerId:'ana',episode,receipt,sessionHash:other,now,operationDuration:0,toolCalls:0}),false);
  assert.equal(await store.finishIntakeHandoff({customerId:'ana',episode,receipt,sessionHash:await tokenHash('x'.repeat(64)),now,operationDuration:0,toolCalls:0}),false);
  assert.equal((await store.findIntake('ana',episode.episode_id)).state,'handoff_pending');
  assert.equal(await store.finishIntakeHandoff({customerId:'ana',episode,receipt,sessionHash:owner,now,operationDuration:0,toolCalls:0}),true);
  assert.equal((await store.findIntake('ana',episode.episode_id)).state,'complete_handoff');
  assert.equal((await store.closeIdleIntakes({now:now + 86400000,limit:100})).length,0);
});

test('export pages through every episode with complete ordered groups and fails closed at its page bound', async t => {
  const {db,store,start} = await setup(t);
  const now = Date.parse('2026-09-30T12:00:00.000Z');
  const episodes = []; for (let i = 0; i < 5; i++) episodes.push(await start(now, now + 3600000));
  await store.closeIdleIntakes({now:now + 3600000,limit:100});
  const {exportIntakeEvents} = await import('../../scripts/export-intake-events.mjs');
  const dir = await artifactDir(t); const output = resolve(dir,'events.jsonl');
  for (const [limit,maxPages,pages] of [[2,100,3],[1,100,6],[1,5,5],[5,1,1],[100,100,1]]) {
    const result = await exportIntakeEvents(store,{output,python,limit,maxPages});
    assert.equal(result.episodes,5); assert.equal(result.pages,pages); assert.equal(result.complete,true);
    assert.equal(result.summary.all.eligible_started,5); assert.equal(result.summary.all.outcomes.abandoned,5);
    const events = lines(await readFile(output,'utf8'));
    assert.equal(events.length,10);
    assert.deepEqual([...new Set(events.map(e=>e.case_id))],episodes.map(e=>e.episode_id).sort(),'episodes once each, in keyset order');
    for (let i = 0; i < events.length; i += 2) assert.deepEqual([events[i].seq,events[i+1].seq,events[i].case_id],[0,1,events[i+1].case_id]);
  }
  const before = await readFile(output,'utf8');
  for (const [limit,maxPages] of [[1,4],[2,2]]) {
    await assert.rejects(exportIntakeEvents(store,{output,python,limit,maxPages}),/^Error: Export failed$/);
    assert.equal(await readFile(output,'utf8'),before,'a partial population is never published'); assert.deepEqual(await readdir(dir),['events.jsonl']);
  }
  for (const bounds of [{maxPages:0},{maxPages:101},{maxPages:1.5},{limit:0},{limit:101},{limit:'5'}]) await assert.rejects(exportIntakeEvents(store,{output,python,...bounds}),/^Error: Export failed$/);
  assert.equal(await readFile(output,'utf8'),before); assert.deepEqual(await readdir(dir),['events.jsonl']);
  db.exec('DELETE FROM intake_events; DELETE FROM intake_turns; DELETE FROM intake_episodes');
  const empty = await exportIntakeEvents(store,{output,python});
  assert.equal(empty.episodes,0); assert.equal(empty.summary.all.eligible_started,0); assert.equal(await readFile(output,'utf8'),'');
});

test('export cursor accepts only lowercase RFC 4122 episode ids', async t => {
  const {store,start} = await setup(t);
  const episode = await start(Date.now(), Date.now() + 1000);
  assert.equal((await store.exportIntakeEvents({afterEpisode:''})).length,1);
  assert.equal((await store.exportIntakeEvents({afterEpisode:episode.episode_id})).length,0);
  for (const afterEpisode of ['-'.repeat(36),'0'.repeat(36),episode.episode_id.toUpperCase(),'ffffffff-ffff-ffff-ffff-ffffffffffff',
    '00000000-0000-0000-0000-000000000000',episode.episode_id+' ',' '+episode.episode_id.slice(1),'8'.repeat(8)+'-'+'8'.repeat(4)+'-4'+'8'.repeat(3)+'-c'+'8'.repeat(3)+'-'+'8'.repeat(12),null,7])
    assert.throws(()=>store.exportIntakeEvents({afterEpisode}),/Invalid export bounds/,String(afterEpisode));
});

test('export destination stays inside the ignored data/intake-events directory after symlinks', async t => {
  const {store,start} = await setup(t); await start(Date.now(), Date.now() + 1000);
  const {exportIntakeEvents} = await import('../../scripts/export-intake-events.mjs');
  const scratch = await mkdtemp(join(tmpdir(),'intake-export-boundary-')); t.after(()=>rm(scratch,{recursive:true,force:true}));
  const outside = join(scratch,'outside'); await mkdir(outside);
  const run = (dataDir, output) => exportIntakeEvents(store,{python,dataDir,output});
  const ok = join(scratch,'ok-data'); await mkdir(join(ok,'intake-events','nested'),{recursive:true});
  assert.equal((await run(ok,join(ok,'intake-events','nested','events.jsonl'))).episodes,1);
  const escapedBase = join(scratch,'escaped-base'); await mkdir(escapedBase); await symlink(outside,join(escapedBase,'intake-events'));
  const selfBase = join(scratch,'self-base'); await mkdir(selfBase); await symlink('.',join(selfBase,'intake-events'));
  const escapedNested = join(scratch,'escaped-nested'); await mkdir(join(escapedNested,'intake-events'),{recursive:true}); await symlink(outside,join(escapedNested,'intake-events','nested'));
  const intoRepo = join(scratch,'into-repo'); await mkdir(intoRepo); await symlink(resolve(root,'back-end/test/support'),join(intoRepo,'data'));
  for (const [dataDir,output] of [[escapedBase,join(escapedBase,'intake-events','events.jsonl')],[selfBase,join(selfBase,'intake-events','events.jsonl')],
    [escapedNested,join(escapedNested,'intake-events','nested','events.jsonl')],[join(intoRepo,'data'),join(intoRepo,'data','intake-events','events.jsonl')],
    [ok,join(ok,'events.jsonl')],[ok,join(ok,'intake-events','events.txt')],[ok,join(ok,'intake-events','missing','events.jsonl')],[ok,join(ok,'intake-events')]]) {
    await assert.rejects(run(dataDir,output),/^Error: Export failed$/,output);
  }
  assert.deepEqual(await readdir(outside),[],'nothing is written through an escaping link');
  assert.equal((await readdir(resolve(root,'back-end/test/support'))).includes('intake-events'),false,'nothing is created in a tracked directory');
  await assert.rejects(readdir(join(ok,'intake-events','missing')),/ENOENT/);
});

test('event export validates failures, acceptance, unknown usage and opaque references before publishing',async t=>{
  const {db,store,start}=await setup(t);const now=Date.parse('2026-09-30T12:00:00.000Z');
  const complete=await start(now-1000,now+10000),failed=await start(now-1000,now+10000);
  const base=e=>({version:'2',case_id:e.episode_id,ts:new Date(now).toISOString(),session_ref:e.session_ref,language:'es',model_version:'guided-0.1'});
  const end={event:'intake_ended',outcome:'accepted',safety:'assessed_safe',duration_ms:1000,llm_calls:0,input_tokens:0,output_tokens:0,known_input_tokens:0,known_output_tokens:0,usage_unavailable_calls:0,tool_calls:5};
  const ref=crypto.randomUUID();const insert=(e,seq,extra)=>db.prepare('INSERT INTO intake_events VALUES(?,?,?)').run(e.episode_id,seq,JSON.stringify({...base(e),seq,...extra}));
  insert(complete,1,{event:'transaction_confirmed',transaction_ref:crypto.randomUUID()});insert(complete,2,{event:'handoff_created',kind:'complete',case_ref:ref,tool_status:'ok'});insert(complete,3,{event:'handoff_accepted',case_ref:ref,accepted_by:'case_service'});insert(complete,4,end);
  insert(failed,1,{...end,outcome:'technical_failure',safety:'not_assessed',llm_calls:1,input_tokens:null,output_tokens:null,usage_unavailable_calls:1});
  const {exportIntakeEvents}=await import('../../scripts/export-intake-events.mjs');const dir=await artifactDir(t);
  const output=resolve(dir,'events.jsonl');const result=await exportIntakeEvents(store,{output,python});assert.equal(result.summary.all.safe_accepted,1);assert.equal(result.summary.all.outcomes.technical_failure,1);assert.equal(result.summary.all.input_tokens,null);
  assert.equal(result.summary.all.known_input_tokens,0); assert.equal(result.summary.all.usage_unavailable_calls,1); assert.equal(result.summary.all.usage_unknown_episodes,1);
  db.prepare('UPDATE intake_events SET event_json=json_set(event_json,\'$.session_ref\',?) WHERE episode_id=?').run('SECRET customer statement',complete.episode_id);
  await assert.rejects(exportIntakeEvents(store,{output,python}),/Export failed/);
});

test('operator CLIs print only their own generic line on failure, with third-party diagnostics silenced', () => {
  // Exact equality is deliberate: the CLIs silence Wrangler and Node warnings, so any extra stderr text is a regression.
  const missing = resolve(root,'back-end/missing-wrangler.jsonc');
  for (const [script,args,message] of [['export-intake-events.mjs',['--unknown'],'Export failed\n'],['export-intake-events.mjs',['--max-pages','0','--config',missing],'Export failed\n'],
    ['close-idle-intakes.mjs',['--unknown'],'Idle closure failed\n'],['close-idle-intakes.mjs',['--limit','101','--config',missing],'Idle closure failed\n']]) {
    const run = spawnSync(process.execPath,[cli(script),...args],{encoding:'utf8',timeout:60000});
    assert.equal(run.status,1,script); assert.equal(run.stdout,'',script); assert.equal(run.stderr,message,script);
  }
});

test('a CLI failure inside the real Wrangler D1 binding leaks neither SQL nor D1 error text', async t => {
  const scratch = await mkdtemp(join(tmpdir(),'intake-cli-quiet-')); t.after(()=>rm(scratch,{recursive:true,force:true}));
  // An empty local D1 (no migrations) makes the export query fail inside the real Wrangler/workerd binding.
  await writeFile(join(scratch,'wrangler.json'),JSON.stringify({name:'quiet-check',compatibility_date:'2026-09-28',
    d1_databases:[{binding:'DB',database_name:'quiet-check',database_id:'00000000-0000-4000-8000-000000000000'}]}));
  const dir = await artifactDir(t);
  const run = spawnSync(process.execPath,[cli('export-intake-events.mjs'),'--config',join(scratch,'wrangler.json'),'--output',join(dir,'events.jsonl'),'--python',python],{encoding:'utf8',timeout:120000});
  assert.equal(run.status,1); assert.equal(run.stdout,''); assert.equal(run.stderr,'Export failed\n');
  for (const leaked of ['intake_episodes','SQLITE','D1_ERROR','SELECT','WARNING','Proxy']) assert.ok(!(run.stdout+run.stderr).includes(leaked),leaked);
  assert.deepEqual(await readdir(dir),[],'no temporary or partial artifact remains');
});

test('idle closure updates only its selected page even when prior end rows exist', async t => {
  const {db,store,start} = await setup(t);
  const now = Date.parse('2026-09-30T12:00:00.000Z');
  const episodes = [await start(now-700000,now+1),await start(now-700000,now+1)];
  // A recovered/corrupt preexisting end must not let the UPDATE exceed the requested page.
  for (const e of episodes) db.prepare('INSERT INTO intake_events VALUES(?,?,?)').run(e.episode_id,1,JSON.stringify({outcome:'abandoned'}));
  assert.equal((await store.closeIdleIntakes({now,limit:1})).length,1);
  assert.equal(db.prepare("SELECT count(*) n FROM intake_episodes WHERE state='selection_required'").get().n,1);
});

test('housekeeping sweeps at one cutoff, one bounded atomic page at a time, and reports remaining work', async t => {
  const {store,start} = await setup(t);
  const now = Date.parse('2026-09-30T12:00:00.000Z');
  for (let i = 0; i < 5; i++) await start(now - 600000 - i, now + 3600000);
  const {closeIdleIntakes} = await import('../../scripts/close-idle-intakes.mjs');
  assert.deepEqual(Object.entries(await closeIdleIntakes(store,{now,limit:2})).filter(([k])=>k!=='metrics'),[['closed',2],['pages',1],['complete',false],['cutoff','2026-09-30T12:00:00.000Z']]);
  const rest = await closeIdleIntakes(store,{now,limit:2,maxPages:5});
  assert.equal(rest.closed,3); assert.equal(rest.pages,2); assert.equal(rest.complete,true);
  const noop = await closeIdleIntakes(store,{now,limit:2,maxPages:5});
  assert.equal(noop.closed,0); assert.equal(noop.pages,1); assert.equal(noop.complete,true);
  for (const maxPages of [0,101,1.5]) await assert.rejects(closeIdleIntakes(store,{now,maxPages}),/Invalid closure bounds/);
});

test('invalid, oversized or incomplete event pages never publish or leak scorer diagnostics', async t => {
  const {db,store,start} = await setup(t);
  const now = Date.parse('2026-09-30T12:00:00.000Z');
  const e = await start(now,now+1000);
  const original = db.prepare('SELECT event_json FROM intake_events WHERE episode_id=?').get(e.episode_id).event_json;
  const {exportIntakeEvents} = await import('../../scripts/export-intake-events.mjs');
  const dir = await artifactDir(t);
  const output = resolve(dir,'events.jsonl');
  await exportIntakeEvents(store,{output,python});
  const before = await readFile(output,'utf8');
  for (const value of [{...JSON.parse(original),seq:-1}, {...JSON.parse(original),scenario:'SECRET'.repeat(1000)}]) {
    db.prepare('UPDATE intake_events SET event_json=? WHERE episode_id=?').run(JSON.stringify(value),e.episode_id);
    await assert.rejects(exportIntakeEvents(store,{output,python}),/^Error: Export failed$/);
    assert.equal(await readFile(output,'utf8'),before);
    assert.deepEqual(await readdir(dir),['events.jsonl']);
  }
  db.prepare('UPDATE intake_events SET event_json=? WHERE episode_id=?').run(original,e.episode_id);
  // Existing scorer remains the authority for sequence validity and usage; its failure is captured.
  await assert.rejects(exportIntakeEvents(store,{output,python:process.execPath}),/^Error: Export failed$/);
  for(let seq=1;seq<=101;seq++) db.prepare('INSERT INTO intake_events VALUES(?,?,?)').run(e.episode_id,seq,original);
  await assert.rejects(exportIntakeEvents(store,{output,python}),/^Error: Export failed$/);
  assert.equal(await readFile(output,'utf8'),before);
  assert.deepEqual(await readdir(dir),['events.jsonl']);
  for (const bounds of [{limit:0},{limit:101},{afterEpisode:'secret statement'}]) assert.throws(()=>store.exportIntakeEvents(bounds));
  for (const bounds of [{now:-1},{now,limit:101},{now:NaN}]) await assert.rejects(store.closeIdleIntakes(bounds));
});
