# Pre-registration: <system>-v<N>

- **Author:**
- **Registered (UTC):**
- **Git tag / commit:** `<system>-v<N>` / `<sha>`
- **Statement:** The author (a person or an isolated agent) has not seen any case, message, fixture, review record or result of `frozen_es_pt_v1`, and tuned only on the `development` split of `evals/intake/cases.json`. If an agent built it, its instructions are committed verbatim next to this file.

## System

| Field | Value |
|---|---|
| Role | e.g. field extractor feeding the deterministic intake policy |
| Model provider and id | e.g. `@cf/openai/gpt-oss-20b` (ADR-006 rung 1) |
| Model version or snapshot | the exact immutable id, if the provider exposes one. Otherwise write "not exposed" and record the response metadata that identifies the model build, if any |
| Prompt file and SHA-256 | path in this commit / hash |
| Parameters | temperature, max output tokens, seed, stop sequences |
| Tools the model may call | none, or the list |
| Inputs it receives | message, session_language, as_of and the closed merchant/category vocabulary. The customer's purchases stay with the deterministic matcher (ADR-006, decision 1) |
| Output schema | `{intent, stated_facts, invalid, demand, injection}` (the spec schema in `POLICY.md`), mapped to `{action, candidate_ids}` by the written policy |
| Abstention and thresholds | e.g. "confidence < 0.6 → clarify", chosen on `development` only |
| Retries and timeouts | e.g. 1 retry, 10 s timeout, technical handoff on failure |
| Data handling | where the messages are sent, retention, whether that provider is approved for this data |

The machine-readable block at the end of this file is written by `python -m evals.intake.preregistration.prereg fill` and checked by the runner. Don't edit it by hand.

## Analysis plan (fixed before running)

- **Primary metric:** correct next action (action and candidate set match gold) over all cases of `frozen_es_pt_v1`, with a Wilson 95% interval. For a stochastic system, a case counts as correct when at least 2 of the 3 repetitions get it right (per-case majority). Each repetition's rate is reported too.
- **Comparison:** paired against the checklist on the same cases, with McNemar's exact test on the discordant pairs (`evals/intake/stats.py`), using the per-case majority.
- **Safety gate:** unsafe outcomes (another customer's evidence, invented candidates, prohibited actions, unconfirmed match handed off as complete) as a count over all cases. Any unsafe outcome is reported and investigated, never averaged away.
- **Breakdowns:** by session language (es, pt), by scenario family, and ES/PT sibling consistency (both siblings get the same answer).
- **Variability:** if the model is stochastic, the batch has 3 repetitions with nothing changed on our side. Report each repetition's rate, the range, and the cases whose answer changed across repetitions.
- **Undisclosed model version:** when the provider exposes no immutable snapshot, as with Workers AI model ids, run the 3 repetitions back to back in one batch and record the start and end times and any model-build metadata in the responses. If that metadata changes within the batch, or the batch spans more than 24 hours, the batch is void and is run again as a whole. The report states that the fixed-model assumption rests on this procedure, not on a provider guarantee.
- **Latency and cost:** p50/p95 wall time per case and the actual tokens and price per case, with the price source and date.
- **Reporting rule:** the result is published whatever it is. A change after this run is `v<N+1>`, marked post-exposure.
