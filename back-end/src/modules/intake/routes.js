/** Guided reports use authenticated ownership and durable start receipts; the extractor switch (off by default) only records a shadow call. */
import { readSession, tokenHash } from '../../auth/session.js';
import { fail, json, readJsonBody, readCookies } from '../../http.js';
import { UUID, validateStartRequest, validateHandoffRequest } from './validation.js';
import { APPROVED_EXTRACTOR, extractShadow, readyExtractor } from './ai-transport.js';
import { createStore } from '../../store/d1.js';
import { deliver } from '../../notify/dispatch.js';
import { STATUS_TEXT } from '../../notify/templates.js';

/**
 * POST /intake/start: start or replay an explicit guided report; never return a case protocol. With the switch on,
 * a new start also makes one shadow extraction call (at most 10 s) and records only its usage; the response is
 * the guided one whatever the call returns. ``ctx`` is the Worker context, so the shadow call runs in waitUntil after
 * the response; ``approved`` is a test seam: the router never passes it.
 */
export async function startIntake(request, env, store, ctx, approved = APPROVED_EXTRACTOR) {
  const current = await readSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const checked = validateStartRequest(body.value);
  if (checked.error) return fail(checked.error.status, checked.error.detail);
  const extractor = await readyExtractor(env, approved);
  let result;
  try {
    result = await store.startIntake({ ...checked.value, customerId: current.customer_id,
      now: Date.now(), expiresAt: current.expires_at, ...(extractor && { producer: extractor.modelVersion }) });
  } catch {
    return fail(503, 'Start not confirmed; retry with the same idempotency key');
  }
  if (result.conflict) return fail(409, 'Key already used with different content');
  const { episode, replayed } = result;
  if (!episode) return fail(503, 'Start not confirmed; retry with the same idempotency key');
  if (extractor && !replayed) {
    // Shadow only: the answer is discarded, so the customer never waits for it. In the Worker it runs after the
    // response, in ctx.waitUntil; without a ctx (direct calls in tests) it runs inline.
    const shadow = async () => {
      const { usage } = await extractShadow(env, extractor, checked.value);
      try {
        await store.recordIntakeExtraction({ customerId: current.customer_id, episodeId: episode.episode_id, producer: extractor.modelVersion, usage });
      } catch { /* The start already recorded one call with unknown usage. */ }
    };
    if (ctx?.waitUntil) ctx.waitUntil(shadow().catch(() => { /* already recorded as one call with unknown usage */ }));
    else await shadow();
  }
  return json({ ...JSON.parse(episode.response_json), replayed }, replayed ? 200 : 201);
}

/** POST /intake/confirm: confirm current owned evidence, then verify the durable receipt. */
export const confirmIntake = (request, env, store, ctx) => finishIntake(request, env, store, ctx, true);
/** POST /intake/handoff: explicitly request human review without inventing a confirmed transaction. */
export const handoffIntake = (request, env, store, ctx) => finishIntake(request, env, store, ctx, false);

/**
 * Reserve immutable handoff content; a failed write/read keeps the original key and never promises a reference.
 * The first acknowledgement may queue a "received" email; it is sent in ctx.waitUntil after the response.
 */
async function finishIntake(request, env, store, ctx, complete) {
  const started = performance.now();
  const current = await readSession(request, store, 'customer');
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
  if (!prior && episode.state !== 'selection_required') return fail(409, 'Episode is no longer open');
  // The statement column holds 10–2000 code points; the appended details must fit (one newline between).
  if (!prior && details && [...episode.customer_statement].length + 1 + [...details].length > 2000) return fail(422, 'Statement and details exceed 2000 characters together');
  let kind = complete ? 'complete' : 'incomplete';
  let evidence = null;
  let toolCalls = 0;
  if (!prior && complete) {
    try { toolCalls++; evidence = await store.findOwnedTransaction(customerId, transactionId); }
    catch { kind = 'technical'; }
    if (kind === 'complete' && !evidence) return fail(404, 'Transaction not found for this session');
  }
  const live = await readSession(request, store, 'customer');
  if (!live || live.customer_id !== customerId) return fail(401, 'Start a demo session first');
  const sessionHash = await tokenHash(readCookies(request).demo_session);
  try {
    toolCalls++;
    const result = await store.persistIntakeHandoff({ customerId, episodeId, turnKey, payloadHash,
      sessionHash, details,
      completeCase: kind === 'complete' ? evidence : null, kind,
      evidence: { transaction: evidence, tool_status: kind === 'technical' ? 'failed' : 'ok' },
      actions: kind === 'complete' ? ['owned_transaction_retrieved', 'customer_confirmation_recorded'] : kind === 'technical' ? ['transaction_lookup_failed'] : [],
      questions: kind === 'complete' ? [] : ['matching_transaction', 'customer_confirmation'],
      usage: { tool_calls: 0, operation_duration_ms: 0 }, now: Date.now() });
    if (result.conflict) return fail(409, 'Episode already submitted with different content or key');
    if (!result.handoff) return await unreserved(request, store, { customerId, episodeId, toolCalls, started });
    toolCalls++;
    const receipt = await store.readIntakeReceipt(customerId, episodeId, { sessionHash, now: Date.now() });
    if (!receipt) throw new Error('Receipt not read back');
    toolCalls++;
    const { acknowledged, emailId } = await store.finishIntakeHandoff({ customerId, episode, receipt, sessionHash, now: Date.now(), operationDuration: Math.floor(performance.now() - started), toolCalls });
    if (!acknowledged) {
      await store.recordIntakeAttempt({ customerId, episodeId, toolCalls, operationDuration: Math.floor(performance.now() - started) });
      return fail(401, 'Session expired; renew the same customer session and retry with the same idempotency key');
    }
    const protocol = receipt.complete_case_id ?? receipt.handoff_id;
    // A store of its own, so the send's queries never count in this response's metrics; skipped without a ctx.
    if (emailId && ctx?.waitUntil) ctx.waitUntil(deliver(env, createStore(env.DB),
      { messageId: emailId, customerId, language: episode.language, reference: receipt.reference_short ?? protocol }));
    return json({ episode_id: episodeId, protocol,
      reference_short: receipt.reference_short ?? null, kind: receipt.kind, accepted_at: receipt.accepted_at, replayed: result.replayed,
      // From the read-back row, so the customer sees only what was durably recorded.
      actions_taken: JSON.parse(receipt.actions_json), unresolved_questions: JSON.parse(receipt.questions_json),
      next_step_code: 'await_human_review' }, result.replayed ? 200 : 201);
  } catch {
    try { await store.recordIntakeAttempt({ customerId, episodeId, toolCalls, operationDuration: Math.floor(performance.now() - started) }); } catch { /* Persistence may also be unavailable; never promise a receipt. */ }
    return fail(503, 'Acceptance not confirmed; retry with the same idempotency key');
  }
}

/**
 * The reservation's SQL checks refused to reserve (session expired in SQL, a sweep closed the episode, or the owned
 * transaction vanished). Record the attempt's usage while the episode is open, then answer from a fresh read:
 * no live same-owner session -> 401; episode closed without a reservation -> 409; otherwise acceptance stays unknown.
 */
async function unreserved(request, store, { customerId, episodeId, toolCalls, started }) {
  try { await store.recordIntakeAttempt({ customerId, episodeId, toolCalls, operationDuration: Math.floor(performance.now() - started) }); } catch { /* best effort */ }
  try {
    const live = await readSession(request, store, 'customer');
    if (!live || live.customer_id !== customerId) return fail(401, 'Session expired; renew the same customer session and retry with the same idempotency key');
    const [episode, reservation] = [await store.findIntake(customerId, episodeId), await store.findOwnedIntakeHandoff(customerId, episodeId)];
    if (episode && episode.state !== 'selection_required' && !reservation) return fail(409, 'Episode is no longer open');
  } catch { /* Storage may be unavailable; never promise a receipt. */ }
  return fail(503, 'Acceptance not confirmed; retry with the same idempotency key');
}

const REPORTS_PAGE = 20;
/** GET /reports: the session customer's own acknowledged reports, newest first; no statement, evidence or episode id. */
export async function listReports(request, env, store) {
  const current = await readSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  if (new URL(request.url).search) return fail(422, 'Unexpected parameters');
  const rows = await store.listCustomerHandoffs(current.customer_id, REPORTS_PAGE + 1);
  // status and next_step are constants until Phase 4 stores a review status per handoff.
  return json({ items: rows.slice(0, REPORTS_PAGE).map(({ protocol, reference_short, kind, accepted_at }) =>
    ({ protocol, reference_short: reference_short ?? null, kind, status: 'received', next_step: 'review_pending', accepted_at })),
    has_more: rows.length > REPORTS_PAGE });
}

const UPDATE_EVERY_MS = 300000;
/**
 * POST /reports/update ``{ protocol }``: email the session customer the status of one of their acknowledged reports.
 * Foreign and missing reports get the same 404; no target 409; one ``update`` email per report per 5 minutes (429).
 */
export async function requestUpdate(request, env, store, ctx) {
  const current = await readSession(request, store, 'customer');
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
  // ponytail: check-then-insert, so two simultaneous requests can both queue; a conditional INSERT closes it if that matters.
  const { count, latest } = await store.recentEmails(customerId, reference, now - UPDATE_EVERY_MS, 'update');
  if (count) return fail(429, 'An update was sent recently', { 'Retry-After': String(Math.max(1, Math.ceil((latest + UPDATE_EVERY_MS - now) / 1000))) });
  const messageId = crypto.randomUUID();
  await store.enqueueEmail({ messageId, now, customerId, template: 'update', language: report.language, reference });
  // Status is a constant until Phase 4 stores a review status per handoff; same as listReports.
  ctx?.waitUntil?.(deliver(env, createStore(env.DB), { messageId, customerId, language: report.language, reference,
    template: 'update', status: STATUS_TEXT.received[report.language] }));
  return json({ queued: true }, 202);
}
