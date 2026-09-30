/** Export one complete episode page, validate with the existing scorer, then atomically publish under ignored data. */
import { mkdir, realpath, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { withIntakeStore } from './intake-store.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const BASE = ['event','version','case_id','ts','seq','session_ref','language','model_version'];
const FIELDS = {
  intake_started: ['scenario'], clarification_requested: ['missing'], transaction_confirmed: ['transaction_ref'],
  handoff_created: ['kind','case_ref','tool_status'], handoff_accepted: ['case_ref','accepted_by'],
  intake_ended: ['outcome','safety','duration_ms','llm_calls','input_tokens','output_tokens','tool_calls','known_input_tokens','known_output_tokens','usage_unavailable_calls']
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reject injection instead of silently cleaning; scorer owns value/sequence/usage validation. */
function checkedEvent(event, episodeId) {
  const extra = FIELDS[event?.event];
  if (!extra || event.version !== '2' || event.case_id !== episodeId || Object.keys(event).some(k => ![...BASE,...extra].includes(k))) throw new Error('Invalid event');
  for (const key of ['case_id','session_ref','transaction_ref','case_ref']) if (key in event && !UUID.test(event[key])) throw new Error('Invalid reference');
  if (event.model_version !== 'guided-0.1' || ('accepted_by' in event && event.accepted_by !== 'case_service')) throw new Error('Unreviewed producer');
  return Object.fromEntries([...BASE,...extra].filter(k => k in event).map(k => [k,event[k]]));
}

/** Bounded at 100 episodes × 101 events × 4096 chars; a failed page leaves the previous validated artifact intact. */
export async function exportIntakeEvents(store, { afterEpisode = '', limit = 100,
  output = resolve(ROOT, 'data/intake-events/events.jsonl'), python = process.env.INTAKE_PYTHON ?? resolve(ROOT, '.venv/bin/python') } = {}) {
  let temporary;
  try {
    const base = resolve(ROOT,'data/intake-events');
    const destination = resolve(output); const path = relative(base,destination);
    if (!path || path.startsWith('..') || isAbsolute(path) || !path.endsWith('.jsonl')) throw new Error('Invalid destination');
    await mkdir(dirname(destination),{recursive:true});
    const actualBase = await realpath(base); const actualParent = await realpath(dirname(destination));
    const parentPath = relative(actualBase,actualParent); if (parentPath.startsWith('..') || isAbsolute(parentPath)) throw new Error('Invalid destination');
    const page = await store.exportIntakeEvents({ afterEpisode, limit });
    const events = page.flatMap(row => {
      const group = JSON.parse(row.events_json);
      if (!Array.isArray(group) || !group.length || group.length > 101) throw new Error('Invalid group');
      return group.map(event => checkedEvent(event,row.episode_id));
    });
    temporary = destination + '.' + crypto.randomUUID() + '.tmp';
    await writeFile(temporary,events.map(event => JSON.stringify(event)+'\n').join(''),{flag:'wx',mode:0o600});
    const summary = JSON.parse(execFileSync(python,['-m','evals.intake.episodes',temporary],{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:100000}));
    await rename(temporary,destination);temporary=undefined;
    return { episodes: page.length, after_episode: page.at(-1)?.episode_id ?? afterEpisode,
      page_full: page.length === limit, summary, metrics: store.metrics() };
  } catch { throw new Error('Export failed'); }
  finally { if (temporary) await rm(temporary,{force:true}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { remote: {type:'boolean',default:false}, config:{type:'string'}, output:{type:'string'}, python:{type:'string'}, 'after-episode':{type:'string'}, limit:{type:'string'} } });
    const result = await withIntakeStore(values,store=>exportIntakeEvents(store,{output:values.output,python:values.python,afterEpisode:values['after-episode'],limit:values.limit===undefined?100:Number(values.limit)}));
    console.log(JSON.stringify(result));
  } catch { console.error('Export failed'); process.exitCode=1; }
}
