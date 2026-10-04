-- Messages between the reviewing agent and the customer on one acknowledged report (ADR-015). In-app only: the email
-- outbox's template CHECK (migration 0009) admits no message template, and widening it is a table rebuild, so a message
-- is not emailed yet. The body is case content, like the customer's statement: it is never copied into an event or a log.
-- ``idempotency_key`` makes a retried post store one message; ``agent_session_ref`` is the 12-hex audit reference of the
-- agent session (never the token), set exactly when the author is the agent. Posting stops once the report is closed.
CREATE TABLE handoff_messages (
  message_id TEXT PRIMARY KEY,
  handoff_id TEXT NOT NULL REFERENCES intake_handoffs(handoff_id),
  author TEXT NOT NULL CHECK (author IN ('agent','customer')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  agent_session_ref TEXT CHECK (agent_session_ref IS NULL OR length(agent_session_ref) = 12),
  CHECK ((author = 'agent') = (agent_session_ref IS NOT NULL)),
  UNIQUE (handoff_id, author, idempotency_key)
);
CREATE INDEX handoff_messages_thread ON handoff_messages(handoff_id, created_at);
