/** Real storage and scorer checks: idle closure never converts unknown persistence into abandonment. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createStore } from '../../src/store/d1.js';

const root = resolve(import.meta.dirname, '../../..');
const python = process.env.INTAKE_PYTHON ?? resolve(root, '.venv/bin/python');
async function setup(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.exec("INSERT INTO customers VALUES('ana','Ana')");
  const store = createStore({ prepare: sql => ({ bind: (...p) => ({ all: () => ({ results: db.prepare(sql).all(...p) }) }) }),
    batch: async statements => { db.exec('BEGIN'); try { const result = statements.map(s => s.all()); db.exec('COMMIT'); return result; } catch(e) { db.exec('ROLLBACK'); throw e; } } });
  const start = async (now,expiresAt) => (await store.startIntake({customerId:'ana',language:'es',statement:'No reconozco este cargo.',key:crypto.randomUUID(),now,expiresAt})).episode;
  return {db,store,start};
}

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
  const dir=resolve(root,'data/intake-events',crypto.randomUUID());await mkdir(dir,{recursive:true});t.after(()=>rm(dir,{recursive:true,force:true}));
  const output=resolve(dir,'events.jsonl'); const result=await exportIntakeEvents(store,{output,python,limit:100});
  assert.equal(result.summary.all.eligible_started,4);assert.equal(result.summary.all.outcomes.abandoned,2);assert.equal(result.summary.all.outcomes.pending,2);assert.equal(result.summary.all.usage_unknown_episodes,2);
  const text=await readFile(output,'utf8');assert.ok(!text.includes('No reconozco'));assert.ok(!text.includes('"customer_id"'));
  const before=text; const row=db.prepare('SELECT event_json FROM intake_events WHERE episode_id=? AND seq=0').get(active.episode_id);
  db.prepare('UPDATE intake_events SET event_json=? WHERE episode_id=? AND seq=0').run(JSON.stringify({...JSON.parse(row.event_json),customer_id:'SECRET_ID'}),active.episode_id);
  await assert.rejects(exportIntakeEvents(store,{output,python}),/Export failed/);
  assert.equal(await readFile(output,'utf8'),before,'failed page cannot replace a validated artifact');assert.deepEqual(await readdir(dir),['events.jsonl']);
});

test('event export validates failures, acceptance, unknown usage and opaque references before publishing',async t=>{
  const {db,store,start}=await setup(t);const now=Date.parse('2026-09-30T12:00:00.000Z');
  const complete=await start(now-1000,now+10000),failed=await start(now-1000,now+10000);
  const base=e=>({version:'2',case_id:e.episode_id,ts:new Date(now).toISOString(),session_ref:e.session_ref,language:'es',model_version:'guided-0.1'});
  const end={event:'intake_ended',outcome:'accepted',safety:'assessed_safe',duration_ms:1000,llm_calls:0,input_tokens:0,output_tokens:0,known_input_tokens:0,known_output_tokens:0,usage_unavailable_calls:0,tool_calls:5};
  const ref=crypto.randomUUID();const insert=(e,seq,extra)=>db.prepare('INSERT INTO intake_events VALUES(?,?,?)').run(e.episode_id,seq,JSON.stringify({...base(e),seq,...extra}));
  insert(complete,1,{event:'transaction_confirmed',transaction_ref:crypto.randomUUID()});insert(complete,2,{event:'handoff_created',kind:'complete',case_ref:ref,tool_status:'ok'});insert(complete,3,{event:'handoff_accepted',case_ref:ref,accepted_by:'case_service'});insert(complete,4,end);
  insert(failed,1,{...end,outcome:'technical_failure',safety:'not_assessed',llm_calls:1,input_tokens:null,output_tokens:null,usage_unavailable_calls:1});
  const {exportIntakeEvents}=await import('../../scripts/export-intake-events.mjs');const dir=resolve(root,'data/intake-events',crypto.randomUUID());await mkdir(dir,{recursive:true});t.after(()=>rm(dir,{recursive:true,force:true}));
  const output=resolve(dir,'events.jsonl');const result=await exportIntakeEvents(store,{output,python});assert.equal(result.summary.all.safe_accepted,1);assert.equal(result.summary.all.outcomes.technical_failure,1);assert.equal(result.summary.all.input_tokens,null);
  db.prepare('UPDATE intake_events SET event_json=json_set(event_json,\'$.session_ref\',?) WHERE episode_id=?').run('SECRET customer statement',complete.episode_id);
  await assert.rejects(exportIntakeEvents(store,{output,python}),/Export failed/);
  const cli=spawnSync(process.execPath,[resolve(root,'back-end/scripts/export-intake-events.mjs'),'--output',output,'--unknown'],{encoding:'utf8'});assert.equal(cli.status,1);assert.equal(cli.stdout,'');assert.equal(cli.stderr,'Export failed\n');
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

test('invalid, oversized or incomplete event pages never publish or leak scorer diagnostics', async t => {
  const {db,store,start} = await setup(t);
  const now = Date.parse('2026-09-30T12:00:00.000Z');
  const e = await start(now,now+1000);
  const original = db.prepare('SELECT event_json FROM intake_events WHERE episode_id=?').get(e.episode_id).event_json;
  const {exportIntakeEvents} = await import('../../scripts/export-intake-events.mjs');
  const dir = resolve(root,'data/intake-events',crypto.randomUUID());
  await mkdir(dir,{recursive:true});t.after(()=>rm(dir,{recursive:true,force:true}));
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
