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
   - It fits the free allocation. ADR-004's envelope, at 12k input and 2k output tokens, gives $0.0030 an episode and 36 free episodes a day, and extraction prompts are much shorter than that. The real tokens and cost are measured in the pre-registered run. (This was the Workers AI rationale; amendment 6 moves the evaluation to Bedrock, billed per token.)
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

These were written before any frozen scoring. Amendments 1, 2, 6, 7 and 9 change how a result is measured and what follows from it, not the result itself. Amendment 8 only supplies documentation sources for a choice amendment 2 already makes. Amendments 3 and 4 change labels and policy, so they need Manoella's approval as the unexposed reviewer (decision 5), given in the PR that carries them.

1. **Latency is measured on enough calls to decide.** Forty-eight calls can't estimate a p95: a two-sided distribution-free 95% interval needs 72 values (a one-sided 95% upper bound needs 59), and at a true p95 of exactly 3 s the old trigger fires 43% of the time. The rule, fixed before the measurement it applies to:
   - **Sample:** at least 150 model-calling executions on the development split (10 repetitions of the 16 model-calling cases), each counted at its wall time, timeouts included at their full duration.
   - **Statistic:** the p95 of all executions, with the equal-tailed 95% order-statistic interval from `evals/intake/stats.py:quantile_interval`. The runner reports it as `latency_p95_interval_ms` on the pooled `repetition: "all"` summary row. Per-case medians are not used, because they hide the tail.
   - **Pass:** the interval's upper bound is at most 3,000 ms. That upper bound is a 97.5% one-sided bound, which is stricter than a one-sided 95% test, and it is kept on purpose as first written. Otherwise the latency trigger fires.
   - The iteration-4 figure (3.25 s over 48 calls) stays reported as measured.
   - **Attempt 1 (2026-09-30) is invalid:** the free daily allocation ran out after 83 of 160 calls (`HTTP 429`), so the rule wasn't applied. The 83 returned calls, as a descriptive sample, had a p50 of 3.4 s and a p95 of 5.5 s (interval 4.8–6.6 s), and 82 of 83 were correct with 0 unsafe. The deciding attempt runs right after a UTC reset. Details are in `DEV_LOG.md`.
   - **Attempt 2 (2026-10-01) decides it: the trigger fires.** 180 executions, no refusals or timeouts: p50 2.33 s, p95 3.58 s, and a 95% interval of 3.42–4.20 s. The upper bound is above 3,000 ms, so under amendment 2 the next version keeps the model and lowers its `reasoning` level, built by the isolated builder. Quality on development: 180 of 180 correct, 0 unsafe. Details are in `DEV_LOG.md`.
   - **Historical Workers AI budget (superseded by amendment 6):** the free allocation served fewer than about 280 calls in one UTC day, and the frozen run needs about 180. The original plan was to start after a reset or use Workers Paid; amendment 6 then moved to Bedrock's token billing, and amendment 7 to Vertex AI's per-token billing against trial credits.
2. **A latency-only failure doesn't climb the model ladder.** A larger model is slower, so it can't fix latency. If only the latency trigger fires, the next version keeps the model and lowers the documented `reasoning` level, which Workers AI now lists for gpt-oss-20b (low/medium/high). The isolated builder makes that change and re-runs it on development, because it changes behaviour (decision 5). The ladder in decision 3 still applies to quality failures.
3. **Development labels follow the written policy.** The two `missing_currency` cases were relabelled to confirm `EVAL-A1`, because `POLICY.md` needs no currency when the other facts fit one purchase. On development the checklist moves from 18/18 to 16/18, and the always-handoff reference stays at 4/18. The details are in `intake_agent/extractor/DEV_LOG.md`.
4. **Countries are compared as ISO codes.** The source stores foreign purchase countries in English (DF-019), so the policy now maps Spanish, Portuguese and English names to ISO 3166-1 codes on both sides. An unknown country on either side never fits. Recomputing every committed frozen answer with it, after checking `draft.json` against its committed hash, changes none of them. That check runs only where `draft.json` exists (CI skips it), and it barely exercises the new map: one frozen situation states a country, already in the stored spelling, and none states abroad. The new unit tests cover the mapping itself. Development cases have no purchase country, so an unexposed author adds some before pre-registration.
5. **Exposed frozen cases are reported separately.** Content of 8 of the 60 frozen cases (2 with message fragments) was in git and reachable from the extractor v1 build's worktree through history. Every frozen result is therefore reported on all 60 cases and on the 52 without them, and the difference is shown. Future blind builds use the history-free snapshot from `make_clean_checkout.py`. Details are in [`EVALUATION.md`](../deliverables/EVALUATION.md), section 4.
6. **Evaluation runs on Amazon Bedrock (2026-10-03).** The development re-check and the frozen run call the same weights, OpenAI `gpt-oss-20b` (`openai.gpt-oss-20b-1:0`, `us-east-2`), through Bedrock's OpenAI-compatible Chat Completions endpoint (`intake_agent/extractor/bedrock.py`). They use the same prompt, body, parsing, deadline and retry as `workers_ai.py`; only the transport differs, so this is a host change, not a step on the model ladder.
   - **Why:** Workers AI Free served fewer than about 280 calls in a UTC day. The development re-check and the frozen run need about 180 each, the team can't move to Workers Paid, and one retry would push the frozen run by a day. Bedrock bills per token without the Workers AI free-allocation reset, but has [account and model quotas](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas.html), which a person checks before running.
   - **What stays the same:** the online Worker is unchanged, and the extractor stays off online. If a later evaluation justifies turning it on, the online host is a separate decision. The latency trigger is measured on the host that runs the evaluation.
   - **Data:** only the evaluation's team-authored, synthetic messages are sent; no customer record or identifier.
   - **Credentials:** a Bedrock API key in `AWS_BEARER_TOKEN_BEDROCK`, set by a person on their machine; never committed or logged.
   - **Who changes what:** the transport is non-behavioural, so an exposed author (decision 5) may write it. The reasoning level of amendment 2 is behavioural, and the isolated builder still sets it, in `workers_ai.build_body`, which the Bedrock transport reuses.
   - **Approval:** the host owner (Lucas) approved Bedrock on 2026-10-03. Manoella, as the unexposed reviewer, approves this amendment in the PR that carries it.
7. **Evaluation runs on Google Vertex AI instead (2026-10-03), because Bedrock is blocked on the account's plan.** The same weights, OpenAI `gpt-oss-20b`, are called as Vertex AI's managed open-model API (`openai/gpt-oss-20b-maas`, location `global`) through its OpenAI-compatible Chat Completions endpoint (`intake_agent/extractor/vertex.py`). The prompt, body, parsing, deadline and retry are the same as `workers_ai.py`; only the transport differs, as in amendment 6. Amendment 6's transport stays in the repository but is not used.
   - **Why Bedrock is out:** AWS account 849110176017 is on the AWS Free plan, which the team keeps (no upgrade). On 2026-10-03, every Bedrock invocation in us-east-2 returned `ValidationException: Operation not allowed`: `openai.gpt-oss-20b-1:0` and `us.amazon.nova-micro-v1:0`, through Converse, the OpenAI-compatible endpoint and the console Playground. `ListFoundationModels` worked with the same key. Both models are serverless (not Marketplace), so the restriction is the account's, not the model's.
   - **Why Vertex:** the Google Cloud trial credits cover the managed open-model API: a probe call on 2026-10-03 returned `traffic_type: ON_DEMAND`, with no charge beyond the credits while the account is not upgraded. Its quota (1,200 queries per minute) lets a whole run finish in one sitting.
   - **First evidence (development smoke, 18 cases, one repetition, reasoning at the provider default):** 18/18 correct, 0 unsafe, 0 errors, p50 1.62 s, p95 2.30 s, about 1,870 input and 240 output tokens per call. Eighteen calls cannot decide the latency trigger (amendment 1 needs at least 150).
   - **Latency decision on Vertex (2026-10-03, amendment 1's protocol, reasoning at the provider default): the trigger fires.** 180 executions (160 model-calling), no errors, timeouts or unavailable usage: p50 1.57 s, p95 2.64 s, and a pooled 95% interval of 2.55–3.08 s. The upper bound is above 3,000 ms (on the 160 model-calling executions alone it is 3.56 s), so under amendment 2 the isolated builder lowers the `reasoning` level and re-runs development. Quality on development: 180 of 180 correct, 0 unsafe, 100% schema-valid. Tokens: 337,170 input and 40,302 output.
   - **Unchanged:** the online Worker and the extractor being off online; the latency trigger is measured on the host that runs the evaluation; only synthetic, team-authored evaluation messages are sent.
   - **Credentials:** a short-lived OAuth token (`gcloud auth print-access-token`, about one hour) in `VERTEX_ACCESS_TOKEN`, with `VERTEX_PROJECT`; set by a person on their machine, never committed or logged.
   - **Who changes what:** as in amendment 6. The transport is non-behavioural (an exposed author may write it); any reasoning-level change stays with the isolated builder, in `workers_ai.build_body`.
   - **Approval:** the host owner (Lucas) approved Vertex AI on 2026-10-03. Manoella, as the unexposed reviewer, approves this amendment in the PR that carries it.
8. **Where the reasoning level is documented for the Vertex host (2026-10-03).** The isolated builder stopped at the Vertex revision's step 1, as it should: Google names the request field but documents no default for `gpt-oss-20b-maas`, and that model's capability table says "Thinking: Not supported" (its `DEV_LOG.md` entry of 2026-10-03 has the pages and quotes). This amendment supplies the sources; it changes no behaviour, and the level is still chosen and set by the isolated builder under amendment 2.
   - **The field:** `reasoning_effort` in the OpenAI-compatible Chat Completions body, per Google's "Thinking for open models" page ("These models also support the `reasoning_effort` parameter", GPT OSS section; https://docs.cloud.google.com/vertex-ai/generative-ai/docs/maas/capabilities/thinking, read 2026-10-03).
   - **The levels and the default** come from the model's author: OpenAI's gpt-oss model card lists low, medium and high (https://huggingface.co/openai/gpt-oss-20b), and its Harmony format guide says "by default, the model will do medium level reasoning" (https://developers.openai.com/cookbook/articles/openai-harmony, read 2026-10-03).
   - **The 20B endpoint honours it (probe, 2026-10-03, Lucas's session):** one content-free arithmetic question, never an evaluation case, twice per setting at temperature 0. No field: 110 completion tokens and 244 reasoning characters; `medium`: identical (110 and 244); `low`: 32 and 45; `high`: 145 and 342. All eight answered correctly. So the omitted field behaves as `medium`, `low` is accepted, and the "Thinking: Not supported" row does not describe this endpoint's behaviour.
   - **Deadline:** Google's page for the model says the `gpt-oss-20b-maas` endpoint is deprecated (2026-07-21) and retires on 2026-10-21. The frozen run must happen before then; after it, the result can't be re-run on this host.
   - **Approval:** Manoella, as the unexposed reviewer, approves this amendment in the PR that carries it, together with the builder's change.

9. **How the instability trigger reads a 10-repetition run (2026-10-03, ruled by Manoella after the result was seen).** At `reasoning_effort: "low"` on Vertex, development scored 18/18 correct, 0 unsafe, 158 of 160 schema-valid, and a p95 interval upper bound of about 2.34 s. Three cases changed answer across the 10 repetitions. One was the model reading a message differently (`missing_currency-es`, repetition 3). Two were provider failures (the call failed and the fail-safe made a technical handoff). The trigger was written as "across the 3 repetitions", before amendment 1 introduced 10.
   - **Ruling (verbatim, [`extractor-v1-instability-ruling.md`](../../evals/intake/preregistration/extractor-v1-instability-ruling.md)):** reading 2, the trigger passes. "Instability measures whether the model reads the same message differently. A failed call to the provider is not a reading (the model returned nothing), so the two service failures are reported as errors, separately. Under this principle the window doesn't matter: the model changed 1 of 18 cases over the first 3, any 3, or all 10 repetitions."
   - **Made after the result was seen.** Lucas and Claude are exposed and didn't choose. Every reading is reported with it:
     - all 10 repetitions with failures counted: 3/18, fires;
     - model changes only: 1/18, passes (the ruling);
     - the first 3 repetitions: 1/18, passes;
     - the worst 3 consecutive repetitions: 2/18, fires.
   - **From now on**, instability counts only changes in the model's reading, over all repetitions run. Provider failures are reported as errors, with their count, and never folded into instability or correctness rates.
   - **Scope of the reasoning field (Manoella's condition).** `reasoning_effort: "low"` is verified only on the Vertex endpoint (amendment 8's probe), so this amendment and the builder's change are described for Vertex only. Workers AI, no longer an evaluation host (amendment 7), documents the reasoning level in another request format, `reasoning: { effort }` in its Responses API ([model page](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b)). Whether it accepts this field was not checked, and nothing here claims it does.
   - **Consequence:** every ADR-006 development trigger passes for extractor v1 at `low` on Vertex. Next comes the pre-registration on the team branch (`prereg fill`), a human tag `extractor-v1`, and the frozen run once, before the endpoint retires on 2026-10-21.

## Consequences

- **+** The original Workers AI choice reused the service account and free allocation. Amendment 7 uses Google Vertex AI for offline evaluation (Bedrock, amendment 6, is blocked on the AWS Free plan), billed per token against trial credits; the online Worker stays deterministic and the frozen comparison remains pending.
- **+** The boundary between AI and deterministic logic is explicit and easy to test. A wrong extraction can make the service ask again or route wrongly, but it can't disclose another customer's data or take an action. Permissions are enforced outside model output, as the brief requires.
- **+** Moving to a bigger model is a measured decision with triggers written before the test. It isn't a guess, and it isn't tuned on the test.
- **−** A 20B model may miss regional slang or implicit dates that a larger model would catch. We accept that for v1, and the ladder shows how we'd respond.
- **−** gpt-oss comes from the same model family as the Codex session that drafted the frozen messages. Shared phrasing habits could flatter it. That's recorded as a limitation, and gold comes from the rules, not from a model.
- **−** Workers AI's free allocation constrained the historical development runs (ADR-004). Current Vertex AI evaluation cost (amendment 7) depends on measured tokens and the dated price source; unknown usage stays visible. Neither host's development costs establish production cost.
- **−** Extraction quality in Portuguese is measured on synthetic cases only (DF-001).

## Alternatives considered

- **Claude Haiku 4.5 on Bedrock first.** It's probably stronger. But it needs a second provider in the runtime, AWS credentials and a data-handling approval, and it costs about 7× more per episode than gpt-oss-20b on ADR-004's envelope. Rejected for v1. Reopen it as rung 3 if the triggers fire.
- **A larger Workers AI model first.** Rejected, because nothing yet shows the smaller one fails. It's rung 2.
- **Train or fine-tune a classifier on the dataset.** The source text is fixed templates, so a model would learn the label from the template (DF-001). Rejected. Reopen it if the organisers supply free text.
- **Let the model choose the action end to end.** That would put permission and policy decisions inside model output, which the brief forbids. Rejected.
- **Keep only the checklist.** It fails the brief's learned-component requirement, and it leaves 10 of 25 known misses unaddressed. Rejected.

## Implementation notes

- Evaluation: `python -m evals.intake.run --cases <frozen corpus>` for the checklist. The extractor gets a runner entry in its own PR. Its batch follows the pre-registration template: 3 unchanged repetitions if the model is stochastic, scored by per-case majority, with Wilson intervals and McNemar against the checklist (`evals/intake/stats.py`).
- Historical Workers AI prices are ADR-004's, checked on 2026-09-29 against the [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) page. The Bedrock pre-registration records its own price source and date, actual input/output tokens and unknown-usage calls; neurons describe Workers AI only.
- 2026-10-02: with the switch on, the shadow call also reads the details an incomplete (not-found) handoff carries, after the response, with the same deadline and fail-safe; only its usage is added to the episode. The agent detail shows `model_reading` (mode, version and call count only, never the model's output).
- 2026-10-04: the frozen comparison ran once on the registered extractor v1 (tag `extractor-v1`, commit `3ad34b5`). Majority of 3: 53/60 correct against the checklist's 23/60 and always-handoff's 14/60; 46/52 against 20/52 on the cases never exposed; 0 unsafe in 180 runs; 1 case changed answer between repetitions; no provider failures; pooled p95 2,048 ms (interval 1,934–2,308 ms), passing the 3,000 ms gate. Every figure, the limits and the aggregates are in [`EVALUATION.md`](../deliverables/EVALUATION.md#1-the-result). This version is not run again; any change is v2.
