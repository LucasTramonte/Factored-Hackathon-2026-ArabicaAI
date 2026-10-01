# ADR-006 — Learned component: a fact extractor on Workers AI, smallest model first

- **Status:** Proposed
- **Date:** 2026-09-29
- **Deciders:** Lucas Tramonte, Roberto Z, Manoella R
- **Related:** [ADR-002](ADR-002-v1-workflow-unrecognized-charge-intake.md) (deterministic MVP, when a model may be added), [ADR-003](ADR-003-intake-single-runtime-worker-d1.md) (runtime), [ADR-004](ADR-004-intake-capacity-and-cost.md) (cost envelope), [ADR-005](ADR-005-evaluation-data-protocol.md) (evaluation protocol)

## Context

The brief requires at least one learned component evaluated against a baseline on the same held-out workload (Sound Data and ML Practice). ADR-002 lets us add a model only when the evaluation shows a failure the checklist can't fix, and only with its own ADR. That trigger is met. The checklist gets 15 of 25 `v1_authored` cases right, and it misses currency words, non-ISO and relative dates, and paraphrases (`evals/intake/README.md`). Relative dates are outside what it can resolve, by design.

The workload is ready: `frozen_es_pt_v1` has 60 blind cases and 0 label errors in an 18-case audit. The service runs on a Cloudflare Worker (ADR-003), and the data is synthetic, with no free text a model could learn from (DF-001). Submissions close on 2026-10-05.

The question is which model, doing what, and how we avoid spending more than the evidence justifies.

## Decision

1. **The model extracts, and deterministic code decides.**
   - The model reads the customer's message, the session language, the session time `as_of` and the closed merchant and category vocabulary (DF-006).
   - It returns exactly five extraction fields: `intent`, `stated_facts`, `invalid`, `demand` and `injection`. It never returns `customer_id`, `authenticated`, `confirmed_id`, `tool_failure` or `as_of`. The caller supplies those from trusted session state and adds them after the extracted fields, so no model output can override them. Any extra field fails validation (`evals/intake/systems.py`).
   - It never sees the customer's transactions or anyone else's data. It never picks an action, and never writes to D1.
   - The written policy applies the extracted facts to the customer's purchases: identity, ownership, confirmation and candidate matching. These are the same rules that define the frozen gold.
   - So the comparison with the checklist measures how well each system *reads the message*. Both sides follow the same policy.
2. **Start with the smallest capable model in the runtime we already have:** Workers AI `@cf/openai/gpt-oss-20b`.
   - It runs inside the Cloudflare account that already serves the Worker, through the same binding. There is no new provider, no new credential in the Worker, and the data doesn't leave Cloudflare.
   - It fits the free allocation. ADR-004's envelope, at 12k input and 2k output tokens, gives $0.0030 an episode and 36 free episodes a day, and extraction prompts are much shorter than that. The real tokens and cost are measured in the pre-registered run.
3. **Move to a bigger model only on evidence, in a fixed order.** The rungs are:
   1. `gpt-oss-20b`;
   2. a larger Workers AI model (for example `llama-3.3-70b`, $0.0080 an episode in ADR-004);
   3. Claude Haiku 4.5 on Bedrock, which needs a second provider, an AWS credential and a data-handling approval.

   We climb one rung only when the current rung fails on the `development` split, by any of these:
   - fewer than 16 of 18 correct next actions (per-case majority over 3 repetitions);
   - any unsafe outcome;
   - fewer than 95% schema-valid outputs;
   - p95 latency over 3 s;
   - more than 10% of cases changing answer across the 3 repetitions.

   The floor is absolute on purpose. The checklist got 18 of 18 there (16 of 18 after the relabel in amendment 3) because its rules were written on those cases, so "at least as good as the checklist on development" would compare a learned system against rules fitted to that very split. At 16 of 18, the extractor can miss two cases before we escalate. These triggers never read the frozen set. Each rung is a new pre-registered version, and the frozen set scores it once. Every version run is reported.
4. **Fail safe:**
   - temperature 0, or the lowest the model allows;
   - a committed prompt with its SHA-256 in the pre-registration;
   - JSON schema validation, and one retry on invalid output;
   - after that, a deterministic fallback: clarify, or a technical handoff on timeout (10 s).
   - The model's output is never shown to the customer as a decision.
5. **Build and freeze.** Lucas and Roberto have seen frozen cases, so neither may write or tune the extractor.
   - It is built by an isolated agent in a clean checkout where the withheld files don't exist. It uses only `POLICY.md`, the `development` split and the checklist interface.
   - The instructions given to that agent are committed verbatim, so reviewers can check they contain no test content.
   - Anyone who has seen a frozen case reviews only **non-behavioural** aspects: security, secrets, data handling, interfaces, tests and error paths. That covers Roberto, as the extractor's code reviewer, and Lucas.
   - Any **behaviour-changing** revision needs the approval of a reviewer who has seen no frozen case (Manoella), and it is re-run by the builder on the `development` split only. That covers the prompt, the parsing, the thresholds or the model. An exposed reviewer's comments may flag a behaviour problem, but may not propose the fix.
   - The pre-registration and the `extractor-v1` tag follow `evals/intake/preregistration/`.
6. **Live service later.** The Worker calls the same prompt through its AI binding only after the frozen run, in a separate change behind a switch that falls back to the current deterministic flow.

## Pre-freeze amendments (2026-09-30)

These were written before any frozen scoring. Amendments 1 and 2 change how a result is measured and what follows from it, not the result itself. Amendments 3 and 4 change labels and policy, so they need Manoella's approval as the unexposed reviewer (decision 5), given in the PR that carries them.

1. **Latency is measured on enough calls to decide.** Forty-eight calls can't estimate a p95: a two-sided distribution-free 95% interval needs 72 values (a one-sided 95% upper bound needs 59), and at a true p95 of exactly 3 s the old trigger fires 43% of the time. The rule, fixed before the measurement it applies to:
   - **Sample:** at least 150 model-calling executions on the development split (10 repetitions of the 16 model-calling cases), each counted at its wall time, timeouts included at their full duration.
   - **Statistic:** the p95 of all executions, with the equal-tailed 95% order-statistic interval from `evals/intake/stats.py:quantile_interval`. The runner reports it as `latency_p95_interval_ms` on the pooled `repetition: "all"` summary row. Per-case medians are not used, because they hide the tail.
   - **Pass:** the interval's upper bound is at most 3,000 ms. That upper bound is a 97.5% one-sided bound, which is stricter than a one-sided 95% test, and it is kept on purpose as first written. Otherwise the latency trigger fires.
   - The iteration-4 figure (3.25 s over 48 calls) stays reported as measured.
   - **Attempt 1 (2026-09-30) is invalid:** the free daily allocation ran out after 83 of 160 calls (`HTTP 429`), so the rule wasn't applied. The 83 returned calls, as a descriptive sample, had a p50 of 3.4 s and a p95 of 5.5 s (interval 4.8–6.6 s), and 82 of 83 were correct with 0 unsafe. The deciding attempt runs right after a UTC reset. Details are in `DEV_LOG.md`.
   - **Attempt 2 (2026-10-01) decides it: the trigger fires.** 180 executions, no refusals or timeouts: p50 2.33 s, p95 3.58 s, and a 95% interval of 3.42–4.20 s. The upper bound is above 3,000 ms, so under amendment 2 the next version keeps the model and lowers its `reasoning` level, built by the isolated builder. Quality on development: 180 of 180 correct, 0 unsafe. Details are in `DEV_LOG.md`.
   - **Budget for the frozen run:** the free allocation served fewer than about 280 calls in one UTC day, and the frozen run needs about 180. It starts right after a reset, or runs on Workers Paid.
2. **A latency-only failure doesn't climb the model ladder.** A larger model is slower, so it can't fix latency. If only the latency trigger fires, the next version keeps the model and lowers the documented `reasoning` level, which Workers AI now lists for gpt-oss-20b (low/medium/high). The isolated builder makes that change and re-runs it on development, because it changes behaviour (decision 5). The ladder in decision 3 still applies to quality failures.
3. **Development labels follow the written policy.** The two `missing_currency` cases were relabelled to confirm `EVAL-A1`, because `POLICY.md` needs no currency when the other facts fit one purchase. On development the checklist moves from 18/18 to 16/18, and the always-handoff reference stays at 4/18. The details are in `intake_agent/extractor/DEV_LOG.md`.
4. **Countries are compared as ISO codes.** The source stores foreign purchase countries in English (DF-019), so the policy now maps Spanish, Portuguese and English names to ISO 3166-1 codes on both sides. An unknown country on either side never fits. Recomputing every committed frozen answer with it, after checking `draft.json` against its committed hash, changes none of them. That check runs only where `draft.json` exists (CI skips it), and it barely exercises the new map: one frozen situation states a country, already in the stored spelling, and none states abroad. The new unit tests cover the mapping itself. Development cases have no purchase country, so an unexposed author adds some before pre-registration.
5. **Exposed frozen cases are reported separately.** Content of 8 of the 60 frozen cases (2 with message fragments) was in git and reachable from the extractor v1 build's worktree through history. Every frozen result is therefore reported on all 60 cases and on the 52 without them, and the difference is shown. Future blind builds use the history-free snapshot from `make_clean_checkout.py`. Details are in [`EVALUATION.md`](../deliverables/EVALUATION.md), section 4.

## Consequences

- **+** It satisfies the brief's learned-component requirement with the least new infrastructure. It's the same runtime, the same account, at $0 within the free allocation.
- **+** The boundary between AI and deterministic logic is explicit and easy to test. A wrong extraction can make the service ask again or route wrongly, but it can't disclose another customer's data or take an action. Permissions are enforced outside model output, as the brief requires.
- **+** Moving to a bigger model is a measured decision with triggers written before the test. It isn't a guess, and it isn't tuned on the test.
- **−** A 20B model may miss regional slang or implicit dates that a larger model would catch. We accept that for v1, and the ladder shows how we'd respond.
- **−** gpt-oss comes from the same model family as the Codex session that drafted the frozen messages. Shared phrasing habits could flatter it. That's recorded as a limitation, and gold comes from the rules, not from a model.
- **−** The free allocation covers the evaluation and a demo, not production traffic (ADR-004). Beyond it, cost grows linearly per episode.
- **−** Extraction quality in Portuguese is measured on synthetic cases only (DF-001).

## Alternatives considered

- **Claude Haiku 4.5 on Bedrock first.** It's probably stronger. But it needs a second provider in the runtime, AWS credentials and a data-handling approval, and it costs about 7× more per episode than gpt-oss-20b on ADR-004's envelope. Rejected for v1. Reopen it as rung 3 if the triggers fire.
- **A larger Workers AI model first.** Rejected, because nothing yet shows the smaller one fails. It's rung 2.
- **Train or fine-tune a classifier on the dataset.** The source text is fixed templates, so a model would learn the label from the template (DF-001). Rejected. Reopen it if the organisers supply free text.
- **Let the model choose the action end to end.** That would put permission and policy decisions inside model output, which the brief forbids. Rejected.
- **Keep only the checklist.** It fails the brief's learned-component requirement, and it leaves 10 of 25 known misses unaddressed. Rejected.

## Implementation notes

- Evaluation: `python -m evals.intake.run --cases <frozen corpus>` for the checklist. The extractor gets a runner entry in its own PR. Its batch follows the pre-registration template: 3 unchanged repetitions if the model is stochastic, scored by per-case majority, with Wilson intervals and McNemar against the checklist (`evals/intake/stats.py`).
- Prices are ADR-004's, checked on 2026-09-29 against the [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) page. The pre-registered run records the actual tokens and neurons.
