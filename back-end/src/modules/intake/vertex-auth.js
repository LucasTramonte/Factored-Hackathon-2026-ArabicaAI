/**
 * A Google access token for Vertex AI through Workload Identity Federation, with no Google key (Docs/Plans/
 * ai-suggestion-plan.md, option A). The Worker is its own OIDC issuer: it signs a 5-minute RS256 JWT with its secret
 * ``VERTEX_WIF_SIGNING_KEY`` (PKCS#8 PEM; the public JWKS is uploaded to the pool provider by a person), exchanges it at
 * Google's STS for a federated token, then impersonates the service account, which holds only Vertex AI User.
 *
 * Invariants: the key, the JWT and both tokens are never logged or returned in an error; the access token is cached in
 * the isolate and renewed 5 minutes before it expires; a failed exchange caches nothing, so the next report tries again
 * (never a loop). Every Google call has its own 10 s bound.
 */
import { SignJWT, importPKCS8 } from 'jose';

export const POOL = 'arabica-worker';
export const PROVIDER = 'cloudflare-worker';
export const SUBJECT = 'arabica-intake-worker';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const JWT_SECONDS = 300;
const RENEW_BEFORE_MS = 5 * 60 * 1000;
const CALL_MS = 10000;
const ORIGINS = { sts: 'https://sts.googleapis.com', iam: 'https://iamcredentials.googleapis.com' };

/** The provider audience the JWT and the exchange name. */
export const audience = projectNumber =>
  `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}`;

/** The credential vars and secret, or ``null`` when any is missing (the extraction is then ``off``). */
export function credentialConfig(env) {
  const names = ['VERTEX_PROJECT', 'VERTEX_PROJECT_NUMBER', 'VERTEX_SERVICE_ACCOUNT', 'VERTEX_WIF_ISSUER', 'VERTEX_WIF_KID', 'VERTEX_WIF_SIGNING_KEY'];
  if (!names.every(n => typeof env[n] === 'string' && env[n].trim())) return null;
  return { project: env.VERTEX_PROJECT.trim(), projectNumber: env.VERTEX_PROJECT_NUMBER.trim(), serviceAccount: env.VERTEX_SERVICE_ACCOUNT.trim(),
    issuer: env.VERTEX_WIF_ISSUER.trim(), kid: env.VERTEX_WIF_KID.trim(), signingKey: env.VERTEX_WIF_SIGNING_KEY };
}

let cached = null;
/** Forget the isolate's token (tests). */
export const resetTokenCache = () => { cached = null; };

/** The JWT the Worker presents to STS: ``iss``, ``sub``, ``aud``, ``iat``, ``exp`` (5 minutes), header ``kid``. */
export async function workerJwt(config, nowMs) {
  const key = await importPKCS8(config.signingKey.replace(/\\n/g, '\n'), 'RS256');
  const iat = Math.floor(nowMs / 1000);
  return new SignJWT({}).setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: config.kid }).setIssuer(config.issuer).setSubject(SUBJECT)
    .setAudience(audience(config.projectNumber)).setIssuedAt(iat).setExpirationTime(iat + JWT_SECONDS).sign(key);
}

async function postJson(fetcher, url, body, headers = {}) {
  const response = await fetcher(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(CALL_MS),
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (response.status !== 200) {
    if (response.body) response.body.cancel().catch(() => {});
    throw new Error('exchange refused');
  }
  return response.json();
}

/**
 * A cached or fresh access token for the service account, or ``null`` when an exchange fails (``auth_error``).
 * ``origin`` replaces both Google origins (local tests only; ``suggestions.js`` decides when).
 */
export async function accessToken(config, { fetcher = fetch, now = Date.now, origin = null } = {}) {
  const key = config.serviceAccount + '|' + config.projectNumber + '|' + (origin ?? '');
  if (cached?.key === key && cached.expiresAt - RENEW_BEFORE_MS > now()) return cached.token;
  // The account and number go into a Google path and audience, so only their documented shapes are accepted.
  if (!/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(config.serviceAccount) || !/^\d+$/.test(config.projectNumber)) return null;
  try {
    const sts = await postJson(fetcher, `${origin ?? ORIGINS.sts}/v1/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', audience: audience(config.projectNumber), scope: SCOPE,
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token', subject_token: await workerJwt(config, now()),
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt' });
    if (typeof sts?.access_token !== 'string' || !sts.access_token) return null;
    const iam = await postJson(fetcher, `${origin ?? ORIGINS.iam}/v1/projects/-/serviceAccounts/${config.serviceAccount}:generateAccessToken`,
      { scope: [SCOPE], lifetime: '3600s' }, { Authorization: `Bearer ${sts.access_token}` });
    const expiresAt = Date.parse(iam?.expireTime);
    if (typeof iam?.accessToken !== 'string' || !iam.accessToken || !Number.isFinite(expiresAt)) return null;
    cached = { key, token: iam.accessToken, expiresAt };
    return iam.accessToken;
  } catch {
    return null;
  }
}
