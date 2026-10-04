# ADR-014 — Online AI only for "I can't find it" suggestions, off until a pilot; no fraud model

- **Status:** Proposed
- **Date:** 2026-10-04
- **Deciders:** Lucas, Roberto, Manoella
- **Supersedes:** ADR-002, in part: its rule that the MVP calls no model. The rule still holds while the switch below is off. ADR-012 decision 3 still stands; this record adds how its third condition is measured.

## Context

ADR-002 built V1 to call no model. ADR-012 kept every live path deterministic and named one path where a model could help: the customer who can't find the charge in their own list and describes it instead. It set four conditions for turning that path on.

Two of the four now hold:
- **The frozen comparison ran once** on 2026-10-04. The registered extractor v1 (gpt-oss-20b on Vertex AI, majority of 3 runs) got 53 of 60 held-out cases right against the rule-based checklist's 23. On the 52 cases never exposed during the build it got 46 against 20, with 0 unsafe outcomes in 180 runs ([`EVALUATION.md`](../deliverables/EVALUATION.md#1-the-result)).
- **Every development trigger passes** (ADR-006 amendment 9).

The other two can't hold yet:
- **The third** needs at least 30 live episodes, and the service has 5, all team sessions. It can only be measured by running the path.
- **The fourth** caps the request at 2,000 ms, and the model's p95 alone was 2,048 ms. It can only hold if the model runs outside the request.

The brief asks for an AI-first system, and every team is "assessed on data engineering and AI/ML rigor" (problem statement p. 4). It also says model training, agents and streaming are optional (p. 4), and that permissions are enforced "outside model-generated prose" (p. 3). The judging criteria put "our solution should work" first (kickoff p. 20).

We also re-examined fraud detection. It is the most visible ML use case in the dataset, which lists it as a "Potential Use Case" (dataset summary p. 4, dictionary p. 16).

## Options evaluated

| | 1. Keep production deterministic | 2. Vertex AI for bounded suggestions, switch off until a pilot | 3. Offline or shadow only | 4. Transaction-level fraud detection |
|---|---|---|---|---|
| **Value to a customer or judge** | Works today; no new failure mode | The one free-text step gets help: "Is it one of these?" from the customer's own charges, so a person doesn't match by hand | Evidence without product change (offline: exists) | Looks impressive |
| **Already in the repository** | The whole flow | The frozen result; the Python transport and parser; the prompt; a switch and shadow scaffold in `ai-transport.js` | The harness, the registration and the frozen result. Shadow mode drops the output | ADR-011's analysis; `fraud_readiness_findings.md` |
| **Minimum addition** | None | A JS port of the transport and parser with parity tests; a Workload Identity Federation token in the Worker; a deterministic matcher; 1 additive migration; 2 customer routes and 1 agent route; the UI; the pilot record | None (offline). Shadow: none, but it costs tokens and shows nothing | A label timeline, a model, a review queue, and a decision path the product doesn't have |
| **Security and privacy** | Unchanged | The model gets only the description, the session language and a closed vocabulary. Suggestions come only from the customer's own charges, enforced in SQL. No Google key exists (federation). The text leaves for Google's `global` endpoint | Offline: synthetic messages only | Would score every customer's transactions |
| **Failure and abstention** | — | Every failure leaves today's incomplete handoff and is recorded as a kind. No match or more than 3 matches means no suggestion | — | A false positive alarms a customer; a false negative is invisible |
| **Evaluation** | Exists | Frozen offline (done); the randomized pilot with fixed decision rules (the plan) | Done | Not possible: see the decision |
| **Latency and cost** | — | 0 ms added to the request (the call runs after the response). About US$0.00021 per call on v1 at the ADR-004 envelope (2,106 input, 266 output tokens); under 1 cent a day at the dataset bank's volume | Offline: US$0.027 per frozen run | — |
| **Operations** | — | One secret, five vars, a daily cap, and a model retirement date the Worker enforces | — | A model to monitor for drift with no ground truth |
| **Rollback** | — | Set `INTAKE_AI_ENABLED` to `0` and deploy. The migration is additive and unused when off | — | — |
| **New ADR needed** | No | **Yes, this one** | No | Yes, and it would fail ADR-005 |

## Decision

1. **Build option 2 and keep it off.** The suggestion path ships behind `INTAKE_AI_ENABLED = "0"`, as specified in the [AI suggestion plan](../Plans/ai-suggestion-plan.md):
   - the model runs after the reference is returned;
   - deterministic code picks at most 3 of the customer's own charges;
   - the customer confirms one or answers "none of these";
   - a person reviews every report.

   The path never refunds, blocks or decides fraud, and a handoff stays a handoff (ADR-002 decisions 1–3).
2. **Turning it on is a pilot, and only in the demo environment, with synthetic customers.** ADR-012's third condition, 30 live episodes, can only be met by running the path. So it may be switched on in the demo environment as the pilot that collects those episodes:
   - each "I can't find it" report is assigned to an arm at random (50/50), and only arm B gets the extraction;
   - the decision rules fixed in the plan switch it off: any unsafe outcome; more than 5% failures over the last 50; more than 1 in 10 confirmed suggestions marked wrong by agents (with at least 20 reviewed); the report request's p95 at 2,000 ms or more;
   - **the demo pilot does not satisfy ADR-012's third condition.** Team and reviewer sessions can't show how often real customers can't find a charge. The demo pilot tests the mechanics: failure rates, latency from the Worker, agent-marked correctness on authored situations. Real-customer use is measured only in a production pilot whose population is the bank's signed-in customers who start a report, with numerator the reports ending in "I can't find it", over at least 30 started reports in a stated event-time window, by language, with abandoned reports counted in the denominator. Turning it on for real customers needs that measurement and a new decision.
3. **The online model is the evaluated one, and only until it retires.** That is v1, `openai/gpt-oss-20b-maas` on Vertex AI with `reasoning_effort: "low"` and the registered prompt. The Worker refuses to call it after its configured retirement date (2026-10-21). After that the path falls back on its own. A successor (the plan recommends Gemini 3.5 Flash-Lite) is a new version: an isolated build, re-measured development triggers, a new held-out set, a registration and a person's tag.
4. **Credential: Workload Identity Federation, no Google key** (ADR-012 decision 4 as revised). The Worker signs a short-lived JWT, exchanges it at Google's STS, and impersonates a service account that holds only Vertex AI User.
5. **No transaction-level fraud model.** It isn't defensible on this data:
   - **The label can't be timed.** `is_fraud` has no availability timestamp, and `process_date` carries no label-arrival information (lag −1 to 0 days, the same for both classes; `fraud_readiness_findings.md`, finding 2). So no time-based split with a real label-delay embargo can be built.
   - **The only strong feature is probably the label.** `fraud_score > 30` has precision 1.000 and recall 0.537–0.551 in every period, and no legitimate row scores above 30 (ADR-011). Until the organizers confirm it is computed before and independently of the label, it is treated as leakage.
   - **Nothing else separates fraud.** At 0.099% prevalence (3,713 of 3,738,506 transactions in the design window), the amount and every other single field leave the fraud rate within 0.05–0.13% in every period (ADR-011).
   - **The product has no decision for a score to drive.** The workflow is intake with a human handoff. A score would need a review queue, a capacity limit and a cost model the bank hasn't given us. ADR-011 already uses the bank's own flag as an input, without claiming detection.

## GCP options for the chosen path

Prices are list prices from the Cloud Billing Catalog API, read 2026-10-04. "Per call" uses 2,106 input and 266 output tokens, the ADR-004 envelope; the frozen run averaged 1,840 and 84.

| Option | Fixed / idle | Per call | Latency | Complexity | Lock-in | Verdict |
|---|---|---|---|---|---|---|
| **Worker calls Vertex directly (federation)** | $0 | At 2,106 input and 266 output tokens: v1 about $0.00021 ($0.07 / $0.25 per M); Gemini 3.5 Flash-Lite about $0.0013 ($0.30 / $2.50 per M) | p95 2,048 ms, after the response | JWT, STS and impersonation in the Worker, about 150 lines | Low: OpenAI-compatible endpoint | **Chosen.** Keeps one online runtime (ADR-003) |
| A Cloud Run proxy in GCP | $0 with scale to zero, plus cold starts of 1–3 s | The same, plus Cloud Run time | Adds a hop and cold starts | A second API to secure and deploy | Medium | Rejected: a second online runtime, contrary to ADR-003 |
| Vertex batch prediction or BigQuery | $0 | About half the online price | Minutes to hours | Low | Medium | Offline evaluation only; the customer is gone by then |
| Workers AI binding (the same gpt-oss-20b weights on Cloudflare) | $0 | About $0.0005 at the default level (ADR-004) | p95 3,582 ms at the default level; `low` never verified there | Lowest: no GCP identity | Low | Deferred: the host wasn't evaluated at `low` (ADR-012 decision 4) |
| Self-deployed weights on a regional Vertex endpoint | About $800 a month always on (one GPU) | ~$0 marginal | Regional | High | Low (open weights) | Only if a bank requires the text to stay in one region; no Flash-Lite offers that today |

## Consequences

- **+** The brief's learned component is in the product, not only in the evaluation, while every decision stays deterministic.
- **+** It adds 0 ms to the customer's request and costs under 1 cent a day at the dataset bank's volume.
- **+** The pilot produces the evidence ADR-012 asked for: use rate, confirmation rate and agent-marked correctness, by randomized arm.
- **+** Saying no to fraud is itself a result: the data can't support it, and the record shows why.
- **−** v1 runs on Google's `global` endpoint, which doesn't pin where text is processed. That is fine for synthetic customers. The successor runs in the `us` multi-region, which keeps text in the United States. For real data a bank also needs Vertex's zero-retention exception, and a self-deployed regional endpoint if the text must stay in Latin America.
- **−** v1 retires on 2026-10-21. Until a successor is registered, the path turns itself off on that date.
- **−** The JavaScript port is new code reading the model's answer. Its parity with the evaluated Python is proven only on the development split and malformed cases. Manoella approves it (ADR-006 decision 5).
- **−** A demo pilot measures team and reviewer sessions, not customers.

## Alternatives considered

- **Keep the path offline until real customers exist.** It is safe, but it never produces the evidence ADR-012's third condition needs. Rejected: the pilot is the measurement. Reopen if a reviewer finds the off switch or the decision rules insufficient.
- **Use the model for the whole conversation.** It would add 1.6–2.6 s to every turn and a failure mode to every step, for a reading need the guided flow doesn't have (ADR-012). Rejected: no measured benefit on any live path. Reopen if a live path appears that must be decided from free text.
- **A fraud model on `fraud_score` and transaction fields.** Rejected: no label timestamp, a likely leaking feature, and no product decision to drive (decision 5). Reopen if the organizers confirm that `fraud_score` is computed before the label and supply a label timestamp, and if a bank defines the review capacity and the cost of each error.
- **Shadow mode** (the model reads, the customer sees nothing). Rejected: it pays for tokens and produces neither a customer benefit nor the agent-marked labels the pilot gives. Reopen if the bank forbids customer-facing suggestions.

## Implementation notes

- Plan, measures, fallbacks and probe results: [`ai-suggestion-plan.md`](../Plans/ai-suggestion-plan.md). The target workflow diagram is in [`SYSTEM_DESIGN.md`](../deliverables/SYSTEM_DESIGN.md#the-target-workflow-with-ai-online).
- **GCP (2026-10-04):**
  - created by a person: the service account `arabica-worker-vertex` (Vertex AI User only), the pool `arabica-worker`, and the OIDC provider `cloudflare-worker` (condition `assertion.sub == 'arabica-intake-worker'`, the Worker's JWKS uploaded, no Google key);
  - the provider's configuration was checked read-only;
  - the Worker's signing key is a Worker secret. The end-to-end token exchange is not verified yet, because it needs the implementation deployed.
