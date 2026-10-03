/**
 * Every SQL statement the service runs. Route handlers never build SQL, so this is the only module
 * to replace if the store moves (for example to PostgreSQL through Hyperdrive).
 *
 * Each call uses ``.all()``, ``.run()`` or ``.batch()`` so D1's ``meta`` is available. ``metrics()`` reports
 * queries, rows read, rows written and round trips for the current request; the budget tests use it.
 * A batch is one round trip and one atomic transaction.
 */
import { SESSION_MS, tokenHash } from '../auth/session.js';

/** Export cursors are server-minted episode ids: lowercase RFC 4122 UUIDs, so text order matches the keyset. */
const EPISODE_CURSOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Housekeeping may not close episodes at a cutoff more than this far past the server clock. */
export const IDLE_CUTOFF_SKEW_MS = 60000;
const IDLE_DUE = 'MIN(e.updated_at+600000,e.expires_at)';
// Model usage of an episode for the sweep's end event: absent keys (the guided flow) are 0, and a total is null
// while any call's usage is unknown.
const USAGE = key => "COALESCE(json_extract(d.usage_json,'$." + key + "'),0)";
const KNOWN = key => "CASE WHEN " + USAGE('usage_unavailable_calls') + '>0 THEN NULL ELSE ' + USAGE(key) + ' END';
const IDLE_CANDIDATES = "FROM intake_episodes e WHERE e.state='selection_required' AND " + IDLE_DUE + '<=? '
  + 'AND NOT EXISTS(SELECT 1 FROM intake_handoffs h WHERE h.episode_id=e.episode_id)';

/** Crockford base32: no I, L, O or U, so a code read over the phone can't be misheard as another. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** The shape of a short human reference; the migration's CHECK enforces the same in SQL. */
export const SHORT_REFERENCE = /^AR-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;
/** A fresh short reference from 40 CSPRNG bits (256 is a multiple of 32, so ``& 31`` is uniform); never derived from a UUID. */
export function newShortReference() {
  const code = [...crypto.getRandomValues(new Uint8Array(8))].map(byte => CROCKFORD[byte & 31]).join('');
  return `AR-${code.slice(0, 4)}-${code.slice(4)}`;
}
/** Fresh codes tried when the unique index rejects one; at 40 bits a single retry is already vanishingly rare. */
const SHORT_REFERENCE_ATTEMPTS = 3;
const shortReferenceTaken = error => /UNIQUE/i.test(String(error?.message)) && /reference_short/i.test(String(error?.message));

/** One encrypted address per customer (AES-GCM blob from ``notify/email.js``); a new email sign-in replaces it. */
const UPSERT_TARGET = 'INSERT INTO notification_targets(customer_id,email_enc,updated_at) VALUES(?,?,?) '
  + 'ON CONFLICT(customer_id) DO UPDATE SET email_enc=excluded.email_enc,updated_at=excluded.updated_at';

/** One authentication audit row (migration 0012): references only, never a customer id, email or token. */
const AUTH_EVENT = 'INSERT INTO auth_events(ts,actor,event,session_ref,request_id) VALUES(?,?,?,?,?)';

/** The episode's reason only when the customer chose it (migration 0017); older rows read null, never 0016's default. */
const REASON = "CASE WHEN e.reason_source='customer' THEN e.reason END AS reason";

/**
 * A confirmed case's report that no person has closed yet, counting a reservation still ``handoff_pending`` (its
 * acknowledgement was lost and a same-key retry can finish it for one session lifetime). Expired reservations
 * no longer block the charge and cannot later be acknowledged; acknowledged reports never expire here.
 */
const OPEN_REPORT = 'SELECT 1 FROM cases c JOIN intake_handoffs oh ON oh.complete_case_id=c.case_id JOIN intake_episodes oe ON oe.episode_id=oh.episode_id';
const STILL_OPEN = "oh.status<>'closed' AND (oe.state='complete_handoff' OR (oe.state='handoff_pending' AND oh.accepted_at>?))";

/** The agent detail summarises at most this many of the customer's other, newest reports. */
const HISTORY_REPORTS = 20;

/** At most one ``update`` email per customer and reference in this window; ``enqueueEmail`` enforces it in SQL. */
export const UPDATE_EVERY_MS = 300000;

/** ``shortReference`` is injectable so tests can force collisions. */
export function createStore(db, { shortReference = newShortReference } = {}) {
  const totals = { queries: 0, rowsRead: 0, rowsWritten: 0, roundTrips: 0 };
  const track = result => {
    totals.queries += 1;
    totals.rowsRead += result?.meta?.rows_read ?? 0;
    totals.rowsWritten += result?.meta?.rows_written ?? 0;
    return result;
  };
  const all = async (sql, ...params) => { totals.roundTrips += 1; return track(await db.prepare(sql).bind(...params).all()).results; };
  const first = async (sql, ...params) => (await all(sql, ...params))[0] ?? null;
  const batch = async statements => {
    totals.roundTrips += 1;
    return (await db.batch(statements.map(([sql, ...params]) => db.prepare(sql).bind(...params)))).map(track);
  };

  /** Reserve one immutable handoff and optional confirmed case in one atomic batch; SQL revalidates live session and ownership. */
  const reserveIntakeHandoff = async ({ customerId, episodeId, turnKey, payloadHash, sessionHash, details, completeCase, kind, evidence, actions, questions, usage, now, referenceShort, urgency = 'normal' }) => {
    const handoffId = crypto.randomUUID();
    const caseId = kind === 'complete' ? crypto.randomUUID() : null;
    const eligible = "e.customer_id=? AND e.episode_id=? AND e.state='selection_required' "
      + "AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND actor='customer' AND customer_id=e.customer_id AND expires_at>?) "
      + 'AND NOT EXISTS(SELECT 1 FROM intake_handoffs WHERE episode_id=e.episode_id)';
    const params = [customerId, episodeId, sessionHash, now];
    const result = await batch([
      ...(kind === 'complete' ? [[
        'INSERT INTO cases(case_id,customer_id,transaction_id,idempotency_key,customer_statement,customer_confirmed) '
        + 'SELECT ?,e.customer_id,t.transaction_id,?,e.customer_statement,1 FROM intake_episodes e '
        + 'JOIN transactions t ON t.customer_id=e.customer_id AND t.transaction_id=? WHERE ' + eligible
        // One open report per charge, checked inside the batch: D1 runs batches one at a time, so of two confirmations
        // racing on the same charge only the first inserts a case; the second reserves nothing and is answered 409.
        + ' AND NOT EXISTS(' + OPEN_REPORT + ' WHERE c.customer_id=e.customer_id AND c.transaction_id=t.transaction_id AND ' + STILL_OPEN + ')',
        caseId, 'intake:' + episodeId, completeCase?.transaction_id ?? '', ...params, new Date(now - SESSION_MS).toISOString()
      ]] : []),
      ['INSERT INTO intake_handoffs(handoff_id,episode_id,complete_case_id,turn_key,payload_hash,kind,tool_status,'
        + 'evidence_json,actions_json,questions_json,destination,priority,accepted_at,usage_json,reference_short,urgency) '
        + "SELECT ?,e.episode_id,?,?,?,?,?,?,?,?,?,?,?,json_set(?,'$.tool_calls',json_extract(e.usage_json,'$.tool_calls'),'$.operation_duration_ms',COALESCE(json_extract(e.usage_json,'$.operation_duration_ms'),0)),?,? FROM intake_episodes e WHERE " + eligible
        + (kind === 'complete' ? ' AND EXISTS(SELECT 1 FROM cases WHERE case_id=?)' : ''),
        handoffId,caseId,turnKey,payloadHash,kind,kind === 'technical' ? 'failed' : 'ok',
        JSON.stringify(evidence),JSON.stringify(actions),JSON.stringify(questions),'case_service','normal',new Date(now).toISOString(),JSON.stringify(usage),referenceShort,urgency,
        ...params,...(kind === 'complete' ? [caseId] : [])],
      ['INSERT INTO intake_turns(episode_id,turn_key,payload_hash,response_json) '
        + 'SELECT episode_id,turn_key,payload_hash,? FROM intake_handoffs WHERE handoff_id=?',
        JSON.stringify({ handoff_id: handoffId }),handoffId],
      // Details (what the customer remembers) are appended once, in the same statement as the state change, so they cost no
      // extra query; a replay inserts no handoff under this id, so it appends nothing.
      ["UPDATE intake_episodes SET state='handoff_pending',updated_at=?,customer_statement=customer_statement||COALESCE(char(10)||?,'') WHERE episode_id=? "
        + 'AND EXISTS(SELECT 1 FROM intake_handoffs WHERE handoff_id=?)',now,details ?? null,episodeId,handoffId],
      ['SELECT h.* FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) WHERE e.customer_id=? AND e.episode_id=?',customerId,episodeId]
    ]);
    const handoff = result.at(-1).results[0] ?? null;
    if (handoff && (handoff.turn_key !== turnKey || handoff.payload_hash !== payloadHash)) return { conflict: true };
    return { handoff, replayed: handoff?.handoff_id !== handoffId };
  };
  return {
    metrics: () => ({ ...totals }),
    ping: () => all('SELECT 1 AS ok'),
    /** ``'fictitious'``, ``'dataset'`` or ``null`` when the customer isn't loaded (migration 0006). */
    customerSource: async customerId => (await first('SELECT source FROM customers WHERE customer_id=?', customerId))?.source ?? null,
    /** Dataset customers to offer at the simulated login; their ids and names live only in the reviewed seed. */
    listDatasetIdentities: limit => all(
      "SELECT customer_id, display_name, country FROM customers WHERE source='dataset' ORDER BY country, customer_id LIMIT ?", limit),
    findContextCard: customerId => first(
      'SELECT card_version, snapshot_at, card_json FROM context_cards WHERE customer_id=?', customerId),

    /**
     * Revoke one ``actor`` session by token hash and, only when that session existed, record ``logged_out`` in the same
     * batch. Another actor's token under this cookie neither logs out nor revokes anything.
     */
    revokeSession: (hash, actor, now, requestId) => batch([
      ["INSERT INTO auth_events(ts,actor,event,session_ref,request_id) SELECT ?,?,'logged_out',?,? "
        + 'WHERE EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND actor=?)', now, actor, hash.slice(0, 12), requestId, hash, actor],
      ['DELETE FROM sessions WHERE token_hash=? AND actor=?', hash, actor]]),
    /** Record a refused presented cookie (``session_expired`` or ``session_rejected``). */
    recordAuthEvent: ({ now, actor, event, sessionRef, requestId }) => all(AUTH_EVENT, now, actor, event, sessionRef, requestId),
    /** Newest audit rows, for tests and operators; the auditor route reads them through ``listAuditEvents``. */
    listAuthEvents: limit => all('SELECT * FROM auth_events ORDER BY id DESC LIMIT ?', limit),

    /**
     * In one atomic batch: purge expired sessions, revoke the presented token, insert the new one and, with
     * ``emailEnc`` (an email sign-in), upsert the customer's encrypted address in the same round trip. Records
     * ``session_started`` in the same batch. ``admin`` marks a session an admin opened (migration 0021).
     */
    rotateSession: ({ now, oldHash, newHash, actor, customerId, expiresAt, emailEnc, requestId, admin = false }) => batch([
      ['DELETE FROM sessions WHERE expires_at<=?', now],
      ...(oldHash ? [['DELETE FROM sessions WHERE token_hash=?', oldHash]] : []),
      ['INSERT INTO sessions(token_hash,actor,customer_id,expires_at,admin) VALUES(?,?,?,?,?)', newHash, actor, customerId, expiresAt, admin ? 1 : 0],
      ...(emailEnc ? [[UPSERT_TARGET, customerId, emailEnc, now]] : []),
      [AUTH_EVENT, now, actor, 'session_started', newHash.slice(0, 12), requestId]
    ]),
    /**
     * Act-as (ADR-007, decision 10), single-use in one atomic batch: the new admin-marked customer session is inserted
     * only while ``oldHash`` is still a live admin session, the two audit rows only if that insert happened, and then
     * the old session is deleted. Of concurrent calls with one cookie, only the first finds it; the rest insert nothing.
     * Stores no email. Resolves ``true`` when the new session exists.
     */
    actAsSession: async ({ now, oldHash, newHash, customerId, expiresAt, requestId }) => {
      const created = "WHERE EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND actor='customer')";
      const results = await batch([
        ['DELETE FROM sessions WHERE expires_at<=?', now],
        ["INSERT INTO sessions(token_hash,actor,customer_id,expires_at,admin) SELECT ?,'customer',?,?,1 "
          + "WHERE EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND actor='customer' AND admin=1 AND expires_at>?)",
          newHash, customerId, expiresAt, oldHash, now],
        ["INSERT INTO auth_events(ts,actor,event,session_ref,request_id) SELECT ?,'customer','session_started',?,? " + created,
          now, newHash.slice(0, 12), requestId, newHash],
        ["INSERT INTO admin_actions(ts,action,admin_session_ref,session_ref,request_id) SELECT ?,'act_as',?,?,? " + created,
          now, oldHash.slice(0, 12), newHash.slice(0, 12), requestId, newHash],
        ["DELETE FROM sessions WHERE token_hash=? AND actor='customer'", oldHash]
      ]);
      return results[1]?.meta?.changes === 1;
    },
    /** The live ``actor`` session: ``{ customer_id, expires_at, admin }`` (``admin`` is 1 for a session an admin opened). */
    findSession: (hash, actor, now) =>
      first('SELECT customer_id, expires_at, admin FROM sessions WHERE token_hash=? AND actor=? AND expires_at>?', hash, actor, now),
    /** Newest act-as rows (references only), for tests and operators. */
    listAdminActions: limit => all('SELECT * FROM admin_actions ORDER BY id DESC LIMIT ?', limit),

    /**
     * Atomically store a start, its immutable turn receipt and one opaque event; conflicting keys never update state.
     * ``reason`` (ADR-010) is required and part of the payload hash, so a replay with another reason conflicts.
     * ``producer`` (the extractor switch, on) labels the events and pre-records one call with unknown usage, so a
     * crash during the call is never counted as free; absent, the row and event are the guided ones.
     * Optional previousProtocol is hashed only when supplied, preserving old retries. Its one closed acknowledged
     * same-owner source and live session are checked in the insert; the durable FK never comes from customer text.
     */
    startIntake: async ({ customerId, language, statement, key, reason, now, expiresAt, producer, previousProtocol, sessionHash }) => {
      const episodeId = crypto.randomUUID();
      const sessionRef = crypto.randomUUID();
      const payloadHash = await tokenHash(JSON.stringify([language, statement, reason, ...(previousProtocol ? [previousProtocol] : [])]));
      const response = JSON.stringify({ episode_id: episodeId, state: 'selection_required', language, mode: 'guided' });
      const event = JSON.stringify({ event: 'intake_started', version: '2', case_id: episodeId,
        ts: new Date(now).toISOString(), seq: 0, session_ref: sessionRef, language, model_version: producer ?? 'guided-0.1' });
      const usage = JSON.stringify(producer ? { tool_calls: 1, model_version: producer, llm_calls: 1, known_input_tokens: 0,
        known_output_tokens: 0, usage_unavailable_calls: 1 } : { tool_calls: 1 });
      // One source through unique public keys, joined 1:1 to its owning episode; no customer-history scan.
      const source = "FROM intake_handoffs h JOIN intake_episodes p ON p.episode_id=h.episode_id WHERE p.customer_id=? AND p.state=h.kind||'_handoff' "
        + 'AND (h.complete_case_id=? OR (h.complete_case_id IS NULL AND h.handoff_id=?))';
      const sourceParams = [customerId, previousProtocol, previousProtocol];
      const authority = previousProtocol ? " AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND actor='customer' AND customer_id=? AND expires_at>?)" : '';
      const authorityParams = previousProtocol ? [sessionHash, customerId, now] : [];
      const results = await batch([
        ['INSERT INTO intake_episodes(episode_id,customer_id,session_ref,language,mode,state,customer_statement,'
          + 'start_key,payload_hash,created_at,updated_at,expires_at,usage_json,reason,reason_source'
          + (previousProtocol ? ',previous_handoff_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,h.handoff_id ' + source
            + " AND h.status='closed' AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND actor='customer' AND customer_id=p.customer_id AND expires_at>?) "
            : ') VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ')
          + 'ON CONFLICT(customer_id,start_key) DO NOTHING',
          episodeId, customerId, sessionRef, language, 'guided', 'selection_required', statement, key, payloadHash, now, now, expiresAt, usage, reason, 'customer',
          ...(previousProtocol ? [...sourceParams, sessionHash, now] : [])],
        ['INSERT INTO intake_turns(episode_id,turn_key,payload_hash,response_json) '
          + 'SELECT episode_id,?,?,? FROM intake_episodes WHERE episode_id=?', key, payloadHash, response, episodeId],
        ['INSERT INTO intake_events(episode_id,seq,event_json) '
          + 'SELECT episode_id,0,? FROM intake_episodes WHERE episode_id=?', event, episodeId],
        ['UPDATE intake_episodes SET updated_at=?,expires_at=? WHERE customer_id=? AND start_key=? '
          + "AND payload_hash=? AND state='selection_required'" + authority, now, expiresAt, customerId, key, payloadHash, ...authorityParams],
        ['SELECT e.*,t.response_json FROM intake_episodes e JOIN intake_turns t '
          + 'ON t.episode_id=e.episode_id AND t.turn_key=e.start_key WHERE e.customer_id=? AND e.start_key=?' + authority, customerId, key, ...authorityParams],
        ...(previousProtocol ? [['SELECT h.status ' + source, ...sourceParams]] : [])
      ]);
      const episode = results[4].results[0] ?? null;
      if (episode && episode.payload_hash !== payloadHash) return { conflict: true };
      if (!episode && previousProtocol) {
        const previous = results[5].results[0];
        return { previousError: !previous ? 404 : previous.status !== 'closed' ? 409 : 401 };
      }
      return { episode, replayed: episode?.episode_id !== episodeId };
    },
    /** Replace the pre-recorded unknown call with the adapter's measured usage while the episode is still open. */
    recordIntakeExtraction: ({ customerId, episodeId, producer, usage }) => batch([
      ['UPDATE intake_episodes SET usage_json=json_patch(usage_json,?) WHERE customer_id=? AND episode_id=? '
        + "AND state='selection_required' AND json_extract(usage_json,'$.model_version')=?",
        JSON.stringify({ llm_calls: usage.llm_calls, known_input_tokens: usage.known_input_tokens,
          known_output_tokens: usage.known_output_tokens, usage_unavailable_calls: usage.usage_unavailable_calls }), customerId, episodeId, producer]
    ]),
    /** Add a usage delta for the details shadow call (first one unknown call, then measured − unknown) to the episode its producer started. */
    recordDetailsExtraction: ({ customerId, episodeId, producer, usage }) => batch([
      ["UPDATE intake_episodes SET usage_json=json_set(usage_json,'$.llm_calls',json_extract(usage_json,'$.llm_calls')+?,"
        + "'$.known_input_tokens',json_extract(usage_json,'$.known_input_tokens')+?,'$.known_output_tokens',json_extract(usage_json,'$.known_output_tokens')+?,"
        + "'$.usage_unavailable_calls',json_extract(usage_json,'$.usage_unavailable_calls')+?) "
        + "WHERE customer_id=? AND episode_id=? AND json_extract(usage_json,'$.model_version')=?",
        usage.llm_calls, usage.known_input_tokens, usage.known_output_tokens, usage.usage_unavailable_calls, customerId, episodeId, producer]
    ]),
    /** Read an episode only for its authenticated owner; a foreign id and a missing id are indistinguishable. */
    findIntake: (customerId, episodeId) => first(
      'SELECT * FROM intake_episodes WHERE customer_id=? AND episode_id=?', customerId, episodeId),

    /** Read only the live owner's evidence; a missing and foreign transaction are indistinguishable. */
    findOwnedTransaction: (customerId, transactionId) => first(
      'SELECT transaction_id,occurred_at,source_occurred_at,merchant_name,amount,currency,bank_flagged FROM transactions '
      + 'WHERE customer_id=? AND transaction_id=?', customerId, transactionId),
    /**
     * The proactive alert (ADR-011): the customer's newest bank-flagged charge that this kind of answerer hasn't answered
     * and that has no report yet (any case on it, open or closed), or null. Reads only the customer's own charges.
     */
    findProactiveAlert: (customerId, answeredBy) => first(
      'SELECT t.transaction_id,t.occurred_at,t.source_occurred_at,t.merchant_name,t.amount,t.currency FROM transactions t '
      + 'WHERE t.customer_id=? AND t.bank_flagged=1 '
      + 'AND NOT EXISTS(SELECT 1 FROM proactive_answers a WHERE a.customer_id=t.customer_id AND a.transaction_id=t.transaction_id AND a.answered_by=?) '
      + 'AND NOT EXISTS(SELECT 1 FROM cases c WHERE c.customer_id=t.customer_id AND c.transaction_id=t.transaction_id) '
      + 'ORDER BY t.occurred_at DESC, t.source_occurred_at DESC, t.transaction_id LIMIT 1', customerId, answeredBy),
    /**
     * Record one answer to an alert, only on the customer's own bank-flagged charge; the first answer stands (a replay
     * changes nothing). Resolves the stored ``{ answer, answered_at }``, or null when the charge isn't the customer's
     * flagged one.
     */
    answerProactiveAlert: async ({ customerId, transactionId, answeredBy, answer, now }) => {
      const [, read] = await batch([
        ['INSERT INTO proactive_answers(customer_id,transaction_id,answered_by,answer,answered_at) SELECT ?,?,?,?,? '
          + 'WHERE EXISTS(SELECT 1 FROM transactions WHERE customer_id=? AND transaction_id=? AND bank_flagged=1) '
          + 'ON CONFLICT(customer_id,transaction_id,answered_by) DO NOTHING',
          customerId, transactionId, answeredBy, answer, now, customerId, transactionId],
        ['SELECT answer,answered_at FROM proactive_answers WHERE customer_id=? AND transaction_id=? AND answered_by=?',
          customerId, transactionId, answeredBy]
      ]);
      return read?.results?.[0] ?? null;
    },
    /**
     * Whether this customer has a complete report on the charge that no person has closed yet, acknowledged or still
     * pending within one session lifetime. The confirm batch repeats this check atomically (``reserveIntakeHandoff``); this read answers fast. Reads only
     * that charge's cases (index ``cases_customer_transaction``, migration 0011), never the customer's whole history.
     */
    openReportForTransaction: (customerId, transactionId, now = Date.now()) => first(
      OPEN_REPORT + ' WHERE c.customer_id=? AND c.transaction_id=? AND ' + STILL_OPEN + ' LIMIT 1', customerId, transactionId, new Date(now - SESSION_MS).toISOString()),
    /** Read a reservation only through its owning episode. */
    findOwnedIntakeHandoff: (customerId, episodeId) => first(
      'SELECT h.* FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) WHERE e.customer_id=? AND e.episode_id=?', customerId, episodeId),
    /** Atomically reserve one immutable handoff and optional confirmed case; SQL revalidates live session and ownership. */
    persistIntakeHandoff: async args => {
      // A collision on the short reference rolls the whole batch back, so retrying with a fresh code is safe.
      for (let attempt = 1; ; attempt++) {
        try { return await reserveIntakeHandoff({ ...args, referenceShort: shortReference() }); }
        catch (error) { if (attempt >= SHORT_REFERENCE_ATTEMPTS || !shortReferenceTaken(error)) throw error; }
      }
    },
    /** A complete receipt requires reading back the confirmed owned case, never just the reservation. */
    readIntakeReceipt: (customerId, episodeId, { sessionHash, now }) => first(
      'SELECT h.*,(SELECT COALESCE(MAX(seq),0)+1 FROM intake_events WHERE episode_id=e.episode_id) AS next_seq FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) '
      + 'LEFT JOIN cases c ON c.case_id=h.complete_case_id AND c.customer_id=e.customer_id AND c.customer_confirmed=1 '
      + "WHERE e.customer_id=? AND e.episode_id=? AND (h.kind<>'complete' OR c.case_id IS NOT NULL) "
      + "AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND actor='customer' AND customer_id=e.customer_id AND expires_at>?)",customerId,episodeId,sessionHash,now),
    /** Preserve failed-attempt usage on open episodes or pending reservations; terminal metrics never change on replay. */
    recordIntakeAttempt: ({ customerId, episodeId, toolCalls, operationDuration }) => batch([
      ["UPDATE intake_episodes SET usage_json=json_set(usage_json,'$.tool_calls',json_extract(usage_json,'$.tool_calls')+?,"
        + "'$.operation_duration_ms',COALESCE(json_extract(usage_json,'$.operation_duration_ms'),0)+?) "
        + "WHERE customer_id=? AND episode_id=? AND state='selection_required' AND NOT EXISTS(SELECT 1 FROM intake_handoffs WHERE episode_id=intake_episodes.episode_id)",
        toolCalls,operationDuration,customerId,episodeId],
      ["UPDATE intake_handoffs SET usage_json=json_set(usage_json,'$.tool_calls',json_extract(usage_json,'$.tool_calls')+?,"
        + "'$.operation_duration_ms',json_extract(usage_json,'$.operation_duration_ms')+?) WHERE episode_id=? "
        + "AND EXISTS(SELECT 1 FROM intake_episodes WHERE episode_id=? AND customer_id=? AND state='handoff_pending')",
        toolCalls,operationDuration,episodeId,episodeId,customerId]
    ]),
    /**
     * After read-back, require live authority to atomically append one terminal chain and freeze state; concurrent
     * acknowledgments are no-ops. The first acknowledgement also queues one ``received`` email when the customer has
     * a notification target (reference: the short one when present, else the protocol). Returns
     * ``{ acknowledged, emailId }``; ``emailId`` is null on a replay or without a target.
     */
    finishIntakeHandoff: async ({ customerId, episode, receipt, sessionHash, now, operationDuration, toolCalls }) => {
      const authority = " AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND actor='customer' AND customer_id=? AND expires_at>?)";
      const authorityParams = [sessionHash, customerId, now];
      const model = JSON.parse(episode.usage_json ?? '{}');
      const unknown = (model.usage_unavailable_calls ?? 0) > 0;
      const base = { version: '2', case_id: episode.episode_id, ts: new Date(now).toISOString(),
        session_ref: episode.session_ref,language: episode.language,model_version:model.model_version ?? 'guided-0.1' };
      const reference = receipt.complete_case_id ?? receipt.handoff_id;
      const emailId = crypto.randomUUID();
      const complete = receipt.kind === 'complete';
      // Check both age and persisted charge ownership in every pending write: an acknowledgement captured before
      // expiry can arrive after its replacement. A newer reservation permanently supersedes this pending one,
      // even after a person closes the replacement. Already acknowledged receipts still replay without writes.
      const cutoff = new Date(now - SESSION_MS).toISOString();
      // A stored completed episode only replays: SQL pending predicates prevent every write, so it needs no charge scan.
      const checkPendingCharge = complete && episode.state !== 'complete_handoff';
      const pendingAuthority = authority + (checkPendingCharge ? ' AND ?>? AND NOT EXISTS(' + OPEN_REPORT
        + ' WHERE c.customer_id=? AND c.transaction_id=(SELECT transaction_id FROM cases WHERE case_id=? AND customer_id=?) '
        + 'AND oh.handoff_id<>? AND (oh.accepted_at>? OR ' + STILL_OPEN + '))' : '');
      const pendingParams = [...authorityParams, ...(checkPendingCharge ? [receipt.accepted_at, cutoff,
        customerId, receipt.complete_case_id, customerId, receipt.handoff_id, receipt.accepted_at, cutoff] : [])];
      const extras = [
        ...(complete ? [{ event:'transaction_confirmed',transaction_ref:receipt.handoff_id }] : []),
        { event:'handoff_created',kind:receipt.kind,case_ref:reference,tool_status:receipt.tool_status },
        ...(complete ? [{ event:'handoff_accepted',case_ref:reference,accepted_by:receipt.destination }] : []),
        { event:'intake_ended',outcome:complete ? 'accepted' : receipt.kind === 'technical' ? 'technical_failure' : 'routed',safety:'not_assessed',
          duration_ms:Math.max(0,now-episode.created_at),llm_calls:model.llm_calls ?? 0,input_tokens:unknown ? null : model.known_input_tokens ?? 0,
          output_tokens:unknown ? null : model.known_output_tokens ?? 0,known_input_tokens:model.known_input_tokens ?? 0,
          known_output_tokens:model.known_output_tokens ?? 0,usage_unavailable_calls:model.usage_unavailable_calls ?? 0,
          tool_calls:0 }
      ];
      const results = await batch([
        ["UPDATE intake_handoffs SET usage_json=json_set(usage_json,'$.tool_calls',json_extract(usage_json,'$.tool_calls')+?,"
          + "'$.operation_duration_ms',json_extract(usage_json,'$.operation_duration_ms')+?) WHERE handoff_id=? "
          + "AND EXISTS(SELECT 1 FROM intake_episodes WHERE episode_id=? AND customer_id=? AND state='handoff_pending')" + pendingAuthority,
          toolCalls,operationDuration,receipt.handoff_id,episode.episode_id,customerId,...pendingParams],
        ...extras.map((extra,index) => [
          'INSERT INTO intake_events(episode_id,seq,event_json) SELECT e.episode_id,?,'
          + (extra.event === 'intake_ended' ? "json_set(?,'$.tool_calls',(SELECT json_extract(usage_json,'$.tool_calls') FROM intake_handoffs WHERE episode_id=e.episode_id))" : '?')
          + ' FROM intake_episodes e '
          + "WHERE e.customer_id=? AND e.episode_id=? AND e.state='handoff_pending' "
          + 'AND EXISTS(SELECT 1 FROM intake_handoffs WHERE handoff_id=? AND episode_id=e.episode_id) '
          + pendingAuthority + ' ON CONFLICT(episode_id,seq) DO NOTHING', receipt.next_seq+index,JSON.stringify({...base,seq:receipt.next_seq+index,...extra}),customerId,episode.episode_id,receipt.handoff_id,...pendingParams
        ]),
        // Before the state change, so only the acknowledgement that moves the episode out of handoff_pending queues it.
        ["INSERT INTO email_outbox(message_id,created_at,customer_id,template,language,reference,provider_status) "
          + "SELECT ?,?,e.customer_id,'received',e.language,?,'queued' FROM intake_episodes e "
          + "WHERE e.customer_id=? AND e.episode_id=? AND e.state='handoff_pending' "
          + 'AND EXISTS(SELECT 1 FROM intake_handoffs WHERE handoff_id=? AND episode_id=e.episode_id) '
          // A language the templates lack skips the email instead of failing the outbox CHECK and rolling back the handoff.
          + "AND e.language IN ('es','pt','en') AND EXISTS(SELECT 1 FROM notification_targets WHERE customer_id=e.customer_id)" + pendingAuthority + ' RETURNING message_id',
          emailId,now,receipt.reference_short ?? reference,customerId,episode.episode_id,receipt.handoff_id,...pendingParams],
        ['UPDATE intake_episodes SET state=?,updated_at=? WHERE customer_id=? AND episode_id=? '
          + "AND state='handoff_pending' AND EXISTS(SELECT 1 FROM intake_handoffs WHERE handoff_id=? AND episode_id=intake_episodes.episode_id)" + pendingAuthority,
          complete ? 'complete_handoff' : receipt.kind === 'technical' ? 'technical_handoff' : 'incomplete_handoff',now,customerId,episode.episode_id,receipt.handoff_id,...pendingParams],
        ['SELECT 1 AS acknowledged FROM intake_episodes e JOIN intake_handoffs h USING(episode_id) '
          + "WHERE e.customer_id=? AND e.episode_id=? AND h.handoff_id=? AND e.state IN ('complete_handoff','technical_handoff','incomplete_handoff')" + authority,
          customerId,episode.episode_id,receipt.handoff_id,...authorityParams]
      ]);
      return { acknowledged: Boolean(results.at(-1).results[0]), emailId: results.at(-3).results[0]?.message_id ?? null };
    },

    /**
     * Close at most ``limit`` (<=100) due unreserved starts atomically, at cutoff ``now`` (never more than
     * IDLE_CUTOFF_SKEW_MS past ``maxNow``, the server clock by default). An episode is due at min(last activity +
     * 10 min, bound session expiry), where activity is the start or its latest same-key replay. The deadline is
     * evaluated only when this sweep runs: an episode whose deadline passed but that has not been swept can still be
     * confirmed or handed off, and a same-key start replay renews it. The end event is appended at the episode's next
     * sequence number and records the deadline as ``ts`` and ``duration_ms``; the state changes only when that event
     * is the episode's latest. Reserved (``handoff_pending``) episodes are never closed: their acceptance needs
     * customer-authorized read-back.
     */
    closeIdleIntakes: async ({ now, limit = 100, maxNow = Date.now() + IDLE_CUTOFF_SKEW_MS }) => {
      if (!Number.isSafeInteger(now) || now < 0 || !(now <= maxNow) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid closure bounds');
      const page = IDLE_CANDIDATES + ' ORDER BY ' + IDLE_DUE + ',e.episode_id LIMIT ?';
      // One index lookup per episode finds its latest event (sequence and name). The derived table has a LIMIT and
      // the outer query a WHERE, so SQLite cannot flatten it and evaluates that lookup once per row. An episode
      // whose latest event already ends it (a corrupt state) gets no second end event.
      const latest = "(SELECT json_object('seq',v.seq,'event',json_extract(v.event_json,'$.event')) FROM intake_events v "
        + 'WHERE v.episode_id=e.episode_id ORDER BY v.seq DESC LIMIT 1)';
      // An eventless episode (never produced by a start, but possible after manual repair) ends at sequence 0
      // instead of a NULL sequence that would roll back the whole page.
      const next = "COALESCE(json_extract(d.latest,'$.seq'),-1)+1";
      const results = await batch([
        ['INSERT INTO intake_events(episode_id,seq,event_json) SELECT d.episode_id,' + next + ',json_set(json_patch(json_object('
          + "'event','intake_ended','version','2','case_id',d.episode_id,"
          + "'ts',strftime('%Y-%m-%dT%H:%M:%S',d.due_at/1000,'unixepoch')||printf('.%03dZ',d.due_at%1000),"
          + "'seq'," + next + ",'session_ref',d.session_ref,'language',d.language,'model_version',COALESCE(json_extract(d.usage_json,'$.model_version'),'guided-0.1')),"
          + "json_object('outcome','abandoned','safety','not_assessed','duration_ms',MAX(0,d.due_at-d.created_at),"
          + "'llm_calls'," + USAGE('llm_calls') + ",'input_tokens',0,'output_tokens',0,"
          + "'known_input_tokens'," + USAGE('known_input_tokens') + ",'known_output_tokens'," + USAGE('known_output_tokens') + ","
          + "'usage_unavailable_calls'," + USAGE('usage_unavailable_calls') + ",'tool_calls',json_extract(d.usage_json,'$.tool_calls'))),"
          // A merge patch drops null members, so the totals (null while any usage is unknown) are set in place after it.
          + "'$.input_tokens'," + KNOWN('known_input_tokens') + ",'$.output_tokens'," + KNOWN('known_output_tokens') + ') '
          + 'FROM (SELECT e.episode_id,e.session_ref,e.language,e.created_at,e.usage_json,' + IDLE_DUE + ' AS due_at,' + latest + ' AS latest '
          + page + ") d WHERE json_extract(d.latest,'$.event') IS NOT 'intake_ended' ON CONFLICT(episode_id,seq) DO NOTHING", now, limit],
        ["UPDATE intake_episodes SET state='abandoned',updated_at=? WHERE episode_id IN (SELECT e.episode_id " + page + ') '
          + 'AND EXISTS(SELECT 1 FROM (SELECT v.event_json FROM intake_events v WHERE v.episode_id=intake_episodes.episode_id '
          + "ORDER BY v.seq DESC LIMIT 1) latest WHERE json_extract(latest.event_json,'$.event')='intake_ended' "
          + "AND json_extract(latest.event_json,'$.outcome')='abandoned') "
          + 'RETURNING episode_id', now, now, limit]
      ]);
      return results.at(-1).results;
    },
    /** Whether any unreserved start is still due at ``now``; lets a sweep report completion without trusting page size. */
    hasDueIdleIntakes: async ({ now }) => {
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid closure bounds');
      return Boolean(await first('SELECT 1 AS due ' + IDLE_CANDIDATES + ' LIMIT 1', now));
    },
    /**
     * One keyset page of at most 100 episodes after ``afterEpisode`` (a lowercase UUID, or '' for the start), each
     * with its complete ordered event group read in the same statement. Pending episodes are included. Groups
     * over 101 events or events over 4096 characters come back as an overflow row or null, so the caller rejects
     * the page rather than truncating it.
     */
    exportIntakeEvents: ({ afterEpisode = '', limit = 100 } = {}) => {
      if (typeof afterEpisode !== 'string' || (afterEpisode && !EPISODE_CURSOR.test(afterEpisode)) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid export bounds');
      return all('WITH page AS (SELECT episode_id FROM intake_episodes WHERE episode_id>? ORDER BY episode_id LIMIT ?) '
        + 'SELECT p.episode_id,(SELECT json_group_array(json(event_json)) FROM '
        + '(SELECT CASE WHEN length(event_json)<=4096 THEN event_json ELSE NULL END AS event_json '
        + 'FROM intake_events v WHERE v.episode_id=p.episode_id ORDER BY seq LIMIT 102)) AS events_json '
        + 'FROM page p ORDER BY p.episode_id',afterEpisode,limit);
    },

    listTransactions: (customerId, limit) => all(
      'SELECT transaction_id, occurred_at, source_occurred_at, merchant_name, amount, currency FROM transactions '
      + 'WHERE customer_id=? ORDER BY occurred_at DESC, source_occurred_at DESC, transaction_id LIMIT ?', customerId, limit),
    /** Record one served charges page (migration 0015, ADR-009); ``viewRef`` is random and never derived from the customer. */
    insertChargeView: ({ viewRef, customerId, language, rowCount, hasMore, coverage, now }) => all(
      'INSERT INTO charge_views(view_ref,customer_id,language,row_count,has_more,coverage,retrieved_at) VALUES(?,?,?,?,?,?,?)',
      viewRef, customerId, language, rowCount, hasMore ? 1 : 0, coverage, now),
    /** The view's ``displayed_at`` after acknowledging it: a replay keeps the first time; another customer's or a missing view is null. */
    acknowledgeChargeView: async (viewRef, customerId, now) => (await first(
      'UPDATE charge_views SET displayed_at=COALESCE(displayed_at,?) WHERE view_ref=? AND customer_id=? RETURNING displayed_at',
      now, viewRef, customerId))?.displayed_at ?? null,
    ownsTransaction: async (customerId, transactionId) => Boolean(await first(
      'SELECT 1 AS ok FROM transactions WHERE customer_id=? AND transaction_id=?', customerId, transactionId)),

    /** Insert unless this customer already used the key; returns the new case id or ``null``. */
    insertCase: async ({ caseId, customerId, transactionId, idempotencyKey, statement }) => {
      const row = await first(
        'INSERT INTO cases(case_id,customer_id,transaction_id,idempotency_key,customer_statement,customer_confirmed) '
        + 'VALUES(?,?,?,?,?,1) ON CONFLICT(customer_id,idempotency_key) DO NOTHING RETURNING case_id',
        caseId, customerId, transactionId, idempotencyKey, statement);
      return row ? row.case_id : null;
    },
    findCaseByKey: (customerId, idempotencyKey) => first(
      'SELECT case_id, transaction_id, customer_statement, status, accepted_at FROM cases '
      + 'WHERE customer_id=? AND idempotency_key=?', customerId, idempotencyKey),

    /**
     * One handoff per episode; only acknowledged terminal rows enter this bounded queue. Open high-urgency reports come
     * first (partial index ``intake_handoffs_urgent``, migration 0013), then the rest newest first; one round trip.
     * Each row carries the episode's ``reason``, or null when the customer never chose one.
     */
    listIntakeHandoffs: async limit => {
      const lane = urgent => 'SELECT COALESCE(h.complete_case_id,h.handoff_id) AS protocol,h.episode_id,h.kind,h.tool_status,'
        + 'h.destination,h.priority,h.urgency,h.accepted_at,h.reference_short,h.status,' + REASON + ' FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) '
        + "WHERE e.state=h.kind||'_handoff' AND " + (urgent ? '' : 'NOT ') + "(h.urgency='high' AND h.status<>'closed') "
        + 'ORDER BY h.accepted_at DESC,protocol LIMIT ?';
      const [high, rest] = await batch([[lane(true), Math.min(limit, 51)], [lane(false), Math.min(limit, 51)]]);
      return [...high.results, ...rest.results].slice(0, Math.min(limit, 51));
    },
    /**
     * The session customer's acknowledged handoffs, newest first, with the charge of a complete one when its case is this customer's and confirmed (null
     * otherwise; ``cases`` is one row per primary key). Only handoffs whose receipt was read back appear.
     */
    // ponytail: reads ~1 + 2 rows per episode of the customer (all states) then a temp sort; LIMIT does not cap it.
    // Upgrade: an index on handoffs keyed by customer and accepted_at, which needs a customer column there.
    listCustomerHandoffs: (customerId, limit) => all(
      'SELECT COALESCE(h.complete_case_id,h.handoff_id) AS protocol,h.reference_short,h.kind,h.status,h.accepted_at,c.transaction_id '
      + 'FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) '
      + 'LEFT JOIN cases c ON c.case_id=h.complete_case_id AND c.customer_id=e.customer_id AND c.customer_confirmed=1 '
      + "WHERE e.customer_id=? AND e.state=h.kind||'_handoff' "
      + 'ORDER BY h.accepted_at DESC,protocol LIMIT ?', customerId, limit),
    /**
     * Record the first answer for an own acknowledged report, then read it back in one atomic batch. Both statements
     * recheck the same customer's live session, so delayed bodies or revocation cannot use captured authority.
     * Returns ``{ easy, created_at }``, or null for lost authority, a missing report or a foreign report.
     */
    recordReportFeedback: async (customerId, protocol, easy, now, sessionHash) => {
      const mine = "FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) WHERE e.customer_id=? AND e.state=h.kind||'_handoff' "
        + 'AND (h.complete_case_id=? OR (h.complete_case_id IS NULL AND h.handoff_id=?)) '
        + "AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND actor='customer' AND customer_id=e.customer_id AND expires_at>?)";
      const params = [customerId, protocol, protocol, sessionHash, now];
      const [, stored] = await batch([
        ['INSERT INTO report_feedback(handoff_id,easy,created_at) SELECT h.handoff_id,?,? ' + mine + ' ON CONFLICT(handoff_id) DO NOTHING',
          easy ? 1 : 0, now, ...params],
        ['SELECT f.easy,f.created_at FROM report_feedback f WHERE f.handoff_id=(SELECT h.handoff_id ' + mine + ')', ...params]]);
      return stored.results[0] ?? null;
    },
    /**
     * Aggregate receipt feedback by report language over an acknowledged-report acceptance window [sinceMs, untilMs).
     * One-to-one handoff/episode/feedback joins preserve report counts; answers after the cutoff remain unknown. SQL
     * performs the grouping and returns at most three rows, without customer identifiers or statements.
     */
    reportFeedbackSummary: ({ sinceMs, untilMs }) => {
      if (!Number.isSafeInteger(sinceMs) || sinceMs < 0 || !Number.isSafeInteger(untilMs) || untilMs <= sinceMs) throw new Error('Invalid feedback window');
      return all('SELECT e.language,COUNT(*) AS reports,COUNT(f.handoff_id) AS respondents,'
        + 'COUNT(*)-COUNT(f.handoff_id) AS unanswered,COALESCE(SUM(f.easy=1),0) AS thumbs_up,COALESCE(SUM(f.easy=0),0) AS thumbs_down '
        + 'FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) '
        + 'LEFT JOIN report_feedback f ON f.handoff_id=h.handoff_id AND f.created_at<? '
        + "WHERE e.state=h.kind||'_handoff' AND h.accepted_at>=? AND h.accepted_at<? GROUP BY e.language ORDER BY e.language",
        untilMs, new Date(sinceMs).toISOString(), new Date(untilMs).toISOString());
    },
    /**
     * One acknowledged report of this customer (same predicate as ``listCustomerHandoffs``) with its episode language
     * and whether the customer has a notification target; null when missing or another customer's.
     */
    findCustomerReport: (customerId, protocol) => first(
      'SELECT COALESCE(h.complete_case_id,h.handoff_id) AS protocol,h.reference_short,h.status,e.language,'
      + 'EXISTS(SELECT 1 FROM notification_targets WHERE customer_id=e.customer_id) AS has_target '
      + "FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) WHERE e.customer_id=? AND e.state=h.kind||'_handoff' "
      + 'AND (h.complete_case_id=? OR (h.complete_case_id IS NULL AND h.handoff_id=?))', customerId, protocol, protocol),
    /**
     * One acknowledged handoff by public ``protocol``, in one round trip: the first read stamps ``first_opened_at``
     * (migration 0018; later reads keep it), then the detail row, then a summary of the same customer's *other*
     * acknowledged reports among their newest 21 episodes (at most ``HISTORY_REPORTS``; ``has_more`` when the episode
     * window or report bound fills, even when pending/abandoned starts use slots),
     * which names no customer. Optional complete evidence
     * is one-to-one and owner-scoped; missing evidence never drops a handoff. ``model_version`` and ``llm_calls`` come
     * from the episode's usage (set only by shadow extraction), never the model's output.
     */
    findIntakeHandoff: async (protocol, now = Date.now()) => {
      const match = '(h.complete_case_id=? OR (h.complete_case_id IS NULL AND h.handoff_id=?))';
      const [, detail, history] = await batch([
        ['UPDATE intake_handoffs AS h SET first_opened_at=? WHERE first_opened_at IS NULL AND ' + match
          + " AND EXISTS(SELECT 1 FROM intake_episodes e WHERE e.episode_id=h.episode_id AND e.state=h.kind||'_handoff')", now, protocol, protocol],
        ['SELECT COALESCE(h.complete_case_id,h.handoff_id) AS protocol,h.episode_id,h.kind,h.tool_status,'
          + 'h.destination,h.priority,h.urgency,h.accepted_at,h.reference_short,h.status,h.first_opened_at,h.evidence_json,h.actions_json,h.questions_json,'
          + 'e.customer_statement,e.language,' + REASON + ',t.transaction_id AS verified_transaction_id,'
          + "json_extract(e.usage_json,'$.model_version') AS model_version,COALESCE(json_extract(e.usage_json,'$.llm_calls'),0) AS llm_calls "
          + 'FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) '
          + 'LEFT JOIN cases c ON c.case_id=h.complete_case_id AND c.customer_id=e.customer_id AND c.customer_confirmed=1 '
          + 'LEFT JOIN transactions t ON t.transaction_id=c.transaction_id AND t.customer_id=e.customer_id '
          + "WHERE e.state=h.kind||'_handoff' AND " + match, protocol, protocol],
        // The customer's newest 21 episodes (index intake_episodes_owner_recent), so the read stays bounded however long
        // their history is. Keep empty/pending/current slots as null rows internally, so a full window is still
        // marked partial even when it contains fewer than 20 other acknowledged reports. No identifier leaves SQL.
        ['WITH me AS (SELECT e.customer_id,h.handoff_id FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) WHERE ' + match + ') '
          + 'SELECT h.status,h.urgency,h.accepted_at FROM (SELECT episode_id,state FROM intake_episodes '
          + 'WHERE customer_id=(SELECT customer_id FROM me) ORDER BY created_at DESC LIMIT 21) e '
          + "LEFT JOIN intake_handoffs h ON h.episode_id=e.episode_id AND e.state=h.kind||'_handoff' "
          + 'AND h.handoff_id<>(SELECT handoff_id FROM me) ORDER BY h.accepted_at DESC,h.handoff_id',
          protocol, protocol]]);
      const row = detail.results[0];
      if (!row) return null;
      const others = history.results.filter(o => o.status !== null).slice(0, HISTORY_REPORTS);
      return { ...row, customer_history: { reports: others.length, open: others.filter(o => o.status !== 'closed').length,
        high_urgency: others.filter(o => o.urgency === 'high').length, last_status: others[0]?.status ?? null,
        last_accepted_at: others[0]?.accepted_at ?? null,
        has_more: history.results.length === HISTORY_REPORTS + 1 || others.length === HISTORY_REPORTS } };
    },
    /**
     * Move one acknowledged handoff (public ``protocol``) from ``from`` to ``to`` in one atomic batch: a history row,
     * the customer's ``to`` email (when they have a target) and the status change, each guarded by ``status=from``.
     * The email statement runs before the update, so ``status`` still equal to ``from`` while the ``to`` history row
     * exists can only mean this batch inserted it: a replay or a concurrent loser queues nothing. Returns the final
     * ``{ status, changed_at, customer_id, language, reference }`` (null when no acknowledged handoff matches) and the
     * queued ``emailId`` or null.
     */
    transitionHandoff: async ({ protocol, from, to, now, agentSessionRef, emailId }) => {
      const target = '(SELECT h.handoff_id FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) '
        + "WHERE (h.complete_case_id=? OR (h.complete_case_id IS NULL AND h.handoff_id=?)) AND e.state=h.kind||'_handoff')";
      const results = await batch([
        ['INSERT INTO handoff_status_history(handoff_id,status,changed_at,agent_session_ref) SELECT handoff_id,?,?,? FROM intake_handoffs '
          + 'WHERE handoff_id=' + target + ' AND status=?', to, now, agentSessionRef, protocol, protocol, from],
        ["INSERT INTO email_outbox(message_id,created_at,customer_id,template,language,reference,provider_status) "
          + "SELECT ?,?,e.customer_id,?,e.language,COALESCE(h.reference_short,h.complete_case_id,h.handoff_id),'queued' "
          + 'FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) WHERE h.handoff_id=' + target + ' AND h.status=? '
          + 'AND EXISTS(SELECT 1 FROM handoff_status_history WHERE handoff_id=h.handoff_id AND status=?) '
          + "AND e.language IN ('es','pt','en') AND EXISTS(SELECT 1 FROM notification_targets WHERE customer_id=e.customer_id) RETURNING message_id",
          emailId, now, to, protocol, protocol, from, to],
        ['UPDATE intake_handoffs SET status=? WHERE handoff_id=' + target + ' AND status=?', to, protocol, protocol, from],
        ['SELECT h.status,(SELECT changed_at FROM handoff_status_history WHERE handoff_id=h.handoff_id AND status=h.status) AS changed_at,'
          + 'e.customer_id,e.language,COALESCE(h.reference_short,h.complete_case_id,h.handoff_id) AS reference '
          + 'FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) WHERE h.handoff_id=' + target, protocol, protocol]
      ]);
      return { row: results.at(-1).results[0] ?? null, emailId: results[1].results[0]?.message_id ?? null };
    },
    /** One handoff's status history, oldest first (audit and tests). */
    listStatusHistory: protocol => all(
      'SELECT s.status,s.changed_at,s.agent_session_ref FROM handoff_status_history s JOIN intake_handoffs h USING(handoff_id) '
      + 'WHERE h.complete_case_id=? OR (h.complete_case_id IS NULL AND h.handoff_id=?) ORDER BY s.changed_at,s.rowid', protocol, protocol),
    /** At most 101 indexed events, so overflow is explicit. Guided chains have at most 5 events; add a cursor before supporting more than 100. */
    listIntakeHistory: episodeId => all(
      'SELECT event_json FROM intake_events WHERE episode_id=? ORDER BY seq LIMIT 101', episodeId),

    findNotificationTarget: customerId => first(
      'SELECT email_enc,updated_at FROM notification_targets WHERE customer_id=?', customerId),
    /**
     * Outbox rows hold template, language and reference only, never a body; they start ``queued``. An ``update`` is
     * inserted only when no ``update`` for that customer and reference is newer than ``UPDATE_EVERY_MS``, in the same
     * statement, so concurrent requests queue one. An ``update`` returns the inserted ``[{ message_id }]``, empty when refused.
     */
    enqueueEmail: ({ messageId, now, customerId, template, language, reference }) => template === 'update'
      ? all("INSERT INTO email_outbox(message_id,created_at,customer_id,template,language,reference,provider_status) SELECT ?,?,?,'update',?,?,'queued' "
        + "WHERE NOT EXISTS(SELECT 1 FROM email_outbox WHERE customer_id=? AND reference=? AND template='update' AND created_at>?) RETURNING message_id",
        messageId, now, customerId, language, reference, customerId, reference, now - UPDATE_EVERY_MS)
      : all("INSERT INTO email_outbox(message_id,created_at,customer_id,template,language,reference,provider_status) VALUES(?,?,?,?,?,?,'queued')",
        messageId, now, customerId, template, language, reference),
    /** One customer's outbox rows for a reference (index ``email_outbox_recent``); no address, no body. */
    findEmails: (customerId, reference) => all(
      'SELECT template,language,provider_status FROM email_outbox WHERE customer_id=? AND reference=? ORDER BY created_at', customerId, reference),
    markEmail: (messageId, status, providerMessageId) => all(
      'UPDATE email_outbox SET provider_status=?,provider_message_id=? WHERE message_id=?', status, providerMessageId ?? null, messageId),
    /**
     * ``{ count, latest }`` of this customer's ``template`` emails for a reference created after ``sinceMs``, for
     * rate limits (index ``email_outbox_recent``); ``latest`` is the newest ``created_at`` or null.
     */
    recentEmails: async (customerId, reference, sinceMs, template) => first(
      'SELECT COUNT(*) AS count,MAX(created_at) AS latest FROM email_outbox WHERE customer_id=? AND reference=? AND created_at>? AND template=?',
      customerId, reference, sinceMs, template),

    /**
     * The auditor's read (``GET /audit/events``): the newest ``limit`` sign-in events and review-status changes, newest
     * first by primary key / rowid (no sort, ``limit`` rows read each), in one round trip. References only.
     */
    listAuditEvents: async limit => {
      const [auth, status] = await batch([
        ['SELECT id,ts,actor,event,session_ref,request_id FROM auth_events ORDER BY id DESC LIMIT ?', limit],
        ['SELECT handoff_id,status,changed_at,agent_session_ref FROM handoff_status_history ORDER BY rowid DESC LIMIT ?', limit]]);
      return { auth: auth.results, status: status.results };
    }
  };
}
