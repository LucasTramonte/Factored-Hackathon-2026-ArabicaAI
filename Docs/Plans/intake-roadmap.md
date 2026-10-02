# Intake roadmap: from the MVP to the target workflow

The target workflow has three stages:

- **Data preparation:** Bronze → Silver → Gold (versioned evidence and coverage).
- **Online service:** validate the session and scope; retrieve permitted candidates with coverage and version; classify the retrieval outcome (matches, none or incomplete, tool error); persist an idempotent case; verify it, then issue a reference; human review.
- **Offline evaluation:** all attempts, not only saved cases.

This page maps each box to what exists and what's next. The decisions behind it are in [ADR-002](../ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md) (Accepted), [ADR-003](../ADRs/ADR-003-intake-single-runtime-worker-d1.md) and [ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md) (Proposed).

## Gap map

| Target box | Today | Gap |
|---|---|---|
| Bronze / Silver / quality | Done, with a quality gate and a bounded one-day sample | — |
| Gold: versioned evidence + coverage | `data_pipelines/gold/` writes a content-versioned D1 seed and a provenance manifest | Multi-day and multi-customer slices with zero, one and several matches. The API doesn't return `slice_version` or coverage yet. |
| Validate session + customer scope | Session-only identity, separate customer and agent actors, expiry, rotation; tested adversarially. Built, not yet deployed: Cognito email sign-in for customers and agents, roles from Cognito groups with a route-to-role table (the agent role gate), audit events and a per-IP rate limit | Idle expiry |
| Retrieve permitted candidates | The customer's newest 20 charges | Filters (amount, date window, merchant) and coverage/version in the response |
| Classify retrieval outcome | Deployed 2026-10-01 and used by the guided UI. The guided flow separates an explicitly confirmed owned transaction (complete handoff), an explicit request for review without one (incomplete handoff) and a failed lookup (technical handoff). | Automatic one / several / none classification of free text, which waits for the approved extraction adapter and Gold serving fields (gated). Never claim a charge doesn't exist. |
| Tool error → bounded retry, safe fallback | Generic 503, and the client retries the frozen request with the same key. Since 2026-10-01 (deployed), a failed owned-transaction lookup ends in a durable technical handoff. | A server-side bounded retry before the technical handoff |
| Idempotent case + evidence + pending questions | Idempotent per customer and key; 409 on divergence; concurrency-tested. Since 2026-10-01 (deployed), guided handoffs store their kind (complete, technical, incomplete), server actions, open questions and an evidence snapshot, one per episode. Built, not yet deployed: one open report per charge, so a charge with a report still received or in review gets 409 until a person closes it. | The check runs before the write, so two confirmations in the same instant can still open two reports |
| Verify the saved case, then issue the reference | The reference is returned only after reading the row back | — |
| Human review | Since 2026-10-01 (deployed), a read-only guided intake queue and detail with the recorded service history. Built, not yet deployed: a person moves a report received → in review → closed, with history; the customer sees the status in their reports and by email; open high-urgency reports lead the queue. | None by design: no refund or verdict actions (ADR-002) |
| ES / PT customer | ES/PT/EN interface with a language switch; evidence (amounts, IDs, timestamps) is not translated | Explicit currency and timezone labels kept |
| Offline evaluation | Checklist baseline and episode scorer in `evals/intake`. Since 2026-10-01 (deployed), the guided API emits the v2 event contract, and a validated export feeds the scorer (pending episodes included). | Scoring real episodes from the deployed UI; routing and authentication failures stay separate from episodes |

## Phases and exit gates

Each phase is its own PR, with adversarial tests first and a merge only when its exit gate passes.

1. **Deploy and measure (now).**
   - **Work:** push the restructure and update the Workers Builds settings. Run the remote checklist in `back-end/README.md`, then a low-rate remote run to capture CPU and end-to-end p50/p95. Record the AWS Pricing Calculator estimate.
   - **Exit:** ADR-004's implementation notes hold the measured numbers.
2. **Full data context in the product (next priority).** Today the live demo serves fictitious charges plus one dataset transaction. The evaluators provided a whole bank's data, so the demo should show it through Gold marts, one per domain, exported to D1 as reviewed, versioned seeds:
   - **Status (2026-10-01): a narrower cohort is built.** 796 customers with an unrecognized-charge complaint and their recent approved purchases only (ADR-004 §2, DF-020 to DF-022). The other domains below stay out of scope: depth in one workflow over breadth.
   - **Demo cohort.** About 1,000 synthetic customer records, stratified by country, segment and accent, and deliberately including customers with `Cargo no reconocido` complaints. Each one comes with its full history: products, transactions, contacts and transcripts, complaints, surveys, digital activity and campaigns. That's about 155k rows at the measured per-customer averages (29.5 transactions, 104 digital events, 4.6 interactions and so on), well inside D1 Free's 500 MB per database, against 2.86 GB for all of Silver. The binding limit is writes, not storage: the Free plan writes 100,000 rows a day including index writes, so with at least one index write per row this cohort (about 310,000 writes) takes three days or more to load, and the full serving slice needs Workers Paid for that month ([ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md), section 2).
   - **Bank-wide context** travels as precomputed aggregates (for example, how common a merchant or complaint type is), never as per-request scans.
   - **Separation of responsibility.** Each domain gets its own Gold mart module (`data_pipelines/gold/<domain>.py`), its own store and route module in `back-end/src/modules/<domain>/`, and its own UI component in `front-end/src/app/features/<domain>/`. The customer and agent views compose those components, and no component reads another domain's data directly.
   - **Excluded by design:** risk and value fields (`fraud_score`, `is_fraud`, credit score, income), following `data_profiles/fraud_readiness_findings.md` and the context-card rules in #15. Consent, segment and status are shown as current snapshots.
   - **Exit:** the D1 budget and contract tests cover every new route, the manifest reconciles cohort counts to Silver, and the agent case view shows the customer's real context.
3. **Outcome states and case kinds.**
   - **Work:** the retrieval outcome classification; technical and incomplete handoff cases; bounded server retry; the cross-key duplicate rule, enforced by a unique index over open cases.
   - **Exit:** the integration tests cover each outcome and a 10-way concurrent duplicate attempt.
4. **Gold coverage.**
   - **Work:** multi-day, multi-customer slice fixtures that include zero and several matches; `slice_version` and coverage in the API response; filters.
   - **Exit:** the Gold and API tests assert coverage and version end to end.
5. **Human review and display labels.**
   - **Work:** case detail and status history; an agent role gate; currency and time zone labels.
   - **Exit:** the Angular specs and integration tests cover the status transitions, and nothing can set a refund or verdict.
6. **Instrumentation.**
   - **Work:** the API emits the event contract, and scripted ES/PT episodes run end to end against the local Worker.
   - **Exit:** `evals/intake` reports safe accepted intake over all eligible starts, from real service events.
7. **AI, only if justified.**
   - **Work:** if phase 6 shows checklist failures a model would fix, write an ADR covering the model, cost (ADR-004's envelope), data handling and the held-out comparison. The design input is the agent spec (PR #11).
   - **Exit:** the model beats the checklist on held-out cases with no increase in unsafe outcomes. Otherwise it doesn't ship.

## Evaluation boundary

- Complaint wording is not a transaction label, and no historical link between the two exists.
- Intake or handoff is not automated dispute resolution.
- The safety suite covers expired sessions, access violations, injection, bad data and tool failures.
