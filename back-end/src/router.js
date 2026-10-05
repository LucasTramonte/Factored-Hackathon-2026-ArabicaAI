/**
 * Exact route table. Every API route has a declared role (``ROUTE_ROLES``); protected ones are checked by their
 * handler's session read (customer or agent), behind a per-IP limit (60 a minute). Unknown paths under API prefixes return JSON 404 and are never served as the app.
 */
import { fail, json } from './http.js';
import { GRANTED } from './auth/cognito.js';
import { acknowledgeDisplay, createCase, listIdentities, listTransactions, logout, startCustomerSession, startEmailSession, whoAmI } from './modules/customer/routes.js';
import { startIntake, confirmIntake, confirmSuggestion, getMessages, getServiceTimes, getSuggestions, handoffIntake, listReports, postMessage, recordFeedback, requestUpdate } from './modules/intake/routes.js';
import { listAgentIntakes, getAgentIntakeDetail, getAgentMessages, markSuggestion, postAgentMessage, startAgentSession, transitionIntake } from './modules/agent/routes.js';
import { reviewerAssist } from './modules/agent/assist-routes.js';
import { listAuditEvents } from './modules/audit/routes.js';
import { actAs, listCustomers } from './modules/admin/routes.js';
import { answerAlert, getAlert } from './modules/proactive/routes.js';

export const API_ROUTES = {
  '/demo/identities': { GET: listIdentities },
  '/demo/session': { POST: startCustomerSession },
  '/auth/session': { POST: startEmailSession },
  '/auth/me': { GET: whoAmI },
  '/auth/logout': { POST: logout },
  '/transactions': { GET: listTransactions },
  '/transactions/displayed': { POST: acknowledgeDisplay },
  '/cases': { POST: createCase },
  '/intake/start': { POST: startIntake },
  '/intake/confirm': { POST: confirmIntake },
  '/intake/handoff': { POST: handoffIntake },
  '/intake/service-times': { GET: getServiceTimes },
  '/reports': { GET: listReports },
  '/reports/update': { POST: requestUpdate },
  '/reports/feedback': { POST: recordFeedback },
  '/demo/agent-session': { POST: startAgentSession },
  '/agent/intakes': { GET: listAgentIntakes },
  '/agent/intake-detail': { GET: getAgentIntakeDetail },
  '/agent/intake-status': { POST: transitionIntake },
  '/agent/intake-assist': { POST: reviewerAssist },
  '/agent/suggestion-mark': { POST: markSuggestion },
  '/audit/events': { GET: listAuditEvents },
  '/admin/customers': { GET: listCustomers },
  '/admin/act-as': { POST: actAs },
  '/alerts': { GET: getAlert },
  '/alerts/answer': { POST: answerAlert },
  '/intake/handoff/{reference}/suggestions': { GET: getSuggestions },
  '/intake/handoff/{reference}/suggestions/confirm': { POST: confirmSuggestion },
  '/intake/handoff/{reference}/messages': { GET: getMessages, POST: postMessage },
  '/agent/intake-messages': { GET: getAgentMessages, POST: postAgentMessage }
};
/** Paths with one ``{reference}`` segment (no slash) and the table key each resolves to; the handler validates the segment. */
const TEMPLATES = Object.keys(API_ROUTES).filter(path => path.includes('{')).map(path =>
  [new RegExp('^' + path.replace('{reference}', '[^/]+') + '$'), path]);
const templateOf = pathname => TEMPLATES.find(([pattern]) => pattern.test(pathname))?.[1];
/** Who may call what. ``public`` needs no session; ``customer`` and ``agent`` need that actor's live session, which each
 *  handler reads itself; ``auditor`` needs a verified Cognito token on every call (no session). ``admin`` needs a customer
 *  session an admin token opened (its ``admin`` mark), read by the handler; ``hasRole`` also lets an admin start a
 *  customer or agent session and read the audit (ADR-007, decisions 8 and 10). Agents see only the
 *  approved queue of acknowledged handoffs. Declarative: adding a route without a role fails at module load. */
export const ROLES = ['public', ...GRANTED];
export const ROUTE_ROLES = {
  '/demo/identities': 'public',
  '/demo/session': 'public',
  '/auth/session': 'public',
  '/auth/me': 'public',
  '/auth/logout': 'public',
  '/transactions': 'customer',
  '/transactions/displayed': 'customer',
  '/cases': 'customer',
  '/intake/start': 'customer',
  '/intake/confirm': 'customer',
  '/intake/handoff': 'customer',
  '/intake/service-times': 'customer',
  '/reports': 'customer',
  '/reports/update': 'customer',
  '/reports/feedback': 'customer',
  '/demo/agent-session': 'public',
  '/agent/intakes': 'agent',
  '/agent/intake-detail': 'agent',
  '/agent/intake-status': 'agent',
  '/agent/intake-assist': 'agent',
  '/agent/suggestion-mark': 'agent',
  '/audit/events': 'auditor',
  '/admin/customers': 'admin',
  '/admin/act-as': 'admin',
  '/alerts': 'customer',
  '/alerts/answer': 'customer',
  '/intake/handoff/{reference}/suggestions': 'customer',
  '/intake/handoff/{reference}/suggestions/confirm': 'customer',
  '/intake/handoff/{reference}/messages': 'customer',
  '/agent/intake-messages': 'agent'
};
for (const path of Object.keys(API_ROUTES)) if (!ROLES.includes(ROUTE_ROLES[path])) throw new Error(`Route ${path} has no role`);
export const API_PREFIXES = ['/demo/', '/auth/', '/agent/', '/audit/', '/admin/', '/alerts/', '/transactions/', '/cases/', '/intake/', '/reports/'];
/** Bare API namespace paths that have no handler but must still answer JSON 404. */
export const API_NAMESPACES = new Set(['/intake', '/auth', '/audit', '/admin']);
/** HTML documents the Worker sees first; all are public. Hashed bundles skip the Worker. */
export const DOCUMENT_PATHS = new Set(['/', '/index.html', '/agent']);

/**
 * The log label of a path: its route-table key (a template keeps references out of logs), ``healthz``, ``document``,
 * ``unknown_api`` or ``asset``. Never the raw path.
 */
export function routeLabel(pathname) {
  if (pathname === '/healthz') return 'healthz';
  if (API_ROUTES[pathname]) return pathname;
  const template = templateOf(pathname);
  if (template) return template;
  if (DOCUMENT_PATHS.has(pathname)) return 'document';
  return API_NAMESPACES.has(pathname) || API_PREFIXES.some(prefix => pathname.startsWith(prefix)) ? 'unknown_api' : 'asset';
}

/** Dispatch one request; ``store`` is the per-request D1 store and ``ctx`` the Worker context (for waitUntil). */
export async function route(request, env, store, ctx) {
  const { pathname } = new URL(request.url);
  if (pathname === '/healthz') {
    if (request.method !== 'GET') return fail(405, 'Method not allowed', { Allow: 'GET' });
    await store.ping();
    return json({ status: 'ok' });
  }
  // A URL path never holds a literal brace (it arrives as %7B), so a template key can only be reached through its pattern.
  const methods = API_ROUTES[pathname] ?? API_ROUTES[templateOf(pathname)];
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
