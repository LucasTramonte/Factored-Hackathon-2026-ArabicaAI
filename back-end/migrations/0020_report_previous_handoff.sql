-- A customer saying "Not resolved" starts a new episode linked to an acknowledged closed report; never reopens it.
-- The server resolves the public previous_protocol only for that session's customer and rechecks it in the insert.
ALTER TABLE intake_episodes ADD COLUMN previous_handoff_id TEXT REFERENCES intake_handoffs(handoff_id);
