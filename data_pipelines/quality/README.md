# DuckDB readiness checks

`python -m data_pipelines.quality.run_quality` reads the ignored local DuckDB after Bronze and Silver complete. It writes aggregate-only JSON and Markdown under ignored `data/quality_runs/<run_id>/` and exits nonzero for missing tables, schema/required-field errors, processing-partition mismatches or unexplained raw-to-typed row changes. Warnings, including foreign-key orphans, product-owner mismatches and transactions before product opening, remain visible for later analysis decisions.

Contracts in `contracts.py` preserve the former CSV baseline's key, required-field, domain, partition and foreign-key expectations. The new gate runs SQL in DuckDB with a bounded configured memory limit and disk spill; it does not retain fact keys in Python. `--tables` is for controlled checks only; the default full run checks all 13 source tables and cross-table relationship signals.

The former baseline and this gate were compared on an identical local CSV sample before retirement. The full reconciliation, observed warnings and resource use are recorded in [PARITY.md](PARITY.md). Differences caused by Silver deduplication or deliberate column transformations are reported explicitly. A successful gate means the source and typed tables are structurally ready to query; it does not certify a specific Marketing/Product metric or an invalid owner link.
