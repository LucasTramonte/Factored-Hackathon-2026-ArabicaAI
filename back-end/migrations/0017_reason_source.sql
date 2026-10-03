-- Where intake_episodes.reason came from (ADR-010). Rows from before 0016 read reason = 'not_mine' only because of that
-- column's default, so they are 'not_recorded'; a start that carries the customer's choice writes 'customer'. Agents
-- see the reason only when it is the customer's (provenance flag, as the FX-estimated flag on USD amounts).
ALTER TABLE intake_episodes ADD COLUMN reason_source TEXT NOT NULL DEFAULT 'not_recorded'
  CHECK (reason_source IN ('customer','not_recorded'));
