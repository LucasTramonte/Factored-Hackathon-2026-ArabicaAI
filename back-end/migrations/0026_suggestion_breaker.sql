-- The AI suggestion path's circuit breaker (ADR-006 amendment 10) reads the outcomes of the last few runs that called the
-- model, newest first. This partial index holds only those finished runs, so the read touches at most a handful of rows
-- instead of every run. Each run that calls the model writes one more index row when it finishes (ADR-004). Additive.
CREATE INDEX handoff_suggestion_runs_called ON handoff_suggestion_runs(finished_at) WHERE llm_calls > 0 AND outcome IS NOT NULL;
