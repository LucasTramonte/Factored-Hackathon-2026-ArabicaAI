# Silver transcript verification implementation plan

**Goal:** Integrate current main and verify the earlier transcript findings against a fresh, quality-gated Silver snapshot.
**Architecture:** Existing Bronze S3 ingestion and Silver transformations; read-only DuckDB aggregate audit; bounded historical SQLite export for exact record/text reconciliation. No new production extractor or model calls.
**Tech stack:** Existing DuckDB, Python stdlib, pytest.
**Spec:** User request to align branches with main/Manoella and verify cleaned data; REPRODUCIBILITY.md.

- [x] Preserve unfinished local work; fast-forward local main and merge origin/main into the active evaluation branch. Keep historical branch pointers.
- [x] Resolve conflicts in favor of current production pipeline while retaining source-reading instructions and historical evidence.
- [x] Add a regression fixture for changed text/labels, missing records and duplicate join keys; implement `data_foundation/src/silver_transcript_audit.py`.
- [x] Build the eight relevant tables from S3; run Silver and the scoped quality gate. Explicitly report tables outside scope.
- [x] Reconcile Bronze/Silver text and labels, saved Jev membership and the original 100-row sample. Reuse predictions only for exact text matches.
- [x] Save aggregate findings and a network-free notebook; run pipeline and affected historical tests. Commit only scoped code/docs, no raw records/credentials; do not push.

Memory: DuckDB 3GB working-memory limit with disk spill, two threads; Python holds bounded SQLite export batches and small aggregate output. Grain: transcript_id; interaction_id join must be one-to-one in the observed cohort before weighted counts. Missing/changed rows remain explicit. Same-model agreement is not accuracy; historical labels are not gold.
