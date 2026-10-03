-- Proactive alert (ADR-011). `bank_flagged` marks a charge the bank itself flagged (its fraud engine, an input this
-- service neither computes nor judges); in this prototype it is set only on authored fictitious charges, and no fraud
-- score ever reaches D1. `proactive_answers` keeps each answer to an alert, once per
-- customer, charge and kind of answerer: an admin acting as the customer answers as 'admin', which never silences the
-- alert for the customer. Answers hold no free text. Additive: existing charges read bank_flagged = 0.
ALTER TABLE transactions ADD COLUMN bank_flagged INTEGER NOT NULL DEFAULT 0 CHECK (bank_flagged IN (0, 1));
CREATE TABLE proactive_answers (
  customer_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  answered_by TEXT NOT NULL CHECK (answered_by IN ('customer', 'admin')),
  answer TEXT NOT NULL CHECK (answer IN ('mine', 'report')),
  answered_at INTEGER NOT NULL,
  PRIMARY KEY (customer_id, transaction_id, answered_by),
  FOREIGN KEY (customer_id, transaction_id) REFERENCES transactions(customer_id, transaction_id)
);
