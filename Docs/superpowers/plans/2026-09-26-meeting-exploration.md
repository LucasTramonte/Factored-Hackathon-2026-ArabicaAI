# Contact Center and Fraud Exploration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver a verified notebook and meeting brief that ground contact-center and fraud-prevention choices in the supplied data.

**Architecture:** One notebook drives a small tested CSV-to-SQLite analysis helper. Disk-backed key checks and aggregations produce bounded tables for charts; raw data is read-only. Reuse the existing contract file discovery without inheriting the baseline runner's incomplete checks.

**Tech Stack:** Python 3.10+, csv/sqlite3/decimal/unittest, pandas, Matplotlib, nbformat, nbclient, nbconvert, ipykernel. Notebook packages and Matplotlib were absent from the inspected bundled Python; check the project's environment first, then install only missing packages in an ignored local virtual environment.

**Spec:** `Docs/superpowers/specs/2026-09-26-meeting-exploration-design.md`

## Global Constraints

- Work on the existing `feat/roberto-data-exploration` branch.
- Raw files are read-only.
- Never retain all fact IDs in a Python set.
- Missing or invalid booleans stay unknown rather than becoming false.
- Exclude every occurrence of a duplicated primary ID from primary entity-level metrics, rather than choosing an arbitrary record.
- Treat `is_fraud` as the target, never a predictor.
- No model training, dashboard, application implementation, publication, or messages to the team are included.
- Committed notebooks have outputs cleared; executed copies and the brief are delivered under the task's `outputs/` directory.

## Review Focus

1. Incomplete/changing downloads: reject missing, extra or size-changed required CSV objects before a final run (Task 1).
2. Cross-file duplicate/conflicting IDs: exclude every affected row and preserve raw-versus-eligible counts (Task 1).
3. Unknown outcomes and empty groups: show zero known denominator and an undefined rate, not 0% (Task 2).
4. Invalid money/dates and open cases: preserve unknowns; never mix currencies or impute resolution (Task 2).
5. Ambiguous dimension matches: preserve fact row counts and report unmatched/ambiguous enrichment (Task 2).

## Files and interfaces

- Create `data_foundation/src/exploration.py`: streaming ingestion, quality and compact aggregates.
- Create `data_foundation/tests/test_exploration.py`: one focused fixture-based unittest module; temporary CSVs/SQLite only.
- Create `notebooks/01_customer_service_workflow_exploration.ipynb`: methods, parameters, charts, interpretation and candidate comparison.
- Create `notebooks/README.md` and `notebooks/requirements.txt`: exact tested setup/run instructions and notebook-only dependencies; leave the stdlib baseline environment intact.
- Generated SQLite, input manifests and intermediate outputs: ignored `data_foundation/runs/meeting-exploration/`.
- User deliverables: task `outputs/contact-center-fraud-exploration.ipynb`, its HTML preview, and `outputs/team-meeting-brief.md`.

### Task 1: Verified streaming inputs and quality gates

**Interfaces:** `verify_inputs(data_root: Path, manifest: list[dict], tables: tuple[str, ...]) -> dict[str, list[Path]]`; manifest records use dataset-relative `path` and integer `size`. `load_table(connection: sqlite3.Connection, table: str, files: list[Path], batch_size: int = 5000) -> dict` returns raw, eligible, missing-key, duplicate-key and conflicting-key counts plus schema/date/field quality counts. SQLite stores projected fields and a full-row digest for duplicate conflict checks.

- [ ] Write `test_input_gate` asserting missing/extra/size-changed files fail, and complete fixture inventory passes. Write `test_cross_partition_keys_and_bom` with two files containing IDs A,A,B,C and one blank ID: raw=5, eligible=2, duplicate_keys=1, duplicate_rows=2, blank_rows=1. Different A payloads must produce conflicting_keys=1. Assert the same result at batch sizes 1 and 3; missing required headers must fail clearly.
- [ ] Run `python -m unittest discover -s data_foundation/tests -p test_exploration.py -v`; confirm failure because the new interfaces do not exist.
- [ ] Implement the interfaces in `exploration.py`, using UTF-8-SIG, csv.DictReader, parameterized SQLite inserts, on-disk temporary storage and a bounded SQLite cache. Validate required fields in every file. Index primary IDs on disk; eligible views include only nonblank IDs with count=1. Report progress by file batch. Do not call the baseline scanner as the analysis validator.
- [ ] Re-run focused tests; require all assertions to pass. Verify database connections and temporary files close on failure.
- [ ] Commit only the helper and its tests.

### Task 2: Contact-center and fraud evidence

**Interfaces:** `summarize(connection: sqlite3.Connection) -> dict[str, list[dict]]` returns compact quality, coverage, contact-demand/outcome, complaint, fraud and enrichment tables. Every boolean rate includes `numerator`, `denominator`, `unknown`, `eligible`, `rate`; undefined rates are `None`. Use exact column names in ingestion; presentation labels may be descriptive.

- [ ] Add `test_analysis_denominators`: eligible flag values True,False,blank,invalid yield numerator=1, denominator=2, unknown=2, eligible=4, rate=0.5; all unknown yields rate=None. Test missing USD amounts remain unknown, and totals in COP/MXN remain separate. Test negative/nonfinite durations are invalid and open complaints are not assigned zero resolution days. Test a duplicated dimension key cannot multiply fact rows.
- [ ] Run focused tests and confirm the new expectations fail before implementing aggregations.
- [ ] Implement `summarize`: contact reasons/categories and channel/country outcomes; valid duration median/p95; complaint categories/status/SLA and resolution coverage; transaction fraud prevalence by type/category/channel, country and amount context; monthly event-date trends; raw-versus-eligible ranking sensitivity. Return bounded top-category displays plus totals; preserve complete aggregates in ignored output if needed. Keep exact sorting/percentiles on disk. Parse finite money with Decimal and aggregate integer minor units. Expose missing, invalid and unmatched counts.
- [ ] Use customers only for unique-key country enrichment; label snapshot semantics. Read transcript metadata for language/coverage without returning raw text. Keep complaint evidence at complaint grain; do not invent complaint-to-transaction links. Label `fraud_score` descriptive and post-decision fields unsuitable for assumed prevention features.
- [ ] Run fixture and integration assertions, including eligible totals reconciling to known+unknown and enrichment preserving counts. Run `make test compile PYTHON=python3` for baseline regressions.
- [ ] Commit the completed helper and focused tests.

### Task 3: Executed notebook and meeting handoff

**Interfaces:** notebook consumes Tasks 1–2 with visible `DATA_ROOT`, `MANIFEST_PATH`, `SCRATCH_ROOT` and `BATCH_SIZE` parameters. Source paths are portable; generated artifacts and execution use explicit project working directory. No hidden kernel state or embedded secrets.

- [ ] Inspect installed environments and supply missing notebook packages in ignored `.venv`; record tested versions in `notebooks/requirements.txt`. Create notebook via nbformat, with summary, context/methods, data quality, contact-center, supporting complaint/transcript, fraud-prevention and takeaway sections. Write summary claims only after results exist.
- [ ] Add explicit variable-role table: `is_fraud` target; `fraud_score` timing/provenance unknown; status/response potentially post-decision; historical features prior-only. Distinguish documented FCR from verified repeat-contact behavior. No predictive-model performance claims.
- [ ] Execute on the synthetic fixture, then a clearly labeled smoke subset and a controlled set of complete partitions. Reconcile output counts to fixture expectations and inspect failure handling. Smoke results never become final conclusions.
- [ ] Poll the existing S3 sync, without restarting due to an observation timeout. Refresh its object manifest. Verify all required tables, then execute the complete notebook in a fresh kernel. Include contact-center, complaints, transactions, customers and transcript metadata; survey analysis is optional and cannot silently mix score scales.
- [ ] Build labeled charts for demand, known-outcome rates with coverage, complaint impact and fraud patterns. Compare 2–3 workflow candidates without invented scoring weights. State safe boundaries, baseline ideas and held-out evaluation needs, including Spanish/Portuguese coverage. If no candidate wins on evidence, say so.
- [ ] Validate notebook with nbformat, execute with nbclient using the local kernel, export HTML via nbconvert, and inspect the rendered HTML and figures. Check claims against calculated numbers, labels, denominator notes and missing-data disclosures.
- [ ] Write the one-page brief from verified outputs, retaining the three strongest findings, limitations and proposed team decisions. Copy executed notebook and HTML to task outputs; clear outputs only in the tracked source notebook. Document rerun commands, package installation and data manifest generation in `notebooks/README.md`.
- [ ] Run `make test compile PYTHON=python3`, inspect `git diff --check`, ensure no raw data/credentials/generated outputs are staged, and commit only intended source files. Obtain a final independent review under the chosen execution workflow, resolve findings, and re-run affected checks.

## Completion audit

Verify branch, fixtures, complete input coverage, full clean-kernel execution, fraud and contact-center findings, generated visual inspection, quality/denominator traceability, and all three deliverable links. Download progress or a source notebook alone is not completion. Preserve unrelated existing AGENTS/README/source-document changes.

## Completion evidence — 26 September 2026

Completed on `feat/roberto-data-exploration`. Twelve regression tests and compilation passed. Synthetic, smoke, controlled and full clean-kernel notebook runs passed; the final full run verified 4,389 CSVs (1,150,192,216 bytes), produced eight figures, and matched all five source-header inventories to the original dictionary. Independent review found no analytical correctness blocker; the missing schema audit and category/repeat-complainer displays were added and verified in the executed output. Presentation fixes were checked visually. Full dataset download separately reconciled all 7,671 inventory objects by name and size.

Implementation decisions: reused the existing dedicated branch and partition helper; used bounded batches with disk-backed SQLite; retained fixed descriptive amount bands/hour groups without optimizing thresholds; raised notebook Python minimum to 3.11 for pinned dependencies (executed on 3.12.14); normalized fixture paths for macOS symlinks. These choices trade disk/runtime and environment setup for reproducibility, without changing raw data. The inherited scanner, unrelated context/source changes, predictive effectiveness and ROI remain outside this analysis. No review findings remain deferred.

Delivered outside Git in the task's `outputs/` directory: executed notebook, HTML report and meeting brief. Source notebook outputs remain cleared; dated interpretations must be revisited after changing inputs.
