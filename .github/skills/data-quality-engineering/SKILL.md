# Data Quality Engineering

## Purpose
Implement repeatable, auditable quality checks from declarative contracts.

## When to use
Use for schema, completeness, domain, key, relationship, partition, temporal, or freshness checks.

## Workflow
1. Identify the table and consult the data dictionary.
2. Extend the contract before adding table-specific logic.
3. Define numerator, denominator, severity, and sample policy.
4. Write a small fixture or regression test first for risky behavior.
5. Implement a reusable check over an iterator.
6. Run focused tests, then a smoke scan, then controlled/full data only when justified.
7. Report findings without mutating or silently deduplicating raw data.

## Constraints
Prefer streaming, bounded memory, exact source column names, and explicit join grain. Parent dimension keys may be materialized; large fact keys may not.

## Validation
Check test behavior, denominators, severity, representative samples, report reproducibility, and raw-data immutability.

## Anti-patterns
Do not encode schemas throughout scanner code, hide failures in one score, silently repair input, or use a full scan as the first debugging step.
