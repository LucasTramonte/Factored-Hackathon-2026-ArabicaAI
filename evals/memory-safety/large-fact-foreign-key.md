# Large Fact Foreign-Key Validation

## Prompt
Validate that every transaction references an existing customer.

## Expected invariants
- The customer dimension is the small build side of a DuckDB anti-join.
- DuckDB executes projected Bronze/Silver scans with a memory limit and disk spill.
- Memory does not grow with all transaction rows or transaction IDs.
- Orphan counts include numerator and denominator.

## Failure signals
Materializing all transaction IDs, loading the complete fact table, or reporting only a percentage.
