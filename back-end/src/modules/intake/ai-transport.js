/**
 * Extractor switch, transport and deadline for the guided start (ADR-006 decision 6). Shadow mode only: the call
 * never changes the customer response, the episode, the identity or the transaction choice; only the producer
 * and measured usage are recorded. Prompt, body, parsing, validation and the one retry belong to the blind
 * builder's adapter, consumed unchanged through ``extractApproved``; nothing here builds or parses model text.
 */
import { PROMPT } from './extractor-prompt.js';

/**
 * The blind builder's approved adapter, set by the release change that lands it:
 * ``{ extractApproved, model, modelVersion, vocabulary }``. ``null`` until then, so the switch cannot turn on.
 */
export const APPROVED_EXTRACTOR = null;
/** ADR-006 decision 4: one 10 s deadline shared by the call and its retry. */
export const EXTRACTION_TIMEOUT_MS = 10000;
const GUIDED = 'guided-0.1';
const EXTRACTION_KEYS = 'demand,injection,intent,invalid,stated_facts';
/** A call that started but whose usage is unknown: counted, never reported as free. */
const UNKNOWN = { llm_calls: 1, known_input_tokens: 0, known_output_tokens: 0, usage_unavailable_calls: 1 };

/** Event producers the exporter accepts: the guided flow and, once registered, the approved extractor. */
export const producers = (extractor = APPROVED_EXTRACTOR) => new Set([GUIDED, ...(extractor ? [extractor.modelVersion] : [])]);

/** ``extractor-v1@<first 12 hex of SHA-256(prompt)>``, the id the pre-registration's prompt hash pins. */
async function registeredVersion() {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PROMPT)));
  return 'extractor-v1@' + [...digest].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

/**
 * The extractor to call, or ``null``. On only when ``INTAKE_AI_ENABLED`` is exactly ``'1'``, the ``AI`` binding
 * exists, an adapter is supplied and its version matches the committed prompt; a placeholder never runs.
 */
export async function readyExtractor(env, extractor = APPROVED_EXTRACTOR) {
  if (env.INTAKE_AI_ENABLED !== '1' || typeof env.AI?.run !== 'function' || typeof extractor?.extractApproved !== 'function') return null;
  return extractor.modelVersion === await registeredVersion() ? extractor : null;
}

const count = n => Number.isSafeInteger(n) && n >= 0;
/** Adapter usage if well formed (1 call plus at most 1 retry), else ``null``. */
function measured(u) {
  if (!u || !(u.llm_calls >= 1 && u.llm_calls <= 2) || ![u.llm_calls, u.known_input_tokens, u.known_output_tokens, u.usage_unavailable_calls].every(count)
    || u.usage_unavailable_calls > u.llm_calls) return null;
  return { llm_calls: u.llm_calls, known_input_tokens: u.known_input_tokens, known_output_tokens: u.known_output_tokens, usage_unavailable_calls: u.usage_unavailable_calls };
}

/**
 * Call the adapter with the statement, the session language and its vocabulary only, within the shared deadline.
 * Never throws. Returns ``{ usage, extracted }``: ``extracted`` is ``null`` unless it has exactly the five
 * extraction fields, and shadow mode drops it anyway. The binding takes no abort signal, so a call abandoned
 * at the deadline may still finish (and bill) in the background; its usage is recorded as unknown.
 */
export async function extractShadow(env, extractor, { statement, language }) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Extraction deadline')), EXTRACTION_TIMEOUT_MS); });
  const invoke = body => Promise.race([env.AI.run(extractor.model, body), expired]);
  try {
    const result = await Promise.race([extractor.extractApproved({ message: statement, language, asOf: null,
      vocabulary: extractor.vocabulary, invoke, deadline: Date.now() + EXTRACTION_TIMEOUT_MS }), expired]);
    const extracted = result?.extracted;
    const valid = extracted !== null && typeof extracted === 'object' && !Array.isArray(extracted) && Object.keys(extracted).sort().join() === EXTRACTION_KEYS;
    return { usage: measured(result?.usage) ?? UNKNOWN, extracted: valid ? extracted : null };
  } catch (error) {
    return { usage: measured(error?.usage) ?? UNKNOWN, extracted: null };
  } finally {
    clearTimeout(timer);
  }
}
