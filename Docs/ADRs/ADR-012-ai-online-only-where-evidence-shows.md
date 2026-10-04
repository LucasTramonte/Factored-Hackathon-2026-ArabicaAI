# ADR-012 — AI online only where the evidence shows the deterministic flow falls short: not yet

- **Status:** Proposed
- **Date:** 2026-10-04
- **Deciders:** Lucas, Roberto, Manoella

## Context

The product owner proposed putting an AI assistant online, but only where evidence shows the deterministic flow is insufficient, or where latency or complexity justifies it; not everywhere. The brief asks the team to "justify where AI is appropriate, where deterministic logic is preferable" (problem statement p. 2). ADR-002 keeps the MVP free of model calls, and adding one needs its own ADR. This is that ADR. It asks, path by path, whether the data and our own measurements justify a model online.

The deployed flow (ADR-002, ADR-009, ADR-010) is guided:
1. the customer signs in;
2. picks one tap of reason;
3. writes a short statement;
4. **picks the charge from their own list** and confirms it, or says "I can't find it" and adds what they remember (an incomplete handoff to a person).

No step needs the service to understand free text in order to act: the charge comes from a list, the reason from a closed set. The statement and the details travel to the agent as written.

**Evidence, per path:**

| Path | Where it could fall short | Measured | Source |
|---|---|---|---|
| Sign-in, reason, charge list, confirmation | Ambiguity or failure in choosing the charge | None measurable: the customer chooses from their own charges, and ownership is enforced in SQL | ADR-009; `back-end/test/integration/` |
| Reading free text (what a fully conversational flow would need) | The rule-based checklist misses currency words, non-ISO and relative dates, paraphrases | Checklist 15/25 on `v1_authored`, 16/18 on development, 22/24 on evaluation. The guided UI avoids this need: nothing is decided from the text | `EVALUATION.md` §3 |
| "I can't find the charge" (incomplete handoff with details) | The customer can't find the charge, so a person must match it by hand | 1 of 5 live episodes (Portuguese). Five episodes support no rate | `EVALUATION.md` §9 (remote export, 2026-10-02) |
| Latency of the guided requests | Slow steps | One timed confirm: 1,268 ms. The report-request target is p95 below 2,000 ms; evidence is still incomplete | `EVALUATION.md` §10 |
| The learned extractor itself | Whether a model reads better than the checklist | Development, 10 repetitions each. At the provider default: 180/180 executions correct, 0 unsafe, but a p95 interval upper bound of 3,079 ms (the latency trigger fires). At `low`: 18/18 cases correct by majority, 0 unsafe, 158 of 160 schema-valid, upper bound about 2,340 ms, and instability 1/18 model changes plus 2 provider failures, which pass under Manoella's ruling. Every development trigger passes; the frozen comparison has **not run** | ADR-006 amendments 7–9; `DEV_LOG.md` |
| Proactive help | Customers wait to start every interaction | Handled deterministically by ADR-011 (a bank flag, no model) | ADR-011 |

**What the evidence says.** The one measured weakness of deterministic logic, reading free text, sits on a step the guided flow doesn't depend on. The one path where a model could plausibly help (matching an "I can't find it" description to the customer's own charges) has a single live occurrence. The model has passed its development gates but not yet its held-out comparison. On top of that, it adds about 1.6 s at p50, and 2.3 to 2.6 s at p95 at the low reasoning level, to whatever step it joins, against a 2,000 ms report-request target.

**Challenge: should an AI agent replace the human reviewer?** The product owner observed that, among escalated cases, the dissatisfaction measured by the KPIs sits where an agent reviewed, and asked whether an online AI agent in place of the person would bring more satisfaction or speed. We tested that against the data ([`AI-01_satisfaction_drivers.sql`](../../data_foundation/queries/ai_decision/AI-01_satisfaction_drivers.sql); design window 2023-06-17 to 2025-12-31; aggregates only):

1. **The data has no automated service to compare against.** All 580,546 contact-centre interactions in the window have a human agent (`agent_id` is never null). `agent_type` (Digital, Phone, In-Person, Hybrid) describes people on different channels, not bots. Whatever the data says, it can't measure how an AI agent would score.
2. **Satisfaction follows resolution, not who handled the case.** Complaint contacts (`Queja`) with a CSAT answer (scale 1–4, 18,526 answers):

   | Cut | Unresolved | Resolved |
   |---|---|---|
   | Not escalated / escalated | 2.00 (n = 9,447) / 2.02 (n = 1,022) | 3.00 (n = 7,218) / 2.99 (n = 839) |
   | Agent type: Digital, Phone, In-Person, Hybrid | 2.01, 2.01, 2.00, 1.97 | 3.02, 3.00, 2.97, 3.01 |
   | Experience: Junior to Specialist | 1.97–2.03 | 2.98–3.00 |
   | Wait under 1 min / 1–5 min | 2.01 / 2.00 | 3.01 / 3.00 |
   | Call under 5 min / 5–10 min / 10 min or more | 1.97 / 2.01 / 2.00 | 2.99 / 3.00 / 3.01 |

   Escalated contacts aren't less satisfied once resolution is held fixed, and they're unresolved about as often (55% against 57%). The dissatisfaction the KPI shows on reviewed and escalated cases is the dissatisfaction of **unresolved** cases. On this dataset, satisfaction looks set almost entirely by the outcome. That is a property of the data as generated, and a reason not to read more into it.
3. **Speed shows no reliable effect on satisfaction.** Unrecognized-charge complaints with a resolution score: 397 of 10,370 (3.8%, closed cases only).
   - **Days to resolution against the score:** correlation 0.036 (n = 397).
   - **SLA breached against not:** 3.21 against 3.01.
   - **Hours to first response:** correlation −0.069 (n = 373: 11 of the 384 have no assignment date, and none was answered before assignment). The one hint in favour of speed is that complaints answered within 12 hours score 3.42 (n = 77), against 2.83–3.11 in the slower bands. It isn't monotonic, and it is the best of four bands chosen after looking, so it is a hypothesis, not evidence.
4. **What a resolution is.** Of 2,535 resolved or closed unrecognized-charge complaints:
   - account adjustment: 20.0%;
   - detailed explanation: 19.4%;
   - escalated with a definitive fix: 19.4%;
   - compensation: 18.3%;
   - correction: 17.9%;
   - none recorded: 5.0%.

   754 (29.7%) record a compensation amount. **About 80% of resolutions move money or change the account.** ADR-002 and the brief keep those out of a model's hands (no refund, no money movement, no fraud decision). Only the "explanation" fifth is informational, and even there the explanation follows an investigation, which no field records.

**What the challenge changes.** It doesn't change the decision to keep the reviewer human. The data offers no evidence that a different handler raises satisfaction, no automated comparison, and no ground truth for a correct dispute outcome against which an AI reviewer could be evaluated. It does leave one **unconfirmed hypothesis to test**: a fast first response might matter besides resolution. The only support is the post-hoc, non-monotonic 12-hour band above, which is not evidence. Our service already responds at once deterministically (the reference right away, status emails at each step). An AI-drafted first explanation for the agent to send is the one AI step left open, and it would itself be the test of that hypothesis (decision 5).

## Decision

1. **No model online now. Every live path stays deterministic.** The extractor stays offline (evaluation, ADR-006) and behind the shadow switch, which is off (`INTAKE_AI_ENABLED`, `APPROVED_EXTRACTOR = null`).
2. **The one candidate path is named in advance:** "I can't find the charge" with details. If it qualifies, the model reads only the customer's details text and turns it into the fixed vocabulary (amount, date, currency, merchant). Deterministic code then **suggests** up to three of the customer's own charges that fit those facts. The customer confirms one or keeps the handoff. The model never sees transactions, never picks a charge, never writes to the store, and never decides an action.
3. **It goes online only when all of these hold**, measured and recorded before the switch is turned on:
   - the frozen comparison has run once (ADR-006), and the extractor is at least as correct as the checklist on held-out cases, with 0 unsafe;
   - every ADR-006 development trigger passes under the recorded rulings, including instability (#98);
   - over at least 30 live episodes, "I can't find it" is at least 15% of started reports. Below that, a person matching by hand costs less than operating a model path;
   - the path's added p95 latency (model call plus suggestion) keeps the request under the 2,000 ms report-request target, measured on that path only.
4. **When it does go online, the architecture optimizes for these properties:**
   - **Latency:** one call, only on that path, never on the main flow; 10 s hard deadline; the response is never blocked by an unrelated model call.
   - **Cost and tokens:** about 2,107 input and 130 output tokens per call at `reasoning_effort: "low"` (development, 158 returned calls, 2026-10-03). At the price the isolated builder recorded from Vertex AI's pricing page that day (US$0.07 per million input tokens, US$0.25 per million output; re-check before production), that is about US$0.00018 per call. Even if every one of the 11 daily reports took the path, it would cost well under a cent a day.
   - **Reliability:** timeout, malformed output, schema failure or provider error all fall back to the current incomplete handoff, recorded as unknown usage and never as free.
   - **Security:** the model sees only the details text, the session language and the closed vocabulary; no customer id, transaction or history. Its output is validated against the schema before anything uses it, and ownership of suggested charges is enforced in SQL.
   - **Auditability:** events carry the producer version, call counts and token usage, never the text (`intake-events.md`). The suggestion, and the customer's choice, are recorded as references.
   - **Determinism:** the suggestion rule (facts → own charges) is deterministic and unit-tested. Only the reading is learned.
   - **Host: Google Vertex AI, the one the model was measured on.** Latency, stability and schema validity are properties of a host as well as a model. Activating on another host (for example the Workers AI binding that ADR-006 decision 6 first named) would need the development triggers re-measured there first. The online call is the evaluated transport (`intake_agent/extractor/vertex.py`), ported to the Worker:
     - **Request:** OpenAI-compatible Chat Completions at `https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/endpoints/openapi/chat/completions`, model `openai/gpt-oss-20b-maas`, `reasoning_effort: "low"`, temperature 0, with the committed prompt and body (ADR-006 amendments 7–9).
     - **Credential:** a dedicated service account with only the Vertex AI User role on the project. Its private key is a Worker secret, never in `vars` or the repository. The Worker signs an RS256 JWT with `jose` (already a dependency) and exchanges it at `https://oauth2.googleapis.com/token` (`urn:ietf:params:oauth:grant-type:jwt-bearer`) for a one-hour access token, cached in the isolate and renewed before expiry. The `gcloud auth print-access-token` used in evaluation is a person's credential, for development only.
     - **Measured on Vertex (development, `low`):** p95 interval upper bound about 2,340 ms; 18/18 correct by majority; 0 unsafe; 158 of 160 schema-valid. Two provider failures in 160 calls: the fallback design above is necessary, not theoretical.
     - **Quota:** 1,200 queries a minute (ADR-006 amendment 7), orders of magnitude above this path's volume.
     - **Data:** Google states that customer data isn't used to train models without permission. Prompts may be logged for abuse monitoring unless an exception is granted, and the `global` endpoint doesn't pin a region ([Vertex AI data governance](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/data-governance)). The details text is the customer's own words, so before real customer data: request the abuse-logging exception for zero retention, pin a region if the managed model offers one, and keep sending nothing but the details text.
     - **Model lifetime:** Google's page for `gpt-oss-20b-maas` says the endpoint retires on 2026-10-21. A production path needs its successor chosen, pre-registered and re-evaluated as a new version (ADR-006), so nothing online may depend on this model id beyond that date.
5. **The person stays the reviewer; AI may later assist the agent, not replace them.** The challenge above found satisfaction tied to resolution, no automated counterfactual, and no correct-outcome label. A model deciding a dispute would also cross ADR-002's boundary. The one candidate is **agent assist**: a model drafts the first explanation, and a person reads, edits and sends it. It is pilot-only and measured by:
   - time to first response;
   - re-contact within 7 days;
   - CSAT for resolved and unresolved cases separately;

   against the current flow, in production, with agents choosing per case. It needs its own ADR before any build.
6. **Everything else stays deterministic by design,** because it is already adequate: sign-in, reason, charge list, confirmation, receipts, notifications, agent queue, proactive alert (ADR-011) and urgency.

## Consequences

- **+** No latency, cost or new failure mode on any live path today.
- **+** The decision is falsifiable: four measurable conditions turn the one AI path on, and the architecture for it is already fixed.
- **+** The learned component still meets the brief's requirement offline: a pre-registered comparison against the checklist on held-out cases.
- **−** The demo shows AI in the offline evaluation, not in the live conversation. That is a deliberate choice, and the reason is stated.
- **−** "I can't find it" stays a manual match for a person until the conditions hold.

## Alternatives considered

- **An AI assistant for the whole conversation.** It would add 1.6 to 2.6 s to every turn and a new failure mode to every step, to solve a reading problem the guided flow doesn't have. Rejected: no measured benefit on live paths. Reopen if a live path appears that must be decided from free text.
- **Turn the shadow extractor on online now.** Shadow mode costs tokens on every start and changes nothing for the customer, and the held-out comparison hasn't run. Rejected: cost with no customer benefit and no held-out result yet. Reopen when decision 3's first two conditions hold, to collect live latency and usage before activation.
- **The model picks the charge directly from the customer's transactions.** It would send transaction data to the model and let a model output choose a record. Rejected: data minimization and ADR-002's boundary. Reopen never for picking; suggestions stay deterministic.
- **A trained urgency or routing classifier (SageMaker).** ADR-011 found no validated pre-outcome signal to learn from. Rejected: nothing trustworthy to train or evaluate on. Reopen with a timestamped label or new pre-outcome fields.
- **An online AI agent instead of the human reviewer** (the product owner's challenge). The data shows satisfaction set by resolution, not by who handled the case: escalated and non-escalated, every agent type and experience level score the same once resolution is fixed. There is no automated service in the data to compare against, and no label for the correct outcome of a dispute. About 80% of resolutions move money or change the account, which a model may not do (ADR-002). Rejected: no evidence it would raise satisfaction or resolve more, and no way to evaluate it. Reopen with a pilot that measures an AI-handled path against the human one on time to first response, re-contact and CSAT within outcome, or with a labelled set of correct dispute outcomes.

