# Reading guide

**Workflow:** transaction-dispute intake, narrowed to unrecognized card charges with a human handoff ([ADR-002](ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md)). A read-only recent-transactions view is the normal-resolution path, recorded in [ADR-009](ADRs/ADR-009-recent-charges-resolution.md) and live since v0.2.0. The data is the supplied synthetic LATAM dataset, so descriptive counts are not measured bank outcomes.

For the whole story in one narrative, read [`SYSTEM_DESIGN.md`](deliverables/SYSTEM_DESIGN.md) first. The sections below follow the six points of "What your solution should demonstrate" in the problem statement ([`sources/`](sources/README.md)).

| # | Brief asks for | Read |
|---|---|---|
| 1 | A problem supported by data | [ADR-001](ADRs/ADR-001-workflow-prioritization.md) compares the four official workflows with measured demand. [ADR-002](ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md) records the choice and its limits. [`BUSINESS_OUTCOMES.md`](deliverables/BUSINESS_OUTCOMES.md) sizes the problem, and the [findings register](deliverables/DATA_ENGINEERING.md#10-findings-register) lists every finding that changes a decision, each with its query |
| 2 | A functioning AI system | [Customer and measurement contract](intake/customer-and-measurement-contract.md), [ADR-006](ADRs/ADR-006-learned-extractor-workers-ai.md) (the model extracts facts, the policy decides), [`back-end/README.md`](../back-end/README.md) |
| 3 | Controlled automation | [ADR-002](ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md) decisions 1–3, [ADR-007](ADRs/ADR-007-customer-identity-cognito-email-otp.md) (Cognito sign-in, roles from groups), the [event contract](intake/intake-events.md), and the adversarial test matrix in [`AGENTS.md`](../AGENTS.md) |
| 4 | Sound data and ML practice | **[`DATA_ENGINEERING.md`](deliverables/DATA_ENGINEERING.md)**: contracts, quality gate, lineage, the update and freshness policy with its labelled test fixture, and the stack. Then **[`EVALUATION.md`](deliverables/EVALUATION.md)**: the test sets we built, leakage prevention, and every option considered. The protocol is [ADR-005](ADRs/ADR-005-evaluation-data-protocol.md). The new-data rehearsal is in `Docs/Evidence/new-data-rehearsal.md` |
| 5 | Measured quality and failure handling | [`EVALUATION.md`](deliverables/EVALUATION.md) (sections 1, 6 and 8), [`evals/intake/`](../evals/intake/README.md), the held-out and safety cases in [`intake/heldout-and-safety-cases.md`](intake/heldout-and-safety-cases.md), and the extractor's [development log](../intake_agent/extractor/DEV_LOG.md) |
| 6 | A credible route to operation | [ADR-003](ADRs/ADR-003-intake-single-runtime-worker-d1.md) (runtime) and **[ADR-004](ADRs/ADR-004-intake-capacity-and-cost.md): capacity, cost, where each layer runs, and the AWS production target** ([calculator estimate](https://calculator.aws/#/estimate?id=2c6fd3cd749c39840166f0e274fd6813501f5f7e), $86.36 a month). Operations: the [runbook](Plans/intake-demo.md) and the [roadmap](Plans/intake-roadmap.md) |

## Where things live

| Folder | Holds |
|---|---|
| [`deliverables/`](deliverables/) | The four documents the brief asks for: system design, business outcomes, data engineering (with the findings register and reproduction) and evaluation |
| [`releases/`](releases/README.md) | Release history: each version's PRs, decisions, evidence and deployed state |
| [`ADRs/`](ADRs/README.md) | Decisions: scope, runtime, cost and placement, evaluation, identity, alerts, sessions, messages, AI suggestions and support assistants. Start here |
| [`Costs/`](Costs/README.md) | Evidence cited by ADR-004 only: the calculator export and the Cloudflare workbook |
| [`intake/`](intake/) | The workflow's contracts: customer and measurement contract, events, authored scenarios |
| [`Plans/`](Plans/) | Runbooks (demo, auth, observability), the roadmap and plans |
| [`Evidence/`](Evidence/) | The accessibility audit and its screenshots, the contrast script, and the architecture diagrams (`diagrams/`, with the editable Excalidraw source) |
| [`archive/`](archive/) | Dated working notes kept as history, not current guidance: early design specs and plans, agent handoffs, the 2026-09-26 team review, the first architecture note, the requirements map, the checkpoint brief, and the Marketing/Product material from before V1 was chosen |
| [`sources/`](sources/README.md) | The organizers' original documents |

The challenge inputs sit at the top of this folder: the data dictionary ([`LATAM_BANK_DATA_DICTIONARY.md`](LATAM_BANK_DATA_DICTIONARY.md)), the dataset overview ([`LATAM_BANK_DATASET.md`](LATAM_BANK_DATASET.md)) and the problem statement ([`FACTORED_HACKATHON_2026.md`](FACTORED_HACKATHON_2026.md)), all transcribed from the originals in `sources/`.
