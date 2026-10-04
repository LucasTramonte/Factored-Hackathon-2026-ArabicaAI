-- AI suggestions on "I can't find the charge" (ADR-012; Docs/Plans/ai-suggestion-plan.md). Additive only. References and
-- counts, never the customer's text or the model's answer.
-- One run per incomplete handoff that carries details, inserted in the handoff's own reservation batch: the pilot arm
-- (A = control, never called; B = extraction; NULL when the switch was off), then the outcome and usage the Worker records
-- after the response. A NULL outcome is still pending, or a Worker that stopped mid-call: its pre-recorded call stays unknown.
CREATE TABLE handoff_suggestion_runs (
  handoff_id TEXT PRIMARY KEY REFERENCES intake_handoffs(handoff_id),
  arm TEXT CHECK (arm IS NULL OR arm IN ('A','B')),
  created_at INTEGER NOT NULL,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('off','capped','retired','auth_error','timeout','provider_error','config_error',
    'invalid_output','no_match','ambiguous','suggested')),
  producer TEXT,
  llm_calls INTEGER NOT NULL DEFAULT 0 CHECK (llm_calls BETWEEN 0 AND 2),
  known_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (known_input_tokens >= 0),
  known_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (known_output_tokens >= 0),
  usage_unavailable_calls INTEGER NOT NULL DEFAULT 0 CHECK (usage_unavailable_calls BETWEEN 0 AND llm_calls),
  finished_at INTEGER
);
-- At most three of the customer's own charges per run, in the policy's order; the insert checks ownership in SQL.
CREATE TABLE handoff_suggestions (
  handoff_id TEXT NOT NULL REFERENCES handoff_suggestion_runs(handoff_id),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 3),
  transaction_id TEXT NOT NULL REFERENCES transactions(transaction_id),
  producer TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (handoff_id, rank),
  UNIQUE (handoff_id, transaction_id)
);
-- The customer's one answer: a suggested charge, or none of them. The first answer stands. It confirms nothing to the
-- bank and closes nothing; the agent still reviews the report.
CREATE TABLE handoff_suggestion_choices (
  handoff_id TEXT PRIMARY KEY REFERENCES handoff_suggestion_runs(handoff_id),
  choice TEXT NOT NULL CHECK (choice IN ('confirmed','none')),
  transaction_id TEXT,
  chosen_at INTEGER NOT NULL,
  CHECK ((choice = 'confirmed') = (transaction_id IS NOT NULL)),
  FOREIGN KEY (handoff_id, transaction_id) REFERENCES handoff_suggestions(handoff_id, transaction_id)
);
-- An agent's mark on a customer-confirmed suggestion: the pilot's label for "was the suggestion right?". One per report;
-- the agent session is a 12-hex reference, never the token.
CREATE TABLE handoff_suggestion_marks (
  handoff_id TEXT PRIMARY KEY REFERENCES handoff_suggestion_choices(handoff_id),
  mark TEXT NOT NULL CHECK (mark IN ('correct','wrong')),
  agent_session_ref TEXT NOT NULL CHECK (length(agent_session_ref) = 12),
  marked_at INTEGER NOT NULL
);
-- The daily call cap (a budget breaker): extractions started per UTC day.
CREATE TABLE ai_daily_calls (
  day TEXT PRIMARY KEY CHECK (length(day) = 10),
  calls INTEGER NOT NULL CHECK (calls >= 0)
);
