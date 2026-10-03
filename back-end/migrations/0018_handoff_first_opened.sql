-- When an agent first opened each acknowledged report (epoch ms), so time to pickup is measured: first_opened_at minus
-- accepted_at. Null until the first GET /agent/intake-detail; never rewritten afterwards.
ALTER TABLE intake_handoffs ADD COLUMN first_opened_at INTEGER;
-- The agent detail summarises a customer's latest reports; this index keeps that read bounded (newest 21 episodes).
CREATE INDEX intake_episodes_owner_recent ON intake_episodes(customer_id, created_at DESC);
