# Pre-registration: extractor-v1

- **Author:** the isolated builder agent for extractor v1 (ADR-006, decision 5), in a history-free snapshot. Lucas and Roberto, who have seen frozen cases, wrote none of the prompt or parsing.
- **Registered (UTC):** 2026-10-04 (document filled in); the commit and registration time are recorded by `prereg fill` in the block at the end.
- **Git tag / commit:** `extractor-v1` / the commit recorded by `prereg fill` on the team branch. A person creates the tag at that commit; the builder doesn't.
- **Statement:** An isolated agent built this system following [`extractor-v1-builder-instructions.md`](extractor-v1-builder-instructions.md), committed verbatim next to this file (its run prompt is in [`intake_agent/extractor/BUILDER_PROMPT.md`](../../../intake_agent/extractor/BUILDER_PROMPT.md)). The author (an isolated agent) has not seen any case, message, fixture, review record or result of `frozen_es_pt_v1`, and tuned only on the `development` split of `evals/intake/cases.json`.

## System

| Field | Value |
|---|---|
| Role | Field extractor feeding the deterministic intake policy (ADR-006, decision 1). It reads one customer message and returns the extraction; the written policy (`evals/intake/frozen_es_pt_v1/label_rules.py`) decides the action. |
| Model provider and id | OpenAI `gpt-oss-20b` on Google Vertex AI's managed open-model API, `openai/gpt-oss-20b-maas`, location `global`, through its OpenAI-compatible Chat Completions endpoint (ADR-006 rung 1; host per amendment 7). |
| Model version or snapshot | Not exposed. `openai/gpt-oss-20b-maas` is a managed endpoint id, not an immutable snapshot. The development runs did not record any response build metadata, so none is registered here; the frozen batch follows the "Undisclosed model version" rule below. Google lists this endpoint as deprecated since 2026-07-21 and retiring on 2026-10-21 (amendment 8), so the frozen run must happen before then and can't be repeated on this host afterwards. |
| Prompt file and SHA-256 | `intake_agent/extractor/prompt.md` / `a270773600cf8c36ca343a619d8b5e1477ac5897211f428722b47b61f3f87e05` (working tree at fill-in; the block below is authoritative) |
| Implementation | Target `intake_agent.extractor.vertex:extract`. Implementation file `intake_agent/extractor/vertex.py` (transport), with the behavioural dependency `intake_agent/extractor/workers_ai.py` (`build_body`, `parse`, deadline, retry), both frozen by hash. |
| Parameters | `temperature=0`; `reasoning_effort=low` (the lowest documented gpt-oss level, sent explicitly; ADR-006 amendments 2, 8 and 9; sources in `DEV_LOG.md`); `max_tokens=2048` (reasoning tokens count against it); no seed (the API takes none we use); no stop sequences. |
| Tools the model may call | None. |
| Inputs it receives | The committed system prompt, then one user message holding only `message`, `session_language`, `as_of` and the closed merchant/category vocabulary. The customer's purchases stay with the deterministic matcher (ADR-006, decision 1). No transactions or customer identifiers are sent (asserted in `test_workers_ai.py` and `test_vertex.py`). |
| Output schema | `{intent, stated_facts, invalid, demand, injection}` (the spec schema in `POLICY.md`, enforced by `evals/intake/systems.py:validate_extraction`; extra fields fail), mapped to `{action, candidate_ids}` by the written policy. Parsing ignores surrounding prose or code fences and drops `stated_facts` entries whose value is null; nothing else is normalised or inferred. |
| Abstention and thresholds | None in the extractor; there is no confidence score. Abstention is the policy's: facts that fit no purchase or more than one lead to clarify or handoff as `POLICY.md` says. Invalid output after the retry, a timeout or a provider failure gives the deterministic fail-safe. |
| Retries and timeouts | One retry on invalid JSON or schema-invalid output, then `ValueError`. A 10 s overall deadline per call (both attempts) raises `TimeoutError`. HTTP 429/5xx, network failures, non-JSON bodies and provider error envelopes raise `ConnectionError` without a retry. The harness turns each of these into a technical handoff. HTTP 401/403 and other 4xx stop the run (`CredentialsError` / `ConfigurationError`) instead of being scored. At most 4 HTTP workers in flight. |
| Data handling | Messages go to Google Vertex AI (`aiplatform.googleapis.com`, location `global`) in project `factored-hackathon-arabica-ai`, under the Google Cloud trial credits. Only the evaluation's synthetic, team-authored messages are sent, never a customer record or identifier. The host owner (Lucas) approved Vertex AI on 2026-10-03, and Manoella approves amendment 7 as the unexposed reviewer. The builder did not review Google's retention terms for this endpoint. Credentials (`VERTEX_ACCESS_TOKEN`, a short-lived OAuth token, and `VERTEX_PROJECT`) are set by a person at run time and are never committed or logged, and neither is the message text. The extractor stays off in the online Worker. |

## Development evidence (development split only)

These are the measurements behind the registration. Development is for tuning, so none of this is an unseen result. Details and raw figures are in [`intake_agent/extractor/DEV_LOG.md`](../../../intake_agent/extractor/DEV_LOG.md), last section.

- **Run:** 2026-10-03 22:04:41–22:08:22 UTC, 18 cases × 10 repetitions (160 model-calling executions), `reasoning_effort=low`, the same prompt and parsing as registered.
- **Correct next action:** 18/18 by per-case majority. Per repetition: 18, 18, 17, 18, 18, 18, 18, 17, 17, 18 (177/180 pooled). The checklist got 16/18 and the always-handoff reference 4/18.
- **Unsafe:** 0 of 180.
- **Schema-valid:** 158/158 returned calls; 158/160 counting the two provider failures (98.8%).
- **Latency (160 model calls):** p50 1,392 ms, p95 1,890 ms, 95% interval for p95 1,822–2,342 ms, slowest 2,408 ms.
- **Instability (amendment 9, Manoella's ruling):** 1/18 (5.6%) cases where the model's reading changed, `missing_currency-es` in repetition 3. The two provider failures (`confirmed_single-pt` repetition 8, `no_match-pt` repetition 9) are errors, reported separately. Every reading in amendment 9 is reported: with failures counted it is 3/18 (fires), in the worst 3 consecutive repetitions 2/18 (fires), and in the first 3 repetitions 1/18 (passes).
- **Tokens and cost:** about 2,107 input and 130 output tokens per returned call. At Vertex's $0.07 / M input and $0.25 / M output for gpt-oss-20b (pricing page read 2026-10-03), that is about $0.00018 per call.
- **ADR-006 triggers:** all pass under amendment 9.

## Analysis plan (fixed before running)

- **Primary metric:** correct next action (action and candidate set match gold) over all cases of `frozen_es_pt_v1`, with a Wilson 95% interval. For a stochastic system, a case counts as correct when at least 2 of the 3 repetitions get it right (per-case majority). Each repetition's rate is reported too. As amendment 5 requires, every result is reported on all 60 cases and on the 52 that were not exposed, with the difference.
- **Comparison:** paired against the checklist on the same cases, with McNemar's exact test on the discordant pairs (`evals/intake/stats.py`), using the per-case majority.
- **Safety gate:** unsafe outcomes (another customer's evidence, invented candidates, prohibited actions, unconfirmed match handed off as complete) as a count over all cases. Any unsafe outcome is reported and investigated, never averaged away.
- **Breakdowns:** by session language (es, pt), by scenario family, and ES/PT sibling consistency (both siblings get the same answer).
- **Variability:** the model is stochastic, so the batch has 3 repetitions with nothing changed on our side. Report each repetition's rate, the range, and the cases whose answer changed across repetitions. Following amendment 9, instability counts only changes in the model's reading. Provider failures (timeouts, `ConnectionError`) are reported as errors, with their count, and are listed separately.
- **Undisclosed model version:** the provider exposes no immutable snapshot for `openai/gpt-oss-20b-maas`. Run the 3 repetitions back to back in one batch and record the start and end times and any model-build metadata in the responses. If that metadata changes within the batch, or the batch spans more than 24 hours, the batch is void and is run again as a whole. The report states that the fixed-model assumption rests on this procedure, not on a provider guarantee.
- **Latency and cost:** p50/p95 wall time per case and the actual tokens and price per case, with the price source and date. Calls without usage are counted in `usage_unavailable_calls` and never reported as free.
- **Reporting rule:** the result is published whatever it is. A change after this run is `v2`, marked post-exposure.
