# Judge feedback and what we decided

This register lists each point Factored's judges raised at the 2026-10-01 checkpoint, what we decided, whether it is built, and where the decision is written down. Each point links to the paragraph that answers it, so the reasoning lives in one place.

**Status values:**
- **Built:** in the deployed service or the pipeline, with tests.
- **Documented:** a decision or limitation written down, with nothing to build.
- **Planned:** designed and assigned to a named follow-up, not built.
- **Out of scope:** deliberately not built, with the reason.

## Customer experience (André)

> "Imagine you found out a $5,000 charge right now on your cc. I would PANIC and would like this to be solved as quick as possible… if I would write to the bank and I have an AI Agent that asks 20+ questions… I would probably ask to speak directly to a representative… Would you feel confident if an AI Agent says 'Done'? I probably wouldn't… I would like proactive reach from the bank."

| ID | Point | Decision | Status | Where |
|---|---|---|---|---|
| A1 | A big unknown charge causes panic; solve it fast | Fast means a person owns the case quickly. The deterministic path gives a reference in about 1.4 s of server work, with no model on the critical path | Built (end-to-end customer time not measured) | [System design: customer experience](SYSTEM_DESIGN.md#the-customer-experience) |
| A2 | An AI agent helps with speed | The model's advantage is less effort (own words instead of a form), not raw speed. It is off online until it passes the frozen comparison and a 3 s latency trigger it currently fails (p95 3.58 s) | Documented | [Where AI helps, and where rules decide](SYSTEM_DESIGN.md#how-it-works), [ADR-006](../ADRs/ADR-006-learned-extractor-workers-ai.md) |
| A3 | It must be solved correctly | Correct = the customer confirms the exact charge, the case is read back before a reference, and a person reviews it. The system never refunds, blocks or decides fraud | Built | [Tenets](SYSTEM_DESIGN.md#tenets), [ADR-002](../ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md) |
| A4 | 20+ questions make people ask for a human | A budget of at most three customer turns before a reference; "I can't find it" goes straight to a person | Built (the clarification metric is 0 by construction until the model asks questions) | [Customer experience](SYSTEM_DESIGN.md#the-customer-experience) |
| A5 | "Done" from an AI isn't trusted | The receipt never says "Done". It says what happened (three server-chosen wordings), "Next step: an agent reviews this case", and what was checked | Built | [Customer experience](SYSTEM_DESIGN.md#the-customer-experience) |
| A6 | Evaluate the "feeling" of the agent | Effort, teach-back and satisfaction from real participants only, never simulated ratings. A five-person moderated test is next; until then we claim nothing about how it feels | Planned | [Customer experience](SYSTEM_DESIGN.md#the-customer-experience), [customer contract](../intake/customer-and-measurement-contract.md) |
| A7 | Do better than a receipt and a week of chasing | A server-backed list of the customer's own reports with each one's state and next step. Today "Tus reportes" keeps references for the session only | Planned (session-only list built) | [Customer experience](SYSTEM_DESIGN.md#the-customer-experience) |
| A8 | Proactive reach from the bank | A notification through the bank's existing channel when a person changes a case's state. The event contract carries references only, so a notification can't leak what the customer wrote | Planned | [Customer experience](SYSTEM_DESIGN.md#the-customer-experience), [event contract](../intake/intake-events.md) |
| A9 | Use agentic AI to upgrade the experience | Bounded roles only: draft the agent's summary, explain a case's status, ask once for a missing fact. Each is measured against the same baseline, and none moves money, blocks a card or decides fraud | Planned | [Where AI helps, and where rules decide](SYSTEM_DESIGN.md#how-it-works) |
| A10 | Following from A1: a $5,000 charge deserves different treatment than a $10 one | The data has no high-value tail (purchases are USD 5–509, almost flat), so urgency is a stated policy: a charge well above the customer's own usual amount gets a priority handoff and a "call the bank to block your card" line | Planned | [DF-024](DATA_QUALITY.md#df-024-purchase-amounts-are-almost-flat-up-to-usd-509-with-no-high-value-tail) |

## Whether the solution works (Diego)

> "Make sure your whole solution works. For example, if we give you some data tomorrow, what would work? That's the main question to get right… what your solution needs to work great?"

| ID | Point | Decision | Status | Where |
|---|---|---|---|---|
| D1 | The whole solution works end to end | The guided report, agent view and 796-customer cohort are live (Worker `77f72eb4`), and each stage is listed as built or not | Built | [Status and next steps](SYSTEM_DESIGN.md#status-and-next-steps) |
| D2 | If we give you data tomorrow, what works? | A step-by-step path from S3 to what a customer sees, marking what is automatic and what a person does. Bronze, Silver and the quality gate handle new, late and re-delivered days. Refreshing the served cohort stops in three known places, all fail-closed, with the fix assigned to a follow-up PR | Built to the quality gate; cohort refresh planned | [Data engineering section 8](DATA_ENGINEERING.md#8-if-new-data-arrives-tomorrow) |
| D3 | What does the solution need to work great? | One list: the same 13 tables and storage pattern, a passing quality run on the same database, disputes with at least 3 recent purchases, room in D1's write quota, and the people who approve | Documented | [Data engineering section 8](DATA_ENGINEERING.md#8-if-new-data-arrives-tomorrow) |
| D4 | Earlier: the intent wasn't clear, it felt slow and stuck, colours overlapped, it should be more direct | Two screens with no timers; the purpose line is the largest text on the first screen; one Report button per charge; every text and background pair measured above 4.5:1 | Built (#51 and this PR) | [Accessibility audit](../Evidence/accessibility-audit.md) |

## Data (Antonio)

> "We care more about how teams identify, document, and safely handle these data limitations than about forcing them into assumptions that aren't supported by the supplied data."

| ID | Point | Decision | Status | Where |
|---|---|---|---|---|
| N1 | Document the update and freshness strategy, and how corrections are reprocessed | What each kind of delivery does, tested on a labelled fixture; corrections need a deliberate full refresh; Gold and D1 change only through a reviewed, versioned seed | Built | [Data engineering sections 5–6](DATA_ENGINEERING.md#5-update-and-freshness-policy) |
| N2 | Write down the tool's limitations; not every edge case needs handling | One indexed list, each with what it limits and how we handle it | Documented | [Limitations and how we handle them](DATA_ENGINEERING.md#limitations-and-how-we-handle-them) |
| N3 | New data follows the same storage pattern | That pattern is a stated input; a delivery that breaks it stops the run (`partition_date_mismatch`) | Built | [Data engineering section 8](DATA_ENGINEERING.md#8-if-new-data-arrives-tomorrow) |
| N4 | Schema change can be a stated next step | A missing column stops the build today; an added column never reaches Silver. Next step: an additive Bronze contract, versioned Silver specs and fixtures for both cases | Documented, next step planned | [Data engineering section 8](DATA_ENGINEERING.md#8-if-new-data-arrives-tomorrow) |
| N5 | The dictionary isn't ground truth; document discrepancies | Every figure comes from the supplied data. Dictionary and supplied counts per table, with 0 duplicates found against the stated ~2% | Documented | [DF-026](DATA_QUALITY.md#df-026-the-dictionarys-row-counts-are-approximate) |
| N6 | Currency, a key point: don't correct it; handle and communicate uncertainty safely | Amounts are served with their own currency code, never converted or summed across currencies. The customer picks the charge, so a currency word can't select the wrong one. Once free text is read, the reply states the card's currency and asks the customer to confirm | Built; the free-text reply is planned | [Data engineering section 9](DATA_ENGINEERING.md#9-currency-and-time-served-as-provided), [DF-023](DATA_QUALITY.md#df-023-amounts-share-one-usd-scale-and-claimed-currencies-ignore-the-customers-country) |
| N7 | Use timestamps as provided; don't invent precision | Source time is shown as stored, labelled "source time zone not provided"; filters use the event timestamp | Built | [Data engineering section 9](DATA_ENGINEERING.md#9-currency-and-time-served-as-provided), [DF-020](DATA_QUALITY.md#df-020-one-clock-for-every-country-no-daily-rhythm) |
| N8 | Identify, document and safely handle limitations | The quality gate and findings queries identify, the register documents, and the service labels uncertainty and fails closed | Built | [Data quality register](DATA_QUALITY.md) |

## Questions the review raised that we answered with data

| ID | Question | Decision | Status | Where |
|---|---|---|---|---|
| Q1 | Can a customer see another customer's transactions? | No. Identity comes only from the session (a trusted test session, which the brief allows). Customer and agent roles are separate (RBAC), and every query is filtered by the session's customer (ABAC), with tests for OWASP API1:2023. Production would use the bank's identity provider with MFA, plus row-level security | Built (demo), production design documented | [Identity and access](SYSTEM_DESIGN.md#safety-privacy-and-operations) |
| Q2 | Friendly fraud: a customer disputes a purchase they made | It can't be measured in this data (no complaint-to-transaction link, template outcomes, 102 of 10,370 rejected), and deciding fraud is out of scope. Intake reduces it by showing the merchant and time before the report and asking for an explicit confirmation | Out of scope, with mitigations | [DF-025](DATA_QUALITY.md#df-025-dispute-outcomes-cant-show-friendly-fraud), [risks](SYSTEM_DESIGN.md#risks-and-what-we-dont-claim) |

## Follow-ups named above

- **Cohort refresh** (D2, N1):
  - `as_of` taken from the quality run;
  - membership that moves with new complaints;
  - a reviewed replace path for seed rows;
  - a recorded rehearsal.
- **Report status** (A7, A8, A10):
  - a server-backed list of the customer's reports;
  - the high-amount priority line;
  - "I recognize it now".
- **A five-person usability test** (A6).
- **The faster extractor version** (A2), built by the isolated builder.
