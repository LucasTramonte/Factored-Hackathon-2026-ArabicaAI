# Intake roadmap: from the MVP to the target workflow

The target workflow has three stages:

- **Data preparation:** Bronze → Silver → Gold (versioned evidence and coverage).
- **Online service:** validate the session and scope; retrieve permitted candidates with coverage and version; classify the retrieval outcome (matches, none or incomplete, tool error); persist an idempotent case; verify it, then issue a reference; human review.
- **Offline evaluation:** all attempts, not only saved cases.

This page maps each box to what exists and what's next. The decisions behind it are in [ADR-002](../ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md), [ADR-003](../ADRs/ADR-003-intake-single-runtime-worker-d1.md) and [ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md).

## Gap map

| Target box | Today | Gap |
|---|---|---|
| Bronze / Silver / quality | Done, with a quality gate and a bounded one-day sample | — |
| Gold: versioned evidence + coverage | `data_pipelines/gold/` writes a content-versioned D1 seed and a provenance manifest | Multi-day and multi-customer slices with zero, one and several matches. The API doesn't return `slice_version` or coverage yet. |
| Validate session + customer scope | Session-only identity, separate customer and agent actors, expiry, rotation; tested adversarially | Idle expiry, and an agent role gated separately from the team gate |
| Retrieve permitted candidates | The customer's newest 20 charges | Filters (amount, date window, merchant) and coverage/version in the response |
| Classify retrieval outcome | Not present | Explicit one / several / none / incomplete / tool-error states. Never claim a charge doesn't exist. |
| Tool error → bounded retry, safe fallback | Generic 503. The client retries the frozen request with the same key. | A server-side bounded retry, then a technical handoff case |
| Idempotent case + evidence + pending questions | Idempotent per customer and key; 409 on divergence; concurrency-tested | Case kinds (complete, technical, incomplete handoff), pending questions, an evidence snapshot, and a cross-key duplicate rule |
| Verify the saved case, then issue the reference | The reference is returned only after reading the row back | — |
| Human review | Read-only agent queue | Case detail, status history (accepted → in review → closed by a human), no refund or verdict actions |
| ES / PT customer | English UI | ES/PT interface text; explicit currency and timezone labels kept |
| Offline evaluation | Checklist baseline and episode scorer in `evals/intake` | The API emits the event contract (`Docs/intake/intake-events.md`) so episodes are scored over all attempts |

## Phases and exit gates

Each phase is its own PR, with adversarial tests first and a merge only when its exit gate passes.

1. **Deploy and measure (now).**
   - **Work:** push the restructure and update the Workers Builds settings. Run the remote checklist in `back-end/README.md`, then a low-rate remote run to capture CPU and end-to-end p50/p95. Record the AWS Pricing Calculator estimate.
   - **Exit:** ADR-004's implementation notes hold the measured numbers.
2. **Outcome states and case kinds.**
   - **Work:** the retrieval outcome classification; technical and incomplete handoff cases; bounded server retry; the cross-key duplicate rule, enforced by a unique index over open cases.
   - **Exit:** the integration tests cover each outcome and a 10-way concurrent duplicate attempt.
3. **Gold coverage.**
   - **Work:** multi-day, multi-customer slice fixtures that include zero and several matches; `slice_version` and coverage in the API response; filters.
   - **Exit:** the Gold and API tests assert coverage and version end to end.
4. **Human review and ES/PT.**
   - **Work:** case detail and status history; an agent role gate; ES/PT interface text.
   - **Exit:** the Angular specs and integration tests cover the status transitions, and nothing can set a refund or verdict.
5. **Instrumentation.**
   - **Work:** the API emits the event contract, and scripted ES/PT episodes run end to end against the local Worker.
   - **Exit:** `evals/intake` reports safe accepted intake over all eligible starts, from real service events.
6. **AI, only if justified.**
   - **Work:** if phase 5 shows checklist failures a model would fix, write an ADR covering the model, cost (ADR-004's envelope), data handling and the held-out comparison. The design input is the agent spec (PR #11).
   - **Exit:** the model beats the checklist on held-out cases with no increase in unsafe outcomes. Otherwise it doesn't ship.

## Evaluation boundary

- Complaint wording is not a transaction label, and no historical link between the two exists.
- Intake or handoff is not automated dispute resolution.
- The safety suite covers expired sessions, access violations, injection, bad data and tool failures.
