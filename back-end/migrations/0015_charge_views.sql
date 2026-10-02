-- One row per GET /transactions?lang= (ADR-009): what was served, and whether the client showed it. Additive.
-- Times are epoch milliseconds, like intake_episodes and email_outbox.
CREATE TABLE charge_views (
  view_ref TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  language TEXT NOT NULL CHECK (language IN ('es', 'pt', 'en')),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  has_more INTEGER NOT NULL CHECK (has_more IN (0, 1)),
  coverage TEXT NOT NULL,
  retrieved_at INTEGER NOT NULL,
  displayed_at INTEGER
);
