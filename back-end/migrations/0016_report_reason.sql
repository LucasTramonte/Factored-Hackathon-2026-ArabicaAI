-- Why the customer doesn't recognise the charge (ADR-010). One closed list; the default keeps old rows valid.
ALTER TABLE intake_episodes ADD COLUMN reason TEXT NOT NULL DEFAULT 'not_mine'
  CHECK (reason IN ('not_mine','duplicate','wrong_amount','cancelled_or_not_received','subscription','card_lost_or_stolen','other'));
