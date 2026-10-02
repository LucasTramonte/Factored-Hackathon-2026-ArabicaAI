/**
 * Exact route table. The access gate runs before method checks, so an unauthenticated caller
 * learns nothing about which methods exist. Unknown paths under API prefixes return JSON 404 and
 * are never served as the single-page app.
 */
import { checkAccessGate } from './auth/access-gate.js';
import { fail, json } from './http.js';
import { createCase, listIdentities, listTransactions, logout, startCustomerSession } from './modules/customer/routes.js';
import { startIntake, confirmIntake, handoffIntake } from './modules/intake/routes.js';
import { listAgentCases, listAgentIntakes, getAgentIntakeDetail, startAgentSession } from './modules/agent/routes.js';

export const API_ROUTES = {
  '/demo/identities': { GET: listIdentities },
  '/demo/session': { POST: startCustomerSession },
  '/auth/logout': { POST: logout },
  '/transactions': { GET: listTransactions },
  '/cases': { POST: createCase },
  '/intake/start': { POST: startIntake },
  '/intake/confirm': { POST: confirmIntake },
  '/intake/handoff': { POST: handoffIntake },
  '/demo/agent-session': { POST: startAgentSession },
  '/agent/cases': { GET: listAgentCases },
  '/agent/intakes': { GET: listAgentIntakes },
  '/agent/intake-detail': { GET: getAgentIntakeDetail }
};
export const API_PREFIXES = ['/demo/', '/auth/', '/agent/', '/transactions/', '/cases/', '/intake/'];
/** Bare API namespace paths that have no handler but must still answer JSON 404 behind the gate. */
export const API_NAMESPACES = new Set(['/intake', '/auth']);
/** HTML documents go through the gate so the browser asks for the team credential once; hashed bundles do not. */
export const DOCUMENT_PATHS = new Set(['/', '/index.html', '/agent']);

/** Dispatch one request; ``store`` is the per-request D1 store and ``ctx`` the Worker context (for waitUntil). */
export async function route(request, env, store, ctx) {
  const { pathname } = new URL(request.url);
  if (pathname === '/healthz') {
    if (request.method !== 'GET') return fail(405, 'Method not allowed', { Allow: 'GET' });
    await store.ping();
    return json({ status: 'ok' });
  }
  const methods = API_ROUTES[pathname];
  if (methods || API_NAMESPACES.has(pathname) || API_PREFIXES.some(prefix => pathname.startsWith(prefix))) {
    const denied = checkAccessGate(request, env);
    if (denied) return denied;
    if (!methods) return fail(404, 'Not found');
    const handler = methods[request.method];
    if (!handler) return fail(405, 'Method not allowed', { Allow: Object.keys(methods).join(', ') });
    return handler(request, env, store, ctx);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'Method not allowed', { Allow: 'GET, HEAD' });
  if (DOCUMENT_PATHS.has(pathname)) {
    const denied = checkAccessGate(request, env);
    if (denied) return denied;
  }
  return env.ASSETS.fetch(request);
}
