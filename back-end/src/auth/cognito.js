/**
 * Verifies Cognito ID tokens and returns the trusted claims the Worker uses. Identity comes only
 * from a verified token, never from a request body or message text.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { CUSTOMER_ID } from '../modules/customer/validation.js';

let remote;

/** The pool's issuer URL, ``https://cognito-idp.<region>.amazonaws.com/<pool>``. */
export function issuerFor(env) {
  return `https://cognito-idp.${env.COGNITO_REGION}.amazonaws.com/${env.COGNITO_USER_POOL_ID}`;
}

/** The pool's JWKS, fetched and cached by jose for the isolate's lifetime (one pool per deployment). */
export function jwksFor(env) {
  remote ??= createRemoteJWKSet(new URL(`${issuerFor(env)}/.well-known/jwks.json`));
  return remote;
}

/**
 * ``{ sub, email, groups, customerId }`` for a valid RS256 ID token from ``issuer`` for ``clientId``
 * with a verified email, or throws. ``groups`` is ``[]`` without ``cognito:groups``; ``customerId``
 * is ``null`` unless ``custom:customer_id`` matches ``CUSTOMER_ID``. ``jwks`` may be a local set in tests.
 */
export async function verifyIdToken(token, { jwks, issuer, clientId }) {
  const { payload } = await jwtVerify(token, jwks, { issuer, audience: clientId, algorithms: ['RS256'], clockTolerance: 30 });
  if (payload.token_use !== 'id') throw new Error('not an id token');
  if (payload.email_verified !== true || typeof payload.email !== 'string') throw new Error('email not verified');
  const groups = Array.isArray(payload['cognito:groups']) ? payload['cognito:groups'].filter(g => typeof g === 'string') : [];
  const id = payload['custom:customer_id'];
  return { sub: payload.sub, email: payload.email, groups, customerId: typeof id === 'string' && CUSTOMER_ID.test(id) ? id : null };
}
