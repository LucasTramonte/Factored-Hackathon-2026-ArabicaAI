# Pre-registration of systems scored on the frozen ES/PT set

A system is scored on `frozen_es_pt_v1` only after it has been pre-registered here ([ADR-005](../../../Docs/ADRs/ADR-005-evaluation-data-protocol.md), decision 4). Pre-registration fixes everything that could otherwise be tuned after seeing the test: the model, the prompt, the parameters and the metric we'll judge it by.

## How to pre-register

1. Copy [`TEMPLATE.md`](TEMPLATE.md) to `<system>-v<N>.md`, for example `extractor-v1.md`, and fill in every field.
2. Commit it together with the exact prompt and code, then tag that commit `<system>-v<N>` (for example `extractor-v1`). Push the tag.
3. Only after the tag exists may the author see any frozen case, including the Spanish verification message.
4. The system is scored in **one pre-registered batch**, and the result is reported whatever it is. A deterministic system runs once. A stochastic one runs 3 fixed repetitions, and nothing may change between them: not the code, the prompt, the parameters or the model. Any later change is a new version (`v2`), registered the same way and marked as post-exposure in the report.

The checklist baseline needs no registration. Its decision code (`decide()` in `baseline.py`) is unchanged since commit `ff80989` (2026-09-28), a day before the set was drafted. The scorer (`score()`) later gained a `systems` parameter so it can score registered systems. `evals/intake/test_systems.py` pins every per-case checklist and handoff score on `cases.json` to its value before that change.

## Tools

- `prereg.py fill` writes the machine-readable block (prompt SHA-256, commit, model, parameters) at the end of the registration file. `prereg.py check` verifies it.
- `python -m evals.intake.run --system NAME=module:callable --preregistration NAME=<file> --repetitions 3` refuses to score a system on `frozen_es_pt_v1` unless the check passes: the prompt is unchanged, and the tag points to the registered commit.
- `make_clean_checkout.py` creates a worktree and proves that no withheld frozen file is present or tracked. [`extractor-v1-builder-instructions.md`](extractor-v1-builder-instructions.md) holds the verbatim instructions for the blind builder.
