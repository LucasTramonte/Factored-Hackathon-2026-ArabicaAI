/**
 * Exact route table. The team gate covers only the agent and demo paths (``/agent``, ``/agent/*``,
 * ``/demo/*``) and runs before method checks there; customer routes are protected by each handler's
 * session check, behind a per-IP limit (60 a minute). Unknown paths under API prefixes return JSON 404 and are never served as the app.
 */
import { checkAccessGate } from './auth/access-gate.js';
import { fail, json } from './http.js';
import { createCase, listIdentities, listTransactions, logout, startCustomerSession, startEmailSession } from './modules/customer/routes.js';
import { startIntake, confirmIntake, handoffIntake, listReports, requestUpdate } from './modules/intake/routes.js';
import { listAgentCases, listAgentIntakes, getAgentIntakeDetail, startAgentSession } from './modules/agent/routes.js';

export const API_ROUTES = {
  '/demo/identities': { GET: listIdentities },
  '/demo/session': { POST: startCustomerSession },
  '/auth/session': { POST: startEmailSession },
  '/auth/logout': { POST: logout },
  '/transactions': { GET: listTransactions },
  '/cases': { POST: createCase },
  '/intake/start': { POST: startIntake },
  '/intake/confirm': { POST: confirmIntake },
  '/intake/handoff': { POST: handoffIntake },
  '/reports': { GET: listReports },
  '/reports/update': { POST: requestUpdate },
  '/demo/agent-session': { POST: startAgentSession },
  '/agent/cases': { GET: listAgentCases },
  '/agent/intakes': { GET: listAgentIntakes },
  '/agent/intake-detail': { GET: getAgentIntakeDetail }
};
export const API_PREFIXES = ['/demo/', '/auth/', '/agent/', '/transactions/', '/cases/', '/intake/', '/reports/'];
/** Bare API namespace paths that have no handler but must still answer JSON 404. */
export const API_NAMESPACES = new Set(['/intake', '/auth']);
/** HTML documents the Worker sees first; of these only ``/agent`` is gated. Hashed bundles skip the Worker. */
export const DOCUMENT_PATHS = new Set(['/', '/index.html', '/agent']);

/** Dispatch one request; ``store`` is the per-request D1 store and ``ctx`` the Worker context (for waitUntil). */
export async function route(request, env, store, ctx) {
  const { pathname } = new URL(request.url);
  if (pathname === '/healthz') {
    if (request.method !== 'GET') return fail(405, 'Method not allowed', { Allow: 'GET' });
    await store.ping();
    return json({ status: 'ok' });
  }
  const team = pathname === '/agent' || pathname.startsWith('/agent/') || pathname.startsWith('/demo/');
  if (team) {
    const denied = checkAccessGate(request, env);
    if (denied) return denied;
  }
  const methods = API_ROUTES[pathname];
  if (methods || API_NAMESPACES.has(pathname) || API_PREFIXES.some(prefix => pathname.startsWith(prefix))) {
    // Public API paths cost a D1 read or a JWKS check per cookie or bearer, so they are limited per IP (ADR-004).
    // A missing binding (unit tests) allows the request.
    if (!team && (await env.API_LIMIT?.limit({ key: request.headers.get('cf-connecting-ip') ?? 'unknown' }))?.success === false) {
      return fail(429, 'Too many requests', { 'Retry-After': '60' });
    }
    if (!methods) return fail(404, 'Not found');
    const handler = methods[request.method];
    if (!handler) return fail(405, 'Method not allowed', { Allow: Object.keys(methods).join(', ') });
    return handler(request, env, store, ctx);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'Method not allowed', { Allow: 'GET, HEAD' });
  return env.ASSETS.fetch(request);
}
