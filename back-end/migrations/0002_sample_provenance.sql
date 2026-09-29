CREATE TABLE IF NOT EXISTS sample_provenance (
  transaction_id TEXT PRIMARY KEY REFERENCES transactions(transaction_id),
  product_id TEXT NOT NULL,
  source_file TEXT NOT NULL,
  business_date TEXT NOT NULL,
  mapping TEXT NOT NULL
);
