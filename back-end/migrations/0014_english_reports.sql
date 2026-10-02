-- English is a report language (ADR-008). SQLite cannot alter a CHECK, so intake_episodes is rebuilt. Columns,
-- defaults, CHECKs and UNIQUE are exactly 0004's except the language list. The table keeps its name: dropping the
-- parent counts each intake_turns/intake_events/intake_handoffs row as a deferred violation, and only re-inserting
-- the parent rows clears it (a create-new-then-rename rebuild fails at commit with rows present). Proven on rows by
-- test/unit/intake-storage.test.js.
PRAGMA defer_foreign_keys = true;
CREATE TABLE intake_episodes_copy AS SELECT * FROM intake_episodes;
DROP TABLE intake_episodes;
CREATE TABLE intake_episodes (
  episode_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  session_ref TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('es', 'pt', 'en')),
  mode TEXT NOT NULL CHECK (mode = 'guided'),
  state TEXT NOT NULL CHECK (state IN ('selection_required','handoff_pending','complete_handoff','technical_handoff','incomplete_handoff','abandoned')),
  customer_statement TEXT NOT NULL CHECK (length(customer_statement) BETWEEN 10 AND 2000),
  start_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  usage_json TEXT NOT NULL DEFAULT '{"tool_calls":1}' CHECK (json_valid(usage_json)),
  UNIQUE(customer_id, start_key)
);
INSERT INTO intake_episodes(episode_id,customer_id,session_ref,language,mode,state,customer_statement,start_key,payload_hash,created_at,updated_at,expires_at,usage_json)
  SELECT episode_id,customer_id,session_ref,language,mode,state,customer_statement,start_key,payload_hash,created_at,updated_at,expires_at,usage_json FROM intake_episodes_copy;
DROP TABLE intake_episodes_copy;
-- The indexes of 0004 and 0005, unchanged.
CREATE INDEX intake_episodes_owner ON intake_episodes(customer_id, episode_id);
CREATE INDEX intake_episodes_idle ON intake_episodes(MIN(updated_at+600000,expires_at),episode_id)
  WHERE state='selection_required';
