/**
 * Proactive alert routes (ADR-011). The bank's fraud flag on a charge reaches the customer first: ``GET /alerts`` returns
 * at most one alert, for the customer's newest flagged charge not yet answered or reported; ``POST /alerts/answer``
 * records "mine" or "report". Both read the session customer only; no customer id ever comes from the request. An admin
 * acting as a customer answers as ``admin``, which never silences the alert for the customer (ADR-007, decision 10).
 */
import { fail, json, readJsonBody } from '../../http.js';
import { requireSession } from '../../auth/session.js';

const ANSWERS = new Set(['mine', 'report']);
/** The same transaction id rule as the guided confirm (``intake/validation.js``). */
const validTransactionId = v => typeof v === 'string' && v.length > 0 && v.length <= 100 && v.isWellFormed() && !v.includes('\u0000');
const answererOf = session => session.admin === 1 ? 'admin' : 'customer';

/** GET /alerts: ``{ alert: { transaction_id, merchant_name, amount, currency, occurred_at, source_occurred_at } | null }``. */
export async function getAlert(request, env, store) {
  const session = await requireSession(request, store, 'customer');
  if (!session) return fail(401, 'Start a demo session first');
  if (new URL(request.url).search) return fail(422, 'No query parameters are accepted');
  return json({ alert: await store.findProactiveAlert(session.customer_id, answererOf(session)) });
}

/**
 * POST /alerts/answer with exactly ``{ transaction_id, answer }`` (``mine`` or ``report``): 200 with the stored answer.
 * The first answer stands, so a replay or a later different answer returns the stored one. A charge that isn't the
 * customer's own flagged one is 404, whether it doesn't exist, isn't flagged or belongs to someone else.
 */
export async function answerAlert(request, env, store) {
  const session = await requireSession(request, store, 'customer');
  if (!session) return fail(401, 'Start a demo session first');
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const value = body.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'answer,transaction_id'
      || !validTransactionId(value.transaction_id) || !ANSWERS.has(value.answer)) {
    return fail(422, 'Provide exactly transaction_id and answer (mine or report)');
  }
  const stored = await store.answerProactiveAlert({ customerId: session.customer_id, transactionId: value.transaction_id,
    answeredBy: answererOf(session), answer: value.answer, now: Date.now() });
  if (!stored) return fail(404, 'Alert not found');
  return json({ transaction_id: value.transaction_id, answer: stored.answer, answered_at: new Date(stored.answered_at).toISOString() });
}
