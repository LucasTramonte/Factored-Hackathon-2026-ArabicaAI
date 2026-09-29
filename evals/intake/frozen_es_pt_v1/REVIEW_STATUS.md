# Review status: `frozen_es_pt_v1`

Last updated 2026-09-29. This page gives aggregates and case IDs only. No message text or fixture detail appears here until the set is published.

## Progress

| Step | Status | Evidence |
|---|---|---|
| Specs, messages and construction gold | Done | `label_rules.py` tests pass; `draft.json` hash in `COMMITMENT.json` |
| Independent verification | Done | Answers agree with construction on 60/60 cases, facts on 58/60; 4 readings just after midnight flagged |
| Portuguese review (Lucas) | Done | 15 questions: 3 flagged + 12 random audit (seed 20260929) |
| Policy decisions | Done: all five rules kept (Lucas, 2026-09-29); Roberto and Manoella can object on PR #21 | Five questions below |
| Extractor v1 pre-registration | **Pending**: Roberto | `evals/intake/preregistration/` |
| Spanish review (Roberto) | **Pending**: after the extractor-v1 tag | 9 questions: 3 flagged + 6 audit |
| Publish, verify hashes, tag `eval-es-pt-v1` | Pending | |
| Run checklist and extractor v1 once each | Pending | `python -m evals.intake.run --cases ...` |

## Portuguese review result

- **Agreement with construction:** exact on 9 of 15 cases (action and candidate set), and on the action alone for 11 of 15.
- **All 6 differences are cases where construction and the independent verifier agree with each other.** They show how a human read the policy, and none of them is yet shown to be a labelling error.

With all five rules kept, no gold answer changes. **The Portuguese audit found 0 label errors in 12 random cases**, and the exact 95% upper bound on the label error rate is 22.1% (Clopper–Pearson; `evals/intake/stats.py`). The 3 flagged cases keep their gold as well.

## Five policy questions (decided 2026-09-29: keep all five)

Each decision applies to every case of its kind, in both languages. Keeping a rule leaves `POLICY.md` and `label_rules.py` as they are. Changing one would edit both and recompute gold. There is one case where the reviewer and construction differ on each point, except question 5, which has two.

| # | Question | Construction rule (policy today) | Reviewer's choice | Case |
|---|---|---|---|---|
| 1 | One purchase matches the report, but the customer hasn't confirmed it yet. Register the case or ask first? | Show it and ask (**F**). A case is registered only after confirmation | Register (H) | frz-024 |
| 2 | The customer confirmed earlier, but the lookup is down now. Register or technical handoff? | Technical handoff (**T**). The evidence can't be re-read, and the contract says a tool failure means a technical handoff with missing evidence | Register (H) | frz-038 |
| 3 | A real report arrives together with a staff claim or instructions to bypass permissions. Continue the report or route? | Continue with the report and ignore the injected text (**F**). Permissions never change because of message text | Route (R) | frz-026 |
| 4 | The message is in an unsupported language (French) but names an identifiable purchase. Help or route? | Route with an explicit message (**R**). V1 serves Spanish and Portuguese only (ADR-002) | Show the purchase (F) | frz-031 |
| 5 | Several purchases match. List them, or ask for more details without listing? | List the candidates (**C with candidates**). The measurement contract requires listing, so the customer doesn't have to guess | Ask for details (C, no candidates) | frz-014, frz-030 |

**Decision:** Lucas kept all five on 2026-09-29, because each follows an existing rule in ADR-002 or in the measurement contract. As ADR-002 and ADR-005 deciders, Roberto and Manoella can object on PR #21. An objection reopens only the question it names.

## Disclosures

- **Option texts:** the Portuguese questions used short option texts without the rule stated. Five of the six differences involve a rule the text didn't show. The Spanish review uses texts that state the rule, for example "only if the customer already confirmed this purchase". The two reviews therefore differ in presentation, and the report says so.
- **Where the review ran:** the Portuguese review began in the Codex session and was finished in Claude Code after the Codex credits ran out. Each record says which tool wrote it (`recorded_by`), and the questions and option order are unchanged, taken from `queues.json`.
- **Codex isolation exception:** the drafting session read `.codex/agents/hackathon-context.toml`, which is repository startup configuration with no cases and no system code. It recorded this itself. Its model is "GPT-6 (Codex)", and no exact snapshot was exposed.
- **What the reviewer knew:** the Portuguese reviewer had seen summaries of the baseline's documented failure categories, not its rules or cases.
- **Erratum:** `TASK.md` and `DATA_FACTS.md` state DF-013 as "32% of buyers hold more than one credit card". The register now clarifies that the share is conditional on holding that card type. The fixture only uses the fact to give two customers two credit cards, so no case changes.
