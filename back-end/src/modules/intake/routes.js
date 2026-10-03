/** Guided reports use authenticated ownership and durable start receipts; the extractor switch (off by default) only records a shadow call. */
import { SESSION_MS, requireSession, tokenHash } from '../../auth/session.js';
import { fail, json, readJsonBody, readCookies } from '../../http.js';
import { UUID, validateStartRequest, validateHandoffRequest } from './validation.js';
import { APPROVED_EXTRACTOR, UNKNOWN, extractShadow, readyExtractor } from './ai-transport.js';
import { UPDATE_EVERY_MS, createStore } from '../../store/d1.js';
import { deliver } from '../../notify/dispatch.js';
import { STATUS_TEXT } from '../../notify/templates.js';
import { urgencyOf } from './urgency.js';
import URGENCY from '../../config/urgency.json' with { type: 'json' };

/**
 * POST /intake/start: start or replay an explicit guided report; never return a case protocol. With the switch on,
 * a new start also makes one shadow extraction call (at most 10 s) and records only its usage; the response is
 * the guided one whatever the call returns. ``ctx`` is the Worker context, so the shadow call runs in waitUntil after
 * the response; ``approved`` is a test seam: the router never passes it. Optional previous_protocol links a new
 * episode to this customer's acknowledged closed report; ownership and closed state are rechecked in the write.
 */
export async function startIntake(request, env, store, ctx, approved = APPROVED_EXTRACTOR) {
  const current = await requireSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const checked = validateStartRequest(body.value);
  if (checked.error) return fail(checked.error.status, checked.error.detail);
  const extractor = await readyExtractor(env, approved);
  let result;
  try {
    result = await store.startIntake({ ...checked.value, customerId: current.customer_id,
      now: Date.now(), expiresAt: current.expires_at, ...(extractor && { producer: extractor.modelVersion }),
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
  if (extractor && !replayed) await inShadow(ctx, async () => {
    const { usage } = await extractShadow(env, extractor, checked.value);
    // The start already recorded one call with unknown usage; a failed write leaves it.
    await store.recordIntakeExtraction({ customerId: current.customer_id, episodeId: episode.episode_id, producer: extractor.modelVersion, usage });
  });
  return json({ ...JSON.parse(episode.response_json), replayed }, replayed ? 200 : 201);
}

/**
 * Shadow only: the answer is discarded, so the customer never waits for it. In the Worker it runs after the response,
 * in ctx.waitUntil; without a ctx (direct calls in tests) it runs inline. Never throws.
 */
async function inShadow(ctx, work) {
  const run = () => work().catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(run());
  else await run();
}

/** POST /intake/confirm: confirm current owned evidence, then verify the durable receipt. */
export const confirmIntake = (request, env, store, ctx) => finishIntake(request, env, store, ctx, true);
/**
 * POST /intake/handoff: explicitly request human review without inventing a confirmed transaction. With the switch on,
 * a new handoff with ``details`` also makes one shadow call on them (as the start does on the statement) and adds only
 * its usage; ``approved`` is the same test seam as in ``startIntake``.
 */
export const handoffIntake = (request, env, store, ctx, approved = APPROVED_EXTRACTOR) => finishIntake(request, env, store, ctx, false, approved);

/**
 * Reserve immutable handoff content; a failed write/read keeps the original key and never promises a reference.
 * The first acknowledgement may queue a "received" email; it is sent in ctx.waitUntil after the response.
 */
async function finishIntake(request, env, store, ctx, complete, approved = null) {
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
  // A charge the bank's own fraud score flagged (ADR-011, derived from the data) is high too.
  if (!prior) urgency = URGENCY.high_reasons.includes(episode.reason) || evidence?.bank_flagged === 1 ? 'high' : kind !== 'complete' ? 'normal'
    : urgencyOf(evidence, (await store.listTransactions(customerId, 21).catch(() => [])).filter(t => t.transaction_id !== transactionId), URGENCY);
  // The flag decides urgency only; the stored evidence keeps the charge's own fields, as before.
  if (evidence) delete evidence.bank_flagged;
  const live = await requireSession(request, store, 'customer');
  if (!live || live.customer_id !== customerId) return fail(401, 'Start a demo session first');
  const sessionHash = await tokenHash(readCookies(request).demo_session);
  try {
    toolCalls++;
    const result = await store.persistIntakeHandoff({ customerId, episodeId, turnKey, payloadHash,
      sessionHash, details, urgency,
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
    // Only an episode the same extractor started; its events already carry that producer. A replay never calls again.
    const extractor = details && !result.replayed ? await readyExtractor(env, approved) : null;
    if (extractor && JSON.parse(episode.usage_json ?? '{}').model_version === extractor.modelVersion) await inShadow(ctx, async () => {
      // Counted as one unknown call before it runs, so an interrupted Worker never makes it free; then measured − unknown.
      // A store of its own, so these writes never count in this response's metrics.
      const shadowStore = createStore(env.DB);
      const record = usage => shadowStore.recordDetailsExtraction({ customerId, episodeId, producer: extractor.modelVersion, usage });
      await record(UNKNOWN);
      const { usage } = await extractShadow(env, extractor, { statement: details, language: episode.language });
      await record(Object.fromEntries(Object.keys(UNKNOWN).map(k => [k, usage[k] - UNKNOWN[k]])));
    });
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
  return json({ items: rows.slice(0, REPORTS_PAGE).map(({ protocol, reference_short, kind, status, accepted_at, transaction_id }) =>
    ({ protocol, reference_short: reference_short ?? null, kind, status, next_step: NEXT_STEP[status], accepted_at, transaction_id: transaction_id ?? null })),
    has_more: rows.length > REPORTS_PAGE });
}

/**
 * POST /reports/update ``{ protocol }``: email the session customer the status of one of their acknowledged reports.
 * Foreign and missing reports get the same 404; no target 409; one ``update`` email per report per 5 minutes (429).
 */
export async function requestUpdate(request, env, store, ctx) {
  const current = await requireSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const value = body.value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'protocol'
    || typeof value.protocol !== 'string' || !UUID.test(value.protocol)) return fail(422, 'Invalid protocol');
  const customerId = current.customer_id;
  const report = await store.findCustomerReport(customerId, value.protocol.toLowerCase());
  if (!report) return fail(404, 'Report not found');
  if (!report.has_target) return fail(409, 'No email on file for this sign-in');
  const reference = report.reference_short ?? report.protocol;
  const now = Date.now();
  const messageId = crypto.randomUUID();
  // The window is checked inside the insert, so concurrent requests queue one; only a refusal reads the newest row.
  if (!(await store.enqueueEmail({ messageId, now, customerId, template: 'update', language: report.language, reference })).length) {
    const { latest } = await store.recentEmails(customerId, reference, now - UPDATE_EVERY_MS, 'update');
    return fail(429, 'An update was sent recently', { 'Retry-After': String(Math.max(1, Math.ceil(((latest ?? now) + UPDATE_EVERY_MS - now) / 1000))) });
  }
  ctx?.waitUntil?.(deliver(env, createStore(env.DB), { messageId, customerId, language: report.language, reference,
    template: 'update', status: STATUS_TEXT[report.status][report.language] }));
  return json({ queued: true }, 202);
}
