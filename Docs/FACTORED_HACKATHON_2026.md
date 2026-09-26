# Factored AI & Data Hackathon 2026

## Problem Statement

Build a working **AI-first customer service system for a real-world
banking environment**.

The solution should:

-   Understand complex customer interactions.
-   Use data and tools securely.
-   Complete appropriate service workflows.
-   Involve human agents when needed.
-   Focus on a coherent customer-service problem.
-   Demonstrate an end-to-end solution.
-   Use the supplied data to explain why the problem matters.
-   Establish a baseline.
-   Measure whether the approach improves service quality and
    operational efficiency.

The solution should be designed with:

-   Privacy.
-   Explainability.
-   Fairness.
-   Reliability.
-   Scalability.
-   Explicit trade-offs across autonomy, accuracy, latency, cost, and
    human oversight.
-   Clear boundaries between AI, deterministic logic, and human
    intervention.
-   Explicit quality and safety evaluation.

## Scope

Deliver a working prototype with evidence of production readiness and an
honest account of the work required before deployment.

The ten-day submission is **not expected to operate a live banking
service**.

Possible focused workflows include:

-   Account or payment inquiries.
-   Card-service support.
-   Transaction-dispute intake.
-   Credit-product information and eligibility support.

These are examples, not separate tracks. Depth, demonstrated behavior,
and engineering judgment determine the assessment; implementing more
workflows does not automatically earn a bonus.

The prototype must include:

1.  A normal resolution path.
2.  An ambiguous or unsupported request.
3.  A case requiring human intervention.
4.  Demonstrations in Spanish and Portuguese.
5.  Reported limitations in the supplied data and language coverage.

## Required Demonstrations

### 1. Problem Supported by Data

Analyze:

-   Contact reasons.
-   Relevant demand patterns.
-   Data quality.
-   Operational constraints.

Use this evidence to:

-   Prioritize the workflow.
-   Define intended customer outcomes.
-   Define intended business outcomes.

### 2. Functioning AI System

The system should:

-   Maintain relevant conversational context.
-   Clarify ambiguity.
-   Ground factual responses in permitted account, transaction, or
    policy information.
-   Use tools when they serve the workflow.
-   Report only actions whose outcomes have been verified.

### 3. Controlled Automation

Define:

-   Which requests the system can answer.
-   Which actions require confirmation.
-   When the system must abstain.
-   When the system must transfer to a human.

Important requirements:

-   Enforce permissions and policy **outside model-generated prose**.
-   Give the human agent:
    -   The customer request.
    -   Verified facts.
    -   Actions taken.
    -   Supporting evidence.
    -   Unresolved questions.

### 4. Sound Data and ML Practice

Build repeatable data preparation with:

-   Data contracts.
-   Quality checks.
-   Data lineage.
-   An update/freshness policy.

Evaluate at least one learned component against an appropriate baseline.

Evaluation must:

-   Use valid labels or relevance judgments.
-   Prevent data leakage.
-   Justify representations.
-   Justify metrics.
-   Justify thresholds.
-   Use appropriate evaluation splits.

### 5. Measured Quality and Failure Handling

Evaluate on held-out cases.

Include:

-   Incorrect or missing data.
-   Expired sessions.
-   Unauthorized access attempts.
-   Prompt injection.
-   Tool failures.
-   Multilingual ambiguity.

Report:

-   Successful outcomes.
-   Unsafe outcomes.
-   Handoff behavior.
-   Latency.
-   Cost.
-   Sample sizes.
-   Limitations.

### 6. Credible Route to Operation

Demonstrate:

-   Tracing.
-   Bounded retries.
-   Safe fallback.
-   Reproducible setup.

Explain:

-   Capacity limits.
-   Monitoring.
-   Access controls.
-   Data retention.
-   Remaining deployment work.

Explanations should be based on:

-   Sources.
-   Policy rules.
-   Execution records.

**Hidden model chain-of-thought is not an audit artifact.**

## Architecture Freedom

The solution may use:

-   Conventional ML.
-   Pretrained language models.
-   Retrieval.
-   Deterministic workflows.
-   Agents.
-   A justified combination of these approaches.

The following are **not mandatory**:

-   Training a new model.
-   Multiple agents.
-   A specific tool count.
-   Streaming.
-   Demand forecasting.
-   A dashboard.

Every team is assessed on data engineering and AI/ML rigor.

For pretrained or retrieval-based solutions, demonstrate rigor through:

-   Component selection.
-   Relevance or intent labels.
-   Representations.
-   Leakage prevention.
-   Held-out evaluation.
-   Error analysis.

A model-training pipeline is only one possible way to provide this
evidence.

### Processing Model

Use batch, incremental, or streaming processing according to:

-   Supplied inputs.
-   Workflow latency requirements.
-   Workflow freshness requirements.

Incremental file delivery does **not** by itself require streaming.

If only static data is supplied, demonstrate update correctness with a
clearly labeled test fixture.

## Data and Execution Boundaries

Use only:

-   Organizer-approved data.
-   Permitted external resources.

Explicitly identify which inputs are:

-   Real.
-   De-identified.
-   Synthetic.
-   Team-generated.

Follow the published data-use terms.

Do not include in public submissions or external model requests:

-   Private customer records.
-   Credentials.
-   Restricted data.

### Sandbox and Mock Banking Services

Sandbox services and mock banking tools are acceptable when their:

-   Contracts are documented.
-   Limitations are documented.

Authentication must be demonstrated with:

-   A trusted test session, or
-   An identity service.

A national ID or customer number alone does **not** prove identity.

Access to customer records and action permissions must be enforced in
the service or tool layer.

### Credit-Related Workflows

For credit workflows, separate:

1.  Conversation handling.
2.  Predictive risk estimates.
3.  Eligibility policy.

Use:

-   Approved rules, or
-   A clearly labeled synthetic policy service

to produce simulated eligibility outcomes.

The conversational model must **not**:

-   Invent eligibility rules.
-   Independently approve credit.

Show:

-   Explanations.
-   Uncertainty.
-   Review paths for missing data.
-   Review paths for borderline cases.

No live lending decisions or movement of money is required or authorized
by the challenge.

## Evaluation Evidence

Compare the baseline and proposed system on the **same held-out
workload**.

Report:

-   Number of cases.
-   Case mix.
-   Label quality.
-   Model versions.
-   Prompt versions.
-   Repeated-run variability, where relevant.
-   Failures.

If a model is used to judge answers:

-   Document its rubric.
-   Validate a sample against human or deterministic judgments.

## Required Outcome Definitions

### Safe Automated Resolution

An eligible case reaches the correct, policy-compliant outcome without
human intervention.

Report:

-   Rate over **all in-scope test cases**.
-   Share of cases on which automation was attempted.

### Containment

A case ends without transfer.

**Important:** containment alone does not demonstrate that the problem
was solved.

### Escalation Quality

Cases requiring escalation are transferred correctly and include useful
handoff context.

Where reference labels permit, report:

-   Missed transfers.
-   Unnecessary transfers.

### Unsafe Outcomes

Report:

-   Unauthorized disclosures.
-   Unauthorized actions.
-   Materially incorrect outcomes.

Always report:

-   Counts.
-   Denominators.

**Zero observed failures in a small test set does not establish zero
risk.**

### Operating Efficiency

Report:

-   End-to-end p50 latency.
-   End-to-end p95 latency.
-   Cost per attempted case.
-   Cost per successful automated resolution.

Also state:

-   Workload.
-   Sample size.
-   Cost assumptions.

Use `not defined` when there are no successful resolutions.

### Language and Customer Segment Analysis

Compare relevant service outcomes by:

-   Language.
-   Authorized customer segments.

State small-sample limitations and investigate disparities.

Clearly distinguish:

-   Offline measurements.
-   Simulations.
-   Projected business savings.

Do **not** describe an offline comparison as a measured production
improvement.
