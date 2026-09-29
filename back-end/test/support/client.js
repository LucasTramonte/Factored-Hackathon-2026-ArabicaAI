/** HTTP client for integration tests against the local Worker; keeps one cookie jar per client. */
export const base = process.env.WORKER_TEST_URL || 'http://127.0.0.1:8787';
export const auth = 'Basic ' + Buffer.from('local-reviewer:local-test-password').toString('base64');

/** Parse ``X-D1-Metrics`` into numbers, or ``null`` when the header is absent. */
export function metricsOf(response) {
  const raw = response.headers.get('X-D1-Metrics');
  if (!raw) return null;
  return Object.fromEntries(raw.split(';').map(part => part.split('=')).map(([k, v]) => [k, Number(v)]));
}

/** A browser-like client: sends the gate credential and replays the last Set-Cookie. */
export function client({ authorization = auth } = {}) {
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
