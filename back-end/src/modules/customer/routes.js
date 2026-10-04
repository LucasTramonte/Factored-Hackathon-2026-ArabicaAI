/**
 * Customer routes: simulated login, own charges, and case creation.
 * Identity always comes from the session, never from the request body.
 */
import identities from '../../config/identities.json' with { type: 'json' };
import { fail, json, readJsonBody } from '../../http.js';
import { endSession, requireSession, startSession } from '../../auth/session.js';
import { bearerClaims, hasRole, rolesOf, verifyIdToken } from '../../auth/cognito.js';
import { CUSTOMER_ID, validateCaseRequest } from './validation.js';
import { UUID } from '../intake/validation.js';
import { encrypt } from '../../notify/email.js';

const COMMITTED = new Map(identities.customers.map(c => [c.customer_id, c]));
const COHORT_LIMIT = 1000;
const PAGE = 20;
const NOT_CONFIRMED = 'Acceptance not confirmed; retry with the same idempotency key';

/**
 * GET /demo/identities: the committed (mostly fictitious) identities, then the dataset cohort loaded in D1.
 * Cohort ids and names are never committed; a D1 row never overrides a committed identity.
 * Both picker routes exist only when ``DEMO_PICKER=1`` (local development); production has no global customer listing.
 */
export async function listIdentities(request, env, store) {
  if (env.DEMO_PICKER !== '1') return fail(404, 'Not found');
  return identityList(store);
}

/** The committed identities, then the dataset cohort loaded in D1 (a D1 row never overrides a committed one); 503 if D1 fails. */
export async function identityList(store) {
  let cohort;
  try { cohort = await store.listDatasetIdentities(COHORT_LIMIT); } catch { return fail(503, 'Demo identities are unavailable'); }
  const items = identities.customers.map(({ customer_id, display_name }) => ({ customer_id, display_name, country: null }));
  for (const { customer_id, display_name, country } of cohort) {
    if (!COMMITTED.has(customer_id)) items.push({ customer_id, display_name, country: country ?? null });
  }
  return json({ items });
}

/**
 * Whether ``customerId`` may be served a session: a committed identity that is loaded, or a dataset customer in D1.
 * Returns ``null`` when allowed, else the error response (422 not allowed, 503 a committed identity not loaded).
 */
export async function refuseIdentity(store, customerId) {
  if (typeof customerId !== 'string' || !CUSTOMER_ID.test(customerId)) return fail(422, 'Select an allowed demo identity');
  const source = await store.customerSource(customerId);
  if (!COMMITTED.has(customerId) && source !== 'dataset') return fail(422, 'Select an allowed demo identity');
  if (!source) return fail(503, 'Demo identity is not loaded');
  return null;
}

/** The served context card for ``customerId``, or ``null`` when missing or malformed. */
export const cardOf = async (store, customerId) => contextCard(await store.findContextCard(customerId));

const LOCALE = /^(es|pt)(-[A-Za-z0-9]+)*$/;
const LAST4 = /^[0-9]{4}$/;
const CURRENCY = /^[A-Z]{3}$/;
const PRODUCT_KEYS = 'currency,last4,product_type';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullable = (value, valid) => value === null || (typeof value === 'string' && valid(value));

/** A stored product entry in exactly the shape of the session contract. */
function validProduct(p) {
  return isObject(p) && Object.keys(p).sort().join() === PRODUCT_KEYS && nullable(p.product_type, () => true) &&
    nullable(p.last4, v => LAST4.test(v)) && nullable(p.currency, v => CURRENCY.test(v));
}

/**
 * The stored card as served: only the known fields, with ``version`` and ``snapshot_at`` taken from
 * their columns. A payload that does not match the session contract yields ``null``, so login stays
 * available and a malformed card never reaches the client.
 */
function contextCard(row) {
  if (!row) return null;
  let card;
  try { card = JSON.parse(row.card_json); } catch { return null; }
  if (!isObject(card)) return null;
  const { first_name = null, locale_hint, products } = card;
  if (!nullable(first_name, v => v.length > 0) || typeof locale_hint !== 'string' || !LOCALE.test(locale_hint) ||
      !Array.isArray(products) || !products.every(validProduct)) return null;
  return { version: row.card_version, snapshot_at: row.snapshot_at, first_name, locale_hint, products };
}

/** POST /demo/session: start a simulated session for a committed identity or a loaded dataset customer (``roles: ['customer']``). */
export async function startCustomerSession(request, env, store) {
  if (env.DEMO_PICKER !== '1') return fail(404, 'Not found');
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const customerId = body.value?.customer_id;
  // A committed identity must be loaded; any other id is allowed only as a dataset customer in D1.
  const refused = await refuseIdentity(store, customerId);
  if (refused) return refused;
  const card = contextCard(await store.findContextCard(customerId));
  return json({ customer_id: customerId, mode: 'simulated_login', context_card: card, roles: ['customer'] }, 200,
    { 'Set-Cookie': await startSession(request, store, 'customer', customerId) });
}

const NOT_ENROLLED = 'This account is not enrolled in the demo';

/**
 * POST /auth/session: a customer session from a verified Cognito ID token in ``Authorization: Bearer``; an ``admin``
 * token counts as both customer and agent, and ``roles`` lists the verified groups that are roles.
 * Identity comes only from the verified claims; any body is ignored. The token is never logged, echoed or
 * stored, and an unverified token never reaches the store. The email is stored only AES-GCM encrypted (for
 * notifications), and only when ``EMAIL_KEY`` is valid; without it sign-in proceeds and nothing is stored.
 */
export async function startEmailSession(request, env, store, ctx, verify = verifyIdToken) {
  const signedIn = await bearerClaims(request, env, verify);
  if (signedIn.error) return signedIn.error;
  const { claims } = signedIn;
  const { customerId } = claims;
  if (!hasRole(claims.groups, 'customer') || customerId === null || !await store.customerSource(customerId)) {
    return fail(403, NOT_ENROLLED);
  }
  const card = contextCard(await store.findContextCard(customerId));
  const emailEnc = await encrypt(claims.email, env).catch(() => null);
  // An admin's session is marked, so it may later list customers and act as one (ADR-007, decision 10).
  return json({ customer_id: customerId, mode: 'email_otp', context_card: card, roles: rolesOf(claims.groups) }, 200,
    { 'Set-Cookie': await startSession(request, store, 'customer', customerId, emailEnc, { admin: claims.groups.includes('admin') }) });
}

/**
 * GET /auth/me (ADR-013, phase 0): the browser's live sessions, so a reload restores the signed-in state from the cookies
 * instead of the tab. ``{ customer: { customer_id, roles, context_card } | null, agent: boolean }``: never a token, an
 * expiry or another customer. Reads only the presented cookies (each through its own actor), so no request field can
 * name an identity; no query is accepted. ``roles`` is ``['admin']`` for a session an admin opened, else ``['customer']``.
 */
export async function whoAmI(request, env, store) {
  if (new URL(request.url).search) return fail(422, 'No query parameters are accepted');
  // A reload with an expired or stale cookie is normal here and answers 200, so it writes no rejection event.
  const customer = await requireSession(request, store, 'customer', { audit: false });
  const agent = await requireSession(request, store, 'agent', { audit: false });
  return json({
    customer: customer ? { customer_id: customer.customer_id, roles: customer.admin === 1 ? ['admin'] : ['customer'],
      context_card: await cardOf(store, customer.customer_id) } : null,
    agent: agent !== null
  });
}

/**
 * POST /auth/logout: revoke the presented customer and agent sessions (an admin sign-in opens both) and clear both
 * cookies; each actor reads only its own cookie, and an absent one costs no query. Always 204, so it reveals nothing.
 */
export async function logout(request, env, store) {
  const headers = new Headers();
  for (const actor of ['customer', 'agent']) headers.append('Set-Cookie', await endSession(request, store, actor));
  return new Response(null, { status: 204, headers });
}

const VIEW_LANGUAGES = new Set(['es', 'pt', 'en']);

/**
 * GET /transactions: the session customer's charges, newest first, one page. With ``?lang=es|pt|en`` the
 * served view is recorded in ``charge_views`` and its random ``view_ref`` returned (ADR-009); without it
 * nothing is recorded and ``view_ref`` is null. A failed record still serves the rows, unrecorded.
 */
export async function listTransactions(request, env, store) {
  const current = await requireSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  const language = new URL(request.url).searchParams.get('lang');
  if (language !== null && !VIEW_LANGUAGES.has(language)) return fail(422, 'Unsupported language');
  const rows = await store.listTransactions(current.customer_id, PAGE + 1);
  // Only committed fictitious identities show fictitious rows; everyone else is a dataset customer.
  const coverage = COMMITTED.get(current.customer_id)?.source === 'fictitious' ? 'fictitious_demo_data_only' : 'dataset_cohort';
  const items = rows.slice(0, PAGE);
  const hasMore = rows.length > PAGE;
  let viewRef = null;
  if (language !== null) {
    const id = crypto.randomUUID();
    try {
      await store.insertChargeView({ viewRef: id, customerId: current.customer_id, language, rowCount: items.length,
        hasMore, coverage, now: Date.now() });
      viewRef = id;
    } catch { /* an unrecorded view is a missing numerator, not an outage */ }
  }
  return json({ items, has_more: hasMore, coverage, view_ref: viewRef });
}

/**
 * POST /transactions/displayed: the client rendered a recorded view. The body is exactly ``{ view_ref }``;
 * the acknowledgement is bound to the session customer, so another customer's view is 404, and a replay keeps
 * the first ``displayed_at``.
 */
export async function acknowledgeDisplay(request, env, store) {
  const current = await requireSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const { value } = body;
  if (!isObject(value) || Object.keys(value).join() !== 'view_ref' || typeof value.view_ref !== 'string'
    || !UUID.test(value.view_ref)) return fail(422, 'Provide exactly a valid view_ref');
  const displayedAt = await store.acknowledgeChargeView(value.view_ref, current.customer_id, Date.now());
  if (displayedAt === null) return fail(404, 'View not found for this session');
  return json({ view_ref: value.view_ref, displayed_at: displayedAt });
}

/**
 * POST /cases: accept a confirmed report for one of the customer's own transactions.
 * The reference is returned only after the row has been read back. Reusing a key with the same
 * content replays the receipt (200); different content is a conflict (409).
 */
export async function createCase(request, env, store) {
  const current = await requireSession(request, store, 'customer');
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
