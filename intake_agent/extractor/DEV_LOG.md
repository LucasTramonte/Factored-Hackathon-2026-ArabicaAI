# Extractor v1 development log

Built by an isolated agent following `evals/intake/preregistration/extractor-v1-builder-instructions.md` (verbatim run prompt in `BUILDER_PROMPT.md`). Tuning used only the 18 `development` cases of `evals/intake/cases.json`. 16 of them call the model; the 2 unauthenticated cases are answered without it.

Command for every iteration (results files are ignored under `data_foundation/runs/extractor-dev/`):

```sh
python -m evals.intake.run --split development --repetitions 3 \
  --system extractor-v1=intake_agent.extractor.workers_ai:extract \
  --output data_foundation/runs/extractor-dev/iterN.json
```

## API documentation

- Model page: https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/ (read 2026-09-29). It documents the REST endpoint `POST /accounts/{ACCOUNT_ID}/ai/run/@cf/openai/gpt-oss-20b`, `messages`, `max_tokens` (default 256), `temperature` (0 to 5, default 0.6), `response_format`, and $0.20 / M input and $0.30 / M output tokens. The fetched page did not give the output schema or how to set the reasoning level.
- JSON mode: https://developers.cloudflare.com/workers-ai/features/json-mode/ (read 2026-09-29). gpt-oss-20b is **not** on its list of supported models, so `response_format` isn't used. JSON comes from the prompt plus parsing and validation.
- The output shape was confirmed with one probe call on 2026-09-29 using a content-free message ("ping"). The response is `result.choices[0].message.content` (plus `reasoning_content`), and `result.usage.prompt_tokens`, `completion_tokens` and `neurons`. `result.model` is `@cf/openai/gpt-oss-20b` and `system_fingerprint` is null, so no immutable build id is exposed.

## Fixed request parameters

`temperature=0`, `max_tokens=2048`, because the reasoning tokens count against it. There's a 10 s overall deadline and one retry on invalid or schema-invalid output. No seed, no stop sequences, no tools.

## Harness observation before tuning (offline, no model calls)

The development cases have no `as_of`. `label_rules._date_bounds` calls `datetime.fromisoformat(as_of)` for **any** date fact, including an absolute ISO date. With `as_of=None` that raises `TypeError`, and the policy then returns clarify. I checked this directly with `policy_prediction`: `{amount 85.00, currency USD, date 2026-06-10}` gives clarify, and `{amount 85.00, currency USD}` gives confirm. A faithful extractor that kept the stated dates would therefore clarify every dated development case (about 12/18). So `parse()` drops the date fact **only when `as_of` is null**. With a session time, as in production and in the frozen set's schema, the rule does nothing. This is a parsing rule, and it's flagged for review.

**Superseded (iteration 4).** Reviewer commit `b27e0a0` changed `label_rules._date_bounds` so that only relative expressions need `as_of`. The workaround then had no reason to exist and hid stated dates, so I removed it from `parse()`. Every stated fact, dates included, is now kept whether or not `as_of` is set.

The `missing_currency` pair ("85" on 2026-06-10, no currency) has gold `clarify`. Under `POLICY.md` the stated facts fit exactly one purchase (85.00 USD), which gives confirm. So the gold follows the checklist's requirement for a currency, not the written policy. I didn't tune toward it, because that would mean inventing an `invalid` reason the customer never stated. Both cases are lost in every iteration, which caps the development score at 16/18.

## Iterations

Per-call latency is wall time per case in the harness. The token figures are sums over the 48 model calls per iteration (16 cases × 3). The checklist gets 18/18 with 0 unsafe in every run, and the always-handoff reference gets 4/18.

| # | Date (UTC) | Change | Rep 1 / 2 / 3 correct | Majority correct | Unsafe | Errors (all timeouts) | Cases changing answer | p50 / p95 per call | Tokens in / out (mean out) |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-09-30 02:40 | Initial prompt | 15 / 15 / 16 | 16/18 | 0 | 3 | 2/18 (11%) | 3.1 s / 10.0 s | 92,977 / 16,137 (359) |
| 2 | 2026-09-30 02:43 | `Reasoning: low` line at the top of the prompt | 15 / 15 / 16 | 16/18 | 0 | 3 | 3/18 (17%) | 3.0 s / 10.0 s | 93,205 / 14,722 (327) |
| 3 | 2026-09-30 02:46 | Also: "keep any private reasoning to one or two short sentences", output compact on one line | 16 / 15 / 15 | 15/18 | 0 | 2 | 1/18 (6%) | 2.6 s / 9.3 s | 96,887 / 12,511 (272) |
| 4 | 2026-09-30 02:56 | No prompt change. Runs on reviewer commit `b27e0a0` (overall deadline enforced, service failures become `ConnectionError`, absolute dates work without `as_of`). Date-drop workaround removed from `parse()` | 16 / 16 / 16 | 16/18 | 0 | 0 (0 timeouts, 0 service failures, 0 invalid) | 0/18 (0%) | 2.3 s / 3.3 s | 101,103 / 12,757 (266) |

- Iteration 4: the stated dates are now extracted (for example `{"expression": "2026-06-10", "from": "2026-06-10", "to": "2026-06-10"}`) and applied by the policy. The only losses are the two `missing_currency` cases. There were no timeouts or service failures in this run. The per-repetition p95 was 2.79, 3.25 and 4.10 s, and the slowest call took 4.1 s.
- Every call that returned produced JSON that passed `validate_extraction` (0 retries needed, 0 schema failures). Every error was a 10 s timeout, which became a technical handoff.
- The extracted facts were identical and correct in every returned call: amounts with `approx=false`, the stated currency, and `out_of_scope:balance` for the balance questions. The losses are the two `missing_currency` cases (see above) plus timeouts.
- Latency tracks output tokens at roughly 110 tokens/s. On top of that there is a service-side tail: about 2 to 3 of 48 calls hit the 10 s timeout, and a few took 4 to 9 s with fewer than 350 tokens. Shortening the reasoning lowered p50 from 3.1 s to 2.6 s but didn't change the tail.
- Model calls used: 1 probe + 4 × 48 = 193, or about 12 per model-calling case, within the budget of about 30.

## ADR-006 triggers

Iteration 4, the current code and prompt:

| Trigger | Result | Status |
|---|---|---|
| < 16/18 correct (majority) | 16/18, exactly at the floor. The only losses are the two `missing_currency` cases | ok (no margin) |
| Any unsafe outcome | 0 | ok |
| < 95% schema-valid outputs | 48/48 (100%) | ok |
| p95 latency > 3 s | 2.79, 3.25 and 4.10 s per repetition; 3.25 s over all 48 calls; 2.79 s on the majority row (the per-case median) | **FIRES**, except on the majority-row reading. ADR-006 doesn't say which p95 to use, so I apply the conservative one |
| > 10% of cases changing answer | 0/18 | ok |

Iteration 3, before the fix: majority 15/18 (**fires**), p95 9.3 to 10.3 s (**fires**), 0 unsafe, 46/48 schema-valid, 1/18 changing answer.

Iteration 4 was a single measurement run after the fix, with no prompt tuning. I didn't switch models, didn't fill in the pre-registration and didn't create a tag.

## Cost per call (observed)

About 2,106 input and 266 output tokens per call (iteration 4; 272 in iteration 3). At $0.20 / M input and $0.30 / M output, that is about $0.00050 per call. The probe used 3.05 neurons for 141 tokens. The harness doesn't record neurons per call.

## Non-behavioural fixes after review (2026-09-30)

Made by Lucas's Claude session, which has seen frozen cases, so the ADR-006 limits apply. Nothing here touches the prompt, parsing, thresholds or model. The changes cover the transport, error paths and accounting only (Roberto's review and CodeRabbit on #26):

- The body is read one socket read at a time with the time left as the socket timeout. An abandoned worker therefore stops at the deadline and doesn't drain a slow body. At most `MAX_IN_FLIGHT = 4` workers exist at once.
- `HTTPError` bodies are closed on every status branch.
- A `success: false` envelope is a provider failure (`ConnectionError`, no retry), not invalid model output.
- Missing or invalid provider usage, and any attempt that fails in transport (timeout, reset, cut body), adds 0 tokens and counts in `usage_unavailable_calls`. The runner reports that count, and a majority row with no usage stays unknown instead of 0.

None of these paths occurred in iteration 4: 48/48 calls returned usage and no failure envelope. The iteration-4 numbers above are unchanged.

## Development relabel (2026-09-30)

The two `missing_currency` development cases ("85" on 2026-06-10, no currency) were relabelled from clarify to **confirm `EVAL-A1`**. Applying `POLICY.md` to the stated facts through `policy_prediction` gives exactly one owned purchase that day (85.00 USD), and a currency is only required when the other facts fit more than one purchase. The old gold followed the checklist's own requirement for a currency, not the written policy. The frozen gold was built with the policy, so it already agrees.

| Development split | Before | After |
|---|---|---|
| Extractor v1, iteration 4 (majority) | 16/18 | 18/18 |
| Checklist | 18/18 | 16/18 |
| Always-handoff reference | 4/18 | 4/18 |
| Unsafe outcomes, any system | 0 | 0 |

The extractor's 18/18 is inferred from iteration 4's recorded facts, which were the facts above in every repetition; the raw outputs aren't in the repository. The latency run below agrees: 82 of the 83 calls that returned were correct. The original 16/18 stays in the iterations table above as it was recorded. The relabel needs Manoella's approval as the unexposed reviewer (ADR-006 decision 5), given in the PR that carries it.

## Latency protocol measurement, attempt 1 (2026-09-30, 19:30–19:35 UTC): invalid for the decision

Run under ADR-006 amendment 1: 10 repetitions of the 18 development cases, 160 model-calling executions, no prompt or parameter change, using `python -m evals.intake.run --system extractor-v1=intake_agent.extractor.workers_ai:extract --repetitions 10 --split development`. The raw results stay in the ignored `data_foundation/runs/latency-2026-09-30/`.

**It can't decide the latency trigger.** After 83 calls, all 77 remaining calls got `HTTP 429` within about 120 ms each. The account's free daily Workers AI allocation was exhausted: this run plus the 193 calls of the four morning iterations fell on the same UTC day. The rule counts wall time per execution, and it assumes the model answered. Counting refusals would pull the p95 down, so this run is recorded and not used. The refused calls were reported as `usage_unavailable_calls`, not as zero tokens, as designed.

The 83 calls that returned are a descriptive sample only:

| Measure | Value |
|---|---|
| p50 | 3,382 ms |
| p95 (95% order-statistic interval) | 5,548 ms (4,821–6,559) |
| Share over 3 s | 65% |
| Output tokens per call (mean) | 298 |
| Correct, unsafe | 82/83, 0 |

This is slower than iteration 4 (p50 2.3 s), possibly because the service slows near the quota. The attempt that counts is repeated right after the next UTC reset (00:00 UTC), in a quiet window. If it fails, amendment 2 applies: a lower `reasoning` level, built by the isolated builder.

**Capacity finding:** on the free allocation the account served fewer than about 280 extraction calls in one UTC day. The frozen run needs about 180 model calls (3 repetitions of the model-calling cases), so it must start right after a reset, or run on Workers Paid.

