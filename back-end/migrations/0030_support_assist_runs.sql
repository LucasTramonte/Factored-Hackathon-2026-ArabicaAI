-- Bounded call metadata only: no generated text, identity, statement or question.
CREATE TABLE support_assist_runs (
  request_id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('reviewer','customer')),
  protocol TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  outcome TEXT CHECK(outcome IN ('success','timeout','provider_error','auth_error','invalid_output','config_error','abandoned','stale')),
  latency_ms INTEGER,
  llm_calls INTEGER NOT NULL DEFAULT 1 CHECK(llm_calls BETWEEN 0 AND 1),
  known_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(known_input_tokens>=0),
  known_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(known_output_tokens>=0),
  usage_unavailable_calls INTEGER NOT NULL DEFAULT 1 CHECK(usage_unavailable_calls BETWEEN 0 AND llm_calls),
  version TEXT NOT NULL CHECK(length(version) BETWEEN 1 AND 160)
);
CREATE INDEX support_assist_time ON support_assist_runs(created_at);
CREATE INDEX support_assist_session ON support_assist_runs(session_hash,mode,created_at);
CREATE INDEX support_assist_pending ON support_assist_runs(created_at) WHERE outcome IS NULL;
