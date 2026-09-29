# Team review: suspicious-charge intake

Prepared for Roberto, Lucas and Andrés • 26 September 2026 • Pending team review

This package asks the team to accept or revise the [customer and measurement contract](customer-and-measurement-contract.md) and adjudicate new test cases. It records no approval on anyone's behalf. Proposed reviewer roles below are not assigned commitments.

## Decisions to record

| Decision | Proposed answer | Reviewer / decision |
|---|---|---|
| Intended customer | Authenticated existing customer reporting an unrecognized transaction through the web experience; receiving agent is secondary. No demographic eligibility filter. | Pending |
| Intent boundary | Recognized billing disputes, receipts and general inquiries route elsewhere. A customer correction withdrawing the claim overrides an earlier intake phrase. | Pending |
| Completion | One explicitly confirmed, owned transaction plus source evidence, original statement, case ID and human-review request. Singleton retrieval alone is not confirmation. | Pending |
| Missing evidence | Missing merchant can be disclosed as unavailable; missing core transaction evidence prevents completion. Failed retrieval requires technical handoff. | Pending |
| Allowed action | Human review only, even if the user requests a refund, card block or fraud determination. No other customer's data may be returned. | Pending |
| Primary KPI | Safe accepted intake (contract v0.2): eligible episodes with an owned transaction, verified evidence, current confirmation, approved draft, durable receipt and assessed safety / all eligible episodes started, including failures, abandonment, withdrawal and pending. Decision-point accuracy is a component measure. | Pending |
| Evaluation acceptance | Independently reviewed ES/PT labels, frozen versions, safety failures examined individually and a separately authored unseen set before claims of generalization. | Pending |

Lucas can review scope and evaluation decisions; Andrés can review language and intent labels; Roberto can incorporate adjudicated definitions. Confirm these roles with the team.

## Candidate cases to review

[review-candidates.json](../../evals/intake/review-candidates.json) contains **24 new messages in 12 paired ES/PT scenario families**, three fictitious transaction records, proposed actions and rationales, and blank reviewer fields. The baseline remains at commit `7df68898839ed50228d010f83c66a5c929cc0e23`. These cases have not been scored.

The same assistant authored these cases with knowledge of the implementation and earlier cases. They are fresh candidate coverage, **not an independently authored or blinded holdout**. Some security themes intentionally repeat prior coverage. Translations are correlated, and no production prevalence is implied.

| Family | Proposed next action | Review focus |
|---|---|---|
| narrative_denial | Confirm | Natural denial outside the initial exact phrase vocabulary |
| quoted_intent_negated | Route | Quoted words must not override actual recognized-purchase intent |
| recognition_correction | Route | Latest customer correction withdraws intake |
| currency_prefix | Confirm | Unambiguous currency before amount; broader than initial parser |
| amount_correction | Clarify | Two conflicting amounts |
| untrusted_identity_command | Confirm owned record | Message identity cannot override session identity |
| missing_merchant_confirmed | Complete human handoff | Optional missing merchant explicitly disclosed |
| refund_demand_with_confirmation | Complete human handoff | Prohibited requested operation remains unexecuted |
| session_revoked_after_confirmation | Authenticate | Prior confirmation does not bypass expired authentication |
| merchant_absent_tool_outage | Technical handoff | No source verification during tool failure |
| fractional_amount_ambiguity | Clarify | Ambiguous amount must not be interpreted from a suffix |
| foreign_confirmation_claim | Clarify without evidence | Claimed permission does not establish ownership |

For each language version, review the message, trusted session, fixture rows and proposed gold answer before seeing model predictions. Change incorrect expectations, explain disagreements in `review.notes`, and fill `reviewer`, `reviewed_at` and `status` only after a real human review. Use `accepted`, `revised` or `needs_discussion`; unresolved cases cannot form an accepted benchmark. Record the exact final corpus hash when freezing it. Review paired language versions for equivalent meaning, not just literal translation.

The existing JSON format is compatible with `evals.intake.run.evaluate`, but the default CLI and notebook deliberately continue to use `cases.json`. Nothing automatically promotes these candidates or substitutes them for the reported 24-case evaluation split. Their integrity was checked without calling either baseline; no new performance score is reported.

## Next evaluation iteration

1. Resolve the seven contract decisions and adjudicate candidate labels. Keep baseline code fixed while comparing it to the accepted expectations; record failures rather than silently rewriting gold labels to fit rules.
2. Have a human author an additional ES/PT set from the agreed contract without consulting implementation rules or previous predictions. Keep it out of development and retain provenance. Once scored or used to guide changes, treat it as a regression set on subsequent iterations.
3. Add multi-turn episodes covering initial report → clarification → transaction selection → explicit confirmation → accepted handoff, plus abandonment, revoked authentication and tool failure. The current stateless harness cannot claim to measure those episodes.
4. Compare a learned extractor and both references on the same frozen, reviewed workload. Keep authentication, ownership and allowed-action checks outside the model. Measure actual handoff receipts, service latency and cost only when those integrations exist.

The latest existing [baseline report](../../reports/2026-09-26/intake-baselines/README.md) remains unchanged: checklist 22/24 and handoff reference 4/24 correct next actions on authored regression cases. These candidate labels and proposed decisions do not represent approval from Lucas or Andrés.
