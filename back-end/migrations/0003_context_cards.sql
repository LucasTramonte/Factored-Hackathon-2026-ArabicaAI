-- One versioned Gold snapshot per loaded customer; language remains a session choice.
CREATE TABLE IF NOT EXISTS context_cards (
  customer_id TEXT PRIMARY KEY REFERENCES customers(customer_id),
  card_version INTEGER NOT NULL CHECK (card_version = 1),
  snapshot_at TEXT NOT NULL,
  card_json TEXT NOT NULL CHECK (json_valid(card_json))
);
