# Suspicious-charge intake: customer and measurement contract

Version 0.1 • 26 September 2026 • Roberto's initial evaluation proposal

## Decision and intended customers

Primary users are authenticated existing bank customers who report a transaction they do not recognize and want the bank to review it through the web experience. The receiving service agent is a secondary user. Inclusion is defined by the customer need and authorized transaction ownership, not by age, nationality, fraud labels, customer value or a demographic risk score. Spanish and Portuguese are required evaluation languages; source transcripts alone do not supply Portuguese coverage.

The initial slice locates the customer's transaction, confirms which record is intended, collects the customer's account of the issue, and prepares evidence for human review. A matching transaction does not establish fraud. No card blocking, refund, money movement or fraud determination is permitted. General complaints, recognized billing disagreements, account inquiries and unsupported languages are outside this first slice and need explicit routing. These boundaries are a proposal for team acceptance, not a claim that production eligibility policy exists.

## Complete intake and safe outcomes

A complete intake requires authenticated customer context; an unrecognized-charge request; exactly one customer-confirmed transaction; source-backed transaction ID, date, original amount/currency and merchant where available; the customer's original statement; explicit human-review request; and a traceable case ID. Missing merchant is reported as missing, never invented. Ambiguous/no matches require clarification; no transaction may be selected by arbitrary ordering. Multiple candidates must not be called confirmed. Tool failure produces a technical handoff with missing evidence, not a completed intake. Unauthenticated requests stop before querying data.

The offline baseline models confirmation as an explicit transaction ID supplied in a subsequent test turn; it validates that ID against the same authenticated customer's matching records. A singleton match alone asks for confirmation. Customer identity is a trusted harness input representing an upstream authenticated session, never extracted from message text. This is not an authentication implementation.

## KPI dictionary

One evaluation case is a scripted decision point in a conversation; all cases have authored expected actions, pending independent human review. Completion cases include an explicit confirmation turn. A future episode-level evaluation must count one entire conversation once; do not mix these decision-point rates with episode completion rates.

| Metric | Numerator / denominator | Use and caveat |
|---|---|---|
| Safe complete intake rate (episode primary) | Entire in-scope episodes ending with all required verified evidence and safe handoff / all in-scope episodes attempted, including failures and abandonment | Primary product KPI. Not measurable from historical FCR or this single-turn harness. |
| Safe completion on completion-ready cases | Safe, correct, complete handoffs / gold completion-ready test cases | Initial component proxy only; includes wrong/failed responses in denominator. |
| Correct next action | Cases whose action and required candidate set match the gold expectation / all decision-point cases | Initial baseline comparator; clarification can be correct without completing intake. |
| Unsafe outcome rate | Cases exposing another customer's evidence, inventing candidates, using prohibited actions, or handing off an unconfirmed match as complete / all attempted cases | Hard release gate: zero observed unsafe cases; zero on a small fixture does not prove production safety. |
| Missed required handoff | Gold handoff cases without the required handoff / gold handoff cases | Separately distinguishes complete handoff and technical/incomplete handoff. |
| Unnecessary handoff | Handoff responses on gold cases requiring authentication, routing or clarification / all such gold cases | Denominator is cases that do not require a handoff, not all traffic. |
| Latency | p50/p95 elapsed wall time per attempted baseline decision | Local CPU + fixture lookup only, not network/model/end-user latency. |
| Cost | Actual attributable tool/model charges / attempts, and / safe completed episodes | Not measured in this local baseline. Do not report zero total operating cost. |

Report counts, denominators and unknowns, overall and by language. Empty denominators are undefined, never zero. Diagnostic slot and retrieval correctness can explain failures; they must not replace the primary outcome. No arbitrary performance target is set before a reviewed baseline. Security invariants are gates, not tunable targets.

## Baselines and iteration

B0: safe handoff-only reference. It passes identity checks and routes recognized intake requests to incomplete human review without claiming retrieval/completion.

B1: deterministic checklist. Rules recognize a small documented Spanish/Portuguese phrase set and exact ISO date, explicit currency and decimal amount; customer-scoped lookup then asks for clarification or confirmation, or packages a confirmed record. Relative dates, implied currencies, grouping separators and unsupported phrasings are intentionally not guessed. This is a transparent initial floor for a learned extractor, not a complete language implementation.

Development fixtures can drive rule improvements. The scenario-disjoint evaluation split is an authored regression suite, not a blinded holdout. Safety-review fixes were applied after the first scoring; subsequent results reuse that suite. A separately authored unseen set is required before a learned-system comparison. Cases are authored synthetic evaluation fixtures, not observed customer conversations or a representative prevalence sample. Record scenario families, language, split, source/version, case-level predictions and code/corpus hashes. Human review by Andrés/Lucas remains required before treating these authored expectations as accepted gold labels.

## Sources and reconciled decisions

- Updated Notion 26/09 Daily Update: https://app.notion.com/p/26-09-Daily-Update-3e7bc7846f3c80d4bed1ed416729782e
- Lucas's attached “Architecture decision — suspicious charge intake” PDF, read 26 September: authenticated identity, intent/slots, customer-scoped lookup, clarification, structured handoff, excluded fraud fields.
- Latest user-provided team direction assigns Roberto customer refinement, KPI recommendations and initial baselines, superseding the PDF's older baseline-owner assignment.
- The PDF diagram sends 1/N matches to handoff, but its explicit requirement demands disambiguation. This contract requires confirmation and clarification for N matches.
- PDF exchange-rate fallback is deferred: Lucas's subsequent Notion comment reports material conversion discrepancies. Original amount/currency suffice for intake; no FX conversion is necessary.
- `Cargo no reconocido` and `Cobro indebido` are complaint subcategories, not validated fraud labels or proof of a common intent. Suspicious-charge intake excludes recognized billing disputes in this first slice.
- Prior reviewed exploration: `reports/2026-09-26/team-meeting-brief.md`. Counts support prioritization, not a loss, savings or causal benefit claim.

## Measurement implementation handoff

Roberto maintains the metric definitions and baseline report; proposed review partners are Lucas for evaluation decisions, Andrés for language/intent gold labels, and Manoella for authenticated tools and event contracts. Review at each model/rule release and at the daily team checkpoint; ownership remains subject to team confirmation.

Before reporting the episode primary KPI, emit versioned events `intake_started`, `clarification_requested`, `transaction_confirmed`, `handoff_created`, `handoff_accepted`, and `intake_ended`. Retain one stable case_id, event timestamp, authenticated-session reference, language, scenario/eligibility classification, rule/model version, tool-call status and evidence record references. Log actual model/tool usage for cost and monotonic request durations for latency. Keep customer identifiers and original statements in access-controlled case storage, not analytics exports. Event names are a proposed instrumentation contract; the offline harness does not implement a live event service.

Close the episode once, with completed, abandoned, unsupported, authentication_failed or technical_failure plus explicit completeness/safety checks. Deduplicate retries by case_id + event type + attempt ID. An otherwise in-scope episode abandoned after intake starts or ending in technical failure remains in the primary denominator. Unsupported and unauthenticated arrivals are excluded from that intake denominator but retained in all-attempt safety and routing metrics. Evaluate required handoff against independently reviewed expected behavior, not model self-reports. A successful handoff requires a durable case/receipt from the receiving tool; generated JSON alone is not production acceptance.

Report language-specific counts before pooling. Inspect failures rather than optimizing a single average; do not choose new thresholds from the evaluation regression set. Define operating targets only after the team reviews baseline coverage and the service can measure real latency, cost and episode outcomes.
