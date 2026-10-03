-- The customer's one answer, on the receipt, to "was it easy to report this charge?" (1 = thumbs up, 0 = thumbs down).
-- One row per acknowledged report; the first answer stands. It is a customer-effort signal for the insights report, not
-- CSAT, and never an event field.
CREATE TABLE report_feedback (
  handoff_id TEXT PRIMARY KEY REFERENCES intake_handoffs(handoff_id),
  easy INTEGER NOT NULL CHECK (easy IN (0, 1)),
  created_at INTEGER NOT NULL
);
