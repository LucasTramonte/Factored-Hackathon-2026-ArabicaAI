-- Guided episode storage is separate from confirmed cases; starts never issue a case reference.
CREATE TABLE intake_episodes (
  episode_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  session_ref TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('es', 'pt')),
  mode TEXT NOT NULL CHECK (mode = 'guided'),
  state TEXT NOT NULL,
  customer_statement TEXT NOT NULL CHECK (length(customer_statement) BETWEEN 10 AND 2000),
  start_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  usage_json TEXT NOT NULL DEFAULT '{"tool_calls":1}' CHECK (json_valid(usage_json)),
  UNIQUE(customer_id, start_key)
);
CREATE INDEX intake_episodes_owner ON intake_episodes(customer_id, episode_id);
CREATE INDEX intake_episodes_updated ON intake_episodes(updated_at, episode_id);
CREATE TABLE intake_turns (
  episode_id TEXT NOT NULL REFERENCES intake_episodes(episode_id),
  turn_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  UNIQUE(episode_id, turn_key)
);
CREATE TABLE intake_events (
  episode_id TEXT NOT NULL REFERENCES intake_episodes(episode_id),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  UNIQUE(episode_id, seq)
);
-- One immutable terminal reservation per episode. Unconfirmed handoffs never invent a case transaction.
CREATE TABLE intake_handoffs (
  handoff_id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL UNIQUE REFERENCES intake_episodes(episode_id),
  complete_case_id TEXT UNIQUE REFERENCES cases(case_id),
  turn_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('complete','technical','incomplete')),
  tool_status TEXT NOT NULL CHECK (tool_status IN ('ok','failed','timeout')),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  actions_json TEXT NOT NULL CHECK (json_valid(actions_json) AND json_type(actions_json)='array'),
  questions_json TEXT NOT NULL CHECK (json_valid(questions_json) AND json_type(questions_json)='array'),
  destination TEXT NOT NULL,
  priority TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  usage_json TEXT NOT NULL CHECK (json_valid(usage_json)),
  CHECK ((kind='complete' AND complete_case_id IS NOT NULL AND tool_status='ok')
    OR (kind='incomplete' AND complete_case_id IS NULL AND tool_status='ok')
    OR (kind='technical' AND complete_case_id IS NULL AND tool_status IN ('failed','timeout')))
);
CREATE INDEX intake_handoffs_queue ON intake_handoffs(accepted_at DESC,handoff_id);
