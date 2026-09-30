/** Manual bounded housekeeping; no scheduler and no customer-authority bypass. */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { withIntakeStore } from './intake-store.mjs';

/** Close one bounded local page; repeated sweeps cannot duplicate end events. */
export async function closeIdleIntakes(store, { now = Date.now(), limit = 100 } = {}) {
  return { closed: (await store.closeIdleIntakes({ now, limit })).length, cutoff: new Date(now).toISOString(), metrics: store.metrics() };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { remote: { type: 'boolean', default: false }, config: { type: 'string' }, now: { type: 'string' }, limit: { type: 'string' } } });
    const result = await withIntakeStore(values, store => closeIdleIntakes(store, { now: values.now === undefined ? Date.now() : Number(values.now), limit: values.limit === undefined ? 100 : Number(values.limit) }));
    console.log(JSON.stringify(result));
  } catch { console.error('Idle closure failed'); process.exitCode = 1; }
}
