/**
 * Exact route table. Every API route has a declared role (``ROUTE_ROLES``); protected ones are checked by their
 * handler's session read (customer or agent), behind a per-IP limit (60 a minute). Unknown paths under API prefixes return JSON 404 and are never served as the app.
 */
import { fail, json } from './http.js';
import { GRANTED } from './auth/cognito.js';
import { acknowledgeDisplay, createCase, listIdentities, listTransactions, logout, startCustomerSession, startEmailSession } from './modules/customer/routes.js';
import { startIntake, confirmIntake, handoffIntake, listReports, requestUpdate } from './modules/intake/routes.js';
import { listAgentIntakes, getAgentIntakeDetail, startAgentSession, transitionIntake } from './modules/agent/routes.js';
import { listAuditEvents } from './modules/audit/routes.js';

export const API_ROUTES = {
  '/demo/identities': { GET: listIdentities },
  '/demo/session': { POST: startCustomerSession },
  '/auth/session': { POST: startEmailSession },
  '/auth/logout': { POST: logout },
  '/transactions': { GET: listTransactions },
  '/transactions/displayed': { POST: acknowledgeDisplay },
  '/cases': { POST: createCase },
  '/intake/start': { POST: startIntake },
  '/intake/confirm': { POST: confirmIntake },
  '/intake/handoff': { POST: handoffIntake },
  '/reports': { GET: listReports },
  '/reports/update': { POST: requestUpdate },
  '/demo/agent-session': { POST: startAgentSession },
  '/agent/intakes': { GET: listAgentIntakes },
  '/agent/intake-detail': { GET: getAgentIntakeDetail },
  '/agent/intake-status': { POST: transitionIntake },
  '/audit/events': { GET: listAuditEvents }
};
/** Who may call what. ``public`` needs no session; ``customer`` and ``agent`` need that actor's live session, which each
 *  handler reads itself; ``auditor`` needs a verified Cognito token on every call (no session). ``admin`` owns no route:
 *  ``hasRole`` lets it start a customer or agent session and read the audit (ADR-007, decision 8). Agents see only the
 *  approved queue of acknowledged handoffs. Declarative: adding a route without a role fails at module load. */
export const ROLES = ['public', ...GRANTED];
export const ROUTE_ROLES = {
  '/demo/identities': 'public',
  '/demo/session': 'public',
  '/auth/session': 'public',
  '/auth/logout': 'public',
  '/transactions': 'customer',
  '/transactions/displayed': 'customer',
  '/cases': 'customer',
  '/intake/start': 'customer',
  '/intake/confirm': 'customer',
  '/intake/handoff': 'customer',
  '/reports': 'customer',
  '/reports/update': 'customer',
  '/demo/agent-session': 'public',
  '/agent/intakes': 'agent',
  '/agent/intake-detail': 'agent',
  '/agent/intake-status': 'agent',
  '/audit/events': 'auditor'
};
for (const path of Object.keys(API_ROUTES)) if (!ROLES.includes(ROUTE_ROLES[path])) throw new Error(`Route ${path} has no role`);
export const API_PREFIXES = ['/demo/', '/auth/', '/agent/', '/audit/', '/transactions/', '/cases/', '/intake/', '/reports/'];
/** Bare API namespace paths that have no handler but must still answer JSON 404. */
export const API_NAMESPACES = new Set(['/intake', '/auth', '/audit']);
/** HTML documents the Worker sees first; all are public. Hashed bundles skip the Worker. */
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
    // Public API paths cost a D1 read or a JWKS check per cookie or bearer, so they are limited per IP (ADR-004).
    // A missing binding (unit tests) allows the request.
    if ((await env.API_LIMIT?.limit({ key: request.headers.get('cf-connecting-ip') ?? 'unknown' }))?.success === false) {
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
