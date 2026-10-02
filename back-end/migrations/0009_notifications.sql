-- Where to reach a customer who signed in by email, and what we sent. The address is AES-GCM encrypted with a
-- Worker secret; the outbox stores template, language and reference only, never a body or a statement.
CREATE TABLE notification_targets (
  customer_id TEXT PRIMARY KEY REFERENCES customers(customer_id),
  email_enc TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE email_outbox (
  message_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  template TEXT NOT NULL CHECK (template IN ('received','in_review','closed','update')),
  language TEXT NOT NULL CHECK (language IN ('es','pt','en')),
  reference TEXT NOT NULL,
  provider_status TEXT NOT NULL CHECK (provider_status IN ('queued','sent','failed','skipped')),
  provider_message_id TEXT
);
CREATE INDEX email_outbox_recent ON email_outbox(customer_id, reference, created_at DESC);
