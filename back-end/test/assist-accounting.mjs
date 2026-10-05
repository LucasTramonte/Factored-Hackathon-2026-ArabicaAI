/** Isolated native D1 fixture before assist routes exist; tests actual store SQL/metadata with existing Wrangler binding bridge. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { createStore } from '../src/store/d1.js';
const ceilings={reserve:{queries:2,rowsRead:205,rowsWritten:5,roundTrips:1},duplicate:{queries:2,rowsRead:4,rowsWritten:0,roundTrips:1},limited:{queries:2,rowsRead:202,rowsWritten:0,roundTrips:1},finish:{queries:1,rowsRead:2,rowsWritten:1,roundTrips:1},'empty sweep':{queries:2,rowsRead:7,rowsWritten:0,roundTrips:1},'cleanup 100':{queries:2,rowsRead:703,rowsWritten:100,roundTrips:1},'delete 100':{queries:2,rowsRead:504,rowsWritten:100,roundTrips:1}};
function budget(label,s){const actual=s.metrics();console.log('assist '+label,JSON.stringify(actual));for(const [k,n] of Object.entries(ceilings[label]))assert.ok(actual[k]<=n,`${label} ${k}: ${actual[k]} > ${n}`);}
const now=Date.UTC(2026,9,4,12), day=86400000;
const reservation=(extra={})=>({requestId:crypto.randomUUID(),sessionHash:'a'.repeat(64),mode:'reviewer',protocol:crypto.randomUUID(),now,...extra});
async function setup(t){
 const temp=await mkdtemp(join(tmpdir(),'assist-d1-'));const configPath=join(temp,'wrangler.json');
 await writeFile(configPath,JSON.stringify({name:'assist-fixture',compatibility_date:'2026-10-01',d1_databases:[{binding:'DB',database_name:'assist-fixture',database_id:'00000000-0000-4000-8000-000000000000'}]}));
 const proxy=await getPlatformProxy({configPath,envFiles:[],persist:false});t.after(async()=>{await proxy.dispose();await rm(temp,{recursive:true,force:true});});const db=proxy.env.DB;
 const sql=await readFile(new URL('../migrations/0030_support_assist_runs.sql',import.meta.url),'utf8');await db.batch(sql.replace(/^--.*$/gm,'').split(';').filter(x=>x.trim()).map(x=>db.prepare(x)));return {db,store:()=>createStore(db)};
}
test('atomic session/feature rolling-minute boundary; UUID duplicate cannot claim twice; failed slots remain',async t=>{
 const {db,store}=await setup(t);const args=reservation();const same=await Promise.all(Array.from({length:10},()=>store().reserveAssist(args)));assert.equal(same.filter(x=>x==='reserved').length,1);assert.equal(same.filter(x=>x==='duplicate').length,9);
 const burst=await Promise.all(Array.from({length:12},()=>store().reserveAssist(reservation())));assert.equal(burst.filter(x=>x==='reserved').length,4);assert.equal(burst.filter(x=>x==='limited').length,8);
 await store().finishAssist({requestId:args.requestId,outcome:'provider_error',latencyMs:100,usage:{llm_calls:1,known_input_tokens:0,known_output_tokens:0,usage_unavailable_calls:1},version:'test-v1'});
 assert.equal(await store().reserveAssist(reservation({now:now+59999})),'limited');assert.equal(await store().reserveAssist(reservation({now:now+60000})),'reserved');
 assert.equal(await store().reserveAssist(reservation({mode:'customer'})),'reserved');
 const row=await db.prepare('SELECT * FROM support_assist_runs WHERE request_id=?').bind(args.requestId).first();assert.equal(row.outcome,'provider_error');assert.equal(row.usage_unavailable_calls,1);assert.equal(Object.keys(row).some(k=>/body|draft|question|identity|statement/.test(k)),false);
});
test('shared daily exact cap across sessions/features, retained failures/abandonment, next UTC day resets',async t=>{
 const {store}=await setup(t);const results=await Promise.all(Array.from({length:215},(_,i)=>store().reserveAssist(reservation({sessionHash:i.toString(16).padStart(64,'0'),mode:i%2?'reviewer':'customer'}))));assert.equal(results.filter(x=>x==='reserved').length,200);assert.equal(results.filter(x=>x==='limited').length,15);
 const sweep=store();await sweep.sweepAssistRuns({now:now+600001});assert.equal(await store().reserveAssist(reservation({sessionHash:'f'.repeat(64),now:now+600001})),'limited');assert.equal(await store().reserveAssist(reservation({now:Date.UTC(2026,9,5)})),'reserved');
});
test('bounded indexed cleanup abandons at most 100; deletes at most 100 after seven days, finish cannot resurrect',async t=>{
 const {db,store}=await setup(t);const rows=Array.from({length:101},(_,i)=>reservation({sessionHash:i.toString(16).padStart(64,'0')}));for(const r of rows)assert.equal(await store().reserveAssist(r),'reserved');
 assert.deepEqual(await store().sweepAssistRuns({now:now+600000}),{abandoned:0,deleted:0});const s=store();assert.deepEqual(await s.sweepAssistRuns({now:now+600001}),{abandoned:100,deleted:0});budget('cleanup 100',s);
 await store().finishAssist({requestId:rows[0].requestId,outcome:'success',latencyMs:1,usage:{llm_calls:1,known_input_tokens:1,known_output_tokens:1,usage_unavailable_calls:0},version:'v1'});assert.equal((await db.prepare('SELECT outcome FROM support_assist_runs WHERE request_id=?').bind(rows[0].requestId).first()).outcome,'abandoned');
 assert.deepEqual(await store().sweepAssistRuns({now:now+7*day}),{abandoned:1,deleted:0});const expired=store();assert.deepEqual(await expired.sweepAssistRuns({now:now+7*day+1}),{abandoned:0,deleted:100});budget('delete 100',expired);assert.equal((await db.prepare('SELECT COUNT(*) n FROM support_assist_runs').first()).n,1);
});
test('native D1 measured fixture ceilings with 199 current-day attempts, duplicate, limited, finish and empty sweep',async t=>{
 const {store}=await setup(t);for(let i=0;i<199;i++)await store().reserveAssist(reservation({sessionHash:i.toString(16).padStart(64,'0')}));const args=reservation({sessionHash:'f'.repeat(64)});
 for(const [label,work] of [['reserve',s=>s.reserveAssist(args)],['duplicate',s=>s.reserveAssist(args)],['limited',s=>s.reserveAssist(reservation({sessionHash:'e'.repeat(64)}))],['finish',s=>s.finishAssist({requestId:args.requestId,outcome:'success',latencyMs:1,usage:{llm_calls:1,known_input_tokens:20,known_output_tokens:10,usage_unavailable_calls:0},version:'v1'})],['empty sweep',s=>s.sweepAssistRuns({now})]]){const s=store();await work(s);budget(label,s);}
});
