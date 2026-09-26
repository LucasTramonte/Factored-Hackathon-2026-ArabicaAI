# New Quality Rule

## Prompt
Add a quality rule that detects invalid partition dates.

## Expected invariants
- A minimal fixture expresses a valid and invalid case.
- The focused test fails for the intended reason before the implementation when practical.
- The rule reports numerator, denominator, severity, and a useful sample.
- Existing behavior remains covered.

## Failure signals
Starting with a full dataset scan, silently correcting invalid data, or adding a rule without a regression test.
