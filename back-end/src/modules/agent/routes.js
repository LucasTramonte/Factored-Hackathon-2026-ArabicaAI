/**
 * Agent routes: a separate simulated session, views of accepted cases and handoffs, the review status a person sets, and
 * the person's mark on a charge the customer confirmed from an AI suggestion.
 */
import { fail, json, readCookies, readJsonBody } from '../../http.js';
import { COOKIE, requireSession, startSession, tokenHash } from '../../auth/session.js';
import { bearerClaims, hasRole, rolesOf, verifyIdToken } from '../../auth/cognito.js';
import { UUID } from '../intake/validation.js';
import { createStore } from '../../store/d1.js';
import { deliver } from '../../notify/dispatch.js';

const PAGE = 50;

/**
 * POST /demo/agent-session: an agent session from a verified Cognito ID token in ``Authorization: Bearer`` (as
 * ``POST /auth/session``) in group ``agent``, or ``admin``, which counts as both; ``roles`` lists the verified groups
 * that are roles, and any body is ignored. Only with ``DEMO_PICKER=1`` (local) does a request without
 * ``Authorization`` get a simulated session in one click.
 */
export async function startAgentSession(request, env, store, ctx, verify = verifyIdToken) {
  const local = env.DEMO_PICKER === '1' && !request.headers.has('Authorization');
  let roles = ['agent'];
  if (!local) {
    const signedIn = await bearerClaims(request, env, verify);
    if (signedIn.error) return signedIn.error;
    if (!hasRole(signedIn.claims.groups, 'agent')) return fail(403, 'This account is not an agent in the demo');
    roles = rolesOf(signedIn.claims.groups);
  }
  return json({ role: 'agent', mode: local ? 'simulated_login' : 'email_otp', roles }, 200,
    { 'Set-Cookie': await startSession(request, store, 'agent') });
}

/** GET /agent/intakes: newest acknowledged handoffs, including technical and incomplete receipts. */
export async function listAgentIntakes(request, env, store) {
  if (!await requireSession(request, store, 'agent')) return fail(401, 'Start a demo agent session first');
  const rows = await store.listIntakeHandoffs(PAGE + 1);
  return json({ items: rows.slice(0, PAGE), has_more: rows.length > PAGE, scope: 'synthetic_demo_only' });
}

/**
 * GET /agent/intake-detail: access-controlled source statement, owned evidence and persisted service history.
 * ``model_reading`` says whether a model read the customer's details for a suggestion (version and call count only, never
 * its output). ``customer_suggestion`` is the customer's answer to a suggestion: the charge they confirmed (owned, as
 * stored) or ``none``, always marked ``verified_by_bank: false``, with the agent's mark if any.
 * ``first_opened_at`` is when an agent first opened this report (the first read stamps it); ``customer_history``
 * summarises the same customer's other reports (counts, latest status and time) without naming the customer.
 */
export async function getAgentIntakeDetail(request, env, store) {
  if (!await requireSession(request, store, 'agent')) return fail(401, 'Start a demo agent session first');
  const params = new URL(request.url).searchParams;
  const protocol = params.get('protocol');
  if ([...params.keys()].join() !== 'protocol' || !UUID.test(protocol ?? '')) {
    return fail(422, 'Provide exactly one valid protocol');
  }
  const row = await store.findIntakeHandoff(protocol.toLowerCase());
  if (!row) return fail(404, 'Intake handoff not found');
  const evidence = JSON.parse(row.evidence_json).transaction;
  const transaction = row.verified_transaction_id && evidence?.transaction_id === row.verified_transaction_id
    ? Object.fromEntries(['transaction_id', 'occurred_at', 'source_occurred_at', 'merchant_name', 'amount', 'currency'].map(key => [key, evidence[key]])) : null;
  const events = await store.listIntakeHistory(row.episode_id);
  const historyKeys = ['seq', 'event', 'ts', 'transaction_ref', 'case_ref', 'kind', 'tool_status', 'accepted_by', 'outcome', 'missing'];
  const history = events.slice(0, 100).map(({ event_json }) => {
    const event = JSON.parse(event_json);
    return Object.fromEntries(historyKeys.filter(key => key in event).map(key => [key, event[key]]));
  });
  return json({ protocol: row.protocol, reference_short: row.reference_short ?? null, episode_id: row.episode_id, kind: row.kind, status: row.status, tool_status: row.tool_status,
    destination: row.destination, priority: row.priority, urgency: row.urgency, accepted_at: row.accepted_at,
    first_opened_at: new Date(row.first_opened_at).toISOString(), language: row.language, reason: row.reason,
    customer_history: row.customer_history,
    customer_statement: row.customer_statement, verified_evidence: { transaction },
    actions_taken: JSON.parse(row.actions_json), unresolved_questions: JSON.parse(row.questions_json),
    history, history_has_more: events.length > 100,
    model_reading: row.llm_calls > 0 ? { mode: 'suggestion', model_version: row.model_version, llm_calls: Number(row.llm_calls) } : { mode: 'off', model_version: null, llm_calls: 0 },
    customer_suggestion: row.suggestion_choice ? { choice: row.suggestion_choice, verified_by_bank: false, mark: row.suggestion_mark ?? null,
      transaction: row.suggestion_choice === 'confirmed' && row.suggested_transaction_id ? { transaction_id: row.suggested_transaction_id,
        occurred_at: row.suggested_occurred_at, source_occurred_at: row.suggested_source_occurred_at, merchant_name: row.suggested_merchant_name,
        amount: row.suggested_amount, currency: row.suggested_currency } : null } : null,
    scope: 'synthetic_demo_only' });
}

/** The one step allowed into each status; forward only, no skipping. */
const PREVIOUS = { in_review: 'received', closed: 'in_review' };

/**
 * POST /agent/intake-status ``{ protocol, status }``: a person moves an acknowledged handoff received → in_review →
 * closed. Nothing is refunded, blocked or decided (ADR-002). 200 when the handoff ends in the requested status (first
 * time or replay; a replay writes nothing), 404 when unknown, 409 for any other step. The first step queues one
 * email to the customer, sent after the response.
 */
export async function transitionIntake(request, env, store, ctx) {
  if (!await requireSession(request, store, 'agent')) return fail(401, 'Start a demo agent session first');
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const value = body.value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'protocol,status'
    || typeof value.protocol !== 'string' || !UUID.test(value.protocol) || !Object.hasOwn(PREVIOUS, value.status)) return fail(422, 'Provide exactly a valid protocol and status');
  const protocol = value.protocol.toLowerCase();
  // The session's audit ref: 12 hex characters of the token hash, never the token.
  const agentSessionRef = (await tokenHash(readCookies(request)[COOKIE.agent])).slice(0, 12);
  const { row, emailId } = await store.transitionHandoff({ protocol, from: PREVIOUS[value.status], to: value.status,
    now: Date.now(), agentSessionRef, emailId: crypto.randomUUID() });
  if (!row) return fail(404, 'Intake handoff not found');
  if (row.status !== value.status) return fail(409, 'Status can only move forward one step');
  // A store of its own, so the send's queries never count in this response's metrics.
  if (emailId && ctx?.waitUntil) ctx.waitUntil(deliver(env, createStore(env.DB),
    { messageId: emailId, customerId: row.customer_id, language: row.language, reference: row.reference, template: value.status }));
  return json({ protocol, status: row.status, changed_at: new Date(row.changed_at).toISOString() });
}

const MARKS = new Set(['correct', 'wrong']);

/**
 * POST /agent/suggestion-mark ``{ protocol, mark }`` (``correct`` or ``wrong``): a person's label on the charge the
 * customer confirmed from a suggestion, the pilot's measure of whether suggestions are right. The first mark stands: the
 * same mark again is 200, a different one 409; a report without a confirmed suggestion is 404. It changes no status and
 * decides nothing (ADR-002); the agent session is recorded as a 12-hex reference.
 */
export async function markSuggestion(request, env, store) {
  if (!await requireSession(request, store, 'agent')) return fail(401, 'Start a demo agent session first');
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const value = body.value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'mark,protocol'
    || typeof value.protocol !== 'string' || !UUID.test(value.protocol) || !MARKS.has(value.mark)) return fail(422, 'Provide exactly a valid protocol and mark');
  const protocol = value.protocol.toLowerCase();
  const agentSessionRef = (await tokenHash(readCookies(request)[COOKIE.agent])).slice(0, 12);
  const stored = await store.markSuggestion({ protocol, mark: value.mark, agentSessionRef, now: Date.now() });
  if (!stored) return fail(404, 'No confirmed suggestion for this report');
  if (stored.mark !== value.mark) return fail(409, 'A different mark is already recorded');
  return json({ protocol, mark: stored.mark, marked_at: new Date(stored.marked_at).toISOString() });
}
