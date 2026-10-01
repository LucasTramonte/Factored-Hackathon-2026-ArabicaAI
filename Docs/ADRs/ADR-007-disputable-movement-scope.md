# ADR-007 — Which movements a customer can dispute in V1

- **Status:** Proposed
- **Date:** 2026-09-30
- **Deciders:** Lucas Tramonte, Roberto Z, Manoella R
- **Related:** [ADR-002](ADR-002-v1-workflow-unrecognized-charge-intake.md) (V1 is intake of unrecognized **card charges**; this record says exactly which movements that covers and how to extend it). It supersedes nothing. A later choice of option 2, 3 or 4 below would partly supersede ADR-002 and needs a new record.

## Context

ADR-002 scopes V1 to "a card charge they don't recognize" but never defines a card charge. In practice the service lists one kind of movement: **approved purchases on a card the customer owns**. The one-day Gold slice selects them, the Gold build (`gold.card_purchases`, branch `feat/serve-gold-tables`) checks them, and D1 `transactions` holds them. Everything else a customer could fail to recognize is invisible to them.

In the design window (business timestamps before 2026-01-01, ADR-005), out of 3,738,506 transactions:

| Movement | Rows | Listed to the customer today |
|---|---|---|
| Approved card purchases | 842,103 (22.5%, DF-008) | **Yes** |
| Approved card withdrawals (ATM) | 180,493 | No |
| Approved card payments | 180,021 | No |
| Pending card purchases | 18,168 | No |
| Reversed / declined card purchases | 9,415 / 46,170 | No |
| Card withdrawals and payments that are pending, reversed or declined | 31,479 | No |
| Movements on accounts, loans, investments and insurance (transfers, withdrawals, deposits, payments, adjustments) | about 2.43 M | No |

Purchases exist only on cards, but every product carries movements a customer might dispute: an ATM withdrawal they didn't make, a transfer out of a savings account, an "adjustment" on a loan that looks like a fee.

What happens to those reports today: the customer can't find the movement in their list, so the guided flow ends in an **incomplete handoff** (`Docs/intake/intake-events.md`). The case still reaches a person with the open question attached, so nothing is lost. But it ends as `routed`, never as safe accepted intake, so it pulls down ADR-002's primary measure.

The data can't tell us which of these customers actually dispute. No complaint links to a transaction (DF-003), and every complaint that cites a product cites another customer's (DF-002). Any priority between movement types is a judgement, not a measurement.

Two constraints apply to any change before submission on 2026-10-05:

- **The frozen evaluation.** The 60 frozen cases were labelled by the current written policy, which matches card purchases (ADR-005, ADR-006). Changing which movements count as candidates before the frozen comparison changes the policy those labels came from.
- **The work sits outside the pipeline.** Widening the filter in Gold is a one-line change. Serving more movements also needs:
  - an additive D1 migration adding movement type and status;
  - API and contract changes, with the adversarial tests AGENTS.md requires;
  - UI changes so a withdrawal or a pending charge reads differently from a purchase;
  - new authored evaluation cases.

## Decision

1. **The V1 disputable movement is an approved purchase on a card the customer owns.** This is what "card charge" in ADR-002 means. Gold, D1 and the evaluation policy use this definition.
2. **Every other movement stays unlisted for the submission.** A report about one ends in an incomplete handoff to a person, as it does today. SYSTEM_DESIGN's risks name this gap.
3. **After the frozen comparison has run, extend in this order:**
   1. **Approved card withdrawals.** They are on the same cards and the same matching applies (amount, date, card), and a customer would naturally call one "a charge on my card".
   2. **Pending card purchases.** "There's a charge I didn't make, still pending" is a natural report. Showing one needs a status the customer can read.
   3. **Movements on other products.** These need their own scope decision, because ownership, wording and the handoff destination differ by product.

   Approved card payments (usually the customer paying their own bill) and declined or reversed movements (no money left the account) stay out unless evidence says otherwise.
4. **Each extension ships as one change across the stack.** Gold builds `gold.card_movements` (type and status at the same grain, with the same ownership, Bronze-uniqueness and exact-value checks), and D1 gains the columns in an additive migration. The API, contract, UI and evaluation cases change together. An extension never reaches the live service before its evaluation cases exist.

## Consequences

- **+** One written definition of what V1 covers, shared by the pipeline, the service and the evaluation.
- **+** The frozen comparison stays valid, and the deadline work stays on what is already scoped.
- **+** The gap is stated with its size and a route to close it, which is the explicit trade-off the brief asks for.
- **−** Customers disputing an ATM withdrawal or a pending charge can't pick it, and those reports count against safe accepted intake.
- **−** The order of the extensions is a judgement. The data can't show which movements customers dispute most.
- **−** Each extension costs a migration, a contract change and new cases, not just a pipeline change.

## Alternatives considered

- **Add approved card withdrawals before submission.** It covers the most natural gap with the same matching logic. Rejected for the submission because it changes the policy behind the frozen labels and needs a migration, a contract change and UI work within five days. Reopen it as the first extension after the frozen comparison (decision 3).
- **Also add pending card purchases before submission.** Rejected for the same reasons, plus the UI must explain an unsettled charge. Reopen it second.
- **List every movement on every product.** It's the broadest coverage, but V1's matching, wording and handoff are designed for cards, and loans or insurance movements need their own owner and destination. Rejected. Reopen it with a scope decision per product family, once complaint data or customer research shows demand.
- **Silently widen Gold and leave D1 and the UI unchanged.** Rejected: rows the service can't explain to the customer don't belong in the serving layer. It would also break `gold.card_purchases`' grain and its checks.

## Implementation notes

- Counts come from aggregate, read-only queries over the full Silver build (quality run `20260929T231714Z`), bounded to the design window. No customer rows were exported.
- `gold.card_purchases` already fails the build if a purchase appears on a product that isn't a card or isn't owned by the buyer. Extending to `gold.card_movements` keeps those checks and adds type and status to the grain.
- SYSTEM_DESIGN's "Risks" section should get one line on this gap when the record is accepted.
