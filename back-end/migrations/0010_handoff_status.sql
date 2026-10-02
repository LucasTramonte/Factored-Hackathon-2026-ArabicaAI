-- A human-owned state per handoff: received → in_review → closed, forward only. "closed" means a person finished the
-- review; the outcome reaches the customer through the bank's own channel. No refund, block or verdict is recorded (ADR-002).
ALTER TABLE intake_handoffs ADD COLUMN status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','in_review','closed'));
CREATE TABLE handoff_status_history (
  handoff_id TEXT NOT NULL REFERENCES intake_handoffs(handoff_id),
  status TEXT NOT NULL CHECK (status IN ('in_review','closed')),
  changed_at INTEGER NOT NULL,
  agent_session_ref TEXT NOT NULL CHECK (length(agent_session_ref) = 12),
  UNIQUE(handoff_id, status)
);
