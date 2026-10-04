/**
 * Guided reports use authenticated ownership and durable start receipts. An incomplete handoff with details may get AI
 * suggestions after its response (``suggestions.js``, switch off by default); the customer reads and answers them here.
 */
import { SESSION_MS, requireSession, tokenHash } from '../../auth/session.js';
import { fail, json, readJsonBody, readCookies } from '../../http.js';
import { UUID, validateStartRequest, validateHandoffRequest } from './validation.js';
import { newArm, runSuggestion } from './suggestions.js';
import { postOutcome, threadJson, validateMessage } from './messages.js';
import { EMAIL_FAILURE_RETRY_MS, SHORT_REFERENCE, UPDATE_EVERY_MS, createStore } from '../../store/d1.js';
import { deliver } from '../../notify/dispatch.js';
import { STATUS_TEXT } from '../../notify/templates.js';
import { urgencyOf } from './urgency.js';
import URGENCY from '../../config/urgency.json' with { type: 'json' };

/**
 * POST /intake/start: start or replay an explicit guided report; never return a case protocol. Optional previous_protocol
 * links a new episode to this customer's acknowledged closed report; ownership and closed state are rechecked in the write.
 */
export async function startIntake(request, env, store) {
  const current = await requireSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const checked = validateStartRequest(body.value);
  if (checked.error) return fail(checked.error.status, checked.error.detail);
  let result;
  try {
    result = await store.startIntake({ ...checked.value, customerId: current.customer_id,
      now: Date.now(), expiresAt: current.expires_at,
      ...(checked.value.previousProtocol && { sessionHash: await tokenHash(readCookies(request).demo_session) }) });
  } catch {
    return fail(503, 'Start not confirmed; retry with the same idempotency key');
  }
  if (result.conflict) return fail(409, 'Key already used with different content');
  if (result.previousError) {
    // A failed insert must not reveal the source's existence or status after authority was lost during the request.
    const live = await requireSession(request, store, 'customer');
    if (!live || live.customer_id !== current.customer_id) return fail(401, 'Start a demo session first');
    return fail(result.previousError, result.previousError === 404 ? 'Previous report not found'
      : result.previousError === 409 ? 'Previous report is not closed' : 'Start a demo session first');
  }
  const { episode, replayed } = result;
  if (!episode) return fail(503, 'Start not confirmed; retry with the same idempotency key');
  return json({ ...JSON.parse(episode.response_json), replayed }, replayed ? 200 : 201);
}

/** POST /intake/confirm: confirm current owned evidence, then verify the durable receipt. */
export const confirmIntake = (request, env, store, ctx) => finishIntake(request, env, store, ctx, true);
/**
 * POST /intake/handoff: explicitly request human review without inventing a confirmed transaction. A new handoff with
 * ``details`` gets a suggestion run (its pilot arm) in its reservation batch only while the switch is on; after the
 * acknowledged response, the Worker schedules ``runSuggestion`` in ctx.waitUntil (no ctx, as in direct unit calls:
 * nothing is scheduled). The response is the same whatever the switch or the run does.
 */
export const handoffIntake = (request, env, store, ctx) => finishIntake(request, env, store, ctx, false);

/**
 * Reserve immutable handoff content; a failed write/read keeps the original key and never promises a reference.
 * The first acknowledgement may queue a "received" email; it is sent in ctx.waitUntil after the response.
 */
async function finishIntake(request, env, store, ctx, complete) {
  const started = performance.now();
  const current = await requireSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const checked = validateHandoffRequest(body.value, complete);
  if (checked.error) return fail(checked.error.status, checked.error.detail);
  const { episodeId, turnKey, transactionId, details } = checked.value;
  const customerId = current.customer_id;
  const episode = await store.findIntake(customerId, episodeId);
  if (!episode) return fail(404, 'Episode not found for this session');
  if (turnKey === episode.start_key) return fail(409, 'Key already used with different content');
  // Details join the hash only when sent, so handoffs reserved before they existed still replay.
  const payloadHash = await tokenHash(JSON.stringify([complete ? 'complete' : 'incomplete', transactionId, ...(details ? [details] : [])]));
  const prior = await store.findOwnedIntakeHandoff(customerId, episodeId);
  if (prior && (prior.turn_key !== turnKey || prior.payload_hash !== payloadHash)) return fail(409, 'Episode already submitted with different content or key');
  if (prior?.kind === 'complete' && episode.state === 'handoff_pending' && Date.parse(prior.accepted_at) + SESSION_MS <= Date.now())
    return fail(409, 'Reservation expired; start a new report');
  if (!prior && episode.state !== 'selection_required') return fail(409, 'Episode is no longer open');
  // The statement column holds 10–2000 code points; the appended details must fit (one newline between).
  if (!prior && details && [...episode.customer_statement].length + 1 + [...details].length > 2000) return fail(422, 'Statement and details exceed 2000 characters together');
  let kind = complete ? 'complete' : 'incomplete';
  let evidence = null;
  let toolCalls = 0;
  let urgency = 'normal';
  if (!prior && complete) {
    try { toolCalls++; evidence = await store.findOwnedTransaction(customerId, transactionId); }
    catch { kind = 'technical'; }
    if (kind === 'complete' && !evidence) return fail(404, 'Transaction not found for this session');
    // Only a new confirmation is checked: a replay has a prior reservation and returns its receipt above this branch.
    // A fast refusal; the reservation batch repeats this check atomically, so two confirms in the same instant still open one report.
    if (kind === 'complete' && await store.openReportForTransaction(customerId, transactionId)) return fail(409, 'This charge already has an open report');
  }
  // Stated policy, not a fitted threshold (DF-024): a reason in ``high_reasons`` (ADR-010) is high on every kind, so a
  // lost card reported without a listed charge still heads the queue; otherwise only a confirmed charge is ranked, by the
  // p95 of the customer's most recent 21 served purchases (newest first), without the chosen one. A failed read leaves
  // only the fixed amount; the report is still accepted.
  // A charge the bank itself flagged (ADR-011: the bank's input, not an inference of ours) is high too.
  if (!prior) urgency = URGENCY.high_reasons.includes(episode.reason) || evidence?.bank_flagged === 1 ? 'high' : kind !== 'complete' ? 'normal'
    : urgencyOf(evidence, (await store.listTransactions(customerId, 21).catch(() => [])).filter(t => t.transaction_id !== transactionId), URGENCY);
  // The flag decides urgency only; the stored evidence keeps the charge's own fields, as before.
  if (evidence) delete evidence.bank_flagged;
  const live = await requireSession(request, store, 'customer');
  if (!live || live.customer_id !== customerId) return fail(401, 'Start a demo session first');
  const sessionHash = await tokenHash(readCookies(request).demo_session);
  try {
    toolCalls++;
    const suggestionArm = !complete && details ? newArm(env) : undefined;
    const result = await store.persistIntakeHandoff({ customerId, episodeId, turnKey, payloadHash,
      sessionHash, details, urgency, suggestionArm,
      completeCase: kind === 'complete' ? evidence : null, kind,
      evidence: { transaction: evidence, tool_status: kind === 'technical' ? 'failed' : 'ok' },
      actions: kind === 'complete' ? ['owned_transaction_retrieved', 'customer_confirmation_recorded'] : kind === 'technical' ? ['transaction_lookup_failed'] : [],
      questions: kind === 'complete' ? [] : ['matching_transaction', 'customer_confirmation'],
      usage: { tool_calls: 0, operation_duration_ms: 0 }, now: Date.now() });
    if (result.conflict) return fail(409, 'Episode already submitted with different content or key');
    if (!result.handoff) return await unreserved(request, store, { customerId, episodeId, toolCalls, started, transactionId: kind === 'complete' ? transactionId : null });
    toolCalls++;
    const receipt = await store.readIntakeReceipt(customerId, episodeId, { sessionHash, now: Date.now() });
    if (!receipt) throw new Error('Receipt not read back');
    toolCalls++;
    const { acknowledged, emailId } = await store.finishIntakeHandoff({ customerId, episode, receipt, sessionHash, now: Date.now(), operationDuration: Math.floor(performance.now() - started), toolCalls });
    if (!acknowledged) {
      if (receipt.kind === 'complete' && Date.parse(receipt.accepted_at) + SESSION_MS <= Date.now())
        return fail(409, 'Reservation expired; start a new report');
      await store.recordIntakeAttempt({ customerId, episodeId, toolCalls, operationDuration: Math.floor(performance.now() - started) });
      return fail(401, 'Session expired; renew the same customer session and retry with the same idempotency key');
    }
    const protocol = receipt.complete_case_id ?? receipt.handoff_id;
    // After the response, never in it; a store of its own, so its queries never count in this response's metrics. A replay
    // schedules it too: the run's atomic claim lets only one runner read a run, so a first request whose Worker stopped
    // before the run started is finished by its replay, and a run already claimed is left alone.
    if (suggestionArm !== undefined && ctx?.waitUntil) ctx.waitUntil(runSuggestion(env, createStore(env.DB),
      { handoffId: receipt.handoff_id, customerId, details, language: episode.language }));
    // A store of its own, so the send's queries never count in this response's metrics; skipped without a ctx.
    if (emailId && ctx?.waitUntil) ctx.waitUntil(deliver(env, createStore(env.DB),
      { messageId: emailId, customerId, language: episode.language, reference: receipt.reference_short ?? protocol, urgent: receipt.urgency === 'high' }));
    return json({ episode_id: episodeId, protocol,
      reference_short: receipt.reference_short ?? null, kind: receipt.kind, accepted_at: receipt.accepted_at, replayed: result.replayed,
      urgency: receipt.urgency, ...(receipt.urgency === 'high' && { block_card_line: URGENCY.demo_block_line }),
      // From the read-back row, so the customer sees only what was durably recorded.
      actions_taken: JSON.parse(receipt.actions_json), unresolved_questions: JSON.parse(receipt.questions_json),
      next_step_code: 'await_human_review' }, result.replayed ? 200 : 201);
  } catch {
    try { await store.recordIntakeAttempt({ customerId, episodeId, toolCalls, operationDuration: Math.floor(performance.now() - started) }); } catch { /* Persistence may also be unavailable; never promise a receipt. */ }
    return fail(503, 'Acceptance not confirmed; retry with the same idempotency key');
  }
}

/**
 * The reservation's SQL checks refused to reserve (session expired in SQL, a sweep closed the episode, the owned
 * transaction vanished, or another report on the charge won a race). Record the attempt's usage while the episode is
 * open, then answer from a fresh read: no live same-owner session -> 401; an open report on the confirmed charge -> 409;
 * episode closed without a reservation -> 409; otherwise acceptance stays unknown.
 */
async function unreserved(request, store, { customerId, episodeId, toolCalls, started, transactionId = null }) {
  try { await store.recordIntakeAttempt({ customerId, episodeId, toolCalls, operationDuration: Math.floor(performance.now() - started) }); } catch { /* best effort */ }
  try {
    const live = await requireSession(request, store, 'customer');
    if (!live || live.customer_id !== customerId) return fail(401, 'Session expired; renew the same customer session and retry with the same idempotency key');
    if (transactionId && await store.openReportForTransaction(customerId, transactionId)) return fail(409, 'This charge already has an open report');
    const [episode, reservation] = [await store.findIntake(customerId, episodeId), await store.findOwnedIntakeHandoff(customerId, episodeId)];
    if (episode && episode.state !== 'selection_required' && !reservation) return fail(409, 'Episode is no longer open');
  } catch { /* Storage may be unavailable; never promise a receipt. */ }
  return fail(503, 'Acceptance not confirmed; retry with the same idempotency key');
}

/**
 * POST /reports/feedback ``{ protocol, easy }``: the customer's answer, on the receipt, to "was it easy to report this
 * charge?" for an own acknowledged report. The first answer stands: the same answer again is 200, a different one 409.
 * A missing or another customer's report is the same 404. It is stored on the report, never in events or logs.
 */
export async function recordFeedback(request, env, store) {
  const current = await requireSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const value = body.value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'easy,protocol'
    || typeof value.protocol !== 'string' || !UUID.test(value.protocol) || typeof value.easy !== 'boolean') {
    return fail(422, 'Provide exactly a protocol and a boolean easy');
  }
  const protocol = value.protocol.toLowerCase();
  const sessionHash = await tokenHash(readCookies(request).demo_session);
  const stored = await store.recordReportFeedback(current.customer_id, protocol, value.easy, Date.now(), sessionHash);
  if (!stored) {
    const live = await requireSession(request, store, 'customer');
    if (!live || live.customer_id !== current.customer_id) return fail(401, 'Start a demo session first');
    return fail(404, 'Report not found');
  }
  if (Boolean(stored.easy) !== value.easy) return fail(409, 'Feedback already recorded for this report');
  return json({ protocol, easy: value.easy, recorded_at: new Date(stored.created_at).toISOString() });
}

const REPORTS_PAGE = 20;
/** What happens next for the customer, per stored review status. */
const NEXT_STEP = { received: 'review_pending', in_review: 'being_reviewed', closed: 'closed_by_person' };
/** GET /reports: the session customer's own acknowledged reports, newest first, each with its confirmed charge id or null; no statement, evidence or episode id. */
export async function listReports(request, env, store) {
  const current = await requireSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  if (new URL(request.url).search) return fail(422, 'Unexpected parameters');
  const rows = await store.listCustomerHandoffs(current.customer_id, REPORTS_PAGE + 1);
  return json({ items: rows.slice(0, REPORTS_PAGE).map(({ protocol, reference_short, kind, status, closing_note, accepted_at, transaction_id }) =>
    ({ protocol, reference_short: reference_short ?? null, kind, status, closing_note: closing_note ?? null, next_step: NEXT_STEP[status], accepted_at, transaction_id: transaction_id ?? null })),
    has_more: rows.length > REPORTS_PAGE });
}

/**
 * GET /intake/service-times: how long unrecognized-charge complaints waited at this bank, historically (the reviewed Gold
 * aggregate in ``service_timing``). The same for every customer, but served only to a live customer session, like the
 * rest of the report flow. ``first_response`` is what the customer is told; ``creation_to_resolution`` covers resolved
 * complaints only (``covers: 'resolved_only'``), so a client must never show it as an expected time. No baseline: 503.
 */
export async function getServiceTimes(request, env, store) {
  const current = await requireSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  if (new URL(request.url).search) return fail(422, 'Unexpected parameters');
  const rows = await store.serviceTiming();
  if (!rows.length) return fail(503, 'Service times unavailable');
  const { version, published_on, subcategory, window_start, window_end_exclusive, source, population } = rows[0];
  return json({ basis: 'bank_history', version, published_on,
    population: { subcategory, window_start, window_end_exclusive, complaints: population, source },
    metrics: rows.map(({ metric, unit, p50, p90, n, missing, negative }) =>
      ({ metric, unit, p50, p90, n, missing, negative, covers: metric === 'creation_to_resolution' ? 'resolved_only' : 'responded' })) });
}

/**
 * POST /reports/update ``{ protocol }``: email the session customer the status of one of their acknowledged reports.
 * Foreign and missing reports get the same 404; no target 409; one queued or SES-accepted ``update`` email per report
 * per 5 minutes (429). A failed or skipped attempt stays auditable in the outbox and can be retried after 10 seconds.
 * On an act-as session the email (and its outbox row and window) is the signed-in admin's own, never the customer's.
 */
export async function requestUpdate(request, env, store, ctx) {
  const current = await requireSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const value = body.value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'protocol'
    || typeof value.protocol !== 'string' || !UUID.test(value.protocol)) return fail(422, 'Invalid protocol');
  // An admin acting as a customer asked for this update, so it goes to the admin's own address (ADR-007, decision 10).
  const customerId = current.acting_admin_customer_id ?? current.customer_id;
  const report = await store.findCustomerReport(current.customer_id, value.protocol.toLowerCase(), customerId);
  if (!report) return fail(404, 'Report not found');
  if (!report.has_target) return fail(409, 'No email on file for this sign-in');
  const reference = report.reference_short ?? report.protocol;
  const now = Date.now();
  const messageId = crypto.randomUUID();
  // The window is checked inside the insert, so concurrent requests queue one; only a refusal reads the newest row.
  if (!(await store.enqueueEmail({ messageId, now, customerId, template: 'update', language: report.language, reference })).length) {
    const retryAt = await store.recentEmailRetryAt(customerId, reference, now - UPDATE_EVERY_MS);
    return fail(429, 'An update request is already in progress or was accepted recently',
      { 'Retry-After': String(Math.max(1, Math.ceil(((retryAt ?? now + EMAIL_FAILURE_RETRY_MS) - now) / 1000))) });
  }
  ctx?.waitUntil?.(deliver(env, createStore(env.DB), { messageId, customerId, language: report.language, reference,
    template: 'update', status: STATUS_TEXT[report.status][report.language] }));
  return json({ queued: true }, 202);
}

/**
 * GET /intake/handoff/{protocol or short reference}/messages: the thread between the session customer and the agent on
 * their own acknowledged report (ADR-015), oldest first, with ``can_post``. Another customer's or a missing report: 404.
 */
export async function getMessages(request, env, store) {
  const current = await requireSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  if (new URL(request.url).search) return fail(422, 'Unexpected parameters');
  const ref = reportRef(request, '/messages');
  const found = ref && await store.listMessages({ customerId: current.customer_id, ...ref });
  return found ? json(threadJson(found)) : fail(404, 'Report not found');
}

/**
 * POST /intake/handoff/{protocol or short reference}/messages ``{ body, idempotency_key }``: the session customer writes
 * to the agent on their own report, until it is closed. A retry with the same key stores one message (``postOutcome``).
 */
export async function postMessage(request, env, store) {
  const current = await requireSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  if (new URL(request.url).search) return fail(422, 'Unexpected parameters');
  const ref = reportRef(request, '/messages');
  if (!ref) return fail(404, 'Report not found');
  const parsed = await readJsonBody(request);
  if (parsed.error) return parsed.error;
  const checked = validateMessage(parsed.value);
  if (checked.error) return checked.error;
  const messageId = crypto.randomUUID();
  const found = await store.postMessage({ customerId: current.customer_id, ...ref, author: 'customer', body: checked.value.body,
    key: checked.value.key, now: Date.now(), messageId, sessionHash: await tokenHash(readCookies(request).demo_session) });
  return postOutcome(found, messageId, checked.value.body);
}

/** The report a suggestion path names: a protocol (UUID, any case) or a short reference; anything else is null. */
function reportRef(request, suffix) {
  const segment = new URL(request.url).pathname.slice('/intake/handoff/'.length, -suffix.length);
  if (UUID.test(segment)) return { protocol: segment.toLowerCase(), short: '' };
  return SHORT_REFERENCE.test(segment) ? { protocol: '', short: segment } : null;
}
const charge = ({ transaction_id, merchant_name, amount, currency, occurred_at, source_occurred_at }) =>
  ({ transaction_id, merchant_name, amount, currency, occurred_at, source_occurred_at });

/**
 * GET /intake/handoff/{protocol or short reference}/suggestions: for the session customer's own acknowledged report,
 * ``status`` ``pending`` (the run has not finished), ``none`` (no run, or any outcome but ``suggested``) or
 * ``suggested`` with up to three of their own charges as stored, plus the customer's answer if any. A missing or
 * another customer's report is the same 404. Optional reason groups recorded outcomes without provider details, model output or usage.
 */
export async function getSuggestions(request, env, store) {
  const current = await requireSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  if (new URL(request.url).search) return fail(422, 'Unexpected parameters');
  const ref = reportRef(request, '/suggestions');
  // The first read that serves suggested charges stamps shown_at in the same round trip (``not_shown`` is its absence).
  const found = ref && await store.findCustomerSuggestions(current.customer_id, ref.protocol, ref.short, { shownAt: Date.now() });
  if (!found) return fail(404, 'Report not found');
  const status = found.outcome === null ? 'pending' : found.outcome === 'suggested' && found.items.length ? 'suggested' : 'none';
  // The charges are served only while they can be answered, or with the answer given: once an agent opened an unanswered
  // report, the status stays 'suggested' but nothing is shown (and shown_at is not stamped).
  const answerable = status === 'suggested' && found.choice === null && found.answerable;
  const reason = found.choice === null && !found.answerable ? 'review_started'
    : status === 'none' ? (['no_match', 'ambiguous'].includes(found.outcome) ? 'no_clear_match' : 'unavailable') : undefined;
  return json({ status, ...(reason && { reason }), items: answerable || (status === 'suggested' && found.choice !== null) ? found.items.map(charge) : [], choice: found.choice,
    chosen_transaction_id: found.chosen_transaction_id, answerable });
}

const validTransactionId = v => typeof v === 'string' && v.length > 0 && v.length <= 100 && v.isWellFormed() && !v.includes('\u0000');

/**
 * POST /intake/handoff/{protocol or short reference}/suggestions/confirm with exactly ``{ transaction_id }`` (one of the
 * charges suggested for that report) or ``{ none: true }``. The first answer stands: the same answer again is 200, a
 * different one 409. A charge that was not suggested for it is 422, never stored; a missing or another customer's
 * report, or one without suggestions, is 404. Once an agent has opened the report (or moved it on), a first answer is
 * 409 with ``code: already_in_review`` and stores nothing, so the agent never reviews an answer that arrived mid-review.
 * It records the customer's answer only; nothing closes or is decided.
 */
export async function confirmSuggestion(request, env, store) {
  const current = await requireSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const value = body.value;
  const keys = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).join() : '';
  if (!(keys === 'transaction_id' && validTransactionId(value.transaction_id)) && !(keys === 'none' && value.none === true)) {
    return fail(422, 'Provide exactly a suggested transaction_id or none: true');
  }
  const ref = reportRef(request, '/suggestions/confirm');
  if (!ref) return fail(404, 'Report not found');
  const transactionId = keys === 'none' ? null : value.transaction_id;
  const now = Date.now();
  const stored = await store.confirmSuggestion({ customerId: current.customer_id, protocol: ref.protocol, short: ref.short, transactionId, now,
    sessionHash: await tokenHash(readCookies(request).demo_session) });
  if (!stored) {
    const live = await requireSession(request, store, 'customer');
    if (!live || live.customer_id !== current.customer_id) return fail(401, 'Start a demo session first');
    const found = await store.findCustomerSuggestions(current.customer_id, ref.protocol, ref.short);
    if (!found) return fail(404, 'Report not found');
    if (found.outcome !== 'suggested' || !found.items.length) return fail(404, 'No suggestions for this report');
    if (transactionId !== null && !found.items.some(c => c.transaction_id === transactionId)) return fail(422, 'Not one of the suggested charges');
    return json({ detail: 'An agent is already reviewing this report; the answer can no longer be added', code: 'already_in_review' }, 409);
  }
  if ((stored.choice === 'none') !== (transactionId === null) || (transactionId !== null && stored.transaction_id !== transactionId)) {
    return fail(409, 'An answer is already recorded for these suggestions');
  }
  return json({ choice: stored.choice, transaction_id: stored.transaction_id ?? null, chosen_at: new Date(stored.chosen_at).toISOString() });
}
