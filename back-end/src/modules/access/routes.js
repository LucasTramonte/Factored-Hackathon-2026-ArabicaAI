/**
 * POST /auth/access-request: an evaluator who isn't enrolled asks the team for access from the sign-in screen. It is public,
 * since the person cannot sign in yet. The team receives one plain-text email at ``ACCESS_REQUEST_TO`` (a Worker secret) and
 * enrols the person by hand (Docs/Plans/auth-runbook.md, section 11). Nothing here creates an account, grants a role or says
 * whether an address is enrolled: every accepted request gets the same answer.
 *
 * Abuse bounds: the per-IP API limit, one email per address a day, at most ``DAILY_CAP`` addresses a day, a fixed subject, a
 * conservative address shape, and nothing ever sent to the requester. D1 keeps only a hash of the address (migration 0031);
 * the log carries the outcome only.
 */
import { fail, json, readJsonBody } from '../../http.js';
import { tokenHash } from '../../auth/session.js';
import { sendEmail } from '../../notify/email.js';
import { logEvent } from '../../log.js';

/** Addresses per UTC day whose request reaches the team; later ones get 429 until the next day. */
export const DAILY_CAP = 20;
const KEEP_DAYS = 7;
const DAY_MS = 86400000;
/** A deliberately narrow address: no characters a shell, a header or a template could act on. */
export const ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const OPTIONAL = { name: 100, note: 500 };
const UNAVAILABLE = 'Access requests are unavailable right now. Try again later.';
const SUBJECT = 'ArabicaAI demo: access request';

/** The trimmed ``{ email, name, note }`` of a valid body, or null: exactly these keys, ``email`` required. */
function fieldsOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Object.keys(value).every(key => key === 'email' || Object.hasOwn(OPTIONAL, key))) return null;
  const email = typeof value.email === 'string' ? value.email.trim() : '';
  if (email.length > 254 || !ADDRESS.test(email)) return null;
  const fields = { email };
  for (const [key, max] of Object.entries(OPTIONAL)) {
    const text = value[key];
    if (text === undefined || text === null) continue;
    if (typeof text !== 'string' || !text.isWellFormed() || text.includes('\0') || [...text.trim()].length > max) return null;
    if (text.trim()) fields[key] = text.trim();
  }
  return fields;
}

/** The team's recipient when it and every SES setting are present, else null. */
function recipient(env) {
  const to = env.ACCESS_REQUEST_TO;
  const ses = env.SES_ACCESS_KEY_ID && env.SES_SECRET_ACCESS_KEY && env.SES_REGION && env.SES_FROM;
  return ses && typeof to === 'string' && ADDRESS.test(to) ? to : null;
}

/** The team's email: the request as typed, labelled untrusted, and how to grant it. */
const message = ({ email, name, note }) => [
  'Someone asked for access to the ArabicaAI demo from the sign-in screen.', '',
  `Email: ${email}`, `Name: ${name ?? '(not given)'}`, `Note: ${note ?? '(none)'}`, '',
  'The name and note are what the requester typed; treat them as untrusted. Nothing was enrolled.',
  'To grant access, enrol the address as an admin on a fictitious evaluator customer (Docs/Plans/auth-runbook.md, section 11):',
  '  back-end/scripts/cognito/enroll.sh <email> <demo customer id> admin',
  'then reply to the person.'].join('\n');

/**
 * POST /auth/access-request with ``{ email, name?, note? }``: 200 ``{ status: 'received' }`` once the team's email is sent,
 * or when the address already asked today (no second email); 422 for any other body; 429 past the daily cap; 503 when
 * requests aren't configured or the email fails (the reservation is released, so the person can retry). ``send`` is a test seam.
 */
export async function requestAccess(request, env, store, ctx, send = sendEmail) {
  if (new URL(request.url).search) return fail(422, 'Unexpected parameters');
  const parsed = await readJsonBody(request);
  if (parsed.error) return parsed.error;
  const fields = fieldsOf(parsed.value);
  if (!fields) return fail(422, 'Provide a valid email, and optionally a name and a note');
  const log = outcome => logEvent('access_request', { outcome });
  const to = recipient(env);
  if (!to) { log('unavailable'); return fail(503, UNAVAILABLE); }
  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
  const reservation = { emailHash: await tokenHash(fields.email.toLowerCase()), day, token: crypto.randomUUID() };
  const held = await store.reserveAccessRequest({ ...reservation, now, cap: DAILY_CAP,
    keepFrom: new Date(now - KEEP_DAYS * DAY_MS).toISOString().slice(0, 10) });
  if (held === 'capped') { log('capped'); return fail(429, 'Too many access requests today', { 'Retry-After': '3600' }); }
  if (held === 'duplicate') { log('duplicate'); return json({ status: 'received' }); }
  const result = await send(env, { to, subject: SUBJECT, text: message(fields) });
  if (!result.ok) {
    await store.releaseAccessRequest(reservation).catch(() => {});
    log('failed');
    return fail(503, UNAVAILABLE);
  }
  log('sent');
  return json({ status: 'received' });
}
