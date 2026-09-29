# Transcript verification after the Bronze/Silver migration

## Branch and source

Local `main` fast-forwarded to `4cc2953`; `origin/main` was merged into `feat/suspicious-charge-evaluation` at `67429b5`. The merge includes Manoella's Bronze/Silver work (PR #3) and Lucas's integration/quality work (PR #4). No history was rewritten and no remote branch was changed. Unfinished evaluation work was preserved, with an additional pre-merge stash backup. Older feature branches remain historical pointers.

The production pipeline and Makefile follow main. Historical CSV notebooks/caches remain dated comparison evidence; the retired CSV quality scanner is not restored. Small compatibility helpers keep prior notebook modules importable. New source analysis reads Silver.

## Reproduce

Use the repository's existing pipeline with the locally configured AWS profile:

```sh
S3_BUCKET=factored-datathon-2026-s3-157725502942-us-east-2-an AWS_REGION=us-east-2 AWS_PROFILE=factored-datathon \
  .venv/bin/python data_pipelines/bronze/run_ingestion.py \
  --tables customers,products,branches,service_agents,daily_exchange_rates,call_center_interactions,call_transcripts,complaints
.venv/bin/python data_pipelines/silver/run_silver.py \
  --tables customers,products,branches,service_agents,call_center_interactions,call_transcripts,complaints
.venv/bin/python -m data_pipelines.quality.run_quality \
  --tables customers,products,branches,service_agents,daily_exchange_rates,call_center_interactions,call_transcripts,complaints \
  --run-id transcript-verification-20260928
.venv/bin/python -m data_foundation.src.silver_transcript_audit \
  --quality data/quality_runs/transcript-verification-20260928/quality_results.json \
  --output data_foundation/runs/silver-transcript-verification
```

The recorded first build used fresh S3 objects, not a regenerated copy of our historical CSV cache. Future Bronze invocations are incremental; corrected historical source partitions require the existing `--full-refresh` workflow and a new audit output/run ID. Do not overwrite an earlier audit. FX builds automatically before the selected Silver tables.

This is an **eight-table, full-history scoped verification**, not an all-thirteen-table production-readiness claim. Campaigns/sends, transactions, digital events and surveys are outside this run. The existing quality gate must pass before the analysis runs. Warnings and the additional complaint-product ownership audit remain explicit.

## Method

- DuckDB: 3 GB audit working-memory limit, two threads, disk spill. Python streams the historical membership export in batches of 2,000; it retains only small aggregate results, 546 model outputs and the 100-record sample.
- Grain: transcript ID. Require unique/non-null transcript and interaction keys before comparing the historical cohort. Join interactions on `interaction_id`, never on customer alone; count orphan links and customer mismatches.
- Compare fresh Bronze/Silver values for transcript content and labeling fields. Preserve changes, missing/added IDs and row-count reconciliation.
- Compare exact SHA256 text, original category, customer and interaction linkage with the saved Jev input cohort. Reuse saved predictions only on exact text matches; new or changed texts remain unclassified. No new inference calls.
- Recheck original sample membership, full text and contact category. This preserves provenance; it does not turn the preliminary sample review into blinded human adjudication.
- Report business event dates from `interaction_date`; processing partitions are ingestion metadata.

## Interpretation

Label-vs-text disagreement is not an adjudicated label-error rate. Silver's typing, deduplication and sentinel cleanup do not decide whether source text, source category or taxonomy is semantically correct. The complaint table is independent evidence; a missing complaint/interaction relationship cannot be reconstructed from shared customers.

## Verified results — fresh S3/Silver run, 2026-09-28 UTC

The eight-table build and quality gate succeeded: **191 checks, zero errors, three warnings**. Every selected Silver table has the same row count as Bronze, with no duplicate primary keys or unexplained row delta. The warning counts are customer status outside the declared domain (4,407/150,000), customer registration-branch orphans (149,995/150,000), and agent branch orphans (831/1,200). These warnings prohibit unsupported branch attribution; they do not break the verified transcript/interaction join.

| Check | Result |
|---|---:|
| All interactions | 686,296 |
| Transcript-bearing interactions | 171,321 (24.96%) |
| Exact distinct full texts | 546 |
| Historical transcript IDs matched | 171,321 |
| Added / removed / changed full text / changed source label | 0 / 0 / 0 / 0 |
| Changed interaction/customer linkage | 0 / 0 |
| Missing transcript-to-interaction links / customer mismatches | 0 / 0 |
| Original 100-record sample missing or changed | 0 |
| Unique text groups carrying multiple original categories | 546 / 546 |
| `contact_reason` differs from `reason_category` | 0 / 686,296 |
| Missing/incorrect `has_transcript` flags | 0 |
| Unique opening lines / unique customer texts | 2 / 42 |
| Transcripts containing unresolved `{...}` placeholders | 171,321 / 171,321 |
| Recorded transcript language | Spanish (`es`), 171,321 / 171,321 |

All eleven checked Bronze-to-Silver content/category fields have zero changes: transcript interaction/customer IDs, full/customer/agent text, recorded language/intents/topics, and interaction customer/category fields. Business timestamps for the transcript-bearing cohort span **2023-06-17 08:10:43 through 2026-06-18 07:58:13**. Processing partitions end June 17; do not truncate the business window to match them.

Saved first-pass Jev predictions match every Silver full-text hash. The mapping comparison remains:

| Original category | Transcript-derived balance intent |
|---|---:|
| Transaccional | 59,786 |
| Producto | 37,658 |
| Queja | 29,198 |
| Técnico | 25,691 |
| Comercial | 13,808 |
| Retención | 5,180 |

Under the explicitly provisional balance → Transaccional mapping, **111,535/171,321 = 65.10%** disagree; **37,658 Producto records are particularly taxonomy-sensitive**. This is not a measured labeling-error rate. Exact transcript/ID equality also preserves the applicability of the earlier second-pass results; it adds no independent model validation or human gold.

The separate complaint-table check reproduces **12,297 Cargo no reconocido + 12,194 Cobro indebido = 24,491**. The additional ownership audit again finds **44,570 mismatches among 44,570 linked complaint/product pairs**. Do not attribute complaint product ownership through that link. No complaint→transcript relationship is established.

**Conclusion:** Manoella's structural cleanup preserves the relevant source evidence. The earlier inconsistency is reproducible on Silver; it was not introduced by our CSV loader. The extreme repetition, placeholders and conflicting category assignments support investigating both transcript generation and taxonomy/label quality. They do not establish which source represents an actual customer request. Keep original labels, transcript-derived candidates and eventual human adjudications separate.

## Evidence and validation

- Ignored fresh snapshot: `data/latam_bank.duckdb`; full ingestion/build logs: `data/bronze-transcript-verification.log` and `data/silver-transcript-verification.log`.
- Quality evidence: `data/quality_runs/transcript-verification-20260928/quality_results.json` and `quality_report.md`.
- Aggregate reconciliation, ingestion timestamps and script hash: `data_foundation/runs/silver-transcript-verification/summary.json`.
- Readout: `notebooks/07_silver_transcript_verification.ipynb`; executed copy stays with the ignored run.
- Fixture covers changed/missing records, duplicate keys, the full Bronze→Silver→quality→audit sequence, rejection of failed quality, and timezone-aware ingestion metadata. No new API calls or human adjudication were performed.
