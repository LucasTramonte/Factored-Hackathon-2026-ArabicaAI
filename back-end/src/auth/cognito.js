/**
 * Verifies Cognito ID tokens and returns the trusted claims the Worker uses. Identity comes only
 * from a verified token, never from a request body or message text.
 */
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose';
import { CUSTOMER_ID } from '../modules/customer/validation.js';
import { fail } from '../http.js';

let remote;

/** The pool's issuer URL, ``https://cognito-idp.<region>.amazonaws.com/<pool>``. */
export function issuerFor(env) {
  return `https://cognito-idp.${env.COGNITO_REGION}.amazonaws.com/${env.COGNITO_USER_POOL_ID}`;
}

/**
 * The pool's JWKS, fetched and cached by jose for the isolate's lifetime (one pool per deployment).
 * Local tests set ``COGNITO_TEST_JWKS`` (a JWKS JSON) instead; predeploy refuses it in ``vars``.
 */
export function jwksFor(env) {
  if (env.COGNITO_TEST_JWKS) return createLocalJWKSet(JSON.parse(env.COGNITO_TEST_JWKS));
  remote ??= createRemoteJWKSet(new URL(`${issuerFor(env)}/.well-known/jwks.json`));
  return remote;
}

/**
 * ``{ sub, email, groups, customerId }`` for a valid RS256 ID token from ``issuer`` for ``clientId``
 * with a verified email, or throws. ``groups`` is ``[]`` without ``cognito:groups``; ``customerId``
 * is ``null`` unless ``custom:customer_id`` matches ``CUSTOMER_ID``. ``jwks`` may be a local set in tests.
 */
export async function verifyIdToken(token, { jwks, issuer, clientId }) {
  const { payload } = await jwtVerify(token, jwks, { issuer, audience: clientId, algorithms: ['RS256'], clockTolerance: 30, requiredClaims: ['exp', 'iat', 'sub'] });
  if (payload.token_use !== 'id') throw new Error('not an id token');
  if (payload.email_verified !== true || typeof payload.email !== 'string') throw new Error('email not verified');
  const groups = Array.isArray(payload['cognito:groups']) ? payload['cognito:groups'].filter(g => typeof g === 'string') : [];
  const id = payload['custom:customer_id'];
  return { sub: payload.sub, email: payload.email, groups, customerId: typeof id === 'string' && CUSTOMER_ID.test(id) ? id : null };
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
// The JWKS could not be fetched: jose's timeout, an unusable set, a non-200 or non-JSON answer (generic), or fetch itself.
const JWKS_DOWN = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID', 'ERR_JOSE_GENERIC']);

/**
 * ``{ claims }`` from the ID token in ``Authorization: Bearer``, or ``{ error }``: 422 without a well-formed token,
 * 401 when it fails verification, 503 when the JWKS is unreachable. The token is never logged, echoed or stored.
 */
export async function bearerClaims(request, env, verify = verifyIdToken) {
  const token = BEARER.exec(request.headers.get('Authorization') || '')?.[1];
  if (!token || token.length > 4096) return { error: fail(422, 'Provide the sign-in token') };
  try {
    return { claims: await verify(token, { jwks: jwksFor(env), issuer: issuerFor(env), clientId: env.COGNITO_CLIENT_ID }) };
  } catch (e) {
    if (e instanceof TypeError || JWKS_DOWN.has(e?.code)) return { error: fail(503, 'Sign-in is unavailable') };
    return { error: fail(401, 'Sign-in could not be verified') };
  }
}
