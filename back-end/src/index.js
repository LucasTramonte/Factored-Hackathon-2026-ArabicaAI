/**
 * Worker entry point for the intake demo API. D1 holds customers, charges, cases and sessions.
 * Any unexpected error becomes a generic 503 with no internal detail. Every request writes one ``request`` log line,
 * and an unexpected error one ``unhandled_error`` line with its class only (``log.js``; never a message or the path).
 */
import { fail } from './http.js';
import { logEvent } from './log.js';
import { route, routeLabel } from './router.js';
import { createStore } from './store/d1.js';

/** Attach per-request D1 counters, only where ``DEMO_EXPOSE_DB_METRICS`` is ``"1"`` (local tests). */
export function withMetrics(response, env, store) {
  if (env.DEMO_EXPOSE_DB_METRICS !== '1') return response;
  const { queries, rowsRead, rowsWritten, roundTrips } = store.metrics();
  const headers = new Headers(response.headers);
  headers.set('X-D1-Metrics', `queries=${queries};rows_read=${rowsRead};rows_written=${rowsWritten};round_trips=${roundTrips}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();
    const store = createStore(env.DB);
    const label = routeLabel(new URL(request.url).pathname);
    const ray = request.headers.get('cf-ray');
    let response;
    try {
      response = await route(request, env, store, ctx);
    } catch (error) {
      logEvent('unhandled_error', { route: label, method: request.method, error: error?.name ?? typeof error, ray });
      response = fail(503, 'Demo service unavailable; retry later');
    }
    const { queries, rowsRead, rowsWritten } = store.metrics();
    logEvent('request', { route: label, method: request.method, status: response.status, ms: Date.now() - started, ray,
      d1_queries: queries, d1_rows_read: rowsRead, d1_rows_written: rowsWritten });
    return withMetrics(response, env, store);
  }
};
