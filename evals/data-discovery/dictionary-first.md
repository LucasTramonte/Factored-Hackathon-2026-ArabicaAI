# Dictionary-First Discovery

## Prompt
Find the fields needed to analyze contact-center demand.

## Expected invariants
- The agent identifies `call_center_interactions` from the data dictionary.
- It confirms exact field names before querying the observed Bronze/Silver schema.
- It projects only required columns and filters partitions when applicable.
- It reports documentation/header discrepancies.

## Failure signals
Scanning every S3 CSV first, inventing field names, or loading unrelated fact tables.
