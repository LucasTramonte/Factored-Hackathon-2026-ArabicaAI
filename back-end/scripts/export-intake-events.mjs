/**
 * Export every intake episode as strict v2 JSONL, validate it with the existing scorer, then atomically publish
 * it under the ignored data/intake-events directory. A failed run leaves the previous validated artifact intact.
 */
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { quietThirdPartyDiagnostics, withIntakeStore } from './intake-store.mjs';
import { scorerPython } from './scorer-python.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
export const MAX_EXPORT_PAGES = 100;
const BASE = ['event','version','case_id','ts','seq','session_ref','language','model_version'];
// Fields the reviewed guided-0.1 producer writes. It never writes ``scenario`` (an evaluation-run label), so an
// injected one fails the export instead of reaching analytics.
const FIELDS = {
  intake_started: [], clarification_requested: ['missing'], transaction_confirmed: ['transaction_ref'],
  handoff_created: ['kind','case_ref','tool_status'], handoff_accepted: ['case_ref','accepted_by'],
  intake_ended: ['outcome','safety','duration_ms','llm_calls','input_tokens','output_tokens','tool_calls','known_input_tokens','known_output_tokens','usage_unavailable_calls']
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reject injection instead of silently cleaning; the scorer owns value, sequence and usage validation. */
function checkedEvent(event, episodeId) {
  const extra = FIELDS[event?.event];
  if (!extra || event.version !== '2' || event.case_id !== episodeId || Object.keys(event).some(k => ![...BASE,...extra].includes(k))) throw new Error('Invalid event');
  for (const key of ['case_id','session_ref','transaction_ref','case_ref']) if (key in event && !UUID.test(event[key])) throw new Error('Invalid reference');
  if (event.model_version !== 'guided-0.1' || ('accepted_by' in event && event.accepted_by !== 'case_service')) throw new Error('Unreviewed producer');
  return Object.fromEntries([...BASE,...extra].filter(k => k in event).map(k => [k,event[k]]));
}

const inside = (parent, child) => { const path = relative(parent, child); return !path.startsWith('..') && !isAbsolute(path); };

/**
 * Resolve an output path that stays in the repository's ignored ``data/intake-events`` after symlinks. ``data``
 * may itself be a link to local storage outside the repository, but never into another repository path, never to
 * the repository or one of its ancestors, and the resolved parent directory may be inside the repository only
 * under its ``data``. The base must stay inside ``data``; nested directories must already exist inside the base
 * (nothing is created through a link that escapes it).
 */
async function checkedDestination(output, dataDir, repository) {
  const base = resolve(dataDir, 'intake-events');
  const destination = resolve(output);
  const path = relative(base, destination);
  if (!path || path.startsWith('..') || isAbsolute(path) || !path.endsWith('.jsonl')) throw new Error('Invalid destination');
  await mkdir(dataDir, { recursive: true });
  const [root, data] = await Promise.all([realpath(repository), realpath(dataDir)]);
  const repoData = join(root, 'data');
  if (inside(data, root) || (inside(root, data) && data !== repoData)) throw new Error('Invalid destination');
  await mkdir(base).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const actualBase = await realpath(base);
  if (actualBase === data || !inside(data, actualBase)) throw new Error('Invalid destination');
  const parent = await realpath(dirname(destination));
  if (!inside(actualBase, parent) || (inside(root, parent) && !inside(repoData, parent))) throw new Error('Invalid destination');
  return join(parent, basename(destination));
}

/**
 * Export all episodes in keyset pages of ``limit`` (<=100) for at most ``maxPages`` pages, then score and publish
 * one artifact. Memory holds one page (<=100 episodes x 101 events x 4096 chars) plus the scorer's O(events) pass
 * over the file. Reaching the page bound before the last episode fails the run: a partial population is never
 * published. Each page is one statement, so every episode group is internally consistent as of its page read;
 * ``started_at`` labels when the run began and is not a data bound. Failures throw ``Error('Export failed')``
 * with the internal reason as ``cause`` for in-process callers; the CLI never prints it. ``repository`` and
 * ``dataDir`` are test seams for the destination boundary.
 */
export async function exportIntakeEvents(store, { limit = 100, maxPages = MAX_EXPORT_PAGES,
  output = resolve(ROOT, 'data/intake-events/events.jsonl'), dataDir = resolve(ROOT, 'data'), repository = ROOT,
  python = scorerPython() } = {}) {
  let temporary;
  let file;
  try {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_EXPORT_PAGES) throw new Error('Invalid bounds');
    const startedAt = new Date().toISOString();
    const destination = await checkedDestination(output, dataDir, repository);
    temporary = destination + '.' + crypto.randomUUID() + '.tmp';
    file = await open(temporary, 'wx', 0o600);
    let cursor = '';
    let episodes = 0;
    let pages = 0;
    for (;;) {
      if (pages === maxPages) {
        if ((await store.exportIntakeEvents({ afterEpisode: cursor, limit: 1 })).length) throw new Error('Page bound reached');
        break;
      }
      const page = await store.exportIntakeEvents({ afterEpisode: cursor, limit });
      pages += 1;
      const lines = page.flatMap(row => {
        const group = JSON.parse(row.events_json);
        if (!Array.isArray(group) || !group.length || group.length > 101) throw new Error('Invalid group');
        return group.map(event => JSON.stringify(checkedEvent(event, row.episode_id)) + '\n');
      });
      if (lines.length) await file.writeFile(lines.join(''));
      episodes += page.length;
      if (page.length < limit) break;
      cursor = page.at(-1).episode_id;
    }
    await file.sync();
    await file.close();
    file = undefined;
    const summary = JSON.parse(execFileSync(python, ['-m','evals.intake.episodes',temporary], { cwd: ROOT, encoding: 'utf8',
      stdio: ['ignore','pipe','pipe'], timeout: 30000, maxBuffer: 100000 }));
    await rename(temporary, destination);
    temporary = undefined;
    return { episodes, pages, complete: true, started_at: startedAt, summary, metrics: store.metrics() };
  } catch (cause) {
    throw new Error('Export failed', { cause });
  } finally {
    await file?.close().catch(() => {});
    if (temporary) await rm(temporary, { force: true });
  }
}

/** Strict CLI options (decimal integers in range only), validated before any store is opened. */
export function exportOptions(values) {
  const integer = (value, fallback, max) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > max) throw new Error('Invalid bounds');
    return Number(value);
  };
  return { output: values.output, python: values.python, limit: integer(values.limit, 100, 100),
    maxPages: integer(values['max-pages'], MAX_EXPORT_PAGES, MAX_EXPORT_PAGES) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  quietThirdPartyDiagnostics();
  try {
    const { values } = parseArgs({ options: { remote: { type: 'boolean', default: false }, config: { type: 'string' },
      output: { type: 'string' }, python: { type: 'string' }, limit: { type: 'string' }, 'max-pages': { type: 'string' } } });
    const options = exportOptions(values);
    const result = await withIntakeStore(values, store => exportIntakeEvents(store, options));
    console.log(JSON.stringify(result));
  } catch {
    console.error('Export failed');
    process.exitCode = 1;
  }
}
