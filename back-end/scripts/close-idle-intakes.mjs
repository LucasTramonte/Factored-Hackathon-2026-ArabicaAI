/** Manual bounded housekeeping for guided intake episodes; no scheduler and no customer-authority bypass. */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { quietThirdPartyDiagnostics, withIntakeStore } from './intake-store.mjs';

export const MAX_SWEEP_PAGES = 100;

/**
 * Close due unreserved starts at one fixed cutoff, one atomic page of at most ``limit`` (<=100) at a time, for at
 * most ``maxPages`` pages. ``complete`` is false when the last page was full, so more due episodes may remain.
 * Repeated sweeps cannot duplicate end events, and reserved (pending) episodes are never closed.
 */
export async function closeIdleIntakes(store, { now = Date.now(), limit = 100, maxPages = 1 } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_SWEEP_PAGES) throw new Error('Invalid closure bounds');
  let closed = 0;
  let pages = 0;
  let full = true;
  while (full && pages < maxPages) {
    const page = await store.closeIdleIntakes({ now, limit });
    pages += 1;
    closed += page.length;
    full = page.length === limit;
  }
  return { closed, pages, complete: !full, cutoff: new Date(now).toISOString(), metrics: store.metrics() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  quietThirdPartyDiagnostics();
  try {
    const { values } = parseArgs({ options: { remote: { type: 'boolean', default: false }, config: { type: 'string' },
      now: { type: 'string' }, limit: { type: 'string' }, 'max-pages': { type: 'string' } } });
    const number = (value, fallback) => value === undefined ? fallback : Number(value);
    const result = await withIntakeStore(values, store => closeIdleIntakes(store, { now: number(values.now, Date.now()),
      limit: number(values.limit, 100), maxPages: number(values['max-pages'], 1) }));
    console.log(JSON.stringify(result));
  } catch {
    console.error('Idle closure failed');
    process.exitCode = 1;
  }
}
