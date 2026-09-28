-- Keep provenance for bounded imports without exposing it through the demo API.
CREATE TABLE IF NOT EXISTS intake_demo.sample_loads (
    run_id uuid PRIMARY KEY,
    loaded_at timestamptz NOT NULL DEFAULT now(),
    business_date date NOT NULL,
    manifest jsonb NOT NULL
);
