/**
 * Worker entry point for the intake demo API. D1 holds customers, charges, cases and sessions.
 * Any unexpected error becomes a generic 503 with no internal detail.
 */
import { fail } from './http.js';
import { route } from './router.js';
import { createStore } from './store/d1.js';

/** Attach per-request D1 counters, only where ``DEMO_EXPOSE_DB_METRICS`` is ``"1"`` (local tests). */
export function withMetrics(response, env, store) {
  if (env.DEMO_EXPOSE_DB_METRICS !== '1') return response;
  const { queries, rowsRead, rowsWritten } = store.metrics();
  const headers = new Headers(response.headers);
  headers.set('X-D1-Metrics', `queries=${queries};rows_read=${rowsRead};rows_written=${rowsWritten}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const store = createStore(env.DB);
    try {
      return withMetrics(await route(request, env, store), env, store);
    } catch {
      return fail(503, 'Demo service unavailable; retry later');
    }
  }
};
