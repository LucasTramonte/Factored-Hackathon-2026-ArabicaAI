-- Separate bounded demo store. Migrate the PostgreSQL demo; do not import historical cases.
CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  transaction_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  occurred_at TEXT,
  source_occurred_at TEXT,
  merchant_name TEXT NOT NULL,
  amount TEXT NOT NULL CHECK (CAST(amount AS REAL) > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  UNIQUE(customer_id, transaction_id),
  CHECK ((occurred_at IS NULL) <> (source_occurred_at IS NULL))
);
CREATE INDEX IF NOT EXISTS transactions_customer_order
  ON transactions(customer_id, occurred_at DESC, source_occurred_at DESC, transaction_id);
CREATE TABLE IF NOT EXISTS cases (
  case_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  customer_statement TEXT NOT NULL CHECK (length(trim(customer_statement)) BETWEEN 10 AND 2000),
  customer_confirmed INTEGER NOT NULL CHECK (customer_confirmed = 1),
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status = 'accepted'),
  accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY(customer_id, transaction_id) REFERENCES transactions(customer_id, transaction_id),
  UNIQUE(customer_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS cases_agent_order ON cases(accepted_at DESC, case_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  actor TEXT NOT NULL CHECK (actor IN ('customer', 'agent')),
  customer_id TEXT,
  expires_at INTEGER NOT NULL,
  CHECK ((actor = 'customer' AND customer_id IS NOT NULL)
      OR (actor = 'agent' AND customer_id IS NULL))
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
