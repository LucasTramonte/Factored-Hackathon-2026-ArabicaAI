/**
 * Team access gate for API routes (HTTP Basic). It is a second layer behind Cloudflare Access,
 * not customer authentication. It fails closed with 503 when its secrets are not configured.
 */
import { fail } from '../http.js';

const encoder = new TextEncoder();

/** Compare two strings in time independent of where they first differ. */
function sameText(a, b) {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function decodeBasic(header) {
  if (!header.startsWith('Basic ')) return null;
  try {
    const bytes = Uint8Array.from(atob(header.slice(6)), c => c.charCodeAt(0));
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const at = decoded.indexOf(':');
    return at > 0 ? [decoded.slice(0, at), decoded.slice(at + 1)] : null;
  } catch {
    return null;
  }
}

/** ``null`` when the request may proceed; otherwise the 401 or 503 response to return. */
export function checkAccessGate(request, env) {
  if (!env.DEMO_ACCESS_USERNAME || !env.DEMO_ACCESS_PASSWORD) return fail(503, 'Demo access gate is not configured');
  const credentials = decodeBasic(request.headers.get('Authorization') || '');
  const userOk = credentials !== null && sameText(credentials[0], env.DEMO_ACCESS_USERNAME);
  const passOk = credentials !== null && sameText(credentials[1], env.DEMO_ACCESS_PASSWORD);
  if (userOk && passOk) return null;
  return fail(401, 'Team access required', { 'WWW-Authenticate': 'Basic realm="ArabicaAI demo"' });
}
