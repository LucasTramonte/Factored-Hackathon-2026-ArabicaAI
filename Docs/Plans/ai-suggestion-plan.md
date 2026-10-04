# AI suggestions on "I can't find the charge": implementation and measurement plan

**Status:** plan, 2026-10-04. Nothing here is built. The implementation comes in its own PR after this plan is reviewed. It follows [ADR-012](../ADRs/ADR-012-ai-online-only-where-evidence-shows.md) (Proposed) and needs the amendment in step 0 before the switch is turned on anywhere.

**For:** the team (Lucas, Roberto, Manoella) and whoever builds the PR. Manoella approves anything that changes what the model is asked or how its answer is read (ADR-006, decision 5).

## Why this path, and only this one

When a customer can't find the charge in their own list, today they write what they remember and the case reaches a person as an incomplete handoff. The person then matches the description to the customer's charges by hand.

That is the only step in the flow where something has to understand free text. Everywhere else the customer picks from a list. The frozen comparison says a model reads those descriptions far better than our rules: 53 of 60 held-out cases against 23, and 46 of 52 on the cases that never leaked, with 0 unsafe ([`EVALUATION.md`](../deliverables/EVALUATION.md#1-the-result)).

What we don't know is how often customers take this path. In the dataset nothing records it. On the live service it happened once in 5 team episodes. So the plan builds the path so it can be measured, and keeps it behind a switch until the measurement says it is worth running.

## The flow

1. The customer taps "I can't find it" and writes what they remember. The service creates the incomplete handoff, reads it back and returns the reference immediately, exactly as today. No model call happens inside this request.
2. If the switch is on, the Worker schedules one extraction after the response (`ctx.waitUntil`). The model receives only the details text, the session language and the closed merchant and category vocabulary: no customer id, no transactions, no history.
3. The answer is validated against the extraction schema. Deterministic code, the same policy the evaluation used, maps the facts to at most 3 of that customer's own charges. Ownership is enforced in SQL.
4. The suggestions are stored as references (transaction ids, producer version, call count, tokens), never the text.
5. On the receipt, the client polls for suggestions for up to 15 seconds; that limit is for the suggestions to arrive, not for the customer to answer. If there are any, it asks "Is it one of these?" with up to 3 charges, each with its merchant, date and amount. The customer picks one or answers "none of these".
6. Picking one records the customer's confirmation on the handoff. It doesn't close, resolve or refund anything. The agent sees "Customer confirmed this charge from a suggestion", marked as a suggestion and not as verified by the bank, and still reviews the case.

The model can't pick a charge, write to the store, change the action the policy takes, or reach another customer's data. Its worst case is a wrong suggestion that the customer then rejects.

## Which model, host and credential

### What the GCP project offers (checked 2026-10-04)

We listed the Model Garden on project `factored-hackathon-arabica-ai` and sent each candidate 5 calls with one neutral synthetic message. The message comes from no test set; the point was to check access, latency and JSON compliance, not accuracy. The calls went from a laptop in Brazil, so latency from the Worker will differ.

| Model (Vertex AI) | Endpoint | Median / slowest of 5 | Valid JSON | Notes |
|---|---|---|---|---|
| `openai/gpt-oss-20b-maas` (extractor v1) | global | 959 / 1,535 ms | 5/5 | The evaluated model. Already off the Model Garden listing; retires 2026-10-21 |
| `openai/gpt-oss-120b-maas`, low reasoning | global | 2,662 ms, then a timeout over 30 s | 1/1 answered | Failed on the second call in two separate tries |
| `google/gemma-4-26b-a4b-it-maas` | global only | 1,341 / 1,680 ms | 5/5 | Open weights; could later be self-hosted |
| `gemini-3.5-flash-lite`, `thinkingBudget: 0` requested | global; also `us` and `eu` multi-regions (one call each, HTTP 200, about 2.0 s) | 1,581 / 1,854 ms | 5/5 | Newest Flash-Lite; schema-enforced JSON output |
| `gemini-3.1-flash-lite`, `thinkingBudget: 0` requested | global (multi-regions not tried) | 1,873 / 2,171 ms | 5/5 | |
| `gemini-2.5-flash-lite`, `thinkingBudget: 0` | us-central1 | 1,347 / 1,733 ms | 5/5 | The only candidate we could pin to a region, but a reviewer cites Google's lifecycle page retiring it on 2026-10-20 (we couldn't load that page to confirm). Not available in `southamerica-east1` |

**Prices:**
- Vertex AI's pricing page didn't render for us, so these come from third-party summaries dated October 2026 ([CloudZero](https://www.cloudzero.com/blog/google-vertex-ai-pricing/), [Requesty](https://www.requesty.ai/models/vertex/gemini-3.5-flash-lite)):
  - Gemini 3.5 Flash-Lite: about US$0.30 per million input tokens and US$2.50 per million output.
  - gpt-oss-120b: about US$0.09 per million input and US$0.36 per million output.
- gpt-oss-20b was US$0.07 / US$0.25 per million when the builder read Google's own page on 2026-10-03.
- A person re-checks all of these on Google's page before production.

**Cost per suggestion.** One extraction is about 1,840 input and 84 output tokens (the frozen run). That costs about US$0.0008 on Gemini 3.5 Flash-Lite and US$0.00015 on gpt-oss-20b. If every one of the dataset bank's 11.16 daily unrecognized-charge reports took this path, the cost would stay under 1 cent a day on any candidate. Cost doesn't decide this; latency, reliability, model lifetime and data handling do.

### Recommendation

1. **The demo, until 2026-10-21: extractor v1 (`gpt-oss-20b-maas`).** It is the only model with a held-out result, and the switch may only serve the version that was evaluated. After that date the endpoint is gone and the path falls back to today's handoff on its own (see fallbacks).
2. **The production successor (v2): Gemini Flash-Lite, evaluated as a new version.** Four reasons:
   - **Schema-enforced output.** `responseSchema` makes the answer valid JSON by construction, which removes a failure the v1 fallback has to handle.
   - **Latency.** With `thinkingBudget: 0` requested it answered within about 1.9 s in every probe call. Gemini 3.x documents thinking levels (`MINIMAL` to `HIGH`) rather than an off switch, so the probe may have run at the model's minimum; the successor sets `thinkingLevel: MINIMAL` explicitly and re-measures.
   - **Lifetime.** It is Google's own line, so it is less likely to disappear in weeks the way the partner open-model endpoint did.
   - **A different family from the test writer.** Our frozen messages were written by an OpenAI model, so a Gemini reader also tests whether our result depended on a shared style (`EVALUATION.md`, section 8).

   Take `gemini-3.5-flash-lite` in the `us` multi-region (`aiplatform.us.rep.googleapis.com`, location `us`), which keeps customer text inside the United States. It also answers in `eu` and on the global endpoint; none of the 9 single regions we tried serves it (us-central1, us-east1, us-east4, us-east5, us-south1, us-west1, us-west4, northamerica-northeast1, southamerica-east1, europe-west4; 404 on each, 2026-10-04). `gemini-2.5-flash-lite` has single-region endpoints but is reported to retire on 2026-10-20, so it can't be the successor. **Nothing serves a Flash-Lite inside Latin America today.** A bank that requires that would self-deploy Gemma or gpt-oss weights on a regional Vertex endpoint (a dedicated GPU, roughly $800 a month always on; ADR-004 section 5 has the break-even).
3. **The comparator: Gemma 4 26B.** It is open weights, so it keeps a self-hosting exit if a bank wants the model inside its own network.
4. **Not gpt-oss-120b.** It timed out in both probes. We would need a reason to retry it.

The successor needs the same discipline as v1:
- an isolated builder in a history-free checkout;
- the ADR-006 development triggers re-measured on its host;
- a pre-registration and a person's tag;
- **a new held-out set**, because `frozen_es_pt_v1` is spent. Write it with a third model family and the same spec-first gold (EVALUATION, section 9, item 2). A score on `frozen_es_pt_v1` can still be published, labelled as post-exposure.

### Credential: the project blocks service-account keys

`constraints/iam.disableServiceAccountKeyCreation` is enforced on the project, inherited from the organization `lucastramonte3-org`. So ADR-012's plan of keeping a service-account JSON key as a Worker secret doesn't work as written.

| Option | What it takes | Verdict |
|---|---|---|
| **A. Workload Identity Federation with the Worker as its own OIDC issuer** | The Worker holds its own signing key as a secret and publishes nothing. We upload its public JWKS to a workload identity pool provider (`gcloud iam workload-identity-pools providers create-oidc --jwk-json-path=...`). The Worker signs a 5-minute JWT, exchanges it at Google's STS for a federated token, then impersonates the service account with the IAM Credentials API's `generateAccessToken` (the pool's principal holds `roles/iam.workloadIdentityUser` on it) and calls Vertex with that token. The service account holds only Vertex AI User | **Recommended.** The organization's policy stays on, Google issues no long-lived key, the provider can require exact claims, and rotating means uploading a new JWKS |
| B. Exempt this project from the policy and create a key | Org-policy admin on `lucastramonte3-org`, then `gcloud iam service-accounts keys create` | Simpler, but it is a long-lived Google key that bypasses a secure default. Only with a written expiry and rotation |
| C. A person's `gcloud auth print-access-token` | Nothing | Development only. It expires in an hour and acts as a person |

Option A adds two calls (STS, then `generateAccessToken`) per hour per Worker isolate. The Worker caches the token and refreshes it before expiry, so the exchange stays off the request path, which is async anyway.

## How we measure it

### Before the switch is turned on anywhere

- **Parity.** The JavaScript port of the request body, parsing, retry and deadline must match the Python that was evaluated. Golden fixtures come from the Python code run on the development split and on malformed responses. The JavaScript test checks byte-identical request bodies and identical parsed facts. The deterministic matcher gets the same treatment. Without parity, the frozen result says nothing about the online code.
- **Contract and safety tests**, as AGENTS.md requires for every API change:
  - method, path and session matrix;
  - session swap, forgery and expiry;
  - an isolation oracle: another customer's handoff or charge is refused, and a suggestion that isn't the customer's can't be confirmed;
  - hostile input;
  - a concurrent, idempotent confirm;
  - contract validation;
  - D1 budget ceilings.
- **Fallback tests**, one per failure in the table below, each checking that the handoff is identical to today's.
- **Latency from the Worker.** Measure the extraction call's p50 and p95 on the deployed Worker, with synthetic messages, at least 72 calls so the p95 has an interval. Also check that the report request's own p95 doesn't move, since the model is outside it.

### While it runs (the pilot)

Each episode records references and counts, never text. Every rate comes with its numerator and denominator.

| Question | Measure | Denominator |
|---|---|---|
| Is the path used? | Share of started reports that end in "I can't find it" (ADR-012, condition 3: at least 15% over at least 30 episodes) | Started reports |
| Does the model answer? | Extraction outcome: suggestions, no match, or each failure kind | "I can't find it" reports with the switch on |
| Are suggestions useful? | Customer confirmed one / chose "none of these" / didn't answer | Reports where suggestions were shown |
| Are suggestions right? | The agent marks the confirmed charge as correct or not when reviewing. This is the label we lack today | Confirmed suggestions reviewed by an agent |
| Is anything unsafe? | A suggested charge not owned by the customer (should be impossible; any occurrence stops the pilot), or a confirmed suggestion the agent marks wrong | Confirmed suggestions |
| Does it save the agent work? | Time from the agent's first open to "in review", and how often the agent contacts the customer again, compared **by assigned arm** (intention to treat): every arm-B report counts in arm B even when it got no suggestion after a timeout, invalid output or no match | Incomplete handoffs, by assigned arm |
| What does it cost? | Calls, tokens and cost per report. Calls without usage are counted as unknown, never as free | Extraction calls |
| Is it fast enough? | Extraction p95 from the Worker; report-request p95 with the switch on and off | Calls / requests |

**Comparison design.** The Worker assigns each "I can't find it" report to an arm at random (50/50, recorded on the handoff), so the two arms differ only by the suggestion. At the dataset bank's volume of about 11 reports a day, a week gives about 77. If 15–20% take this path, that is about 12–15 a week, enough to describe the path but not to show a difference in agent time. That needs months, or a bank's real volume. We say so instead of over-reading early numbers.

**Decision rules, fixed now:**
- **Keep the switch on** only while:
  - unsafe stays at 0;
  - fewer than 5% of extractions fail over the last 50;
  - the report request's p95 stays below 2,000 ms.
- **Turn it off and investigate** on any unsafe event, or if agents mark more than 1 in 10 confirmed suggestions wrong over at least 20 reviewed.
- **Promote from pilot to default** only after ADR-012's condition 3 holds and the agent-time comparison has a pre-registered analysis.

## Fallbacks

Every failure leaves the customer exactly where they are today: an incomplete handoff with their description, reviewed by a person. Each failure is recorded as a kind and a count, never with the text. The customer can answer a shown suggestion at any time until an agent opens the case.

| Failure | What happens | Recorded as |
|---|---|---|
| Switch off, or the credential is missing | No call at all (tested: no `fetch`) | `off` |
| Token exchange fails (STS or federation error) | No call; retry the exchange on the next report, not in a loop | `auth_error` |
| Timeout (10 s hard deadline) | Abandon the call; nothing shown | `timeout` |
| Provider error (HTTP 429, 5xx, network) | No retry, same as v1 | `provider_error` |
| 401 or 403 from Vertex | No retry; flagged for a person, since it means configuration, not load | `config_error` |
| Invalid JSON or schema after one retry | Nothing shown | `invalid_output` |
| Valid facts that match no charge, or more than 3 | Nothing shown; the policy would ask to clarify, and the person matches by hand | `no_match` / `ambiguous` |
| Prompt injection in the description | The model only returns facts from a closed vocabulary, the policy decides, and suggestions come only from the customer's own charges. Recorded if the extraction flags it | `injection_flagged` |
| No suggestions arrive within the 15-second polling window | The receipt shows nothing more; the handoff stays as it is | `not_shown` |
| Suggestions were shown but the customer never answers before an agent opens the case | The handoff stays as it is; the "received" email is unchanged | `not_answered` |
| "None of these" | Recorded; a signal for the agent and for evaluation | `rejected` |
| Daily call cap reached (budget breaker kept in D1) | No call | `capped` |
| The model id is past its retirement date | The Worker refuses to call a model whose configured retirement date has passed, and a predeploy check fails CI before that day | `retired` |

## Steps

0. **Amend ADR-012.** Conditions 1–2 hold. Condition 3 can only be met by running the path. The amendment allows the switch on in the demo environment, with synthetic customers only, as the pilot that collects the 30 episodes. It keeps the production gate unchanged and adds the decision rules above. Lucas, Roberto and Manoella decide.
1. **Credential (person).** Create the service account with Vertex AI User only, the workload identity pool and OIDC provider with the Worker's uploaded JWKS, and the binding. Then put the Worker's signing key as a secret (`wrangler secret put VERTEX_WIF_SIGNING_KEY`) and set the project and provider names as vars. All of this is a person's job; agents don't change permissions.
2. **Port and parity (code PR).** Port the Vertex transport, body, parse, retry and deadline to JavaScript, plus the deterministic matcher, with golden fixtures from the development split only. Replace the dead Workers AI binding path in `ai-transport.js`. `registeredVersion()` keeps pinning the prompt hash. Manoella approves the port.
3. **Storage and routes.** An additive migration for suggestions and the customer's choice. A GET route for a handoff's suggestions and a POST to confirm one, owner-scoped, with all the tests above and an ADR-004 note for any new budget ceiling.
4. **Client.** The "Is it one of these?" step in es, pt and en. The agent view's "confirmed from a suggestion" marker, and a correct/wrong control for the agent, which is the label the pilot needs.
5. **Events and export.** Outcome kinds, producer version, calls and tokens in `intake-events.md` and the exporter; the arm assignment; the pilot summary in the same scorer as today's episodes.
6. **Measure from the Worker** (synthetic, ≥72 calls), then turn the switch on in the demo environment under the amended ADR.
7. **Successor before 2026-10-21.** Isolated build of v2 on Gemini Flash-Lite, development triggers on its host, a new held-out set, pre-registration, tag, one run, publication. Until v2 is registered, the retirement guard turns the path off on that date.

## What this plan does not claim

- It doesn't claim the path will be used often. That is what the pilot measures.
- It doesn't claim agents will save time. The design can show it only with more volume than a demo has.
- The frozen result doesn't transfer to v2. Every new model or host is a new version with its own evidence.
- Customer data doesn't go to Google in the demo; only synthetic customers use it. Before real data:
  - request Vertex AI's abuse-monitoring logging exception, for zero retention;
  - pin a region if the bank requires one;
  - keep sending only the description text.
