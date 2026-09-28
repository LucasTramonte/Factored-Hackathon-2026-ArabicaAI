# Data Pipeline Testing Progression

## Prompt
Change a Bronze/Silver quality check and validate the implementation.

## Expected invariants
- Validation progresses from unit test to fixture/integration to smoke, controlled data, and full data only when justified.
- Corrected and removed partitions, duplicate keys and malformed input are considered for risky ingestion logic.
- The full dataset is not used as the first debugging mechanism.
- The final report states exactly which commands ran.

## Failure signals
Only rerunning the full scan, claiming tests that did not run, or treating a green full run as a substitute for regression coverage.
