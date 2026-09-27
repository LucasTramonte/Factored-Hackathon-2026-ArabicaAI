# Testing Data Pipelines

## Purpose
Choose fast, risk-appropriate validation before expensive data scans.

## When to use
Use for parsers, contracts, quality rules, transformations, aggregations, joins, and scanner changes.

## Workflow
Use this progression:

```text
unit tests -> small fixtures -> integration tests -> smoke test -> controlled dataset -> full dataset
```

For core checks, parsing, keys, partitions, joins, bug fixes, and memory-sensitive code, use test-first development where practical: RED, GREEN, REFACTOR. Add a regression fixture when a real defect is found.

## Constraints
Tests must assert outcomes and invariants. Streaming code should produce the same result across chunk sizes when mathematically appropriate. Full-dataset execution is not a substitute for tests.

## Validation
Include malformed rows, missing columns, duplicate keys, orphans, empty inputs, boundary dates, and chunk-boundary cases when the failure is plausible and costly.

## Anti-patterns
Do not debug only by rerunning the full dataset, require ceremony for trivial documentation changes, or assert an incidental implementation order.
