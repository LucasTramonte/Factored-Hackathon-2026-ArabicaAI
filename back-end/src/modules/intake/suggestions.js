/**
 * AI suggestions on "I can't find the charge" (ADR-012; Docs/Plans/ai-suggestion-plan.md). After an incomplete handoff
 * with details is acknowledged, the Worker reads the details with extractor v2 on Vertex AI (ADR-006 amendment 10), outside
 * the request (``ctx.waitUntil``), and deterministic code suggests at most three of the customer's own charges. The customer may then
 * confirm one; nothing closes, resolves or refunds, and the agent still reviews the report.
 *
 * One runner per run: ``runSuggestion`` first claims the pending run atomically (a replay or a second Worker gets
 * nothing), and the idle sweep closes a run still pending after 10 minutes as ``abandoned``.
 *
 * Guards, in order, each recorded as the run's outcome when it stops the call: the switch (``INTAKE_AI_ENABLED`` exactly
 * ``'1'``, else ``off``), the pilot arm (A is the control: ``off``), the model's retirement date (``retired``), the
 * credential vars and secret (missing: ``off``), the circuit breaker (``provider_error`` with no call: see ``breakerOpen``),
 * the token exchange (``auth_error``), the daily cap in D1 (``capped``).
 * Then the call (``timeout``, ``provider_error``, ``config_error``, ``invalid_output``) and the rule (``no_match``,
 * ``ambiguous``, ``suggested``). Nothing here throws into the request, and the request's response never depends on it.
 */
import { VOCABULARY, extract, registeredVersion, vertexUrl } from './ai-transport.js';
import { accessToken, credentialConfig } from './vertex-auth.js';
import { suggest } from './matcher.js';

/**
 * The last day (UTC, exclusive) the Worker calls ``google/gemini-3.5-flash-lite`` without a fresh review. Google has
 * announced no shutdown for it (its predecessor, 3.1 Flash-Lite, runs to 2027-05-07), so this is a review date, kept well
 * inside that horizon: re-check Google's model lifecycle page and move it with an ADR-006 note.
 */
export const DEFAULT_RETIRES = '2027-01-31';
/** Circuit breaker (ADR-006 amendment 10): of the last ``BREAKER_SAMPLE`` model-calling runs in the window... */
export const BREAKER_WINDOW_MS = 5 * 60 * 1000;
export const BREAKER_SAMPLE = 5;
/** ...this many failing with ``timeout`` or ``provider_error`` opens it until they age out of the window. */
export const BREAKER_FAILURES = 3;
/** Extractions per UTC day (each at most two model calls) unless ``INTAKE_AI_DAILY_CAP`` says otherwise. */
export const DEFAULT_DAILY_CAP = 200;
/** Every outcome kind a run records; ``ai-suggestions.test.js`` keeps it equal to migration 0024's CHECK and ``episodes.py``. */
export const OUTCOMES = ['off', 'capped', 'retired', 'auth_error', 'timeout', 'provider_error', 'config_error', 'invalid_output',
  'no_match', 'ambiguous', 'suggested', 'abandoned'];
const ZERO = { llm_calls: 0, known_input_tokens: 0, known_output_tokens: 0, usage_unavailable_calls: 0 };
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;

export const switchOn = env => env.INTAKE_AI_ENABLED === '1';

/**
 * The local test origin that replaces every Google origin, or ``null``. Honoured only for a loopback ``http`` origin, so
 * a misplaced value can never send a token elsewhere; ``predeploy.mjs`` refuses it in ``vars``.
 */
export const testOrigin = env => typeof env.VERTEX_TEST_ORIGIN === 'string' && LOOPBACK.test(env.VERTEX_TEST_ORIGIN) ? env.VERTEX_TEST_ORIGIN : null;

/** The randomized pilot's share of arm B (ADR-014) unless ``INTAKE_AI_SHARE_B`` says otherwise. */
export const DEFAULT_SHARE_B = 0.5;

/**
 * The share of new runs assigned to arm B: ``INTAKE_AI_SHARE_B`` when it is a number from 0 to 1 (``"1"`` for the demo,
 * where every eligible report is read; ADR-012 amendment 1), else the pilot's 50/50.
 */
export function shareB(env) {
  const share = env.INTAKE_AI_SHARE_B === undefined || String(env.INTAKE_AI_SHARE_B).trim() === '' ? NaN : Number(env.INTAKE_AI_SHARE_B);
  return share >= 0 && share <= 1 ? share : DEFAULT_SHARE_B;
}

/** The pilot arm of a new incomplete handoff with details: absent with the switch off, else B with ``shareB`` odds. */
export function newArm(env) {
  if (!switchOn(env)) return undefined;
  if (testOrigin(env) && ['A', 'B'].includes(env.INTAKE_AI_TEST_ARM)) return env.INTAKE_AI_TEST_ARM;
  return crypto.getRandomValues(new Uint32Array(1))[0] < shareB(env) * 2 ** 32 ? 'B' : 'A';
}

/**
 * Whether the model is past its retirement date at ``nowMs``: the earlier of ``VERTEX_MODEL_RETIRES`` and the built-in
 * ``DEFAULT_RETIRES`` for ``MODEL``, so configuration can only move retirement earlier. An unreadable date counts as retired.
 */
export function retired(env, nowMs) {
  const date = env.VERTEX_MODEL_RETIRES ?? DEFAULT_RETIRES;
  const at = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(date + 'T00:00:00Z') : NaN;
  return !(nowMs < Math.min(at, Date.parse(DEFAULT_RETIRES + 'T00:00:00Z')));
}

/**
 * The ``as_of`` the request carries: the Worker's current UTC time as ``YYYY-MM-DDTHH:MM:SS``, the evaluation harness's
 * timezone-free form. It can be a day off the customer's local date near midnight; then a relative date matches nothing.
 */
export const asOfAt = nowMs => new Date(nowMs).toISOString().slice(0, 19);

/**
 * Whether the provider looks down: at least ``BREAKER_FAILURES`` of the last ``BREAKER_SAMPLE`` runs that called the
 * model within ``BREAKER_WINDOW_MS`` timed out or failed at the provider. While open, a run skips the call (no tokens, no
 * load on a struggling pool, no customer waiting 10 s for nothing) and records ``provider_error`` with no call, which keeps
 * the skips countable apart from real failures. It closes on its own as those failures age out; the next run then probes.
 */
export async function breakerOpen(store, nowMs) {
  const outcomes = await store.recentModelOutcomes({ since: nowMs - BREAKER_WINDOW_MS, limit: BREAKER_SAMPLE });
  return outcomes.filter(o => o === 'timeout' || o === 'provider_error').length >= BREAKER_FAILURES;
}

function dailyCap(env) {
  const cap = env.INTAKE_AI_DAILY_CAP === undefined ? DEFAULT_DAILY_CAP : Number(env.INTAKE_AI_DAILY_CAP);
  return Number.isSafeInteger(cap) && cap >= 0 ? cap : 0;
}

/** The suggestion rule's view of one D1 purchase: the date as served, and only fields D1 holds (the rest never fit). */
function record(t) {
  return { transaction_id: t.transaction_id, merchant_name: t.merchant_name, merchant_category: VOCABULARY.merchants[t.merchant_name] ?? null,
    amount: t.amount, currency: t.currency, transaction_date: (t.source_occurred_at ?? t.occurred_at ?? '').slice(0, 10),
    product_type: null, last4: null, transaction_country: null };
}

/** The outcome and suggested ids for ``extracted`` against the customer's own purchases, with the ``as_of`` sent to the model. */
function suggestionFor(extracted, { country, purchases }, asOf = null) {
  const records = purchases.map(record);
  // systems.customers_from: without card data, the customer's cards are the currencies of their own purchases.
  const cards = [...new Set(records.map(t => t.currency))].map(currency => ({ product_type: null, last4: null, currency }));
  try {
    return suggest({ ...extracted, as_of: asOf }, { country, cards }, records); // at most MAX_SUGGESTIONS ids
  } catch {
    return { outcome: 'no_match', ids: [] }; // a purchase the policy cannot read: suggest nothing
  }
}

/**
 * Claim the handoff's pending run, then run the guards, the extraction and the rule, and record the outcome once. Resolves
 * the outcome kind, or null when the run was already claimed or finished (a replay, a second Worker) or storage failed;
 * never throws. The arm is the one stored with the handoff. ``store`` is a store of its own (never the request's);
 * ``fetcher`` and ``now`` are test seams.
 */
export async function runSuggestion(env, store, { handoffId, customerId, details, language }, { fetcher = fetch, now = Date.now } = {}) {
  const finish = async (outcome, { usage = ZERO, producer = null, ids = [], injectionFlagged = null } = {}) => {
    await store.recordSuggestionOutcome({ handoffId, outcome, producer, usage, transactionIds: ids, injectionFlagged, now: now() });
    return outcome;
  };
  try {
    const claimed = await store.claimSuggestionRun({ handoffId, now: now() });
    if (!claimed) return null;
    if (!switchOn(env) || claimed.arm !== 'B') return await finish('off');
    if (retired(env, now())) return await finish('retired');
    const config = credentialConfig(env);
    if (!config) return await finish('off');
    if (await breakerOpen(store, now())) return await finish('provider_error');
    const origin = testOrigin(env);
    const token = await accessToken(config, { fetcher, now, origin });
    if (!token) return await finish('auth_error');
    if (!await store.reserveAiCall({ day: new Date(now()).toISOString().slice(0, 10), cap: dailyCap(env) })) return await finish('capped');
    const producer = await registeredVersion();
    await store.startSuggestionCall({ handoffId, producer });
    const url = vertexUrl(config.project, origin ?? undefined);
    const asOf = asOfAt(now());
    const result = await extract({ url, message: details, language, asOf, token, fetcher, now });
    if (result.kind !== 'extracted') return await finish(result.kind, { usage: result.usage, producer });
    const { outcome, ids } = suggestionFor(result.extracted, await store.listSuggestionPurchases(customerId), asOf);
    // The injection flag is recorded only; the policy already ignores injected text (label_rules), so it changes nothing.
    return await finish(outcome, { usage: result.usage, producer, ids, injectionFlagged: result.extracted.injection });
  } catch {
    return null; // storage unavailable: the run stays pending, its pre-recorded call unknown
  }
}
