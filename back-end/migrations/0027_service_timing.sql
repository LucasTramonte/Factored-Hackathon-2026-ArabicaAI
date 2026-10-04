-- How long unrecognized-charge complaints waited at this bank, historically: the reviewed Gold aggregate
-- (``gold.complaint_timing`` -> ``back-end/seeds/service_timing.json``, ``data_pipelines/gold/service_timing.py``) that the
-- Worker serves for "How long does it take?". Counts and quantiles only, no customer or complaint row. ``n`` complaints
-- have the interval; ``missing`` have none yet and ``negative`` run backwards (n + missing + negative = population).
-- ``creation_to_resolution`` covers resolved complaints only, so it is never shown as an expected time. A refresh adds a
-- new ``version`` in a new migration; the Worker serves the newest ``published_on``. Additive: a table and new rows.
CREATE TABLE service_timing (
  version TEXT NOT NULL,
  published_on TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('first_response','creation_to_resolution')),
  unit TEXT NOT NULL CHECK (unit IN ('hours','days')),
  p50 REAL NOT NULL CHECK (p50 >= 0),
  p90 REAL NOT NULL CHECK (p90 >= p50),
  n INTEGER NOT NULL CHECK (n >= 0),
  missing INTEGER NOT NULL CHECK (missing >= 0),
  negative INTEGER NOT NULL CHECK (negative >= 0),
  population INTEGER NOT NULL CHECK (population = n + missing + negative),
  subcategory TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end_exclusive TEXT NOT NULL,
  source TEXT NOT NULL,
  query TEXT NOT NULL,
  gold_build TEXT NOT NULL,
  PRIMARY KEY (version, metric)
);
INSERT INTO service_timing (version, published_on, metric, unit, p50, p90, n, missing, negative, population, subcategory, window_start, window_end_exclusive, source, query, gold_build) VALUES ('4e2a1b33eac4812d', '2026-10-04', 'creation_to_resolution', 'days', 15.0, 27.0, 2414, 7956, 0, 10370, 'Cargo no reconocido', '2023-06-17', '2026-01-01', 'silver.fact_complaints', 'data_foundation/queries/product/PR-04_before.sql', '20261004T164425548775Z');
INSERT INTO service_timing (version, published_on, metric, unit, p50, p90, n, missing, negative, population, subcategory, window_start, window_end_exclusive, source, query, gold_build) VALUES ('4e2a1b33eac4812d', '2026-10-04', 'first_response', 'hours', 25.0, 44.0, 6045, 4325, 0, 10370, 'Cargo no reconocido', '2023-06-17', '2026-01-01', 'silver.fact_complaints', 'data_foundation/queries/product/PR-04_before.sql', '20261004T164425548775Z');
