# AI suggestions on "I can't find the charge": implementation and measurement plan

**Status:** plan, 2026-10-04. Step 0 is done ([ADR-012 amendment 1](../ADRs/ADR-012-ai-online-only-where-evidence-shows.md#amendment-1-2026-10-04-ai-suggestions-on-in-the-demo-before-condition-3)): the switch is on in the demo, every eligible report in arm B (`INTAKE_AI_SHARE_B = "1"`). The online model is extractor v2 ([ADR-006 amendment 10](../ADRs/ADR-006-learned-extractor-workers-ai.md#post-freeze-amendment-2026-10-04)), the successor this plan chose, adopted early after v1's endpoint degraded on 2026-10-04. Its held-out evaluation (step 7) is still owed. Step 1 is done: the service account, pool, provider and binding exist (read-only check, 2026-10-04), and the Worker secret is set. Steps 2–5 are built (see the [implementation note](#implementation-note-2026-10-04)); steps 6 and 7 are open. It follows [ADR-012](../ADRs/ADR-012-ai-online-only-where-evidence-shows.md) (Proposed) and its demo amendment; the production gate remains unchanged.

**For:** the team (Lucas, Roberto, Manoella) and whoever builds the PR. Manoella approves anything that changes what the model is asked or how its answer is read (ADR-006, decision 5).

## Why this path, and only this one

When a customer can't find the charge in their own list, today they write what they remember and the case reaches a person as an incomplete handoff. The person then matches the description to the customer's charges by hand.

That is the only step in the flow where something has to understand free text. Everywhere else the customer picks from a list. The frozen comparison says a model reads those descriptions far better than our rules: 53 of 60 held-out cases against 23, and 46 of 52 on the cases that never leaked, with 0 unsafe ([`EVALUATION.md`](../deliverables/EVALUATION.md#1-the-result)).

What we don't know is how often customers take this path. In the dataset nothing records it. On the live service it happened once in 5 team episodes. The path is now enabled in the synthetic demo so its mechanics can be measured; real-customer use still needs the production gate.

## The flow

1. The customer taps "I can't find it" and writes what they remember. The service creates the incomplete handoff, reads it back and returns the reference immediately, exactly as today. No model call happens inside this request.
2. If the switch is on, the Worker schedules one extraction after the response (`ctx.waitUntil`). The model receives only the details text, the session language and the closed merchant and category vocabulary: no customer id, no transactions, no history.
3. The answer is validated against the extraction schema. Deterministic code, the same policy the evaluation used, maps the facts to at most 3 of that customer's own charges. Ownership is enforced in SQL.
4. The suggestions are stored as references (transaction ids, producer version, call count, tokens), never the text.
5. On the receipt, the client polls for suggestions for up to 15 seconds; that limit is for the suggestions to arrive, not for the customer to answer. If there are any, it asks "Is it one of these?" with up to 3 charges, each with its merchant, date and amount. The customer picks one or answers "none of these".
6. Picking one records the customer's confirmation on the handoff. It doesn't close, resolve or refund anything. The agent sees "Customer confirmed this charge from a suggestion", marked as a suggestion and not as verified by the bank, and still reviews the case.

The model can't pick a charge, write to the store, change the action the policy takes, or reach another customer's data. Its worst case is a wrong suggestion that the customer then rejects.

### How a suggestion is found, as implemented (checked against the code, 2026-10-04)

The available evidence supports a **bounded candidate-assistance workflow**, not automatic transaction matching. There are three separate steps, and only the first is learned.

1. **AI extraction.** The model reads the customer's description and returns structured facts in a closed vocabulary: merchant, category, amount (exact or "about"), currency, date or date range, card, country, abroad. It sees no transaction and is never asked to choose one (`ai-transport.js`).
2. **Deterministic matching** (`suggestions.js` `suggestionFor`, `matcher.js`, the evaluation's `label_rules` policy, ported with parity tests):
   - **Retrieval.** At most `SUGGESTION_PURCHASES = 200` of the customer's newest charges: `WHERE customer_id=? ORDER BY occurred_at DESC, source_occurred_at DESC, transaction_id LIMIT 200` (`d1.js` `listSuggestionPurchases`). There is no date window and no status filter in that query. D1's `transactions` table holds only approved card purchases, because the Gold and cohort publishers load only `Purchase`/`Approved` rows and the table has no status column. In the deployed demo the cap doesn't bind: remote D1 holds at most 10 charges per customer (3.65 on average, 803 customers; read-only query, 2026-10-04).
   - **Fields compared.** Merchant (with a few aliases), category (from the vocabulary's merchant → category map), amount (exact, or within 10% when the customer said "about"), currency (which must be one the customer has purchases in), and the transaction date against the extracted date range. Every stated fact must fit.
   - **Facts D1 can't check.** D1 holds no card type, last four digits or transaction country, so `record()` leaves them null. An extracted card, last four, country or `abroad` fact therefore fits **no** online purchase, and the outcome is `no_match` even when the charge is in the list. `test/unit/suggestion-contract.test.js` pins this. Serving those fields, or dropping such facts from the match, is a behavioural change for a later version.
   - **Outcome.** 0 fits → `no_match`; 1–3 → `suggested`; **more than 3 → `ambiguous`, and no suggestion is shown**. A description with no usable fact is `no_match`.
   - **Order.** Suggested charges are listed in `transaction_id` order, a stable display order. The stored `rank` (1–3) is that position. **Nothing is ranked by likelihood**, and no fraud field is read: `is_fraud` and `fraud_score` aren't in D1, and `bank_flagged` only feeds urgency (ADR-011).
3. **Customer confirmation.** A suggestion is only a candidate. The customer confirms one or answers "none of these". A confirmation doesn't show the charge is fraudulent or the complaint valid, and the agent sees it marked "not verified by the bank". **Human review remains the final control.** Nothing refunds, blocks a card, rules on fraud or closes the case.

In one sentence: the system searches up to 200 of the customer's newest transactions and presents only deterministic matches that satisfy the extracted facts. The customer confirms whether a suggested charge is theirs, and human review remains the final control.

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

1. **The current demo: extractor v2 (`google/gemini-3.5-flash-lite`).** ADR-006 amendment 10 adopted it after v1's endpoint degraded. It uses v1's prompt and parsing, `reasoning_effort: "minimal"`, and the global OpenAI-compatible endpoint. The review date is 2027-01-31; from that date the Worker falls back without a call, and CI fails one day earlier while the switch is on. Its held-out evaluation remains owed; the frozen result belongs to v1.
2. **The original production recommendation: Gemini Flash-Lite, evaluated as a new version.** The current v2 demo uses the compatibility endpoint without `responseSchema` or a pinned region; the following proposed production changes still need implementation and evaluation. Four reasons:
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

### Validation for demo enablement

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
- **Latency from the Worker (still owed).** Measure the extraction call's p50 and p95 on the deployed Worker, with synthetic messages, at least 72 calls so the p95 has an interval. Also check that the report request's own p95 doesn't move, since the model is outside it.

### While it runs (demo and planned pilot)

The demo assigns every eligible report to arm B. Set `INTAKE_AI_SHARE_B = "0.5"` for the randomized pilot and its arm comparisons.

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
| HTTP 429 | One jittered retry if the shared 10 s deadline permits, within the two-call limit shared with invalid-output retries; nothing shown if it fails | `provider_error` if retries are exhausted |
| Provider error (5xx, network, error envelope) | No retry | `provider_error` |
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

0. **Amend ADR-012 (done; amendment 1).** Conditions 1–2 hold. Condition 3 can only be met by running the path. The amendment allows the switch on in the demo environment, with synthetic customers only, as the pilot that collects the 30 episodes. It keeps the production gate unchanged and adds the decision rules above. Lucas, Roberto and Manoella decide.
1. **Credential (person).** Create the service account with Vertex AI User only, the workload identity pool and OIDC provider with the Worker's uploaded JWKS, and the binding. Then put the Worker's signing key as a secret (`wrangler secret put VERTEX_WIF_SIGNING_KEY`) and set the project and provider names as vars. All of this is a person's job; agents don't change permissions.
2. **Port and parity (code PR).** Port the Vertex transport, body, parse, retry and deadline to JavaScript, plus the deterministic matcher, with golden fixtures from the development split only. Replace the dead Workers AI binding path in `ai-transport.js`. `registeredVersion()` keeps pinning the prompt hash. Manoella approves the port.
3. **Storage and routes.** An additive migration for suggestions and the customer's choice. A GET route for a handoff's suggestions and a POST to confirm one, owner-scoped, with all the tests above and an ADR-004 note for any new budget ceiling.
4. **Client.** The "Is it one of these?" step in es, pt and en. The agent view's "confirmed from a suggestion" marker, and a correct/wrong control for the agent, which is the label the pilot needs.
5. **Events and export.** Outcome kinds, producer version, calls and tokens in `intake-events.md` and the exporter; the arm assignment; the pilot summary in the same scorer as today's episodes.
6. **Measure from the Worker** (synthetic, ≥72 calls). This remains owed; the switch is already on in the demo under ADR-012 amendment 1.
7. **Complete v2 evaluation.** Gemini Flash-Lite is already in the demo, measured on development and safety splits. A new held-out set, pre-registration, tag, one run and publication remain owed. Review the model before its configured 2027-01-31 cutoff.

## What the evidence supports, layer by layer

| Layer | Evidence in the repository | What it does not show |
|---|---|---|
| **Extraction correctness** | v1: frozen held-out set, 53/60 against the checklist's 23/60 ([EVALUATION §1](../deliverables/EVALUATION.md#1-the-result)). v2: development 18/18 by majority, 179/180 runs ([ADR-006 amendment 10](../ADRs/ADR-006-learned-extractor-workers-ai.md#post-freeze-amendment-2026-10-04)) | v2 has no held-out result; development shaped the prompt |
| **Prompt injection / red team** | v2: 22/22 safety cases, 66/66 runs, 0 unsafe ([EVALUATION §11](../deliverables/EVALUATION.md#11-other-measurements)) | Not a substitute for accuracy; the cases are authored, not held out |
| **Latency and provider reliability** | v2 offline p95 1.83 s (upper bound 2.07 s); 15-call samples per location through the Worker's transport; the circuit breaker, the 429 retry and the alerts | **The p95 from the deployed Worker is still owed** (step 6) |
| **Deterministic matcher** | Parity with the Python policy on 753/753 cases (`ai-parity.test.js`); the contract above (`suggestion-contract.test.js`) | That the facts a customer gives single out the right charge |
| **End-to-end suggestion accuracy** | **None.** No dataset links a complaint to the transaction it disputes | Any recall, precision or coverage of suggestions |

**Why there is no end-to-end number.** The dataset has no transaction-level ground truth. The complaint's `claimed_amount` doesn't identify a transaction either. Reproduced on the full Silver file (read-only DuckDB, 2026-10-04):
- of 12,297 `Cargo no reconocido` complaints, 3,907 have a claimed amount and a currency;
- **0 of those 3,907** have a transaction of the same customer with the same amount and currency, at any time, and 0 within ±7 days of the complaint.

A looser candidate count depends on its window. With "any same-currency transaction in the 90 days before the complaint" we count 765 of the 3,907 complaints (19.6%). That is not a match rate and not suggestion coverage: production uses no 90-day window. **Any measure of recent-transaction availability describes the data, not what the suggestions find, and must not be quoted as suggestion coverage.**

**What would measure it.** The pilot's own labels: the customer's confirmation and, above all, the agent's correct/wrong mark on each confirmed suggestion ([measurement](#while-it-runs-demo-and-planned-pilot)). Together with the share of runs that end `ambiguous` or `no_match`, those are the first trustworthy transaction-level labels this workflow will have.

### Would a learned ranker or classifier ("JEV") help now? No.

- **The limit is missing ground truth, not model complexity.** A ranker needs examples of "this complaint was about this transaction". The dataset has none (0/3,907 even on the amount), so a model trained on it would learn from labels that don't exist, and nothing could evaluate it.
- **The current design already abstains.** More than 3 fits shows nothing, and 0 fits shows nothing. A model ranking a long list would remove that abstention, which is a safety property.
- **Where one might help later, as a hypothesis to evaluate, not a feature:**
  1. ordering 2–3 deterministic candidates by likelihood;
  2. a calibrated abstention when the facts are weak.

  Both need a labelled set built from the pilot's agent marks (confirmed and marked correct or wrong), split by time, with the deterministic guardrails kept in front: a learned score may reorder or withhold candidates the rules already admitted, never add one.
- **Decision:** no ML/JEV component is added. Reopen when there are at least a few hundred agent-marked confirmations.

## What this plan does not claim

- It doesn't claim that the model identifies the disputed transaction, or any recall, precision or coverage for suggestions. There is no transaction-level ground truth yet (above).
- It doesn't claim that `claimed_amount` identifies a transaction (0 of 3,907 exact matches), or that fraud fields could rank suggestions. Neither is used.

- It doesn't claim the path will be used often. That is what the pilot measures.
- It doesn't claim agents will save time. The design can show it only with more volume than a demo has.
- The frozen result doesn't transfer to v2. Every new model or host is a new version with its own evidence.
- Customer data doesn't go to Google in the demo; only synthetic customers use it. Before real data:
  - request Vertex AI's abuse-monitoring logging exception, for zero retention;
  - pin a region if the bank requires one;
  - keep sending only the description text.

## Implementation note (2026-10-04)

Historical implementation snapshot: built on branch `feat/ai-suggestions` with v1 and the switch off (`INTAKE_AI_ENABLED = "0"`). The notes below describe that initial build. ADR-012 amendment 1 and ADR-006 amendment 10 subsequently enabled the demo with v2; current settings, retry behavior and review date are above and in [`back-end/README.md`](../../back-end/README.md#ai-suggestions-on-i-cant-find-it-adr-012).

- **Port and parity.** `back-end/src/modules/intake/ai-transport.js` ports `vertex.py` and `workers_ai.py` (body, parse, schema, one retry, 10 s deadline, no retry on provider errors); `matcher.js` ports `label_rules.evaluate`. `python -m evals.intake.online_parity` runs the evaluated Python, unchanged, on the development split and authored synthetic inputs and writes `back-end/test/fixtures/ai-parity.json`: 15 request bodies byte-identical, 26 parse cases, 21 HTTP exchanges (kind, calls, usage), 753 policy cases, all equal. Known divergences, none reachable with the routes' inputs: Python's `json.loads` accepts `NaN`/`Infinity` in a provider body (the JS reads such a body as `provider_error`); `Decimal` accepts non-ASCII digits and `fromisoformat` week dates (the JS refuses them, so they can only drop a suggestion); diacritics are removed only in U+0300–U+036F.
- **Online inputs.** `as_of` is the Worker's current UTC time in the harness's timezone-free form (`YYYY-MM-DDTHH:MM:SS`), the same value the policy then uses, which is closer to the evaluated condition than null. The Worker doesn't know the customer's local time, so near midnight the UTC date can be a day off the customer's: the worst case is a relative date ("ayer") that matches nothing, which suggests nothing. **For Manoella's port review (reading condition):** the frozen run's `as_of` was the session's local time; online it is UTC. D1 holds no category, card or country per charge, so those facts never fit; the category is taken from the closed vocabulary's merchant names. The customer's "cards" are the currencies of their own charges, as `systems.customers_from` derives them.
- **Outcome kinds** are the ones in the fallbacks table, plus `abandoned` (the idle sweep closes a run still pending after 10 minutes). `injection_flagged` is recorded on the run and the event as a boolean, but changes no outcome (a reported purchase is still suggested). `rejected` is the choice `none`. `not_shown` is a suggested run never served to the customer (`shown_at` null). `not_answered` is a suggested and shown run with no answer before the agent's first open (`first_opened_at`): from that moment the customer's answer is refused with 409 `already_in_review`, so the agent never reviews an answer that arrived mid-review. These three come from D1 through `suggestionPilotSummary`, not from events.
- **One runner per run.** The run is claimed atomically before anything else; a same-key replay of the handoff schedules the run again, so a first request whose Worker stopped before the run started is finished by its replay. The retirement date can only move earlier than 2026-10-21, the built-in date for the model.
- **Credential:** option A, as above. The Worker never holds a Google key.
- **Storage and routes:** migration 0024 (runs with the arm, suggestions, the customer's choice, the agent's mark, the daily cap); `GET /intake/handoff/{reference}/suggestions`, `POST …/suggestions/confirm` and `POST /agent/suggestion-mark`. The arm is fixed in the handoff's reservation batch. One `suggestion_recorded` event per run carries the arm, the outcome and the usage; the customer's choice and the agent's mark are in D1 only, not in events.
- **Human steps before the switch is on:** the ADR-012 amendment (step 0); the service account, pool, provider with the Worker's JWKS and the binding (step 1); `wrangler secret put VERTEX_WIF_SIGNING_KEY`; the latency measurement from the Worker (step 6).
