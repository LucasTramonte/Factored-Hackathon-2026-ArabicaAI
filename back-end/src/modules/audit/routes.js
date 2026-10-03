/** Read-only audit for the ``auditor`` role (issue #69): sign-in and review-status events, references only. */
import { fail, json } from '../../http.js';
import { bearerClaims, hasRole, verifyIdToken } from '../../auth/cognito.js';

const LIMIT = /^(?:[1-9][0-9]?|100)$/;

/**
 * GET /audit/events?limit=: the newest ``auth_events`` and ``handoff_status_history`` rows, up to ``limit`` (1–100,
 * default 50) of each. Every call carries a verified Cognito ID token in group ``auditor`` (``admin`` implies it,
 * ADR-007 decision 8); no cookie session is read or started, so the route writes nothing. Rows are references only:
 * no customer id, email, statement or token.
 */
export async function listAuditEvents(request, env, store, ctx, verify = verifyIdToken) {
  const signedIn = await bearerClaims(request, env, verify);
  if (signedIn.error) return signedIn.error;
  if (!hasRole(signedIn.claims.groups, 'auditor')) return fail(403, 'This account is not an auditor in the demo');
  const params = new URL(request.url).searchParams;
  const raw = params.getAll('limit');
  if ([...params.keys()].some(key => key !== 'limit') || raw.length > 1 || (raw.length && !LIMIT.test(raw[0]))) {
    return fail(422, 'Provide at most one limit from 1 to 100');
  }
  const limit = raw.length ? Number(raw[0]) : 50;
  const { auth, status } = await store.listAuditEvents(limit + 1);
  return json({ auth_events: auth.slice(0, limit), auth_events_has_more: auth.length > limit,
    status_changes: status.slice(0, limit), status_changes_has_more: status.length > limit, scope: 'references_only' });
}
