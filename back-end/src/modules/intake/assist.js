/** One bounded support generation, including WIF authentication; no retry, tool loop or generated-text storage. */
import { accessToken, credentialConfig } from './vertex-auth.js';
import { vertexUrl } from './ai-transport.js';
import { testOrigin, retired } from './suggestions.js';
import { FIELDS, INTENTS, PROMPTS, SCHEMAS } from './assist-prompts.js';

export const ASSIST_TIMEOUT_MS = 10000;
export const ASSIST_MODEL = 'google/gemini-3.5-flash-lite';
/** Version of both dedicated prompts, schemas, bounds and the chosen provider identifier. */
export const ASSIST_VERSION = 'support-assist-v1@google/gemini-3.5-flash-lite';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const text = (v, max, empty = false) => typeof v === 'string' && v.isWellFormed() && !v.includes('\0')
  && [...v].length <= max && (empty || v.trim().length > 0);
const invalid = () => { throw new SyntaxError('Invalid assistance value'); };

/** Keep original statement/details, then newest eight human messages, trimming oldest selected bodies first. */
export function boundedReviewerInput(input) {
  if (!object(input) || !text(input.statement, 2000) || !text(input.details ?? '', 2000, true)
    || !['received', 'in_review', 'closed'].includes(input.status) || !Array.isArray(input.messages)) invalid();
  if (input.messages.some(m => !object(m) || !['customer', 'agent'].includes(m.author) || !text(m.body, 2000))) invalid();
  const messages = input.messages.slice(-8).map(({ author, body }) => ({ author, body }));
  let excess = messages.reduce((n, m) => n + [...m.body].length, 0) - 4000;
  const context_truncated = input.messages.length > 8 || excess > 0;
  for (const m of messages) {
    const points = [...m.body];
    const remove = Math.min(Math.max(excess, 0), points.length);
    m.body = points.slice(remove).join('');
    excess -= remove;
  }
  return { statement: input.statement, details: input.details ?? '', status: input.status, messages, context_truncated };
}

/** Parse the entire JSON text and validate exact provider keys before any computed client fields are added. */
export function parseAssist(mode, content) {
  if (typeof content !== 'string' || !content.isWellFormed()) invalid();
  const value = JSON.parse(content);
  if (mode === 'reviewer') {
    if (!exact(value, ['summary', 'missing_fields', 'draft']) || !text(value.summary, 600) || !text(value.draft, 2000)
      || /[<>]|https?:\/\//i.test(value.summary + value.draft) || !Array.isArray(value.missing_fields) || value.missing_fields.length > 5
      || new Set(value.missing_fields).size !== value.missing_fields.length || value.missing_fields.some(f => !FIELDS.includes(f))) invalid();
  } else if (mode === 'customer') {
    if (!exact(value, ['intent', 'field']) || !INTENTS.includes(value.intent) || !(value.field === null || FIELDS.includes(value.field))
      || (value.intent !== 'provide_details' && value.field !== null)) invalid();
  } else invalid();
  return value;
}

/** Both assistance paths default off; enabling one does not enable the other. */
export const assistEnabled = (env, mode) => env[mode === 'reviewer' ? 'ASSIST_REVIEWER_ENABLED' : 'ASSIST_CUSTOMER_ENABLED'] === '1';

/** Run one attempt; only safe outcome kinds and known/unknown token accounting leave the transport. */
export async function runAssist(env, { mode, language, input }, { fetcher = fetch, signal } = {}) {
  const usage = { llm_calls: 0, known_input_tokens: 0, known_output_tokens: 0, usage_unavailable_calls: 0 };
  const fail = kind => ({ ok: false, kind, usage });
  if (!['reviewer', 'customer'].includes(mode) || !['es', 'pt', 'en'].includes(language)
    || !assistEnabled(env, mode) || retired(env, Date.now())) return fail('config_error');
  let context;
  try {
    context = mode === 'reviewer' ? boundedReviewerInput(input)
      : text(input?.question, 2000) ? { question: input.question, intents: INTENTS, fields: FIELDS } : invalid();
  } catch { return fail('config_error'); }
  const config = credentialConfig(env);
  const origin = testOrigin(env);
  const url = config && vertexUrl(config.project, origin ?? undefined, env.VERTEX_LOCATION ?? 'global');
  if (!url) return fail('config_error');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timer, abortListener;
  const expired = new Promise((_, reject) => {
    abortListener = () => reject(new Error('timeout'));
    controller.signal.addEventListener('abort', abortListener, { once: true });
    timer = setTimeout(abort, ASSIST_TIMEOUT_MS);
    if (controller.signal.aborted) reject(new Error('timeout'));
  });
  // WIF retains its own 5 s ceiling. Add the shared deadline without changing extractor authentication.
  const boundedFetch = async (target, init = {}) => {
    const active = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    active.throwIfAborted();
    let rejectAbort;
    const stopped = new Promise((_, reject) => {
      rejectAbort = () => reject(new Error('aborted'));
      active.addEventListener('abort', rejectAbort, { once: true });
    });
    try { return await Promise.race([stopped, fetcher(target, { ...init, signal: active })]); }
    finally { active.removeEventListener('abort', rejectAbort); }
  };
  try {
    return await Promise.race([expired, (async () => {
      const token = await accessToken(config, { fetcher: boundedFetch, origin });
      controller.signal.throwIfAborted();
      if (!token) return fail('auth_error');
      const body = {
        model: ASSIST_MODEL,
        messages: [{ role: 'system', content: PROMPTS[mode] }, { role: 'user', content: JSON.stringify({ language, ...context }) }],
        temperature: 0, reasoning_effort: 'minimal', max_tokens: mode === 'reviewer' ? 1024 : 128,
        response_format: { type: 'json_schema', json_schema: { name: 'support_' + mode, strict: true, schema: SCHEMAS[mode] } }
      };
      usage.llm_calls = 1;
      usage.usage_unavailable_calls = 1;
      let response, payload;
      try {
        response = await boundedFetch(url, { method: 'POST', redirect: 'manual',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!response.ok) {
          response.body?.cancel().catch(() => {});
          return fail(response.status === 401 || response.status === 403 ? 'auth_error'
            : response.status === 429 || response.status >= 500 ? 'provider_error' : 'config_error');
        }
        // Bound envelope bytes too; do not buffer an arbitrary provider payload.
        const reader = response.body?.getReader();
        if (!reader) return fail('provider_error');
        const cancelRead = () => { reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', cancelRead, { once: true });
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        let bytes = 0, raw = '';
        try {
          while (true) {
            controller.signal.throwIfAborted();
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 65536) throw new Error('Provider body limit');
            raw += decoder.decode(part.value, { stream: true });
          }
          raw += decoder.decode();
        } catch (error) {
          // Cancellation can itself stall: request it, then release the lock and return the safe failure.
          cancelRead();
          throw error;
        } finally {
          controller.signal.removeEventListener('abort', cancelRead);
          reader.releaseLock();
        }
        controller.signal.throwIfAborted();
        payload = JSON.parse(raw);
      } catch { return fail(controller.signal.aborted ? 'timeout' : 'provider_error'); }
      if (!object(payload) || Object.hasOwn(payload, 'error')) return fail('provider_error');
      const u = payload.usage;
      const knownInput = object(u) && Number.isSafeInteger(u.prompt_tokens) && u.prompt_tokens >= 0;
      const knownOutput = object(u) && Number.isSafeInteger(u.completion_tokens) && u.completion_tokens >= 0;
      if (knownInput) usage.known_input_tokens = u.prompt_tokens;
      if (knownOutput) usage.known_output_tokens = u.completion_tokens;
      if (knownInput && knownOutput) usage.usage_unavailable_calls = 0;
      try {
        const choice = payload.choices?.[0];
        if (choice?.finish_reason !== 'stop' || choice.message?.tool_calls) invalid();
        const value = parseAssist(mode, choice.message?.content);
        return { ok: true, value: mode === 'reviewer' ? { ...value, context_truncated: context.context_truncated } : value, usage };
      } catch { return fail('invalid_output'); }
    })()]);
  } catch { return fail('timeout'); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', abortListener);
  }
}
