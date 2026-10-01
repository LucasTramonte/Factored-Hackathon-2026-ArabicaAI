# Recent-transactions resolution path: decision proposal

- **Status:** Draft proposal. It is not an ADR, has not been accepted, and has no ADR number.
- **Date:** 2026-09-30
- **Deciders when it is proposed as an ADR:** Lucas Tramonte, Roberto Z, Manoella R
- **Related:** [ADR-001](../ADRs/ADR-001-workflow-prioritization.md), [ADR-002](../ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md), [ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md), [intake events](../intake/intake-events.md), [online completion design](../superpowers/specs/2026-09-29-intake-online-completion-design.md)

This is the scope, coverage and measurement proposal that ADR-002 says the normal resolution path needs before it counts as one. It describes no new implementation and records no team decision.

## Why it is needed

The official sources, as indexed in [`Docs/sources/README.md`](../sources/README.md), set the requirement:

- **Problem statement, p. 3:** the prototype must include "a normal resolution path, an ambiguous or unsupported request, and a case requiring human intervention". The kickoff deck (p. 11) calls the normal case "automated resolution", including "verified account queries", next to clarification or abstention and a structured handoff.
- **Problem statement, pp. 5–6:** safe automated resolution means an eligible case "reaches the correct, policy-compliant outcome without human intervention". It is reported over **all in-scope test cases**, together with the share of cases on which automation was attempted. Containment alone "does not demonstrate that the problem was solved". Cost per successful automated resolution must be reported as "not defined" when there are no successful resolutions.
- **ADR-002 (accepted):** V1 is unrecognized-charge intake with human handoff, and a handoff never counts as automated resolution, so V1 has no resolution numerator. ADR-002 names "a bounded recent-transactions view that reuses the customer-scoped transaction read, measured separately from intake" as the candidate normal path, and says it needs its own ADR.

## Proposed scope

- **What it answers:** an authenticated customer asks to see their recent charges, in Spanish or Portuguese. The service returns the session customer's newest charges through the existing `GET /transactions`: customer-scoped, 20 per page, with `has_more`. It adds no data source, no write and no money movement.
- **Read-only:** nothing refunds, disputes, blocks a card, decides fraud or changes status.
- **Separate from intake:** if the customer spots a charge they don't recognize, that starts a guided intake episode, which ends in a human handoff. The two paths never share a numerator or a denominator.
- **Out of scope:** balances, statements, filters by amount, date or merchant, pages beyond the first unless the deciders add them, other customers' data, and unsupported languages. These are routed with an explicit message, as intake does.

## Coverage

- **Rows:** only what the reviewed Gold slice seeds into D1. That is one business day, allowlisted customers and at most 20 transactions per customer (ADR-003), or the fictitious seed in the demo. `has_more` says when more rows exist than the page shows, and today's response declares `coverage: "fictitious_demo_data_only"`.
- **Amounts:** each row keeps its source amount and currency from Bronze. No FX conversion is applied, and no amounts in different currencies are summed.
- **Timestamps:** Gold rows keep the timezone-free source timestamp (`source_occurred_at`) without conversion. Only the fictitious seed carries zoned `occurred_at` values.
- **Missing fields:** the slice carries no card, category or country fields, so the view can't filter or explain by them.
- **Ownership:** the view relies only on `transactions.customer_id`, which the Gold slice checks against the product owner for every eligible row. In the full Silver build, all 4,425,008 transaction product links match their owner. The source documentation says a small percentage of records may be orphaned for testing (`Docs/LATAM_BANK_DATASET.md`). That is a separate case from an owner mismatch: an orphan points to a product or customer that does not exist. The Gold slice neither keeps nor silently drops such rows: its build fails if any eligible transaction of the selected day has a missing product, a missing customer or a product owned by someone else (`validate_sample` in `data_pipelines/gold/intake_slice.py`), so the served slice contains none. It never uses complaint or digital-event product links. Those show observed Bronze/Silver ownership mismatches, for example DF-002 in [`DATA_QUALITY.md`](../deliverables/DATA_QUALITY.md): every one of the 44,570 complaints with an `affected_product_id` points to another customer's product. These are observed source anomalies. The register labels the random-draw cause "confirmed in Bronze"; this proposal treats the cause as an inference, while the mismatch itself is observed.

## Eligibility and denominator

- **Eligible attempt:** an authenticated demo session (simulated identity, not bank authentication) explicitly asks for recent transactions in ES or PT, identified by one idempotent request key. Unauthenticated, unsupported-language and out-of-scope requests are not eligible attempts. They count separately in the all-attempt routing and authentication safety measures, as for intake.
- **Denominator:** all in-scope test cases, as p. 6 requires. It includes cases where retrieval failed, returned incomplete coverage, or was never acknowledged as displayed.
- **Attempted share:** in-scope cases where the service attempted retrieval, over all in-scope cases.

## Numerator: unavailable until display is acknowledged

A case would count as a safe automated resolution only when all three hold:

1. The retrieval returned only the session customer's rows, with a verified outcome and its coverage and `has_more` declared.
2. The client showed them and sent a **session-bound, idempotent display acknowledgment** for that request. The same live session and request key replay the same result, and a different session is rejected.
3. No unauthorized disclosure or other unsafe outcome occurred.

The acknowledgment belongs to the separately owned frontend and needs a backend endpoint with its own adversarial tests and D1 budget. Neither exists. **Until the frontend implements it and the deciders accept this proposal, the numerator is unavailable.** It is not zero, and it must not be inferred as zero. A successful HTTP retrieval (`200` on `GET /transactions`) proves the rows were served, not that they were displayed, and not that the request was resolved. Retrievals are never counted as resolutions. Even with the acknowledgment, the metric is a declared demo-display outcome, not evidence that a bank resolved anything.

**Cost per successful automated resolution: "not defined"** while the numerator is unavailable, and per p. 6 also whenever it is zero. Cost per attempted case can be reported from ADR-004's per-request figures. On local D1 today, `GET /transactions` costs 1 Worker request, 2 queries and 4 rows read (ceiling 2 / 25 / 0 / 2), measured separately from intake.

## Measurement design, to be decided

- A separate inquiry event stream and scorer, never mixed with intake episodes. For example: request, retrieval (row count, `has_more`, coverage, tool status), display acknowledgment, and end. Events would carry only opaque references, under the same privacy rules as `Docs/intake/intake-events.md`.
- Authored held-out inquiry cases in ES and PT, with normal, empty, `has_more`, expired-session, cross-customer and tool-failure cases. Portuguese cases are synthetic, as for intake.

## Decisions requested

1. Accept, or change, the scope, coverage and eligibility above.
2. The shape of the acknowledgment API, and who builds each side: the frontend belongs to Roberto's separate work, and the backend endpoint would be new work.
3. The inquiry event vocabulary and scorer.
4. Whether a first page with `has_more = true` can count as resolved. The proposal is yes, when the request was for recent charges and the page declares its coverage.
5. Assign an ADR number when the proposal is accepted.

## Consequences if accepted

- **+** The challenge's normal path gets a measurable definition without counting handoffs or retrievals as resolutions.
- **+** It reuses a tested, customer-scoped read, so there is no new data or write path.
- **−** Its numerator stays unavailable until the frontend acknowledgment exists, so the submission may have to report "unavailable" and "not defined".
- **−** Coverage is limited to the reviewed slice and the fictitious seed.
