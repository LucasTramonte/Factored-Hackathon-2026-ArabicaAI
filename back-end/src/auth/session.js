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

/** The live session row for ``actor`` (``{ customer_id }``), or ``null``. */
export async function readSession(request, store, actor) {
  const token = readCookies(request)[COOKIE[actor]];
  if (!token || !TOKEN.test(token)) return null;
  return store.findSession(await tokenHash(token), actor, Date.now());
}

/**
 * Create a session and return its Set-Cookie value. The presented token for this actor is revoked
 * and expired sessions are purged in the same atomic store call (one D1 round trip).
 */
export async function startSession(request, store, actor, customerId = null) {
  const now = Date.now();
  const previous = readCookies(request)[COOKIE[actor]];
  const token = newToken();
  await store.rotateSession({ now, oldHash: previous && TOKEN.test(previous) ? await tokenHash(previous) : null,
    newHash: await tokenHash(token), actor, customerId, expiresAt: now + SESSION_MS });
  return cookieHeader(COOKIE[actor], token, request, SESSION_MS / 1000);
}
