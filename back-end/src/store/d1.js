/**
 * Every SQL statement the service runs. Route handlers never build SQL, so this is the only module
 * to replace if the store moves (for example to PostgreSQL through Hyperdrive).
 *
 * Each call uses ``.all()``, ``.run()`` or ``.batch()`` so D1's ``meta`` is available. ``metrics()`` reports
 * queries, rows read, rows written and round trips for the current request; the budget tests use it.
 * A batch is one round trip and one atomic transaction.
 */
import { tokenHash } from '../auth/session.js';

export function createStore(db) {
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

  return {
    metrics: () => ({ ...totals }),
    ping: () => all('SELECT 1 AS ok'),
    customerExists: async customerId => Boolean(await first('SELECT 1 AS ok FROM customers WHERE customer_id=?', customerId)),
    findContextCard: customerId => first(
      'SELECT card_version, snapshot_at, card_json FROM context_cards WHERE customer_id=?', customerId),

    /** In one atomic batch: purge expired sessions, revoke the presented token, insert the new one. */
    rotateSession: ({ now, oldHash, newHash, actor, customerId, expiresAt }) => batch([
      ['DELETE FROM sessions WHERE expires_at<=?', now],
      ...(oldHash ? [['DELETE FROM sessions WHERE token_hash=?', oldHash]] : []),
      ['INSERT INTO sessions(token_hash,actor,customer_id,expires_at) VALUES(?,?,?,?)', newHash, actor, customerId, expiresAt]
    ]),
    findSession: (hash, actor, now) =>
      first('SELECT customer_id, expires_at FROM sessions WHERE token_hash=? AND actor=? AND expires_at>?', hash, actor, now),

    /** Atomically store a start, its immutable turn receipt and one opaque event; conflicting keys never update state. */
    startIntake: async ({ customerId, language, statement, key, now, expiresAt }) => {
      const episodeId = crypto.randomUUID();
      const sessionRef = crypto.randomUUID();
      const payloadHash = await tokenHash(JSON.stringify([language, statement]));
      const response = JSON.stringify({ episode_id: episodeId, state: 'selection_required', language, mode: 'guided' });
      const event = JSON.stringify({ event: 'intake_started', version: '2', case_id: episodeId,
        ts: new Date(now).toISOString(), seq: 0, session_ref: sessionRef, language, model_version: 'guided-0.1' });
      const results = await batch([
        ['INSERT INTO intake_episodes(episode_id,customer_id,session_ref,language,mode,state,customer_statement,'
          + 'start_key,payload_hash,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) '
          + 'ON CONFLICT(customer_id,start_key) DO NOTHING',
          episodeId, customerId, sessionRef, language, 'guided', 'selection_required', statement, key, payloadHash, now, now, expiresAt],
        ['INSERT INTO intake_turns(episode_id,turn_key,payload_hash,response_json) '
          + 'SELECT episode_id,?,?,? FROM intake_episodes WHERE episode_id=?', key, payloadHash, response, episodeId],
        ['INSERT INTO intake_events(episode_id,seq,event_json) '
          + 'SELECT episode_id,0,? FROM intake_episodes WHERE episode_id=?', event, episodeId],
        ['UPDATE intake_episodes SET updated_at=?,expires_at=? WHERE customer_id=? AND start_key=? '
          + "AND payload_hash=? AND state='selection_required'", now, expiresAt, customerId, key, payloadHash],
        ['SELECT e.*,t.response_json FROM intake_episodes e JOIN intake_turns t '
          + 'ON t.episode_id=e.episode_id AND t.turn_key=e.start_key WHERE e.customer_id=? AND e.start_key=?', customerId, key]
      ]);
      const episode = results.at(-1).results[0] ?? null;
      if (episode && episode.payload_hash !== payloadHash) return { conflict: true };
      return { episode, replayed: episode?.episode_id !== episodeId };
    },
    /** Read an episode only for its authenticated owner; a foreign id and a missing id are indistinguishable. */
    findIntake: (customerId, episodeId) => first(
      'SELECT * FROM intake_episodes WHERE customer_id=? AND episode_id=?', customerId, episodeId),

    /** Read only the live owner's evidence; a missing and foreign transaction are indistinguishable. */
    findOwnedTransaction: (customerId, transactionId) => first(
      'SELECT transaction_id,occurred_at,source_occurred_at,merchant_name,amount,currency FROM transactions '
      + 'WHERE customer_id=? AND transaction_id=?', customerId, transactionId),
    /** Read a reservation only through its owning episode. */
    findOwnedIntakeHandoff: (customerId, episodeId) => first(
      'SELECT h.* FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) WHERE e.customer_id=? AND e.episode_id=?', customerId, episodeId),
    /** Atomically reserve one immutable handoff and optional confirmed case; SQL revalidates live session and ownership. */
    persistIntakeHandoff: async ({ customerId, episodeId, turnKey, payloadHash, sessionHash, completeCase, kind, evidence, actions, questions, usage, now }) => {
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
          + 'JOIN transactions t ON t.customer_id=e.customer_id AND t.transaction_id=? WHERE ' + eligible,
          caseId, 'intake:' + episodeId, completeCase?.transaction_id ?? '', ...params
        ]] : []),
        ['INSERT INTO intake_handoffs(handoff_id,episode_id,complete_case_id,turn_key,payload_hash,kind,tool_status,'
          + 'evidence_json,actions_json,questions_json,destination,priority,accepted_at,usage_json) '
          + "SELECT ?,e.episode_id,?,?,?,?,?,?,?,?,?,?,?,json_set(?,'$.tool_calls',json_extract(e.usage_json,'$.tool_calls'),'$.operation_duration_ms',COALESCE(json_extract(e.usage_json,'$.operation_duration_ms'),0)) FROM intake_episodes e WHERE " + eligible
          + (kind === 'complete' ? ' AND EXISTS(SELECT 1 FROM cases WHERE case_id=?)' : ''),
          handoffId,caseId,turnKey,payloadHash,kind,kind === 'technical' ? 'failed' : 'ok',
          JSON.stringify(evidence),JSON.stringify(actions),JSON.stringify(questions),'case_service','normal',new Date(now).toISOString(),JSON.stringify(usage),
          ...params,...(kind === 'complete' ? [caseId] : [])],
        ['INSERT INTO intake_turns(episode_id,turn_key,payload_hash,response_json) '
          + 'SELECT episode_id,turn_key,payload_hash,? FROM intake_handoffs WHERE handoff_id=?',
          JSON.stringify({ handoff_id: handoffId }),handoffId],
        ["UPDATE intake_episodes SET state='handoff_pending',updated_at=? WHERE episode_id=? "
          + 'AND EXISTS(SELECT 1 FROM intake_handoffs WHERE handoff_id=?)',now,episodeId,handoffId],
        ['SELECT h.* FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) WHERE e.customer_id=? AND e.episode_id=?',customerId,episodeId]
      ]);
      const handoff = result.at(-1).results[0] ?? null;
      if (handoff && (handoff.turn_key !== turnKey || handoff.payload_hash !== payloadHash)) return { conflict: true };
      return { handoff, replayed: handoff?.handoff_id !== handoffId };
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
    /** After read-back, require live authority to atomically append one terminal chain and freeze state; concurrent acknowledgments are no-ops. */
    finishIntakeHandoff: async ({ customerId, episode, receipt, sessionHash, now, operationDuration, toolCalls }) => {
      const authority = " AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND actor='customer' AND customer_id=? AND expires_at>?)";
      const authorityParams = [sessionHash, customerId, now];
      const base = { version: '2', case_id: episode.episode_id, ts: new Date(now).toISOString(),
        session_ref: episode.session_ref,language: episode.language,model_version:'guided-0.1' };
      const reference = receipt.complete_case_id ?? receipt.handoff_id;
      const complete = receipt.kind === 'complete';
      const extras = [
        ...(complete ? [{ event:'transaction_confirmed',transaction_ref:receipt.handoff_id }] : []),
        { event:'handoff_created',kind:receipt.kind,case_ref:reference,tool_status:receipt.tool_status },
        ...(complete ? [{ event:'handoff_accepted',case_ref:reference,accepted_by:receipt.destination }] : []),
        { event:'intake_ended',outcome:complete ? 'accepted' : receipt.kind === 'technical' ? 'technical_failure' : 'routed',safety:'not_assessed',
          duration_ms:Math.max(0,now-episode.created_at),llm_calls:0,input_tokens:0,output_tokens:0,known_input_tokens:0,known_output_tokens:0,usage_unavailable_calls:0,
          tool_calls:0 }
      ];
      const results = await batch([
        ["UPDATE intake_handoffs SET usage_json=json_set(usage_json,'$.tool_calls',json_extract(usage_json,'$.tool_calls')+?,"
          + "'$.operation_duration_ms',json_extract(usage_json,'$.operation_duration_ms')+?) WHERE handoff_id=? "
          + "AND EXISTS(SELECT 1 FROM intake_episodes WHERE episode_id=? AND customer_id=? AND state='handoff_pending')" + authority,
          toolCalls,operationDuration,receipt.handoff_id,episode.episode_id,customerId,...authorityParams],
        ...extras.map((extra,index) => [
          'INSERT INTO intake_events(episode_id,seq,event_json) SELECT e.episode_id,?,'
          + (extra.event === 'intake_ended' ? "json_set(?,'$.tool_calls',(SELECT json_extract(usage_json,'$.tool_calls') FROM intake_handoffs WHERE episode_id=e.episode_id))" : '?')
          + ' FROM intake_episodes e '
          + "WHERE e.customer_id=? AND e.episode_id=? AND e.state='handoff_pending' "
          + 'AND EXISTS(SELECT 1 FROM intake_handoffs WHERE handoff_id=? AND episode_id=e.episode_id) '
          + authority + ' ON CONFLICT(episode_id,seq) DO NOTHING', receipt.next_seq+index,JSON.stringify({...base,seq:receipt.next_seq+index,...extra}),customerId,episode.episode_id,receipt.handoff_id,...authorityParams
        ]),
        ['UPDATE intake_episodes SET state=?,updated_at=? WHERE customer_id=? AND episode_id=? '
          + "AND state='handoff_pending' AND EXISTS(SELECT 1 FROM intake_handoffs WHERE handoff_id=? AND episode_id=intake_episodes.episode_id)" + authority,
          complete ? 'complete_handoff' : receipt.kind === 'technical' ? 'technical_handoff' : 'incomplete_handoff',now,customerId,episode.episode_id,receipt.handoff_id,...authorityParams],
        ['SELECT 1 AS acknowledged FROM intake_episodes e JOIN intake_handoffs h USING(episode_id) '
          + "WHERE e.customer_id=? AND e.episode_id=? AND h.handoff_id=? AND e.state IN ('complete_handoff','technical_handoff','incomplete_handoff')" + authority,
          customerId,episode.episode_id,receipt.handoff_id,...authorityParams]
      ]);
      return Boolean(results.at(-1).results[0]);
    },

    listTransactions: (customerId, limit) => all(
      'SELECT transaction_id, occurred_at, source_occurred_at, merchant_name, amount, currency FROM transactions '
      + 'WHERE customer_id=? ORDER BY occurred_at DESC, source_occurred_at DESC, transaction_id LIMIT ?', customerId, limit),
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

    /** One handoff per episode; only acknowledged terminal rows enter this bounded queue. */
    listIntakeHandoffs: limit => all(
      'SELECT COALESCE(h.complete_case_id,h.handoff_id) AS protocol,h.episode_id,h.kind,h.tool_status,'
      + 'h.destination,h.priority,h.accepted_at FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) '
      + "WHERE e.state=h.kind||'_handoff' ORDER BY h.accepted_at DESC,protocol LIMIT ?", Math.min(limit, 51)),
    /** Optional complete evidence is one-to-one and owner-scoped; missing evidence never drops a handoff. */
    findIntakeHandoff: protocol => first(
      'SELECT COALESCE(h.complete_case_id,h.handoff_id) AS protocol,h.episode_id,h.kind,h.tool_status,'
      + 'h.destination,h.priority,h.accepted_at,h.evidence_json,h.actions_json,h.questions_json,'
      + 'e.customer_statement,e.language,t.transaction_id AS verified_transaction_id '
      + 'FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) '
      + 'LEFT JOIN cases c ON c.case_id=h.complete_case_id AND c.customer_id=e.customer_id AND c.customer_confirmed=1 '
      + 'LEFT JOIN transactions t ON t.transaction_id=c.transaction_id AND t.customer_id=e.customer_id '
      + "WHERE e.state=h.kind||'_handoff' AND (h.complete_case_id=? OR (h.complete_case_id IS NULL AND h.handoff_id=?))", protocol, protocol),
    /** At most 101 indexed events; overflow is explicit. ponytail: guided chains have <=5 events; add a cursor before supporting >100. */
    listIntakeHistory: episodeId => all(
      'SELECT event_json FROM intake_events WHERE episode_id=? ORDER BY seq LIMIT 101', episodeId),

    listAgentCases: limit => all(
      'SELECT c.case_id AS protocol, c.customer_id, u.display_name, c.transaction_id, t.merchant_name, '
      + 't.occurred_at, t.source_occurred_at, t.amount, t.currency, c.customer_statement, '
      + 'c.customer_confirmed, c.status, c.accepted_at FROM cases c '
      + 'JOIN customers u ON u.customer_id=c.customer_id '
      + 'JOIN transactions t ON t.transaction_id=c.transaction_id AND t.customer_id=c.customer_id '
      + 'ORDER BY c.accepted_at DESC, c.case_id LIMIT ?', limit)
  };
}
