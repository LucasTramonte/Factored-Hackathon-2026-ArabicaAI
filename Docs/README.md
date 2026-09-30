# Reading guide

**Workflow:** transaction-dispute intake, narrowed to unrecognized card charges with a human handoff ([ADR-002](ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md)). A read-only recent-transactions view is **proposed** as the normal-resolution path; that decision is still a draft. The data is the supplied synthetic LATAM dataset, so descriptive counts are not measured bank outcomes.

The sections follow the six points of "What your solution should demonstrate" in the problem statement ([`sources/`](sources/README.md)).

| # | Brief asks for | Read |
|---|---|---|
| 1 | A problem supported by data | [ADR-001](ADRs/ADR-001-workflow-prioritization.md) compares the four official workflows with measured demand. [ADR-002](ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md) records the choice and its limits. [`DATA_QUALITY.md`](../DATA_QUALITY.md) lists every finding that changes a decision, each with its query |
| 2 | A functioning AI system | [Customer and measurement contract](intake/customer-and-measurement-contract.md), [ADR-006](ADRs/ADR-006-learned-extractor-workers-ai.md) (the model extracts facts, the policy decides), [`back-end/README.md`](../back-end/README.md) |
| 3 | Controlled automation | [ADR-002](ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md) decisions 1–3, the [event contract](intake/intake-events.md), and the adversarial test matrix in [`AGENTS.md`](../AGENTS.md) |
| 4 | Sound data and ML practice | The data pipeline in the [root README](../README.md#data-pipeline-start-here), and **[`EVALUATION.md`](../EVALUATION.md)**: the test sets we built, leakage prevention, and every option considered. The protocol is [ADR-005](ADRs/ADR-005-evaluation-data-protocol.md) |
| 5 | Measured quality and failure handling | [`EVALUATION.md`](../EVALUATION.md) (sections 3, 5 and 7), [`evals/intake/`](../evals/intake/README.md), the held-out and safety cases in [`intake/heldout-and-safety-cases.md`](intake/heldout-and-safety-cases.md), and the extractor's [development log](../intake_agent/extractor/DEV_LOG.md) |
| 6 | A credible route to operation | [ADR-003](ADRs/ADR-003-intake-single-runtime-worker-d1.md) (runtime) and **[ADR-004](ADRs/ADR-004-intake-capacity-and-cost.md): capacity, cost, where each layer runs, and the AWS production target** ([calculator estimate](https://calculator.aws/#/estimate?id=2c6fd3cd749c39840166f0e274fd6813501f5f7e), $86.36 a month). Operations: the [runbook](Plans/intake-demo.md) and the [roadmap](Plans/intake-roadmap.md) |

## Where things live

| Folder | Holds |
|---|---|
| [`ADRs/`](ADRs/README.md) | Decisions: scope, runtime, cost and placement, evaluation, the learned component. Start here |
| [`Costs/`](Costs/README.md) | Evidence cited by ADR-004 only: the calculator export and the Cloudflare workbook |
| [`intake/`](intake/) | The workflow's contracts: customer and measurement contract, events, authored scenarios |
| [`Plans/`](Plans/) | Runbook, roadmap and data plans |
| [`Reviews/`](Reviews/) | Dated review material, such as the 2026-10-01 checkpoint brief for Factored |
| [`superpowers/`](superpowers/) | Detailed design specs and implementation plans behind the ADRs |
| [`sources/`](sources/README.md) | The organizers' original documents |

Data definitions are in [`LATAM_BANK_DATA_DICTIONARY.md`](LATAM_BANK_DATA_DICTIONARY.md) and [`LATAM_BANK_DATASET.md`](LATAM_BANK_DATASET.md).
