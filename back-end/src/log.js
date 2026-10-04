/**
 * Structured logs for Cloudflare Workers Logs (``observability`` in wrangler.jsonc): one JSON object per line, which
 * Workers Logs indexes field by field, so the dashboard can filter and chart ``event``, ``route``, ``status``, ``ms``.
 *
 * Invariant (AGENTS.md, ``Docs/intake/intake-events.md``): a log carries references, kinds and counts, never a customer
 * statement, message, email address, customer id, token, raw path or query string. Callers pass only such fields.
 */
export function logEvent(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}
