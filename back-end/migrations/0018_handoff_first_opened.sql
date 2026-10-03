-- First agent open: epoch-ms INTEGER, null until GET /agent/intake-detail and never rewritten; the API returns UTC ISO.
-- accepted_at is UTC ISO TEXT. Pickup milliseconds = first_opened_at -
-- CAST(ROUND((julianday(accepted_at)-2440587.5)*86400000) AS INTEGER); do not subtract its text directly.
ALTER TABLE intake_handoffs ADD COLUMN first_opened_at INTEGER;
-- The agent detail summarises a customer's latest reports; this index keeps that read bounded (newest 21 episodes).
CREATE INDEX intake_episodes_owner_recent ON intake_episodes(customer_id, created_at DESC);
