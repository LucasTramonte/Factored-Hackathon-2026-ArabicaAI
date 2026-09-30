# Review status: `frozen_es_pt_v1`

Last updated 2026-09-30. This page gives aggregates and case IDs only. No message text or fixture detail appears here until the set is published.

## Progress

| Step | Status | Evidence |
|---|---|---|
| Specs, messages and construction gold | Done | `label_rules.py` tests pass; `draft.json` hash in `COMMITMENT.json` |
| Independent verification | Done | Answers agree with construction on 60/60 cases, facts on 58/60; 4 readings just after midnight flagged |
| Portuguese review (Lucas) | Done | 15 questions: 3 flagged + 12 random audit (seed 20260929) |
| Policy decisions | Done: all five rules kept (Lucas, 2026-09-29); Roberto and Manoella can object on PR #21 | Five questions below |
| Spanish review (Lucas, with a translation aid) | Done | 9 questions: 3 flagged + 6 audit |
| Harness for learned systems | Done | `run.py --system/--repetitions/--split/--preregistration`, `systems.py`, `prereg.py`; checklist scores pinned unchanged |
| Publication rehearsal (local) | Done | Hashes verified, 60 cases valid for the runner, manifest drafted; nothing scored |
| Blind builder setup | Done | `make_clean_checkout.py` (14 withheld paths verified absent) and verbatim `extractor-v1-builder-instructions.md` |
| Roberto's native Spanish review | Done (2026-09-30) | The same 9 questions, answered by Roberto himself. `reviews/roberto.jsonl` hash in `COMMITMENT.json`. He is now exposed, so he doesn't build the extractor and reviews its code for non-behavioural aspects only (ADR-006, decision 5) |
| Extractor v1 build and pre-registration | **Pending**: isolated agent, then Roberto's code review and the `extractor-v1` tag | ADR-006 |
| Publish, verify hashes, tag `eval-es-pt-v1` | Pending | |
| Run checklist and extractor v1 once each | Pending | `python -m evals.intake.run --cases ...` |

## Portuguese review result

- **Agreement with construction:** exact on 9 of 15 cases (action and candidate set), and on the action alone for 11 of 15.
- **All 6 differences are cases where construction and the independent verifier agree with each other.** They show how a human read the policy, and none of them is yet shown to be a labelling error.

With all five rules kept, no gold answer changes. **The Portuguese audit found 0 label errors in 12 random cases**, and the exact 95% upper bound on the label error rate is 22.1% (Clopper–Pearson; `evals/intake/stats.py`). The 3 flagged cases keep their gold as well.

## Spanish review result

- **Agreement with construction:** 7 of 9, and 5 of 6 on the random audit.
- **Both differences fall under rules already decided, so gold is unchanged:**
  - one falls under decision 3 (injected instructions alongside a real report);
  - the other under the explicit routing of lost or stolen cards in `POLICY.md`.

  Case details stay out of this page, so that a reviewer who has seen no frozen case can read it and stay unexposed (ADR-006, decision 5).
- **The Spanish audit found 0 label errors in 6 random cases** (upper bound 39.3%).
- **Both audits together: 0 label errors in 18 random cases, with an exact 95% upper bound of 15.3%.**

## Roberto's native Spanish review

Roberto answered the same 9 Spanish questions himself, as a native reader, on 2026-09-30. He saw the same option texts as Lucas and neither gold nor the other answers. The record is `reviews/roberto.jsonl`, and its SHA-256 is in `COMMITMENT.json`.

| | Flagged (3) | Audit (6) | All (9) |
|---|---|---|---|
| Exact agreement with construction | 1 | 2 | 3 |
| Exact agreement with Lucas | 0 | 1 | 1 |

Cohen's kappa on the action is 0.21 against construction and −0.06 against Lucas. Two readers of the same packet agreed with each other less often than either agreed with construction.

All six differences from construction fall under rules that `POLICY.md` already states, so no gold changes. Two fall under policy question 1 below. The other four fall under the sign-in, technical-handoff and clarification rules. Case details stay out of this page, as in the section above.

None of these is shown to be a labelling error, so the audit count stays at 0 label errors in 18 random cases. Roberto's audit answers cover the same 6 Spanish cases Lucas audited, so they add no new cases to that bound.

Roberto differed from the policy on 6 of 9 questions and Lucas on 2 of 9, although the Spanish option texts stated the rule. So at least one native reader does not find these rules obvious, even when they are spelled out. The evaluation still scores systems against the written policy, and the published report will give each reviewer's agreement.

This record supersedes the delegated, AI-assisted record proposed in PR #24. The answers here are Roberto's own.

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

- **Option texts:** the Portuguese questions used short option texts without the rule stated. Five of the six differences involve a rule the text didn't show. The Spanish review used texts that state the rule, for example "only if the customer already confirmed this purchase". The two reviews therefore differ in presentation, and the report says so.
- **Who reviewed the Spanish cases:** Lucas, who is not a native Spanish reader, reviewed them with a Portuguese translation aid written by Claude and shown under each original message. This replaced the planned review by Roberto ("option B"), so that the extractor's author never sees a case. Each record carries `reviewer_note`. On 2026-09-30 Roberto also reviewed the Spanish cases himself (section above). The extractor is built by an isolated agent (ADR-006), so his exposure doesn't affect the blind build.
- **Where the review ran:** the Portuguese review began in the Codex session and was finished in Claude Code after the Codex credits ran out. Each record says which tool wrote it (`recorded_by`), and the questions and option order are unchanged, taken from `queues.json`.
- **Codex isolation exception:** the drafting session read `.codex/agents/hackathon-context.toml`, which is repository startup configuration with no cases and no system code. It recorded this itself. Its model is "GPT-6 (Codex)", and no exact snapshot was exposed.
- **What the reviewer knew:** the Portuguese reviewer had seen summaries of the baseline's documented failure categories, not its rules or cases.
- **Erratum:** `TASK.md` and `DATA_FACTS.md` state DF-013 as "32% of buyers hold more than one credit card". The register now clarifies that the share is conditional on holding that card type. The fixture only uses the fact to give two customers two credit cards, so no case changes.
