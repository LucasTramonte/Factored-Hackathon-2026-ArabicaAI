/**
 * Notification email: AES-GCM for the stored address and an SES v2 sender. Bodies carry references only, never a
 * customer's statement. Nothing sends unless all SES settings are present, and ``sendEmail`` never throws.
 */
import { AwsClient } from 'aws4fetch';

const b64 = bytes => btoa(Array.from(new Uint8Array(bytes), b => String.fromCharCode(b)).join(''));
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const ENCODER = new TextEncoder();
const utf8b64 = text => b64(ENCODER.encode(text));
/** Base64 in 76-character lines, as MIME bodies require. */
const wrap = text => text.replace(/.{1,76}/g, '$&\r\n');
/**
 * RFC 2047 header value: ``=?UTF-8?B?…?=`` words of at most 75 characters (so at most 45 UTF-8 bytes each, never
 * splitting a character), folded with CRLF and a space between words.
 */
export function encodedWords(text) {
  const words = []; let chunk = '', bytes = 0;
  for (const ch of text) {
    const size = ENCODER.encode(ch).length;
    if (bytes + size > 45) { words.push(chunk); chunk = ''; bytes = 0; }
    chunk += ch; bytes += size;
  }
  words.push(chunk);
  return words.map(w => `=?UTF-8?B?${utf8b64(w)}?=`).join('\r\n ');
}

/**
 * A raw RFC 5322 message: multipart/related holding a multipart/alternative (text, html) and the inline images.
 * Every body part is base64, so no content needs escaping; the subject is RFC 2047 encoded for non-ASCII. A CR or LF
 * in ``from``, ``to`` or ``subject`` would inject a header, so it throws (``sendEmail`` turns that into ``ok: false``).
 */
export function mime({ from, to, subject, text, html, inline, date = new Date() }) {
  if (/[\r\n]/.test(from + to + subject)) throw new Error('CR/LF in a header');
  const rel = 'rel-arabicaai', alt = 'alt-arabicaai';
  const part = (headers, body) => `${headers}\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(body)}`;
  return [
    `From: ${from}`, `To: ${to}`, `Subject: ${encodedWords(subject)}`, `Date: ${date.toUTCString()}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${rel}"`, '',
    `--${rel}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '',
    `--${alt}`, part('Content-Type: text/plain; charset=UTF-8', utf8b64(text)),
    `--${alt}`, part('Content-Type: text/html; charset=UTF-8', utf8b64(html ?? '')),
    `--${alt}--`, '',
    ...inline.flatMap(({ cid, type, base64 }) => [`--${rel}`,
      part(`Content-Type: ${type}\r\nContent-ID: <${cid}>\r\nContent-Disposition: inline; filename="${cid}"`, base64)]),
    `--${rel}--`, ''
  ].join('\r\n');
}

/** The 256-bit key from ``env.EMAIL_KEY`` (base64); throws when it is missing or not 32 bytes. */
async function key(env) {
  const raw = unb64(env.EMAIL_KEY ?? '');
  if (raw.length !== 32) throw new Error('EMAIL_KEY must be 32 bytes, base64');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Encrypt with a fresh 12-byte IV; returns ``base64(iv).base64(ciphertext)``. Throws without a valid key. */
export async function encrypt(text, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return b64(iv) + '.' + b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), new TextEncoder().encode(text)));
}

/** Decrypt a blob from ``encrypt``; throws on a missing key, a wrong key or any tampering (GCM tag). */
export async function decrypt(blob, env) {
  const [iv, ct] = String(blob).split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await key(env), unb64(ct ?? '')));
}

/**
 * Send one email through SES v2. Plain text, plus HTML when given; with ``inline`` images (``[{ cid, type, base64 }]``)
 * the message goes as raw MIME (multipart/related over multipart/alternative) so the HTML can reference them as
 * ``cid:``. Returns ``{ ok: true, messageId }``, ``{ ok: false }`` on any failure, or ``{ ok: false, skipped: true }``
 * (no request made) when an SES setting is missing. Never throws.
 */
export async function sendEmail(env, { to, subject, text, html, inline = [] }, fetchImpl = fetch) {
  const { SES_ACCESS_KEY_ID: accessKeyId, SES_SECRET_ACCESS_KEY: secretAccessKey, SES_REGION: region, SES_FROM: from } = env;
  if (!accessKeyId || !secretAccessKey || !region || !from) return { ok: false, skipped: true };
  // Fail closed for both the structured and raw SES paths; none of these values may inject another header.
  if (/[\r\n]/.test(from + to + subject)) return { ok: false };
  try {
    const aws = new AwsClient({ accessKeyId, secretAccessKey, service: 'ses', region });
    const signed = await aws.sign(`https://email.${region}.amazonaws.com/v2/email/outbound-emails`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ FromEmailAddress: from, Destination: { ToAddresses: [to] }, Content: inline.length
        ? { Raw: { Data: utf8b64(mime({ from, to, subject, text, html, inline })) } }
        : { Simple: { Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Text: { Data: text, Charset: 'UTF-8' }, ...(html && { Html: { Data: html, Charset: 'UTF-8' } }) } } } })
    });
    const res = await fetchImpl(signed);
    if (!res.ok) return { ok: false };
    return { ok: true, messageId: (await res.json().catch(() => ({}))).MessageId ?? null };
  } catch {
    return { ok: false };
  }
}
