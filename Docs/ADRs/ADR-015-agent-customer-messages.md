# ADR-015 — Messages between the reviewing agent and the customer, on one report

- **Status:** Proposed
- **Date:** 2026-10-04
- **Deciders:** Lucas, Roberto, Manoella
- **Related:** [ADR-002](ADR-002-v1-workflow-unrecognized-charge-intake.md) (intake with a human handoff), [ADR-003](ADR-003-intake-single-runtime-worker-d1.md) (one runtime), [ADR-004](ADR-004-intake-capacity-and-cost.md) (budgets), [ADR-012](ADR-012-ai-online-only-where-evidence-shows.md) decision 5 (agent assist)

## Context

The agent could move a report received → in review → closed, and the customer saw that status and was emailed at each step. Neither could write to the other. In a live test (2026-10-04), the product owner, acting as the agent, could not ask the customer for the merchant or explain what happens next. That is the most common thing an agent needs to do with a report that has no confirmed charge.

Email isn't a substitute today:
- SES is in the sandbox, so only verified addresses receive mail.
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

## Consequences

- **+** The agent can ask for what's missing and explain the next step. The customer answers on the same report.
- **+** The design follows the existing patterns: SQL only in `d1.js`, roles in the route table, ownership checked in SQL, adversarial tests, contracts and budgets.
- **+** Measured D1 work: a post is `3 / 10 / 4 / 2` and a read `3 / 7 / 0 / 2` (ADR-004 note).
- **−** The customer learns about a new message only by opening the report until email-on-message exists.
- **−** Free text from an agent can promise what the bank can't deliver. The agent's training and the demo banner cover this; there is no automated check.

## Alternatives considered

- **Email the message body.** Rejected: SES sandbox, the template `CHECK`, and statements and messages are kept out of email bodies by design.
- **Fixed message templates only** (closing reasons, "please send the merchant"). Safer wording, but too rigid for the questions agents actually ask. Reopen if wording risk shows up in review.
- **An AI assistant that writes to the customer.** Rejected for now (ADR-012). The agent-assist step (a model drafts, a person edits and sends) can build on this thread later, under its own ADR.
- **A chat channel per customer instead of per report.** Rejected: a dispute is about one charge, and isolation and review are per report.
