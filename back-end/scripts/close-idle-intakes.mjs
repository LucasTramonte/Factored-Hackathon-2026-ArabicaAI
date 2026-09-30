/** Manual bounded housekeeping for guided intake episodes; no scheduler and no customer-authority bypass. */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { IDLE_CUTOFF_SKEW_MS } from '../src/store/d1.js';
import { quietThirdPartyDiagnostics, withIntakeStore } from './intake-store.mjs';

export const MAX_SWEEP_PAGES = 100;

/**
 * Strict CLI options: decimal integers only (no empty, signed, fractional or exponent forms), and a ``--now``
 * cutoff no more than IDLE_CUTOFF_SKEW_MS past ``clock``. Throws before any store is opened.
 */
export function sweepOptions(values, clock = Date.now()) {
  const integer = (value, fallback) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid closure bounds');
    return Number(value);
  };
  const options = { now: integer(values.now, clock), limit: integer(values.limit, 100), maxPages: integer(values['max-pages'], 1) };
  if (options.now > clock + IDLE_CUTOFF_SKEW_MS || options.limit < 1 || options.limit > 100 || options.maxPages < 1 || options.maxPages > MAX_SWEEP_PAGES) throw new Error('Invalid closure bounds');
  return options;
}

/**
 * Close due unreserved starts at one fixed cutoff, one atomic page of at most ``limit`` (<=100) at a time, for at
 * most ``maxPages`` pages. ``complete`` comes from a final probe: false while any unreserved start is still due at
 * the cutoff. Repeated sweeps cannot duplicate end events, and reserved (pending) episodes are never closed.
 * ``maxNow`` overrides the store's clock-skew guard for fake-clock tests.
 */
export async function closeIdleIntakes(store, { now = Date.now(), limit = 100, maxPages = 1, maxNow } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_SWEEP_PAGES) throw new Error('Invalid closure bounds');
  let closed = 0;
  let pages = 0;
  while (pages < maxPages) {
    const page = await store.closeIdleIntakes({ now, limit, maxNow });
    pages += 1;
    closed += page.length;
    if (page.length < limit) break;
  }
  const remaining = await store.hasDueIdleIntakes({ now });
  return { closed, pages, complete: !remaining, cutoff: new Date(now).toISOString(), metrics: store.metrics() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  quietThirdPartyDiagnostics();
  try {
    const { values } = parseArgs({ options: { remote: { type: 'boolean', default: false }, config: { type: 'string' },
      now: { type: 'string' }, limit: { type: 'string' }, 'max-pages': { type: 'string' } } });
    const options = sweepOptions(values);
    const result = await withIntakeStore(values, store => closeIdleIntakes(store, options));
    console.log(JSON.stringify(result));
  } catch {
    console.error('Idle closure failed');
    process.exitCode = 1;
  }
}
