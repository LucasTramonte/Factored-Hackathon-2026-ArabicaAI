# Pre-registration: <system>-v<N>

- **Author:**
- **Registered (UTC):**
- **Git tag / commit:** `<system>-v<N>` / `<sha>`
- **Statement:** I have not seen any case, message, fixture, review record or result of `frozen_es_pt_v1`. I tuned only on the `development` split of `evals/intake/cases.json`.

## System

| Field | Value |
|---|---|
| Role | e.g. field extractor feeding the deterministic intake policy |
| Model provider and id | e.g. `@cf/openai/gpt-oss-20b`, or `anthropic.claude-haiku-4-5` on Bedrock |
| Model version or snapshot | exact id, or "not exposed" |
| Prompt file and SHA-256 | path in this commit / hash |
| Parameters | temperature, max output tokens, seed, stop sequences |
| Tools the model may call | none, or the list |
| Inputs it receives | message, session_language, as_of, the customer's approved purchases (same as the checklist gets, plus as_of) |
| Output schema | e.g. `{intent, stated_facts, ...}` mapped to `{action, candidate_ids}` by `<file>` |
| Abstention and thresholds | e.g. "confidence < 0.6 → clarify", chosen on `development` only |
| Retries and timeouts | e.g. 1 retry, 10 s timeout, technical handoff on failure |
| Data handling | where the messages are sent, retention, whether that provider is approved for this data |

## Analysis plan (fixed before running)

- **Primary metric:** correct next action (action and candidate set match gold) over all cases of `frozen_es_pt_v1`, with a Wilson 95% interval.
- **Comparison:** paired against the checklist on the same cases, with McNemar's exact test on the discordant pairs (`evals/intake/stats.py`).
- **Safety gate:** unsafe outcomes (another customer's evidence, invented candidates, prohibited actions, unconfirmed match handed off as complete) as a count over all cases. Any unsafe outcome is reported and investigated, never averaged away.
- **Breakdowns:** by session language (es, pt), by scenario family, and ES/PT sibling consistency (both siblings get the same answer).
- **Variability:** if the model is stochastic, 3 runs, reporting each and the spread.
- **Latency and cost:** p50/p95 wall time per case and the actual tokens and price per case, with the price source and date.
- **Reporting rule:** the result is published whatever it is. A change after this run is `v<N+1>`, marked post-exposure.
