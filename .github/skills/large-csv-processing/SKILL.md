# Large CSV Processing

## Purpose
Process partitioned and multi-million-row CSV data without memory amplification.

## When to use
Use for fact tables, large aggregations, duplicate detection, foreign-key checks, profiling, joins, and partition scans.

## Workflow
1. Identify partitions and project only required columns.
2. Filter early by partition or business date.
3. Stream rows or use bounded chunks.
4. Incrementally aggregate; retain only bounded state or small-side dimension keys.
5. Declare analytical grain before joining and aggregate facts before customer-level joins.
6. Prefer one pass when checks share row state; use multiple passes when it makes correctness clearer and document the trade-off.
7. Measure or reason about memory before full execution.

## Constraints
Target `O(chunk_size)` or `O(unique_dimension_keys)` memory. Never build a set of all identifiers from a multi-million-row fact table. Avoid many-to-many row explosions.

## Validation
Test equivalent results across small and large simulated chunks, inspect peak-memory behavior when practical, and run a bounded smoke test before a full scan.

## Anti-patterns
Do not load every fact table into memory, reverse a small-side join, concatenate all partitions before aggregation, or log every row.
