/** HTTP client for integration tests against the local Worker; keeps one cookie jar per client. */
export const base = process.env.WORKER_TEST_URL || 'http://127.0.0.1:8787';

/** Parse ``X-D1-Metrics`` into numbers, or ``null`` when the header is absent. */
export function metricsOf(response) {
  const raw = response.headers.get('X-D1-Metrics');
  if (!raw) return null;
  return Object.fromEntries(raw.split(';').map(part => part.split('=')).map(([k, v]) => [k, Number(v)]));
}

/** A browser-like client: sends ``authorization`` when given and replays the last Set-Cookie. */
export function client({ authorization } = {}) {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    set cookie(value) { cookie = value; },
    async call(path, body, { method } = {}) {
      const response = await fetch(base + path, {
        method: method || (body === undefined ? 'GET' : 'POST'),
        headers: { ...(authorization ? { Authorization: authorization } : {}), ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
      });
      const received = response.headers.get('set-cookie');
      if (received) cookie = received.split(';', 1)[0];
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: response.status, body: json, text, headers: response.headers, metrics: metricsOf(response) };
    }
  };
}

/** A Cognito-shaped ID token signed with run-local's throwaway key, for the real issuer and client id. */
export async function idToken(customerId, { groups = ['customer'] } = {}) {
  const { SignJWT, importJWK } = await import('jose');
  const jwk = JSON.parse(process.env.COGNITO_TEST_PRIVATE_JWK);
  return new SignJWT({ token_use: 'id', email: 'test@example.com', email_verified: true, 'cognito:groups': groups,
    'custom:customer_id': customerId }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setSubject('sub-' + customerId)
    .setIssuer(process.env.COGNITO_TEST_ISSUER).setAudience(process.env.COGNITO_TEST_CLIENT_ID).setIssuedAt().setExpirationTime('5m')
    .sign(await importJWK(jwk, 'RS256'));
}

/** Close one report as a person would (received → in_review → closed), releasing its charge for a new report. */
export async function closeReport(protocol) {
  const agent = client();
  await agent.call('/demo/agent-session', {});
  for (const status of ['in_review', 'closed']) {
    const moved = await agent.call('/agent/intake-status', { protocol, status, ...(status === 'closed' ? { closing_note: 'Review finished; contact the bank for help.' } : {}) });
    if (moved.status !== 200) throw new Error(`close ${protocol}: ${status} -> ${moved.status}`);
  }
}
