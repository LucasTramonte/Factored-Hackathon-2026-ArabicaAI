/**
 * Customer routes: simulated login, own charges, and case creation.
 * Identity always comes from the session, never from the request body.
 */
import identities from '../../config/identities.json' with { type: 'json' };
import { fail, json, readJsonBody } from '../../http.js';
import { readSession, startSession } from '../../auth/session.js';
import { validateCaseRequest } from './validation.js';

const ALLOWED = new Set(identities.customers.map(c => c.customer_id));
const PAGE = 20;
const NOT_CONFIRMED = 'Acceptance not confirmed; retry with the same idempotency key';

/** GET /demo/identities: the simulated identities the client may offer; no D1 access. */
export function listIdentities() {
  return json({ items: identities.customers.map(({ customer_id, display_name }) => ({ customer_id, display_name })) });
}

/**
 * The stored card as served: only the known fields, with ``version`` and ``snapshot_at`` taken from
 * their columns. A payload that is not a card object yields ``null`` so login stays available.
 */
function contextCard(row) {
  if (!row) return null;
  let card;
  try { card = JSON.parse(row.card_json); } catch { return null; }
  if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
  const { first_name = null, locale_hint, products } = card;
  if (typeof locale_hint !== 'string' || !Array.isArray(products)) return null;
  return { version: row.card_version, snapshot_at: row.snapshot_at, first_name, locale_hint, products };
}

/** POST /demo/session: start a simulated session for an allowlisted identity. */
export async function startCustomerSession(request, env, store) {
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const customerId = body.value?.customer_id;
  if (typeof customerId !== 'string' || !ALLOWED.has(customerId)) return fail(422, 'Select an allowed demo identity');
  if (!await store.customerExists(customerId)) return fail(503, 'Demo identity is not loaded');
  const card = contextCard(await store.findContextCard(customerId));
  return json({ customer_id: customerId, mode: 'simulated_login', context_card: card }, 200,
    { 'Set-Cookie': await startSession(request, store, 'customer', customerId) });
}

/** GET /transactions: the session customer's charges, newest first, one page. */
export async function listTransactions(request, env, store) {
  const current = await readSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  const rows = await store.listTransactions(current.customer_id, PAGE + 1);
  return json({ items: rows.slice(0, PAGE), has_more: rows.length > PAGE, coverage: 'fictitious_demo_data_only' });
}

/**
 * POST /cases: accept a confirmed report for one of the customer's own transactions.
 * The reference is returned only after the row has been read back. Reusing a key with the same
 * content replays the receipt (200); different content is a conflict (409).
 */
export async function createCase(request, env, store) {
  const current = await readSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const checked = validateCaseRequest(body.value);
  if (checked.error) return fail(checked.error.status, checked.error.detail);
  const { transactionId, statement, idempotencyKey } = checked.value;
  if (!await store.ownsTransaction(current.customer_id, transactionId)) return fail(404, 'Transaction not found for this session');
  let inserted;
  try {
    inserted = await store.insertCase({ caseId: crypto.randomUUID(), customerId: current.customer_id,
      transactionId, idempotencyKey, statement });
  } catch {
    return fail(503, NOT_CONFIRMED);
  }
  const row = await store.findCaseByKey(current.customer_id, idempotencyKey);
  if (!row) return fail(503, NOT_CONFIRMED);
  if (row.transaction_id !== transactionId || row.customer_statement !== statement) {
    return fail(409, 'Key already used with different content');
  }
  return json({ protocol: row.case_id, transaction_id: row.transaction_id, status: row.status,
    accepted_at: row.accepted_at, replayed: !inserted, scope: 'synthetic_demo_only',
    next_step: 'Await review in the demo agent view; no refund initiated' }, inserted ? 201 : 200);
}
