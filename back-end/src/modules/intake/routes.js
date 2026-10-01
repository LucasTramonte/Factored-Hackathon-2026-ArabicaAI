/** Guided reports use authenticated ownership and durable start receipts; the extractor switch (off by default) only records a shadow call. */
import { readSession, tokenHash } from '../../auth/session.js';
import { fail, json, readJsonBody, readCookies } from '../../http.js';
import { validateStartRequest, validateHandoffRequest } from './validation.js';
import { APPROVED_EXTRACTOR, extractShadow, readyExtractor } from './ai-transport.js';

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
export const confirmIntake = (request, env, store) => finishIntake(request, store, true);
/** POST /intake/handoff: explicitly request human review without inventing a confirmed transaction. */
export const handoffIntake = (request, env, store) => finishIntake(request, store, false);

/** Reserve immutable handoff content; a failed write/read keeps the original key and never promises a reference. */
async function finishIntake(request, store, complete) {
  const started = performance.now();
  const current = await readSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const checked = validateHandoffRequest(body.value, complete);
  if (checked.error) return fail(checked.error.status, checked.error.detail);
  const { episodeId, turnKey, transactionId } = checked.value;
  const customerId = current.customer_id;
  const episode = await store.findIntake(customerId, episodeId);
  if (!episode) return fail(404, 'Episode not found for this session');
  if (turnKey === episode.start_key) return fail(409, 'Key already used with different content');
  const payloadHash = await tokenHash(JSON.stringify([complete ? 'complete' : 'incomplete', transactionId]));
  const prior = await store.findOwnedIntakeHandoff(customerId, episodeId);
  if (prior && (prior.turn_key !== turnKey || prior.payload_hash !== payloadHash)) return fail(409, 'Episode already submitted with different content or key');
  if (!prior && episode.state !== 'selection_required') return fail(409, 'Episode is no longer open');
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
      sessionHash,
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
    const acknowledged = await store.finishIntakeHandoff({ customerId, episode, receipt, sessionHash, now: Date.now(), operationDuration: Math.floor(performance.now() - started), toolCalls });
    if (!acknowledged) {
      await store.recordIntakeAttempt({ customerId, episodeId, toolCalls, operationDuration: Math.floor(performance.now() - started) });
      return fail(401, 'Session expired; renew the same customer session and retry with the same idempotency key');
    }
    return json({ episode_id: episodeId, protocol: receipt.complete_case_id ?? receipt.handoff_id,
      kind: receipt.kind, accepted_at: receipt.accepted_at, replayed: result.replayed,
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
