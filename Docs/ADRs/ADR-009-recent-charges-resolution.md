# ADR-009 — Recent charges as the normal resolution path

- **Status:** Proposed
- **Date:** 2026-10-02
- **Deciders:** Lucas Tramonte, Roberto Z, Manoella R

## Context

The problem statement (p. 3) asks for "a normal resolution path, an ambiguous or unsupported request, and a case requiring human intervention". It defines safe automated resolution (pp. 5–6) as an eligible case that "reaches the correct, policy-compliant outcome without human intervention", reported over **all in-scope test cases** with the share where automation was attempted, and cost per successful automated resolution as "not defined" when there are none. Under [ADR-002](ADR-002-v1-workflow-unrecognized-charge-intake.md), every report ends in a human handoff, and a handoff never counts as a resolution, so V1 has no numerator. ADR-002 names "a bounded recent-transactions view that reuses the customer-scoped transaction read, measured separately from intake" as the candidate, and says it needs its own record. The scope, coverage and measurement proposal is [`Docs/Plans/recent-transactions-resolution-decision.md`](../Plans/recent-transactions-resolution-decision.md). This record decides the questions that proposal left open.

Two facts shape the measurement:
- `GET /transactions` returns the session customer's newest charges (20, with `has_more` and `coverage`). It already exists and has been tested for isolation. A `200` proves the rows were served, not that they were shown.
- The client loads the charges on every sign-in and resume, so a live load is a page view, not a customer asking for their charges.

## Decision

1. **Scope** is the draft's, read-only, in `es`, `pt` and `en` ([ADR-008](ADR-008-english-report-language.md)). Nothing refunds, disputes, blocks or decides.
2. **A view is recorded and acknowledged.** `GET /transactions?lang=es|pt|en` records one row in `charge_views` (migration 0015: what was served, its row count, `has_more` and coverage) and returns its random `view_ref`. Without `lang`, nothing is recorded and `view_ref` is `null`. After the rows render, the client sends `POST /transactions/displayed {view_ref}`. That request is bound to the session customer and idempotent: a replay keeps the first `displayed_at`, and another customer's acknowledgement matches nothing (404). Agents build both sides.
3. **A separate stream and scorer.** `charge_views` is the inquiry stream. `evals/inquiry/score.py` scores it, and it is never mixed with intake episodes or their KPIs.
4. **A first page with `has_more = true` counts** when its coverage is declared.
5. **Population.** The in-scope cases are the authored inquiry cases: each one is an explicit request run against local D1 (ES, PT, EN × normal, empty and `has_more`, plus expired session, cross-customer acknowledgement and tool failure). Only those cases feed safe automated resolution and the attempted share. Live views are page loads, reported only as descriptive counts and display rates. All inquiry figures are provisional while this record is Proposed.
6. **Success and unsafe.** An in-scope case is a safe automated resolution when a view was recorded and acknowledged as displayed, its coverage was declared and nothing unsafe happened. A case is **unsafe** if any row of another customer was served or acknowledged, or if a view was recorded or acknowledged without a live customer session. Cost per success is the ADR-004 cost per attempt × attempts ÷ successes, and it is "not defined" at zero successes.

## Consequences

- **+** The challenge's normal path gets a numerator that counts neither handoffs nor raw retrievals.
- **+** It reuses the tested customer-scoped read. It adds no data source and no money movement.
- **−** `GET /transactions` now writes one row, which raises the rows written per episode (ADR-004 is updated with the new figures).
- **−** The numerator comes from authored cases, not from real customers asking. Live traffic only shows that pages were displayed.
- **−** An acknowledgement proves the client rendered the rows, not that the customer read them.

## Alternatives considered

- **Count every live page load as a resolution.** Rejected: the client loads charges on sign-in, so this would count logins as resolved inquiries. Reopen if the client adds an explicit "show my charges" request.
- **Bind the acknowledgement to the session as well as the customer.** Rejected: the random `view_ref` plus the customer already stop cross-customer acknowledgement, and a session column adds state without a measured need. Reopen if per-session display rates are needed.
- **An export script for `charge_views`.** Rejected at demo volume: one read-only `wrangler d1 execute` query gives the live counts. Reopen when views go beyond one D1 page.
