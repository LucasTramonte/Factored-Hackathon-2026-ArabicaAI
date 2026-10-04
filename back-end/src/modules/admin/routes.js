/**
 * Admin routes (ADR-007, decision 10): an admin lists the demo customers and acts as one, so evaluators can see the
 * service from any customer's side. Both need a live customer session that a verified admin token opened (the
 * session's ``admin`` mark); a customer session without it is 403, and no session is 401. A customer never learns
 * that another customer exists: the listing is only behind that mark.
 */
import { fail, json, readJsonBody } from '../../http.js';
import { actAsSession, requireSession } from '../../auth/session.js';
import { cardOf, identityList, refuseIdentity } from '../customer/routes.js';

const NOT_ADMIN = 'This session was not opened by an admin';

/** The live customer session if an admin opened it, else ``{ error }`` (401 no session, 403 not an admin's). */
async function adminSession(request, store) {
  const session = await requireSession(request, store, 'customer');
  if (!session) return { error: fail(401, 'Sign in as an admin first') };
  if (session.admin !== 1) return { error: fail(403, NOT_ADMIN) };
  return { session };
}

/** GET /admin/customers: the committed identities and the loaded dataset cohort, the same list as the local picker. */
export async function listCustomers(request, env, store) {
  const { error } = await adminSession(request, store);
  return error ?? identityList(store);
}

/**
 * POST /admin/act-as with exactly ``{ customer_id }``: replace the admin's customer session with one for that customer.
 * The new session keeps the admin mark (so the admin can switch again), stores no email (notifications never go to the
 * admin's address for another customer's reports, and the customer's own address on file is untouched; only an update
 * the admin asks for goes to the admin's own address, through the remembered sign-in identity), and the same
 * batch records one reference-only ``admin_actions`` row. The swap is single-use: of concurrent calls with one cookie,
 * the first wins and the rest are 401. From here identity comes from the session, as everywhere.
 */
export async function actAs(request, env, store) {
  const { error } = await adminSession(request, store);
  if (error) return error;
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const value = body.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'customer_id') {
    return fail(422, 'Provide exactly one customer_id');
  }
  const refused = await refuseIdentity(store, value.customer_id);
  if (refused) return refused;
  const customerId = value.customer_id;
  const card = await cardOf(store, customerId);
  const cookie = await actAsSession(request, store, customerId);
  if (!cookie) return fail(401, 'Sign in as an admin first');
  return json({ customer_id: customerId, mode: 'admin_act_as', context_card: card, roles: ['admin'] }, 200, { 'Set-Cookie': cookie });
}
