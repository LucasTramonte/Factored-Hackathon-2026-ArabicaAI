# ADR-015 — Messages between the reviewing agent and the customer, on one report

- **Status:** Proposed
- **Date:** 2026-10-04
- **Deciders:** Lucas, Roberto, Manoella
- **Related:** [ADR-002](ADR-002-v1-workflow-unrecognized-charge-intake.md) (intake with a human handoff), [ADR-003](ADR-003-intake-single-runtime-worker-d1.md) (one runtime), [ADR-004](ADR-004-intake-capacity-and-cost.md) (budgets), [ADR-012](ADR-012-ai-online-only-where-evidence-shows.md) decision 5 (agent assist)

## Context

The agent could move a report received → in review → closed, and the customer saw that status and was emailed at each step. Neither could write to the other. In a live test (2026-10-04), the product owner, acting as the agent, could not ask the customer for the merchant or explain what happens next. That is the most common thing an agent needs to do with a report that has no confirmed charge.

Email isn't a substitute today:
- SES left the sandbox on 2026-10-04 (50,000 messages a day, 14 a second, us-east-2), but the sender still needs a domain that passes DMARC (#120).
- The email outbox's `template` column has a `CHECK` that admits only the four status templates (migration 0009). Adding a message template means rebuilding that table, a non-additive migration that would stop the automatic deploy.

## Decision

1. **One thread per acknowledged report, in the app, between the reviewing agent and that report's customer** (migration 0028, `handoff_messages`).
   - The customer reads and writes on their own reports only. Another customer's report looks missing (404).
   - Any agent session reads and writes on any report in the approved queue, as with the detail.
   - Routes:
     - `GET` and `POST /intake/handoff/{reference}/messages` (customer);
     - `GET` and `POST /agent/intake-messages` (agent).
2. **Bounded and idempotent.**
   - A message is 1–2,000 code points of well-formed text.
   - A thread holds at most 50 messages: it's about one charge, not a chat channel.
   - Every post carries an `idempotency_key`. A retry stores one message, and the same key with other text is a 409.
3. **Read-only once the report is closed.** Closing ends the review, and the bank's own channel takes the outcome from there (ADR-002).
4. **A message is case content, like the statement.** It is stored in D1 and served to the two parties. It never goes into an event, a log or an email body. The agent's session is recorded as the 12-hex audit reference and never served.
5. **No email yet.** The message is in-app only. Emailing "you have a new message" needs a non-additive migration to widen the template `CHECK`, applied by a person, and is a follow-up.
6. **Nothing moves money or decides.** A message is text between people. The agent still only moves the status, and nothing refunds, blocks or rules on fraud.

## Explained closure contract (2026-10-04)

The lifecycle remains `received → in_review → closed`: closed means a person finished the review, never that the charge was resolved. Starting review keeps exactly `{protocol,status}`. Closing requires exactly `{protocol,status,closing_note}`, with 1–2000 Unicode code points after trimming, well-formed text without NUL. An old reviewer client omitting the note receives 422; invalid note text also receives 422. Deploy the client and API together through the existing pipeline.

Migration 0029 adds nullable `intake_handoffs.closing_note`. New closure stores note, status, history and the existing notification outbox in the same D1 batch, then reads back before success. The immutable first note wins: identical trimmed close/note replay returns the stored result, a different note conflicts (409), and a concurrent losing request never stores its note. Legacy closed rows retain null and display an honest missing-explanation message; they cannot acquire a note through replay.

The owned customer report and approved agent detail expose the note as plain text. The customer can use the existing linked follow-up with “Todavía necesito ayuda”; closed message threads remain read-only. The existing closing email stays generic and points to the app, without note, statement, new template, model, logs or event content. No refund, card block or fraud decision is implied.

## Consequences

- **+** The agent can ask for what's missing and explain the next step. The customer answers on the same report.
- **+** The design follows the existing patterns: SQL only in `d1.js`, roles in the route table, ownership checked in SQL, adversarial tests, contracts and budgets.
- **+** Measured D1 work: a customer post is `3 / 12–13 / 4 / 2` and a read `3 / 7 / 0 / 2` (ADR-004 note).
- **−** The customer learns about a new message only by opening the report until email-on-message exists.
- **−** Free text from an agent can promise what the bank can't deliver. The agent's training and the demo banner cover this; there is no automated check.

## Alternatives considered

- **Email the message body.** Rejected: the template `CHECK`, a sender that doesn't yet pass DMARC alignment, and the policy keeping statements and messages out of email bodies prevent this. Reopen only if SES production access is granted, a person applies the template migration, and a superseding ADR explicitly permits message content in email.
- **Fixed message templates only** (closing reasons, "please send the merchant"). Rejected: templates cannot cover the follow-up questions agents need to ask. Reopen if a reviewed agent message promises a refund, card block or fraud decision outside the agent's authority; require approved Spanish and Portuguese templates covering the observed questions before adopting this alternative.
- **An AI assistant that writes to the customer.** Rejected: there is no evaluated, approved customer-facing generation workflow (ADR-012). Reopen after a separate ADR defines the permitted messages, human approval requirement and evaluation thresholds, and a Spanish/Portuguese pilot meets those thresholds. A model drafting text for a person to edit and send also needs that ADR.
- **A chat channel per customer instead of per report.** Rejected: a dispute concerns one charge, and ownership and review are enforced per report. Reopen if a documented support workflow requires one conversation across multiple reports and a superseding ADR defines report links, authorization and closure behavior for that conversation.
