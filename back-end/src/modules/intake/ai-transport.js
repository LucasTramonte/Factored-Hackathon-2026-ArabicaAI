/**
 * Extractor v1 on Google Vertex AI, ported from the evaluated Python (ADR-012 decision 4): the transport of
 * ``intake_agent/extractor/vertex.py`` with the body, parsing, schema validation, one retry on invalid output and the
 * 10 s overall deadline of ``intake_agent/extractor/workers_ai.py``. Nothing here changes what the model is asked or how
 * its answer is read; golden fixtures generated from the Python (``evals/intake/online_parity.py``) pin the request bytes
 * and the parsed facts (``test/unit/ai-parity.test.js``).
 *
 * Invariants:
 * - The request carries only the committed prompt, the message text, the session language, ``as_of`` and the closed
 *   vocabulary: no customer id, transaction or history.
 * - The message text, the token and the model's answer are never logged or put in an error.
 * - Every result carries usage: one call per attempt, and an attempt without provider token counts adds one to
 *   ``usage_unavailable_calls``, so unmeasured is never reported as free.
 * - Failures are kinds, never exceptions: ``timeout``, ``provider_error`` (HTTP 429/5xx, network, non-JSON, an error
 *   envelope; no retry), ``config_error`` (401/403, any other non-2xx, a refused redirect, an invalid project id) and
 *   ``invalid_output`` (invalid JSON or schema twice).
 */
import { PROMPT } from './extractor-prompt.js';

/** Vertex AI's managed open-model id, as registered (ADR-006 amendment 7). */
export const MODEL = 'openai/gpt-oss-20b-maas';
/** ADR-006 decision 4: one 10 s deadline shared by the call and its retry. */
export const EXTRACTION_TIMEOUT_MS = 10000;
const TEMPERATURE = 0;
const MAX_TOKENS = 2048;
const REASONING_EFFORT = 'low';
const ATTEMPTS = 2;
const GUIDED = 'guided-0.1';
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** ``evals/intake/systems.py`` VOCABULARY, same order (merchant -> category); no customer data. */
const BY_CATEGORY = {
  Entertainment: ['Cine Premium', 'Conciertos Live', 'Streaming Music', 'Teatro Nacional'],
  Food: ['Mercado Central', 'Restaurante El Buen Sabor', 'Super Ahorro', 'Tienda Don José'],
  Health: ['Clínica Médica', 'Farmacia Salud', 'Laboratorio Central', 'Óptica Visión'],
  Other: ['Boutique Moda', 'Centro Comercial', 'Ferretería', 'Tienda General'],
  Services: ['Cable TV', 'Empresa Telefónica', 'Internet Plus', 'Servicios Públicos'],
  Transport: ['Estación de Servicio', 'Gasolinera Express', 'Taxi Seguro', 'Uber']
};
export const VOCABULARY = {
  merchants: Object.fromEntries(Object.entries(BY_CATEGORY).flatMap(([c, ms]) => ms.map(m => [m, c]))),
  categories: Object.keys(BY_CATEGORY).sort(),
  currencies: ['ARS', 'COP', 'USD'],
  card_types: ['Tarjeta Crédito', 'Tarjeta Débito']
};

/** ``extractor-v1@<first 12 hex of SHA-256(prompt)>``, the id the pre-registration's prompt hash pins. */
export async function registeredVersion() {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PROMPT)));
  return 'extractor-v1@' + [...digest].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

/** Event ``model_version`` values the exporter accepts: the guided flow. The extractor's version travels as ``producer``. */
export const producers = () => new Set([GUIDED]);

/** The OpenAI-compatible endpoint for ``project`` on the global location, or ``null`` for an invalid project id. */
export const vertexUrl = (project, origin = 'https://aiplatform.googleapis.com') => typeof project === 'string' && PROJECT.test(project)
  ? `${origin}/v1/projects/${project}/locations/global/endpoints/openapi/chat/completions` : null;

/**
 * Python's ``json.dumps(value, ensure_ascii=False)`` for JSON values: ``", "`` and ``": "`` separators. String escapes
 * are JSON.stringify's, which equal Python's for well-formed strings (the only kind the routes accept).
 */
export function pyJson(value) {
  if (Array.isArray(value)) return '[' + value.map(pyJson).join(', ') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).map(([k, v]) => JSON.stringify(k) + ': ' + pyJson(v)).join(', ') + '}';
  return JSON.stringify(value);
}

/** ``vertex.build_body``: the committed prompt plus the four allowed inputs, then Vertex's model id. */
export function buildBody(message, sessionLanguage, asOf, vocabulary = VOCABULARY) {
  const user = { message, session_language: sessionLanguage, as_of: asOf, vocabulary };
  return { messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: pyJson(user) }],
    temperature: TEMPERATURE, max_tokens: MAX_TOKENS, reasoning_effort: REASONING_EFFORT, model: MODEL };
}

const INTENTS = new Set(['report', 'confirm', 'unsupported_language', ...['balance', 'non_purchase_movement', 'recognized_dispute',
  'stolen_card', 'human_request', 'third_party_card', 'injection_only'].map(k => 'out_of_scope:' + k)]);
const FACT_KEYS = new Set(['merchant', 'category', 'amount', 'currency', 'date', 'card', 'country', 'abroad']);
const DEMANDS = new Set([null, 'refund', 'card_block', 'fraud_verdict']);
const isDict = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const optional = (v, type) => v === undefined || v === null || typeof v === type;
const sameKeys = (o, keys) => Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
const within = (o, keys) => Object.keys(o).every(k => keys.includes(k));
const invalid = reason => { throw new SyntaxError(reason); };

/** ``systems._validate_facts``: nested fact shapes, so a malformed value is invalid output instead of a policy crash. */
function validateFacts(facts) {
  for (const key of ['merchant', 'category', 'currency', 'country']) if (!optional(facts[key], 'string')) invalid('invalid ' + key);
  if (!optional(facts.abroad, 'boolean')) invalid('invalid abroad');
  const { amount, date, card } = facts;
  if (amount != null && !(isDict(amount) && sameKeys(amount, ['value', 'approx']) && typeof amount.value === 'string' && typeof amount.approx === 'boolean')) invalid('invalid amount');
  if (date != null && !(isDict(date) && within(date, ['expression', 'from', 'to']) && typeof date.expression === 'string'
    && optional(date.from, 'string') && optional(date.to, 'string'))) invalid('invalid date');
  if (card != null && !(isDict(card) && within(card, ['type', 'last4']) && optional(card.type, 'string') && optional(card.last4, 'string'))) invalid('invalid card');
}

/** ``systems.validate_extraction``: anything outside the spec schema is invalid; returns the value unchanged. */
export function validateExtraction(x) {
  if (!isDict(x) || !sameKeys(x, ['intent', 'stated_facts', 'invalid', 'demand', 'injection'])) invalid('invalid extraction keys');
  if (!INTENTS.has(x.intent)) invalid('invalid intent');
  if (!isDict(x.stated_facts) || Object.keys(x.stated_facts).some(k => !FACT_KEYS.has(k))) invalid('invalid stated_facts keys');
  validateFacts(x.stated_facts);
  if (!DEMANDS.has(x.demand)) invalid('invalid demand');
  if (typeof x.injection !== 'boolean') invalid('invalid injection flag');
  if (x.invalid !== null && typeof x.invalid !== 'string') invalid("invalid 'invalid' field");
  return x;
}

/** ``workers_ai.parse``: the outermost braces, JSON, null facts dropped, then the schema. Throws on invalid output. */
export function parse(content) {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end < start) invalid('no JSON object in model output');
  let data;
  try { data = JSON.parse(content.slice(start, end + 1)); } catch { invalid('model output is not valid JSON'); }
  if (isDict(data) && isDict(data.stated_facts)) data.stated_facts = Object.fromEntries(Object.entries(data.stated_facts).filter(([, v]) => v !== null));
  return validateExtraction(data);
}

/** ``workers_ai._content``: the assistant text of a chat-completion ``result``. */
function content(payload) {
  const result = isDict(payload) ? payload.result : null;
  if (!isDict(result)) invalid('response without result');
  const first = Array.isArray(result.choices) && result.choices.length ? result.choices[0] : null;
  const message = isDict(first) ? first.message : null;
  const text = isDict(message) ? message.content : null;
  if (typeof text !== 'string' || !text.trim()) invalid('response without content');
  return text;
}

/** A provider number Python reads as ``int`` (an integer literal) stays a number; any other number never counts as one. */
const FLOAT = Symbol('float');
const providerJson = text => JSON.parse(text, (key, value, context) =>
  typeof value === 'number' && !/^-?\d+$/.test(context?.source ?? '') ? FLOAT : value);
const count = n => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** ``workers_ai._usage``: provider token counts, or ``null`` when missing or not non-negative integers. */
function usageOf(payload) {
  const result = isDict(payload) ? payload.result : null;
  const usage = isDict(result) ? result.usage : null;
  if (!isDict(usage)) return null;
  return count(usage.prompt_tokens) && count(usage.completion_tokens) ? [usage.prompt_tokens, usage.completion_tokens] : null;
}

class Failure extends Error {
  constructor(kind) { super(kind); this.kind = kind; }
}

/** ``vertex._post``: one POST within ``ms``; maps every failure to a kind and wraps the OpenAI shape as an envelope. */
async function post(fetcher, url, token, bytes, ms) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Failure('timeout')); }, ms); });
  expired.catch(() => {});
  try {
    return await Promise.race([expired, (async () => {
      let response;
      try {
        // A redirect is refused (its status is kept), so the bearer token never reaches another origin.
        response = await fetcher(url, { method: 'POST', body: bytes, redirect: 'manual', signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
      } catch {
        throw new Failure(controller.signal.aborted ? 'timeout' : 'provider_error');
      }
      const status = response.status;
      if (status < 200 || status > 299) {
        if (response.body) response.body.cancel().catch(() => {});
        // Status only: the error body is never read, so nothing from the request can leak.
        throw new Failure(status === 429 || status >= 500 ? 'provider_error' : 'config_error');
      }
      let payload;
      try {
        // Python decodes strictly and keeps a BOM, which json.loads then rejects.
        payload = providerJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await response.arrayBuffer()));
      } catch {
        throw new Failure(controller.signal.aborted ? 'timeout' : 'provider_error');
      }
      // An error envelope is a provider failure, not an invalid answer; its message is never read.
      if (isDict(payload) && Object.hasOwn(payload, 'error')) throw new Failure('provider_error');
      return isDict(payload) ? { result: payload, success: true } : payload;
    })()]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ``vertex.extract`` for one message at ``url`` (``vertexUrl``) with a Google access ``token``. Resolves
 * ``{ kind: 'extracted', extracted, usage }`` or ``{ kind: <failure>, usage }``; never throws. ``usage`` is
 * ``{ llm_calls, known_input_tokens, known_output_tokens, usage_unavailable_calls }``.
 */
export async function extract({ url, message, language, asOf = null, token, fetcher = fetch, now = () => Date.now() }) {
  const usage = { llm_calls: 0, known_input_tokens: 0, known_output_tokens: 0, usage_unavailable_calls: 0 };
  if (!url) return { kind: 'config_error', usage };
  const bytes = new TextEncoder().encode(pyJson(buildBody(message, language, asOf)));
  const deadline = now() + EXTRACTION_TIMEOUT_MS;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    usage.llm_calls += 1;
    let payload;
    try {
      const remaining = deadline - now();
      if (remaining <= 0) throw new Failure('timeout');
      payload = await post(fetcher, url, token, bytes, remaining);
    } catch (error) {
      // This attempt's tokens are unknown (a timeout may still be billed).
      usage.usage_unavailable_calls += 1;
      return { kind: error instanceof Failure ? error.kind : 'provider_error', usage };
    }
    const counts = usageOf(payload);
    if (counts) { usage.known_input_tokens += counts[0]; usage.known_output_tokens += counts[1]; }
    else usage.usage_unavailable_calls += 1;
    try {
      return { kind: 'extracted', extracted: parse(content(payload)), usage };
    } catch {
      if (attempt + 1 === ATTEMPTS) return { kind: 'invalid_output', usage };
    }
  }
  return { kind: 'invalid_output', usage }; // unreachable: the loop returns
}
