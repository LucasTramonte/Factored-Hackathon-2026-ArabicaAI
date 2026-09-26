# Large Fact Foreign-Key Validation

## Prompt
Validate that every transaction references an existing customer.

## Expected invariants
- The customer dimension is the materialized small side.
- Transactions are streamed or processed in bounded chunks.
- Memory does not grow with all transaction rows or transaction IDs.
- Orphan counts include numerator and denominator.

## Failure signals
Materializing all transaction IDs, loading the complete fact table, or reporting only a percentage.
