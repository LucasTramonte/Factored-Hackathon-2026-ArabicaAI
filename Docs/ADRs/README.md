# Architecture decision records

Technical and product-scope decisions for the ArabicaAI hackathon solution. Each record states the context it was made in, the decision, what it costs us, and what we rejected. How to run things lives in the READMEs and `AGENTS.md`; data definitions live in `Docs/LATAM_BANK_DATA_DICTIONARY.md`.

## Index

| ADR | Title | Status |
|---|---|---|
| [001](ADR-001-workflow-prioritization.md) | Prioritize a read-only inquiry workflow for evaluation (comparison of the four official workflows) | Superseded by 002 for the V1 choice |
| [002](ADR-002-v1-workflow-unrecognized-charge-intake.md) | V1 workflow: unrecognized-charge intake with human handoff | Accepted (2026-09-29); 008 proposes to supersede decision 3 for English; 014 proposes to lift "no model" behind a switch |
| [003](ADR-003-intake-single-runtime-worker-d1.md) | Intake runtime: one online API on Cloudflare Workers + D1, Python for batch | Proposed (2026-09-29); decision 5 superseded by 007 |
| [004](ADR-004-intake-capacity-and-cost.md) | Capacity, cost and where each layer runs (the single record for cloud cost and sizing) | Proposed (revised 2026-09-30) |
| [005](ADR-005-evaluation-data-protocol.md) | Evaluation data protocol: design and holdout windows, and a blind frozen set | Proposed (2026-09-29) |
| [006](ADR-006-learned-extractor-workers-ai.md) | Learned component: a fact extractor on Workers AI, smallest model first | Proposed (2026-09-29); amendment 10 puts extractor v2 (Gemini 3.5 Flash-Lite) online |
| [007](ADR-007-customer-identity-cognito-email-otp.md) | Customer identity: Amazon Cognito email one-time codes | Proposed (2026-10-02) |
| [008](ADR-008-english-report-language.md) | English as a report language | Proposed (2026-10-02) |
| [009](ADR-009-recent-charges-resolution.md) | Recent charges as the normal resolution path (view and display acknowledgement) | Proposed (2026-10-02) |
| [010](ADR-010-report-reasons-and-help-entry.md) | Report reasons (one tap, seven authored options) and the "?" help entry | Proposed (2026-10-03) |
| [011](ADR-011-proactive-alert-bank-flag.md) | Proactive alert: the bank's own fraud flag as an input, never the charge amount | Proposed (2026-10-04) |
| [012](ADR-012-ai-online-only-where-evidence-shows.md) | AI online only where the evidence shows the deterministic flow falls short: not yet | Proposed (2026-10-04); amendment 1 turns AI suggestions on in the demo |
| [013](ADR-013-gcp-sso-and-persistent-sessions.md) | Persistent sessions and Google sign-in for staff on GCP | Proposed (2026-10-04) |
| [014](ADR-014-online-ai-suggestions-and-no-fraud-model.md) | Online AI only for "I can't find it" suggestions, off until a pilot; no fraud model | Proposed (2026-10-04) |
| [015](ADR-015-agent-customer-messages.md) | Messages between the reviewing agent and the customer, on one report | Proposed (2026-10-04) |

## Format

File name: `ADR-NNN-kebab-case-title.md`, three-digit number, never reused.

Header, right after the `# ADR-NNN — Title` line:

```
- **Status:** Proposed
- **Date:** YYYY-MM-DD
- **Deciders:** names
- **Supersedes:** ADR-NNN (optional)
```

Sections, in order: **Context** · **Decision** (numbered subsections when there is more than one point) · **Consequences** (`+` and `−` bullets) · **Alternatives considered** (each ends with "Rejected: …" and the condition that would reopen it) · **Implementation notes** (optional).

Status moves `Proposed` → `Accepted` → `Superseded by ADR-NNN` or `Deprecated`. A supersession can be partial; the older record then says which part still stands. Once a record is `Accepted`, its Decision section is not edited. Changing your mind means writing a new record that supersedes it. Implementation notes and links can still be updated.

A record is accepted when the deciders named in its header agree in the pull request that introduces it, or in a follow-up PR that only changes its status.
