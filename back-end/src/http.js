/** HTTP helpers shared by every route: JSON responses, cookies and bounded body parsing. */

export const MAX_BODY_BYTES = 16 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** JSON response that is never cached. */
export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
}

/** Error response with a single human-readable ``detail``; never includes internals. */
export function fail(status, detail, headers = {}) {
  return json({ detail }, status, headers);
}

/** Parse the Cookie header; malformed pairs are ignored and the first value of a name wins. */
export function readCookies(request) {
  const cookies = {};
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    if (name && !(name in cookies)) cookies[name] = part.slice(at + 1).trim();
  }
  return cookies;
}

/** Session cookie with fixed attributes; ``Secure`` everywhere except local development hosts. */
export function cookieHeader(name, token, request, maxAgeSeconds = 3600) {
  const local = LOCAL_HOSTS.has(new URL(request.url).hostname);
  return `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${local ? '' : '; Secure'}`;
}

/**
 * Read at most ``maxBytes`` of JSON. Returns ``{ value }`` or ``{ error: Response }``: 413 as soon as
 * the stream passes the limit (it stops reading), 422 when the body is not valid JSON.
 */
export async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxBytes) return { error: fail(413, 'Request body too large') };
  const chunks = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { error: fail(413, 'Request body too large') };
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: fail(422, 'Request body must be JSON') };
  }
}
