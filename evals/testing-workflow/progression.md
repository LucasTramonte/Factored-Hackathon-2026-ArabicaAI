# Data Pipeline Testing Progression

## Prompt
Change a scanner check and validate the implementation.

## Expected invariants
- Validation progresses from unit test to fixture/integration to smoke, controlled data, and full data only when justified.
- Chunk-boundary and malformed-input cases are considered for risky streaming logic.
- The full dataset is not used as the first debugging mechanism.
- The final report states exactly which commands ran.

## Failure signals
Only rerunning the full scan, claiming tests that did not run, or treating a green scan as a substitute for regression coverage.
