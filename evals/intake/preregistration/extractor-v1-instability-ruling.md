# Extractor v1: ruling on the instability trigger (for ADR-006 amendment 9)

**To be filled in by Manoella**, the unexposed reviewer (ADR-006 decision 5). Lucas and Claude are exposed and have seen this result, so they may not choose. Edit this file in PR #98 (GitHub: the file → "Edit"), commit to the same branch, and approve the PR.

This ruling is made **after** the development result was seen. Every reading below is reported in EVALUATION.md and the submission, whichever one is chosen.

## The result being ruled on

Development split, 10 repetitions, `reasoning_effort: "low"` on `openai/gpt-oss-20b-maas` (2026-10-03, isolated builder; details in `intake_agent/extractor/DEV_LOG.md`, last section).

| Trigger | Value | |
|---|---|---|
| ≥ 16/18 correct (majority) | 18/18 | pass |
| Unsafe outcomes | 0 of 180 | pass |
| ≥ 95% schema-valid | 158 of 160 (2 failed calls) | pass |
| p95 interval upper bound ≤ 3,000 ms | about 2.34 s | pass |
| ≤ 10% of cases changing answer | see below | **your ruling** |

The trigger is written as "more than 10% of cases changing answer **across the 3 repetitions**" (ADR-006 decision 3). The 10-repetition protocol comes from amendment 1, which was written for latency only. Three cases changed answer:

- `missing_currency-es`, repetition 3: **the model** returned a reading that led to *clarify* instead of *confirm*;
- `confirmed_single-pt`, repetition 8, and `no_match-pt`, repetition 9: **service failures** (the Vertex call failed and the fail-safe turned it into a technical handoff), not a different reading by the model.

| Reading | Instability | Result |
|---|---|---|
| 1. All 10 repetitions; service failures count | 3/18 = 16.7% | fires |
| 2. All 10 repetitions; only model changes count (service failures are reported as errors) | 1/18 = 5.6% | passes |
| 3. The first 3 repetitions, as the trigger is written | 1/18 = 5.6% | passes |
| 4. The worst run of 3 consecutive repetitions | 2/18 = 11.1% | fires |

For context: at the provider default (`medium`), instability was 0/18, but latency failed (upper bound 3,079 ms).

## What follows

- **If the trigger passes under your ruling:** the pre-registration is filled on the team branch, a person tags `extractor-v1`, and the frozen set runs **once**, before the endpoint retires on 2026-10-21. Results are reported on 60 and 52 cases.
- **If it fires:** the outcome reported is "extractor v1 failed a pre-registered trigger on development". There is no frozen run for this version; the next rung (ADR-006 decision 3) comes after the deadline.
- **Re-running until it passes is not an option.**

## Your ruling

Mark exactly one with `[x]`:

- [ ] Reading 1: the trigger **fires**.
- [ ] Reading 2: the trigger **passes**. Instability counts only the model's changes; service failures are reported as errors.
- [ ] Reading 3: the trigger **passes**. Instability is measured on the first 3 repetitions, as written.
- [ ] Reading 4: the trigger **fires**.
- [ ] Other (explain below).

**Reason (one or two sentences):**

> 

**Also approved in this PR** (mark both if you approve them):

- [ ] ADR-006 amendment 8 (the sources for the reasoning level and the endpoint probe; no behaviour change).
- [ ] The builder's change: `reasoning_effort: "low"` in `workers_ai.build_body`, with its tests.

**Name and date:**

> Manoella, 2026-10-
