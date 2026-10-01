-- Which reviewed seed parts are in this database, by content version. The cohort loader records a part
-- after it loads and checks here first, so a rerun never spends the write quota on a part already present.
CREATE TABLE IF NOT EXISTS seed_loads (
  version TEXT PRIMARY KEY CHECK (length(version) = 16),
  loaded_at TEXT NOT NULL
);
