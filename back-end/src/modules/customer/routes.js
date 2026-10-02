/**
 * Customer routes: simulated login, own charges, and case creation.
 * Identity always comes from the session, never from the request body.
 */
import identities from '../../config/identities.json' with { type: 'json' };
import { fail, json, readJsonBody } from '../../http.js';
import { endSession, readSession, startSession } from '../../auth/session.js';
import { issuerFor, jwksFor, verifyIdToken } from '../../auth/cognito.js';
import { CUSTOMER_ID, validateCaseRequest } from './validation.js';
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
  let cohort;
  try { cohort = await store.listDatasetIdentities(COHORT_LIMIT); } catch { return fail(503, 'Demo identities are unavailable'); }
  const items = identities.customers.map(({ customer_id, display_name }) => ({ customer_id, display_name, country: null }));
  for (const { customer_id, display_name, country } of cohort) {
    if (!COMMITTED.has(customer_id)) items.push({ customer_id, display_name, country: country ?? null });
  }
  return json({ items });
}

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

/** POST /demo/session: start a simulated session for a committed identity or a loaded dataset customer. */
export async function startCustomerSession(request, env, store) {
  if (env.DEMO_PICKER !== '1') return fail(404, 'Not found');
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const customerId = body.value?.customer_id;
  if (typeof customerId !== 'string' || !CUSTOMER_ID.test(customerId)) return fail(422, 'Select an allowed demo identity');
  // A committed identity must be loaded; any other id is allowed only as a dataset customer in D1.
  const source = await store.customerSource(customerId);
  if (!COMMITTED.has(customerId) && source !== 'dataset') return fail(422, 'Select an allowed demo identity');
  if (!source) return fail(503, 'Demo identity is not loaded');
  const card = contextCard(await store.findContextCard(customerId));
  return json({ customer_id: customerId, mode: 'simulated_login', context_card: card }, 200,
    { 'Set-Cookie': await startSession(request, store, 'customer', customerId) });
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const NOT_ENROLLED = 'This account is not enrolled in the demo';
// The JWKS could not be fetched: jose's timeout, an unusable set, a non-200 or non-JSON answer (generic), or fetch itself.
const JWKS_DOWN = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID', 'ERR_JOSE_GENERIC']);

/**
 * POST /auth/session: a customer session from a verified Cognito ID token in ``Authorization: Bearer``.
 * Identity comes only from the verified claims; any body is ignored. The token is never logged, echoed or
 * stored, and an unverified token never reaches the store. The email is stored only AES-GCM encrypted (for
 * notifications), and only when ``EMAIL_KEY`` is valid; without it sign-in proceeds and nothing is stored.
 */
export async function startEmailSession(request, env, store, ctx, verify = verifyIdToken) {
  const token = BEARER.exec(request.headers.get('Authorization') || '')?.[1];
  if (!token || token.length > 4096) return fail(422, 'Provide the sign-in token');
  let claims;
  try {
    claims = await verify(token, { jwks: jwksFor(env), issuer: issuerFor(env), clientId: env.COGNITO_CLIENT_ID });
  } catch (e) {
    if (e instanceof TypeError || JWKS_DOWN.has(e?.code)) return fail(503, 'Sign-in is unavailable');
    return fail(401, 'Sign-in could not be verified');
  }
  const { customerId } = claims;
  if (!claims.groups.includes('customer') || customerId === null || !await store.customerSource(customerId)) {
    return fail(403, NOT_ENROLLED);
  }
  const card = contextCard(await store.findContextCard(customerId));
  const emailEnc = await encrypt(claims.email, env).catch(() => null);
  return json({ customer_id: customerId, mode: 'email_otp', context_card: card }, 200,
    { 'Set-Cookie': await startSession(request, store, 'customer', customerId, emailEnc) });
}

/** POST /auth/logout: revoke the presented customer session; always 204, so it reveals nothing. */
export async function logout(request, env, store) {
  return new Response(null, { status: 204, headers: { 'Set-Cookie': await endSession(request, store, 'customer') } });
}

/** GET /transactions: the session customer's charges, newest first, one page. */
export async function listTransactions(request, env, store) {
  const current = await readSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  const rows = await store.listTransactions(current.customer_id, PAGE + 1);
  // Only committed fictitious identities show fictitious rows; everyone else is a dataset customer.
  const coverage = COMMITTED.get(current.customer_id)?.source === 'fictitious' ? 'fictitious_demo_data_only' : 'dataset_cohort';
  return json({ items: rows.slice(0, PAGE), has_more: rows.length > PAGE, coverage });
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
