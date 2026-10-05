# ADR-010 — Report reasons and the help entry

- **Status:** Proposed
- **Date:** 2026-10-03
- **Deciders:** Lucas Tramonte, Roberto Z, Manoella R

## Context

A guided report starts with a free-text statement ("Describe lo que pasó", 10 to 2,000 characters). Everything the customer knows about *why* they don't recognise the charge is buried in that text: the agent reads a sentence instead of seeing a category, the service cannot treat a lost card differently from a disputed subscription, and the fastest report still requires typing. The feedback from Factored asked for speed and for no long questionnaires.

Our data cannot say why customers don't recognise charges. `fact_complaints.subcategory` has five values and only `Cargo no reconocido` is ours; the description is one template per subcategory (DF-001); dispute outcomes are templates with no transaction link (DF-025). What the data does support is the amount-tier urgency policy (DF-024, `back-end/src/config/urgency.json`).

The only way into a report today is the button on a charge row. A customer who sees a charge on their statement that is not in the served list (the newest 20), or who has reported every listed charge, has nothing to press.

## Decision

1. **Every guided report carries one `reason`** from a closed list of seven: `not_mine`, `duplicate`, `wrong_amount`, `cancelled_or_not_received`, `subscription`, `card_lost_or_stolen`, `other`. The customer picks it with one tap; `not_mine` is offered first. `POST /intake/start` requires it, and it is part of the start's idempotency hash, so a replay with a different reason is a conflict.
2. **Picking a reason prefills an editable one-line statement** in the report language, so a complete report needs no typing: tap, send, choose the charge, confirm. The exception is `other`, which fills nothing and asks for the customer's own words, because a generic sentence would tell the agent nothing. Changing the report language rewrites a sentence a chip wrote, never the customer's own words. The 10 to 2,000 character rule is unchanged.
3. **`card_lost_or_stolen` is handled at once and raised in urgency.** The guide shows the "call your bank" words immediately, and the handoff is `high` whatever the amount and whatever its kind: a confirmed charge, an incomplete handoff from the "?" entry, or a technical one. So the receipt always carries the demo number and the report heads the agent queue. `config/urgency.json` gains `high_reasons`, an addition to DF-024's amount tiers, which still rank only confirmed charges. Choosing another reason takes the "call your bank" line back. Nothing blocks a card (ADR-002).
4. **The reason is stored on the episode and shown to agents** (queue chip and detail row). It is not an event field, so the v2 event contract, the export and the scorer are unchanged. Migration 0016 gave every older episode `reason = 'not_mine'` by default, which a customer never chose, so migration 0017 adds the provenance flag `reason_source` (`customer` or `not_recorded`, default `not_recorded`). Agents see the reason only when its source is `customer`, and "Not recorded" otherwise; the stored value is kept. Reports created between the deploy of 0016 and the deploy of 0017 also read "Not recorded": that understates, and never invents, the customer's choice.
5. **A "?" help entry opens the same guided chat without a preselected charge.** It is always visible, a deliberate superset of the ask ("when every charge is reported"), because a charge missing from the list is the same problem whether or not the listed ones are reported. It greets the customer by first name (no name when none is known, never the customer id) and asks for the merchant, amount and approximate date. A charge that is not in the list can only end as an incomplete handoff reviewed by a person; a charge the customer does find is confirmed through the same ownership check as today. No server change.
6. **The reasons are authored.** They follow the segmentation Nubank's app applies to a disputed card purchase (first "did you make this purchase?", then not recognised, charged twice, a different amount, cancelled or not received, a subscription that keeps charging, card lost or stolen). They are a product hypothesis to re-cut when real statements exist.

## Consequences

- **+** A report takes four taps and no typing; the agent sees the kind of problem at a glance; a compromised card is prioritised by a stated rule.
- **+** Customers without a listed charge have a way in that can never resolve anything automatically.
- **−** The reason distribution in real traffic is unknown; the seven options may not fit it.
- **−** One more required field on `POST /intake/start` (every client body changes) and one additive migration (0016), which must be applied to remote D1 before the code deploys.
- **−** Urgency is now policy from two sources, amount and reason; both are stated, neither is learned.

## Alternatives considered

- **A free-text reason classifier.** Rejected: the MVP calls no model online (ADR-002; ADR-006 keeps the extractor offline). Reopen when the extractor is on and evaluated.
- **Ask the reason after the charge is chosen.** Rejected: the statement comes first today and the prefill needs the reason; moving the statement after the charge is a bigger change for the same outcome. Reopen if the statement moves after the charge and the prefill can still follow the reason.
- **More than seven options, or sub-reasons.** Rejected: the feedback asked for no long questionnaires; `other` catches the rest. Reopen if real statements show `other` is a large share of reports, or that one reason hides two different problems.
- **A help menu with several options (status of a report, something else).** Rejected: the ask is one action; the reports list already shows status. Reopen if evaluators ask for it.

## Implementation notes

- **The "?" entry's choose step (2026-10-05).** Evaluators found that, from "I have a problem with a charge", the choose step listed every charge with a "Confirm this charge" button that did nothing until a charge and the confirmation box were ticked. The guided chat opened from this entry now lists no charges and has no confirm button: after the statement, the guide says to press "Report" on the charge if it is in the list, and offers only "I can't find the charge". Pressing a row's "Report" while that chat is open switches it to the usual choose step with that charge selected, on the same episode, so decision 5 still holds: a charge the customer finds is confirmed through the same ownership check, and one that is not in the list ends as an incomplete handoff. Client only (`customer.page.html`, `customer.page.ts`, `chatChooseGeneral` in `lang.service.ts`); no server change.
