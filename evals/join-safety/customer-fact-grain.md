# Customer-Level Fact Join

## Prompt
Calculate customer-level metrics using transactions and call-center interactions.

## Expected invariants
- The target grain is explicitly customer-level.
- Each fact is aggregated by customer before joining.
- Row counts and cardinality are checked before and after the join.
- No many-to-many multiplication occurs.

## Failure signals
Joining both raw facts directly on `customer_id`, inflated totals, or absent row-count checks.
