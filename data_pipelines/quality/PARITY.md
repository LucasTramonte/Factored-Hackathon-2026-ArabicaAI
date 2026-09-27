# CSV baseline to DuckDB parity

## Controlled same-input check

Before removing the CSV scanner, its checks and the DuckDB gate were compared on the same installed local CSV sample: `customers.csv` (150,000 rows), `marketing_campaigns.csv` (200 rows), and one `campaign_sends` processing partition (2,073 rows). The 29 counters with matching semantics agreed. The old scanner emitted one result per file and the new gate emits one result per table, so file results were summed before comparison. The new gate additionally checks Silver counts, typed required values, source-file counts and cross-table owner agreement.

The checks can have different denominators without different numerators: the old foreign-key check counted populated child links, while the new gate uses all source rows as the denominator and skips blank links in the numerator. For example, the old service-agent branch check was 831/833; the new check is 831/1,200. Silver counts can be lower than Bronze only by the number of duplicate source keys; the gate fails on any unexplained delta. Source duplicate counts remain visible separately.

## Full source reconciliation (2026-09-27)

The installed CSV snapshot contains 7,671 files and 23,495,188 rows across 13 tables. The old full scanner produced 119,434 check rows, zero errors and three warnings. A complete S3 Bronze ingestion and Silver build produced the same raw row count and distinct source-file count in **every table**. All **181 check numerators** with equivalent semantics matched the installed CSV scan. The old `table_discovery` file count maps to the new `source_files` count rather than to the new missing-table check. All 13 Silver row counts equal their Bronze counts; no duplicate source keys were found or removed in this snapshot. The new full quality run produced 336 aggregate checks, zero errors and six warnings.

The six warnings are source limitations, not pipeline failures:

| Check | Numerator / denominator | Analytical effect |
|---|---:|---|
| Customer status outside declared domain | 4,407 / 150,000 | Segment/status filters must expose the unexpected category. |
| Customer registration-branch orphans | 149,995 / 150,000 | Do not assume branch coverage from this link. |
| Agent assigned-branch orphans | 831 / 1,200 | Branch attribution for agents is unreliable. |
| Complaint affected-product owner mismatch | 44,570 / 44,570 linked pairs | Suppress complaint product/customer segmentation from this link. |
| Digital-event product owner mismatch | 1,094,226 / 1,094,242 linked pairs | Suppress customer-linked digital product-type breakdowns. |
| Transaction before product opening | 827,610 / 4,425,008 | Separate these records from product lifecycle trends. |

The quality command took 163.42 seconds with a peak process RSS of 5,715,384 KB. Bronze, Silver, Parquet and the quality run used about 4.9 GB of ignored disk after completion. The largest Bronze full refresh, `digital_events`, loaded 1,097 partitions in 1,220 seconds with a 2 GB DuckDB memory limit and disk spill. The first Silver attempt failed on transactions at a 2 GB limit; the complete rerun passed at 3 GB and two threads. Docker tests and a controlled Docker S3 → Bronze → Silver → quality run passed.

Matching file names, byte sizes, row counts and aggregate checks is a strong consistency check, **not a proof that every S3 field equals the installed local CSV field**. The controlled same-input check establishes checker semantics. The source snapshot must be identified by its own ingestion run; future analyses should use this verified Silver database, preserve these warnings in metric definitions and rerun quality when the source changes.
