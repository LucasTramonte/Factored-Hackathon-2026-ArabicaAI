# Report support assistant — proposed design

Status: design approved by the user on October 4, 2026. The user approved all six implementation tasks on one branch with one final PR on October 4, 2026. Live model pilot and activation require separate approval.

## Outcome

A customer who asks about a report gets an understandable, accurate next step instead of an unexplained silence. A reviewer can understand the case and compose a helpful answer faster. Human review remains responsible for review decisions. Demonstrations must distinguish an automated explanation, a human reply, and an actual persisted status change.

User requests: clearer waiting states and message experience; a Vertex-backed assistant for customers and reviewers; minimal implementation; sequential scoped PRs managed by a coordinator with small agent briefs.

Assumption for review: the customer assistant initially supports one report's status, process questions and missing details. General banking advice, refunds, card blocking and fraud decisions are outside its scope.

## Alternatives

| Approach | Benefit | Tradeoff |
|---|---|---|
| Recommended: clear messaging + factual status help, reviewer copilot, then bounded customer assistant | Each phase is useful and can be evaluated independently; reuses the existing runtime | Customer free-text automation arrives last |
| Reviewer copilot only | Smallest generative pilot; human checks every answer | Customer still waits for human replies |
| Broad autonomous chatbot for both audiences | More flexible conversation | Larger permission, evaluation and operational scope; weak fit for a one-report workflow |

## Existing building blocks and constraints

- Angular customer and agent pages share `message-thread.component.ts`; customer polling already detects new human replies.
- `handoff_messages` stores at most 50 messages per report, each up to 2,000 code points. Its author CHECK accepts only customer and agent. Closed threads are read-only.
- The only online runtime is the Worker; SQL stays in `back-end/src/store/d1.js`.
- `vertex-auth.js` provides workload identity federation. Existing `ai-transport.js` is a versioned, evaluated extractor, not a generic chat client. Reuse authentication and compatible endpoint construction without changing its prompt, schema, retry behavior or frozen evaluation.
- ADR-012 and ADR-015 do not approve customer-facing generated responses or reviewer drafts. A separate decision record must define these new scopes, permitted input data and evaluation gates before activation.
- Current model choice is a candidate only. Verify availability and suitability at implementation time; extraction results do not establish conversation quality.

## Phase 1: honest messaging and immediate factual help

1. Show one report header and one progress indicator when its thread is expanded; remove the duplicate status block in the screenshot.
2. Label the human thread “Messages with the review team,” localized in ES/PT/EN. After confirmed persistence, say the message was saved and is awaiting a team reply. Show a retry state on failure; never acknowledge an unsaved message.
3. Derive the waiting state from message order and report state: last customer message means waiting for the team; a subsequent agent message means a reply arrived; closed reports show the closing explanation and existing follow-up action. Do not invent a response-time promise.
4. Add a “Check report status” action that reads the owned report and displays its actual status, recorded receipt time (`received_at`), time of this check (`checked_at`) and permitted next step; explicitly state that the last status-update time is unavailable in the selected language. This path calls no model. Label it as an automatic status explanation, not a human message.
5. Reuse the existing refresh and reply-notice behavior. Preserve failed-refresh and stale-data notices, keyboard focus, mobile containment and screen-reader announcements.

Acceptance: customer posts → persisted waiting state → reviewer posts → reply appears in the customer thread → human closes with explanation → customer sees that explanation. Also verify reload, network failure and session change. The status action never writes to the report lifecycle.

## Phase 2: reviewer copilot

Add an explicit “Prepare reply” action in the existing agent detail. One bounded Vertex call produces a short summary, missing-information checklist and editable reply draft. A reviewer must inspect/edit and press the existing Send button. Generation does not send a message, change report state or make a banking decision.

The Worker authenticates the agent and loads the approved report itself. The request cannot supply another customer's identity or arbitrary model tools. Model context is limited to the selected report's relevant statement, details, bounded conversation and current review facts; omit credentials, email addresses, raw customer IDs and unrelated history. Free text may itself contain personal information, so the new ADR must explicitly approve this expanded data flow for synthetic-demo use; it is not authorization for real bank data.

The response is structured and bounded; display plain text. Persisted human messages continue through the current idempotent message route. Drafts are transient, disappear on report/session change, and are never presented as an agent having acted. A stale report status invalidates the draft before sending. Failures leave manual reply fully usable.

## Phase 3: bounded customer assistant

Provide a clearly labeled “ArabicaAI assistant” panel beside the human thread, scoped to the currently owned report. Start with status, next steps, required details and a human-help action. Keep the human message composer distinct. Use existing report APIs for facts and approved ES/PT/EN copy for process answers; a model may interpret a natural-language question and select a supported response category, but cannot fabricate status or execute arbitrary tools.

The first version uses validated intent/field identifiers and deterministic rendering for customer-visible factual answers. It may ask for a missing detail using approved localized text. Information is only sent to the team through an explicit customer-confirmed message, using the existing persistence route. This avoids silent writes and a second intake workflow.

Unsupported questions, invalid output and provider failures offer the human channel. Status questions remain answerable from D1 when Vertex is unavailable. On closed reports, explain the stored result and point to the existing follow-up flow; do not reopen or post automatically.

Assistant exchanges are transient in this first version and clearly described as such. They are not inserted as fake human messages or counted against the human thread limit. A later requirement for persistent AI conversation must define an additive schema and merged ordering separately.

## Shared operational rules

- Separate switches for reviewer assist and customer assist; both default off. Phase 1 has no model dependency.
- One explicit user action initiates at most one model call, with a proposed 10-second hard timeout and no automatic generation retry. A failed save retries persistence with the existing idempotency key, not generation.
- Bound input by character/token budget, retain the original report context and newest messages, and state when older context is omitted. Exact limits and output-token ceilings belong in the approved implementation plan.
- Daily call caps and per-session/request limits must be enforced server-side and atomically where concurrency matters. Reuse applicable existing controls; do not reset budgets independently in each Worker isolate.
- Check ownership before every customer read and generation. Recheck session/report state before accepting generated results or sending human-reviewed text. Cancel/discard stale frontend responses on report switches, logout or language changes.
- No generated HTML, no arbitrary URL fetches, no money movement, no automatic closure and no “fixed/refunded” claim unsupported by stored facts.
- Operational logs contain references, outcomes, latency, token usage and prompt/model version; never statements, messages, drafts, tokens or customer identifiers.
- No new runtime, agent framework, vector database, web search, fine-tuning, streaming transport or WebSockets for the initial release.

## Evaluation and release gates

Use a dedicated ES/PT/EN synthetic conversation set; do not reuse frozen extractor results as evidence for these features. Separate development cases from held-out acceptance cases. Include each review state, missing and contradictory details, unsupported requests, adversarial instructions in customer text, foreign references, closed reports, stale responses, retries and provider failures.

Customer factual responses must exactly match the owned stored status; no cross-customer data or unauthorized action is permitted. Reviewer drafts must not invent case facts or promise a banking outcome. Any such failure blocks activation and returns that path to deterministic/manual behavior. Report the evaluated sample size; zero failures in a finite suite is not a general safety guarantee.

Measure: successful grounded answers / eligible questions; unsupported statements / assessed answers; reviewer draft acceptance and edited acceptance / drafts shown; first human-response latency; model p50/p95 including failed attempts; failure and fallback rates; measured token cost per successful assistance. Do not count an automated acknowledgement as a first human reply or a resolved report. Agree numerical quality and latency thresholds in the written implementation plan before running the held-out set.

For each phase run relevant Angular, Worker unit, local-D1 isolation/concurrency/contract/budget checks; test mobile and desktop. Measure and record any additional D1 work in ADR-004 rather than silently increasing ceilings. Use synthetic records for an end-to-end pilot. Keep default-off rollback available independently of the existing extractor.

## Delivery and coordination

Execute the three feature phases as six sequential tasks on one branch with scoped commits and one final PR, as approved by the user on October 4, 2026. Within each phase use one coder per task, then spec and quality review, capped at three correction rounds. The coordinator holds the briefing and assigns exact file ownership and interfaces in short briefs.

Use `codex/report-support-assistants` for all six tasks; the earlier per-phase merge stops are superseded. Never rewrite reviewed history. Each PR gets its type label, assignee, teammate reviewer and next open version milestone before opening, plus only genuine human steps before merge. Humans review/merge and approve model activation; the normal green-main pipeline deploys. Verify the live version and rendered app afterward, given the recent out-of-band deployment incident.

## Design review decisions

Approved direction: implement all six tasks on one branch with one final PR; both assistance switches stay off pending their evaluations and separate activation approval.

After design review, write the execution plan with exact files, endpoint/response contracts, limits, test assertions, rollout checks and task interfaces. The resulting six-task implementation plan is approved; this approval does not authorize a live model pilot or activation.

## References

- [ADR-012: online AI scope](../../ADRs/ADR-012-ai-online-only-where-evidence-shows.md)
- [ADR-015: messages](../../ADRs/ADR-015-agent-customer-messages.md)
- [Evaluation](../../deliverables/EVALUATION.md)
- [System design](../../deliverables/SYSTEM_DESIGN.md)
- [Vertex function calling](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/function-calling): platform capability, not a requirement to expose model-selected tools in this release.
