/**
 * Print the dispute managers' KPIs (store ``intakeKpis``; definitions in Docs/intake/intake-events.md) for one window as
 * JSON. Read-only: one batch of reads, no write. Local D1 by default; ``--remote`` reads the deployed database and is run
 * only by a person. The output holds aggregates only, never a customer or transaction identifier or statement.
 *
 *   node scripts/intake-kpis.mjs [--since 2026-10-01] [--until 2026-10-08T00:00:00Z] [--remote] [--config path]
 *
 * ``--until`` defaults to now and ``--since`` to seven days before it; both are UTC (a date alone is its midnight).
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { quietThirdPartyDiagnostics, withIntakeStore } from './intake-store.mjs';

const DAY_MS = 24 * 3600 * 1000;
const UTC = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z)?$/;

/** The window in epoch ms from strict UTC options; throws before any store is opened. */
export function kpiWindow(values, clock = Date.now()) {
  const instant = (value, fallback) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !UTC.test(value)) throw new Error('Invalid KPI window');
    const ms = Date.parse(value.length === 10 ? value + 'T00:00:00Z' : value);
    // Date.parse rolls 2026-02-30 over to March; a date that doesn't round-trip is refused.
    if (!Number.isSafeInteger(ms) || new Date(ms).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error('Invalid KPI window');
    return ms;
  };
  const untilMs = instant(values.until, clock);
  const sinceMs = instant(values.since, untilMs - 7 * DAY_MS);
  if (sinceMs < 0 || untilMs <= sinceMs) throw new Error('Invalid KPI window');
  return { sinceMs, untilMs };
}

/** The KPIs for ``window`` and the store's D1 counters for the call. */
export async function intakeKpis(store, window) {
  const kpis = await store.intakeKpis(window);
  return { ...kpis, metrics: store.metrics() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  quietThirdPartyDiagnostics();
  try {
    const { values } = parseArgs({ options: { remote: { type: 'boolean', default: false }, config: { type: 'string' },
      since: { type: 'string' }, until: { type: 'string' } } });
    const window = kpiWindow(values);
    console.log(JSON.stringify(await withIntakeStore(values, store => intakeKpis(store, window)), null, 2));
  } catch {
    console.error('KPI read failed');
    process.exitCode = 1;
  }
}
