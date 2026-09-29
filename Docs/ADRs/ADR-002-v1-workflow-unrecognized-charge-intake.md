# ADR-002 — V1 workflow: unrecognized-charge intake with human handoff

- **Status:** Proposed — reviewers are asked to accept it in the intake PR
- **Date:** 2026-09-29
- **Deciders:** Lucas Tramonte, Roberto Z, Manoella R
- **Related:** [ADR-001](ADR-001-workflow-prioritization.md) (recommended a read-only inquiry as the primary path; this record narrows V1 to intake)

## Context

ADR-001 compared three candidate workflows and left the choice open. Since 2026-09-27 the team has been building one of them: an authenticated customer reports a card charge they don't recognize, confirms which transaction they mean, and gets a reference for human review. The working agreement is in the [customer and measurement contract v0.2](../intake/customer-and-measurement-contract.md), the agent design in PR #11 builds on it, and the evaluation harness in `evals/intake/` scores against it. What's missing is a written decision, so the README and `AGENTS.md` still call the workflow a hypothesis.

The data supports the choice and also limits what we can claim from it:

- 12,297 of 67,095 complaints are `Cargo no reconocido`. That is the largest subcategory, but only just: `Cobro indebido` has 12,194 and the distribution is nearly uniform, so the count shows the need exists but doesn't show that this need dominates. 2025 alone had 4,118 (p50 11, p95 17 per day).
- No complaint links to a transaction, so we can't say which charges customers actually disputed.
- Transcripts contain only two balance-inquiry openers, so real dispute phrasing has to be authored.
- No Portuguese-speaking customers exist, so Portuguese cases are synthetic.

## Decision

1. **V1 is intake with human handoff, not dispute resolution.** The service locates the customer's own transaction, asks them to confirm it, collects their statement and returns a reference once the case is stored. A human decides the outcome.
2. **The MVP is deterministic.** Identity comes from the session, retrieval is customer-scoped, there is an explicit confirmation step and an idempotent case write, and a checklist handles the conversation. No language model is called. A model is added only when the held-out and safety evaluation shows a failure the checklist can't fix, and that addition needs its own ADR covering cost, data handling and measured quality.
3. **Out of scope:** refunds, reversals, card blocks, fraud verdicts, recognized billing disputes, account inquiries and unsupported languages. Out-of-scope requests are routed with an explicit message.
4. **Primary measure:** safe accepted intake over all eligible starts, as defined in the contract. Failures, abandonment and pending episodes stay in the denominator. A handoff never counts as an automated resolution.

## Consequences

- **+** One workflow for everyone to build, test and present. The contract, the eval harness (#16), the agent spec (#11) and the demo all point at the same thing.
- **+** A deterministic MVP gives a baseline that any later AI has to beat on the same cases.
- **+** The safety boundary is easy to explain: nothing moves money, and a person decides.
- **−** The brief's "safe automated resolution" has no V1 numerator. Cost per successful automated resolution is reported as `not defined`.
- **−** Portuguese results show the system can handle Portuguese, not that there is Portuguese demand.
- **−** Without complaint-to-transaction links, we can't estimate the business value of faster intake from this data.

## Alternatives considered

- **Read-only account inquiry as the primary path (ADR-001's recommendation).** It gives a real automated-resolution numerator, but inquiry intents aren't labelled in the data and the team has no fixtures or harness for them. Rejected for V1. Reopen it if the team wants a second workflow after 2026-10-15.
- **Fraud triage.** `fraud_score` is tied to the label and there is no decision-time label (see `data_profiles/fraud_readiness_findings.md`). Rejected. Reopen it if the data gains a fraud signal available at conversation time that isn't derived from the label, or a decision-time label with outcomes such as confirmed fraud or recovered amounts, plus an agreed false-positive cost.
- **AI-first intake.** Without a deterministic baseline, a model's benefit can't be measured, and the cost and data-handling questions come first. Rejected for the MVP. Reopen it when the evaluation shows a checklist failure a model would fix.

## Implementation notes

- The live demo implements decisions 1–2. Its runtime is [ADR-003](ADR-003-intake-single-runtime-worker-d1.md) and its sizing is [ADR-004](ADR-004-intake-capacity-and-cost.md).
- The authored ES/PT scenarios are in `Docs/intake/v1_scenarios.md` (PR #9), and the held-out and safety splits are in `evals/intake/cases.json` (PR #16).
