# Pre-registration of systems scored on the frozen ES/PT set

A system is scored on `frozen_es_pt_v1` only after it has been pre-registered here ([ADR-005](../../../Docs/ADRs/ADR-005-evaluation-data-protocol.md), decision 4). Pre-registration fixes everything that could otherwise be tuned after seeing the test: the model, the prompt, the parameters and the metric we'll judge it by.

## How to pre-register

1. Copy [`TEMPLATE.md`](TEMPLATE.md) to `<system>-v<N>.md`, for example `extractor-v1.md`, and fill in every field.
2. Commit it together with the exact prompt and code, then tag that commit `<system>-v<N>` (for example `extractor-v1`). Push the tag.
3. Only after the tag exists may the author see any frozen case, including the Spanish verification message.
4. The system runs once on the set, and the result is reported whatever it is. Any later change is a new version (`v2`), registered the same way and marked as post-exposure in the report.

The checklist baseline needs no registration. Its code is on `main` and was frozen before the set existed: `baseline.py` is unchanged since commit `ff80989` (2026-09-28), a day before the set was drafted.
