/**
 * Simulated sessions stored in D1. Only a SHA-256 hash of each random token is stored. Customer
 * and agent sessions use separate cookies and separate ``actor`` values, so one can never stand
 * in for the other. Starting a session revokes the token the browser presented.
 */
import { cookieHeader, readCookies } from '../http.js';

export const SESSION_MS = 60 * 60 * 1000;
export const COOKIE = { customer: 'demo_session', agent: 'demo_agent_session' };
const TOKEN = /^[0-9a-f]{64}$/;

/** 256 random bits as lowercase hex. */
export function newToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Lowercase hex SHA-256 of a token; the only form stored. */
export async function tokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** The audit request id: Cloudflare's ``cf-ray``, or a fresh UUID where there is none (local); at most 64 characters. */
const requestId = request => (request.headers.get('cf-ray') ?? crypto.randomUUID()).slice(0, 64);

/**
 * The live session row for ``actor`` (``{ customer_id, expires_at }``; expiry is internal only), or ``null``. A
 * presented cookie with no live row records ``session_expired`` (well formed) or ``session_rejected`` (malformed);
 * no cookie records nothing.
 */
export async function requireSession(request, store, actor) {
  const token = readCookies(request)[COOKIE[actor]];
  if (!token) return null;
  const hash = await tokenHash(token);
  const wellFormed = TOKEN.test(token);
  const session = wellFormed ? await store.findSession(hash, actor, Date.now()) : null;
  if (session) return session;
  await store.recordAuthEvent({ now: Date.now(), actor, event: wellFormed ? 'session_expired' : 'session_rejected',
    sessionRef: hash.slice(0, 12), requestId: requestId(request) });
  return null;
}

/**
 * Create a session and return its Set-Cookie value. The presented token for this actor is revoked
 * and expired sessions are purged in the same atomic store call (one D1 round trip), which also stores
 * ``emailEnc`` (an encrypted address) when given. ``admin`` marks a session an admin opened (ADR-007, decision 10).
 */
export async function startSession(request, store, actor, customerId = null, emailEnc = null, { admin = false } = {}) {
  const now = Date.now();
  const previous = readCookies(request)[COOKIE[actor]];
  const oldHash = previous && TOKEN.test(previous) ? await tokenHash(previous) : null;
  const token = newToken();
  await store.rotateSession({ now, oldHash, newHash: await tokenHash(token), actor, customerId, expiresAt: now + SESSION_MS, emailEnc,
    requestId: requestId(request), admin });
  return cookieHeader(COOKIE[actor], token, request, SESSION_MS / 1000);
}

/**
 * Replace the presented admin customer session with one for ``customerId`` (ADR-007, decision 10) and return its
 * Set-Cookie value, or ``null`` when the presented session was no longer a live admin session by the time the
 * store's single-use batch ran (a concurrent act-as already used it).
 */
export async function actAsSession(request, store, customerId) {
  const now = Date.now();
  const previous = readCookies(request)[COOKIE.customer];
  if (!previous || !TOKEN.test(previous)) return null;
  const token = newToken();
  const created = await store.actAsSession({ now, oldHash: await tokenHash(previous), newHash: await tokenHash(token), customerId,
    expiresAt: now + SESSION_MS, requestId: requestId(request) });
  return created ? cookieHeader(COOKIE.customer, token, request, SESSION_MS / 1000) : null;
}

/** Revoke the presented token for ``actor`` (no-op when absent or malformed) and return the clearing Set-Cookie. */
export async function endSession(request, store, actor) {
  const token = readCookies(request)[COOKIE[actor]];
  if (token && TOKEN.test(token)) await store.revokeSession(await tokenHash(token), actor, Date.now(), requestId(request));
  return cookieHeader(COOKIE[actor], '', request, 0);
}
