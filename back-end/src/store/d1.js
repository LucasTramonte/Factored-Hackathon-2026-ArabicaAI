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

    listAgentCases: limit => all(
      'SELECT c.case_id AS protocol, c.customer_id, u.display_name, c.transaction_id, t.merchant_name, '
      + 't.occurred_at, t.source_occurred_at, t.amount, t.currency, c.customer_statement, '
      + 'c.customer_confirmed, c.status, c.accepted_at FROM cases c '
      + 'JOIN customers u ON u.customer_id=c.customer_id '
      + 'JOIN transactions t ON t.transaction_id=c.transaction_id AND t.customer_id=c.customer_id '
      + 'ORDER BY c.accepted_at DESC, c.case_id LIMIT ?', limit)
  };
}
