# System design: unrecognized-charge intake for a LATAM bank

*ArabicaAI, Factored AI & Data Hackathon 2026. Status as of 2026-10-02.*

## Introduction

This document explains the whole solution in one place:
- who the customer is, and what hurts;
- what we built to fix it;
- how it works and how we know it works;
- what it costs to run, and what is still missing.

It is written as a narrative so it can be read top to bottom in about fifteen minutes. The detail behind each claim lives in one other document, linked where it is used, so no number is maintained in two places.

The data is the synthetic LATAM banking dataset supplied by the organizers: Mexico, Colombia and Argentina, June 2023 to June 2026. Counts from it describe that dataset, not a real bank.

## Tenets

These principles decided every trade-off below. We would change them only with new evidence.

1. **The customer's money is never moved by this system.** It collects a dispute and hands it to a person. It never refunds, blocks a card or decides fraud.
2. **Rules decide, models read.** A model may turn a customer's words into facts. Permissions, ownership and the next step are decided by code we can test.
3. **A promise is made only after it is kept.** The customer gets a case reference only after the case has been stored and read back.
4. **We measure against a baseline on data the builder never saw.** A learned component earns its place by beating simple rules on hidden cases, not by existing.
5. **We spend where a requirement demands it, not where volume does not.** Each layer runs in the cheapest place that meets its requirement, and we write down what would move it.

## The customer and the problem

There are two customers.

**The account holder** sees a card charge they don't recognize. They contact the bank in Spanish or Portuguese, describe the charge in their own words, and want two things: to know the bank understood which charge they mean, and to know what happens next.

**The dispute agent** receives the case. They need the right transaction, the customer's own statement and what was already checked. Without these they have to call the customer back.

The data shows where it hurts:
- **Complaints are a large share of contact.** `Queja` (complaint) contacts are 17.05% of 686,296 call-center interactions.
- **They are the least resolved.** Only 43.60% of them carry a resolved flag, and 62.97% are flagged for follow-up. They account for 41.18% of all unresolved contacts.
- **Unrecognized charges are the largest complaint type.** `Cargo no reconocido` is 12,297 of 67,095 complaints, and stable at 18.2–18.4% a year.

The deeper problem is that **nothing ties a complaint to the disputed transaction.** No complaint points to a transaction (DF-003). The product a complaint cites belongs to a different customer in every one of 44,570 cases (DF-002). Only 33% of unrecognized-charge complaints record an amount. So today the agent starts each case by working out which charge the customer meant.

That is the job we take on: **leave every dispute with the right transaction, confirmed by the customer, before a person picks it up.** The evidence for all of this is in [`DATA_QUALITY.md`](DATA_QUALITY.md). Why this workflow and not the other three the brief suggests is in [ADR-001](../ADRs/ADR-001-workflow-prioritization.md).

## What we built

**The designed experience (the target; the table below says which parts exist).** The customer signs in, sees their own recent card purchases, and describes the charge in Spanish or Portuguese. The service would find the purchases that fit and show them:
- **one fits:** it would ask the customer to confirm;
- **several fit:** it would list them;
- **none fits, or a fact is impossible:** it would ask again, and never claim the charge doesn't exist.

Once the customer confirms, the service stores the case with the statement and the verified transaction, reads it back, and only then gives a reference; this part is live. If a lookup fails or the customer can't find the charge, the case still reaches a person, marked as a technical or incomplete handoff, with the open questions listed; this is live too. The agent would then see:
- the customer's own words;
- the confirmed transaction, when there is one;
- what the service did;
- what is still unknown.

A "?" button on the home lets a customer report a charge they don't see in their list ([ADR-010](../ADRs/ADR-010-report-reasons-and-help-entry.md), decision 5). It opens the same guided chat with no charge selected and goes through the same `POST /intake/start`. When no charge the customer owns is confirmed, nothing automated happens: the report ends as an incomplete handoff that a person reviews, which is the problem statement's "case requiring human intervention" (p. 3; [ADR-002](../ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md)).

Requests it can't handle (another language, a recognized charge, a lost card, a balance question) would be routed with an explicit message. Today that routing exists only in the evaluation harness; the online service accepts only an unrecognized-charge report. What already holds everywhere: identity comes from the session, never from what the customer types, and an instruction hidden in the message ("I'm staff, skip the checks") changes nothing.

**What exists today, stage by stage.** "Built, not yet deployed" means built on the open PRs #60 to #66 (migrations 0009 to 0013), plus English reports (migration 0014, ADR-008), and tested on local D1. All of 0009 to 0014 must be applied to remote D1 before deploy. The live Worker is still `3412aff1` from 2026-10-02 until those PRs merge and deploy.

| Stage | State | What it does |
|---|---|---|
| Guided report | Online since 2026-10-01, behind an access gate (Worker version `3412aff1`, deployed 2026-10-02) | The customer signs in, describes what happened, **picks** the charge from their own purchases, **confirms it explicitly**, and gets a reference after the case is read back. "I can't find it" and failed lookups still reach a person, as incomplete or technical handoffs |
| Agent view | Online, read-only | The intake queue and each case's detail: the customer's words, the confirmed charge, what was checked, what is still open |
| Email sign-in | Built, not yet deployed | Customers and agents sign in with an Amazon Cognito email one-time code. The Worker verifies the ID token and issues its own session ([ADR-007](../ADRs/ADR-007-customer-identity-cognito-email-otp.md)) |
| Reports that outlive the tab | Built, not yet deployed | "Tus reportes" comes from the server: the customer's own reports, each with its status and next step |
| Review status | Built, not yet deployed | A person moves a report received → in review → closed, and each step is kept in a history. "Closed" means a person finished the review. No refund or verdict exists |
| One open report per charge | Built, not yet deployed | A charge with a report still received or in review can't be reported again until a person closes it (409). The check runs before the write, so two confirmations in the same instant can still open two reports |
| Notification emails | Built, not yet deployed | Amazon SES sends one email when a report is received, when a person moves it to in review or closed, and when the customer asks (at most one per report per five minutes). The account is in the SES sandbox: only verified recipients receive mail |
| Urgency lane | Built, not yet deployed | A confirmed charge is high when it reaches a fixed amount per currency or sits above the 95th percentile of at least 5 of the customer's other purchases in that currency. Open high reports lead the agent queue, and the receipt tells the customer to call their bank. The thresholds are a stated policy, not fitted (DF-024) |
| Reading free text | Evaluated offline; wired online behind a switch that is off | The rule-based checklist and the model's fact extractor, run through the written policy in the evaluation harness. With the switch on, the service would only record a shadow call on the statement and on the "I can't find it" details; the model decides nothing online. Built, not yet deployed: the agent sees whether the model read the case in shadow (call count and version, never its output) |

The customer contract and the measurement contract are in [`Docs/intake/`](../intake/customer-and-measurement-contract.md).

## The customer experience

A large charge you don't recognize causes panic. The customer wants it handled fast and handled correctly, and doesn't trust a machine that says "Done". Each of these is a design decision here, and each says what is built and what isn't.

- **Fast means a person owns it quickly, not that a bot replies quickly.**
  - **Built.** On the earlier pick-and-confirm flow, the server work from sign-in to a reference was about 1.4 s in one measured episode ([ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md)). The speed comes from the deterministic path: no model sits on the customer's critical path today.
  - **Not done yet.** The guided flow adds steps and hasn't been timed end to end the same way, and nobody has measured how long a customer takes to reach a reference.
- **Correct means the right charge, safely stored, in front of the right person.** The customer confirms the exact charge, and the reference appears only after the case is read back (Tenet 3). The agent sees what was checked. Nothing is refunded, blocked or decided by the system, so nothing can be "decided wrong" by it.
- **Few questions.** The guided report is three steps: say what happened, pick the charge, confirm. "I can't find it" asks one question (what the customer remembers: amount, approximate date, merchant), then goes to a person with the statement and that answer.
  - **Our question budget:** at most three customer turns before a reference.
  - **Limitation:** the event contract's `clarifications_per_episode` is always 0 in this flow. The one "what do you remember" question is asked by the client and is not emitted as a `clarification_requested` event, so the budget only becomes measurable once the server asks the questions.
- **Never "Done".** The receipt has three wordings, chosen by the server:
  - "Report accepted in the demo";
  - "Sent for human review without a confirmed charge";
  - "We could not check the charge; sent for human review".

  Each is followed by "Next step: an agent reviews this case. No refund has been initiated." and a "What we checked" list. We say what happened and what happens next, never that the problem is solved.
- **Built, not yet deployed: the follow-up, not just the receipt.** Customers usually get a receipt and then chase the bank for a week.
  - "Tus reportes" lists the customer's own reports from the server, with each one's status and next step, after the tab closes.
  - An email goes out when a report is received and when a person moves it to in review or closed. The customer can also ask for one. The email carries the short reference and the status, not the customer's words.
  - **Limit:** production access was requested and denied on 2026-10-02. The account stays in the SES sandbox, so each recipient's address must be a verified SES identity: its owner clicks AWS's verification email. Re-filing with more detail from the SES console is optional.
- **Built, not yet deployed: urgency for high amounts.** The data has no high-value tail to calibrate on ([DF-024](DATA_QUALITY.md#df-024-purchase-amounts-are-almost-flat-up-to-usd-509-with-no-high-value-tail)). So urgency is a stated policy in `back-end/src/config/urgency.json`. A high charge leads the agent queue, and the receipt and the "received" email tell the customer to call their bank to block the card. The service still never blocks a card.
  - **Limit:** the thresholds are round policy values, not learned or validated on outcomes.
- **How we'll know it feels right.** No user test has been run yet, and we make no claim about how it feels. The measures are defined in the [customer contract](../intake/customer-and-measurement-contract.md): effort, teach-back and satisfaction, from real participants only, never simulated ratings. The next step is a five-person moderated test before any claim.

## How it works

**The data path is batch.** The organizers' S3 files are ingested into a raw layer (Bronze) and typed into Silver. They then pass a quality gate that stops the build on missing tables, schema errors or unexplained row changes. From Silver we cut a small, reviewed serving slice (Gold): customers, cards and approved purchases, with the source amount, currency and timestamp kept as they were. All of it runs on DuckDB in minutes; the full build took 11 minutes on a laptop. The pipeline is described in the [README](../../README.md#data-pipeline-start-here).

**The online path is one service.** A Cloudflare Worker serves the Angular client and the API, with the case store in D1 (SQLite). On the submission build the Worker also calls two AWS services: Amazon Cognito for sign-in and Amazon SES for notification emails. Cases stay in D1. The Worker never reads the raw data; it only sees the reviewed slice. All database statements live in one module, which is also the only thing that changes if the store moves. Why one runtime, and why Cloudflare, is in [ADR-003](../ADRs/ADR-003-intake-single-runtime-worker-d1.md).

**The learned component only reads, and it isn't online yet.** A pretrained model (gpt-oss-20b on Workers AI) turns the message into facts: amount, date, currency, merchant, card, country. The same written policy that drives the rule-based baseline then decides the action. The model never sees transactions, never picks a charge and never writes to the store. Today it runs in the evaluation harness only. It joins the service after the frozen comparison, behind a switch. Why this design, which model, and when to change it are in [ADR-006](../ADRs/ADR-006-learned-extractor-workers-ai.md).

**Where AI helps, and where rules decide.** In this workflow, AI's advantage is that the customer can say what happened in their own words instead of filling a form. Speed today comes from the deterministic path, so the model has to earn its place on effort without costing correctness:
- **It reads; it doesn't decide.** It extracts facts. The written policy, the customer's confirmation and the session decide everything else.
- **It must be fast enough to sit in front of a panicked customer.** It is accurate enough on development: in the latency run (attempt 2), all 180 extractor calls on the development cases were correct, with 0 unsafe outcomes. The per-case scores are under "How we know it works". But its p95 latency is 3.58 s against a 3 s trigger, so the next version lowers its reasoning level before it goes online ([ADR-006](../ADRs/ADR-006-learned-extractor-workers-ai.md)).
- **It fails safe.** If the switch is off, the call fails or the facts are unsafe, the customer gets the guided flow they have today.
- **Later roles stay inside the same limits:** drafting the case summary for the agent, explaining a case's status in the customer's language, and asking for a missing fact once. Each would be measured against the same baseline before it ships. None of them moves money, blocks a card or decides fraud (ADR-002).

**Data the source doesn't settle.** The data's currency and time zone are uncertain. We show them as provided, never correct them, and say what we don't know ([`DATA_ENGINEERING.md` section 9](DATA_ENGINEERING.md#9-currency-and-time-served-as-provided)):
- each amount is shown with its own currency code, and nothing is converted;
- times carry a "source time zone not provided" label.

If a bank ran this workflow on AWS, the same design becomes the target below. We priced it, drew it and wrote it as a CloudFormation template, but did not deploy it.

![AWS production target: CloudFront and WAF at the edge, HTTP API and Lambda in a two-AZ VPC with RDS PostgreSQL Multi-AZ and a Bedrock endpoint, a daily Fargate batch into an S3 lake](../Costs/aws-target/architecture.png)

## How we know it works

We compare three systems on the same cases: send everything to a person, the rule-based checklist, and the checklist's policy fed by the model's facts.

The dataset has no realistic customer wording: its complaint text is five fixed sentences. So we built our own test sets in Spanish and Portuguese. The one that counts is a frozen set of 60 cases. It was locked by fingerprint before the model was built, withheld from the builder's checkout, labelled by the written policy, checked by a second model and audited by people. Content of 8 of its cases still reached the repository and was reachable during the build, which we disclose and handle below.

So far:
- The checklist gets 15 of 25 on phrases written without knowledge of its rules. It misses currency words, non-ISO and relative dates, and paraphrases.
- On the development cases, two labels contradicted the written policy and were corrected (the correction still needs the unexposed reviewer's approval). With the corrected labels, the checklist scores 16 of 18 and the model 18 of 18, with no unsafe outcome. These are per-case scores on 18 development cases. The model's figure is inferred from its logged outputs. Two later runs repeated the calls: latency attempt 1 got 82 of its 83 returned calls right, and attempt 2 got all 180 calls right (ADR-006). Before the correction the figures were 18 of 18 and 16 of 18.
- The frozen comparison has not run yet. It runs once, after the model is registered, and is reported on all 60 cases and on the 52 whose content never reached the repository.
- The recent-charges view (provisional, ADR-009 Proposed) served and displayed the customer's own charges in 10 of 12 team-authored cases; the other two were written to fail (expired session, tool failure), and no outcome was unsafe ([`EVALUATION.md` §8](EVALUATION.md#8-normal-resolution-path-provisional-adr-009-proposed)).
- On the live service, 5 report episodes since the last demo reset (1 Spanish, 4 Portuguese, 0 English) reached 4 accepted handoffs and 1 routed (incomplete) handoff, with no model calls; production does not assess safety, so none counts as safe accepted and none was recorded unsafe ([`EVALUATION.md` §9](EVALUATION.md#9-live-service-as-measured)).

How the sets were built, every leakage control, what 60 cases can and can't show, and every option we rejected are in [`EVALUATION.md`](EVALUATION.md).

## What it costs, and how far it scales

**The prototype costs $0** on Cloudflare's free plan. It serves a cohort of 796 customers from the supplied synthetic dataset who disputed a charge, rather than the full data slice, so the load fits one day of the free write quota. The only cloud spend so far is $0.21 on AWS, from an exploratory database that is deleted by 2026-10-20.
- **Capacity:** about 1,960 complete episodes a day for a customer signed in by email, limited by database writes (51 rows each; ADR-004, latest implementation note). The busiest day for unrecognized-charge complaints in 2025 had 23.
- **The first limit to hit** is writes, and $5 a month removes it.

**The AWS production target costs $86.36 a month** at list price ([calculator estimate](https://calculator.aws/#/estimate?id=2c6fd3cd749c39840166f0e274fd6813501f5f7e)).
- **Per unit:** about $0.02 per disputed case, or $0.0035 per contact at the front door.
- **Where the money goes:** about three quarters is a standby database and private networking. That spend comes from what a bank requires, not from traffic.
- **At 10× the traffic,** the bill rises by about 46%.

**Reading one message with the model costs about $0.0005.** On Bedrock, with the same model, it costs about the same.

The open question is speed, not cost. Each layer's choice, the alternatives we priced and rejected, and the triggers that would change them are in [ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md).

## Safety, privacy and operations

- **Permissions are enforced in code, outside anything the model writes.**
  - Every request carries a session.
  - A customer only ever reads their own purchases, and a missing record looks the same as someone else's.
  - Every write is idempotent.
- **Tests attack the service before each change:** forged and expired sessions, cross-customer reads, hostile input, duplicate submissions, and budgets on database work per request.
- **Identity and access** (built, not yet deployed; the live Worker still sits behind Cloudflare Access and a Basic gate). Customers and agents sign in with an email one-time code from Amazon Cognito, an identity service the brief accepts ([ADR-007](../ADRs/ADR-007-customer-identity-cognito-email-otp.md)); a customer number alone never proves identity. The Worker verifies the token and issues its own session. There is no shared team password.
  - **Roles (RBAC):** roles come from Cognito groups (`customer`, `agent`, `admin`, `auditor`), and a route-to-role table assigns every API route. Customer and agent sessions are separate cookies with separate routes.
  - **Audit:** session start, logout, expiry and rejection are recorded with a 12-character prefix of the token hash and the request id only.
  - **Rate limit:** every API path allows 60 requests a minute per IP. The count is per Cloudflare location, so it is approximate, and users behind a shared NAT share it.
  - **Ownership (ABAC):** every customer query is filtered by the session's customer in `back-end/src/store/d1.js`. The integration tests attack it the way OWASP API1:2023 (broken object-level authorization) describes.
  - **In production:** the bank's identity provider (OIDC with MFA, and step-up for a dispute) replaces Cognito, with the same two rules. On the AWS target, Postgres row-level security adds a second check inside the database.
- **Logs and events carry references, never what the customer wrote.**
- **Demo data is synthetic, and the service is shut down after 2026-10-20.**

## Risks, and what we don't claim

- **The data is synthetic.** Every rate describes a generated dataset. Real volume, real peaks and real phrasing could all differ.
- **The test set is small.** It can show a large improvement over the rules, not a small one.
- **The model is not fast enough yet.** Its p95 is 3.58 s against a 3 s trigger (ADR-006), so it stays off the customer's path until a faster version passes.
- **Friendly fraud can't be measured here.** A customer may dispute a charge they made. Complaints don't link to transactions, and outcomes are templates ([DF-025](DATA_QUALITY.md#df-025-dispute-outcomes-cant-show-friendly-fraud)), so we can't size it. Deciding it is out of scope. Intake reduces it by showing the merchant and time before the report and asking for an explicit confirmation.
- **New data doesn't reach the demo on its own.** The pipeline handles new and late days, but refreshing the served cohort is manual and stops in three known places ([`DATA_ENGINEERING.md` section 8](DATA_ENGINEERING.md#8-if-new-data-arrives-tomorrow)).
- **Some test content leaked into the repository.** Content of 8 frozen cases was reachable during the model build. We report results with and without them, and the next build will use a checkout with no history.
- **The sign-in code email is Cognito's default.** It comes in English from `no-reply@verificationemail.com` and can't be changed until SES production access is granted, so the sign-in screens say which email to look for ([ADR-007](../ADRs/ADR-007-customer-identity-cognito-email-otp.md#implementation-notes)).
- **Sign-in is capped at 50 codes a day.** Cognito's default sender allows 50 emails a day per AWS account, and the team and evaluators share them ([ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md#implementation-notes)).
- **What we don't claim:**
  - that faster intake saves money;
  - that the model improves a live service;
  - that zero observed unsafe outcomes means zero risk.

## Status and next steps

**Live today** (behind Cloudflare Access with simulated sign-in; latest Worker version `3412aff1`, deployed 2026-10-02):
- simulated sign-in;
- the customer's own purchases;
- the guided report with confirmation and the technical and incomplete handoffs;
- a stored case with its reference;
- the agent queue and case detail;
- the 796-customer dataset cohort (ADR-004 section 2).

**Built, not yet deployed** (PRs #60 to #66, migrations 0009 to 0013):
- Cognito email sign-in for customers and agents, with no team password, audit events and a per-IP rate limit;
- the customer's reports from the server, with status and next step;
- the review status a person changes, and one open report per charge;
- notification emails through SES (sandbox);
- the urgency lane;
- the agent's view of whether the model read the case in shadow.

**Measured:** the model's latency (ADR-006, attempt 2). It fired the trigger, so the next version lowers its reasoning level.

**Before submission on 2026-10-05:**
1. Merge and deploy PRs #60 to #66, with the human steps in the [release history](../releases/README.md) (migrations, secrets, removing Cloudflare Access).
2. The faster extractor version, built by the isolated builder.
3. The frozen comparison, run once.
4. A public repository.

**Next, after submission:**
- the cohort refresh path for new data (DATA_ENGINEERING section 8);
- optionally, re-filing for SES production access with more detail from the SES console, so mail reaches unverified addresses;
- a five-person usability test.

## FAQ

**Why not let the model run the whole conversation?** It would add latency, cost and safety surface, and it would be much harder to compare with a baseline. The model reads, and the rules decide.

**Why not resolve the dispute automatically?** The brief authorizes no movement of money, and a wrong fraud verdict hurts the customer. A complete, confirmed case in a person's queue is the job.

**Where is "safe automated resolution"?** Intake always ends with a person, so its automated-resolution rate is `not defined`. A read-only "recent purchases" answer is proposed as the path that can resolve something by itself, measured separately.

**Why Cloudflare now and AWS later?** The prototype's load fits the free plan. The AWS design exists for when a bank requires private networking, a standby database and its own keys. That requirement, not traffic, would trigger the move.

**Why so few test cases?** Because the dataset has no realistic wording, every case is written by us, and labels come from the policy. A larger synthetic tier is proposed to add statistical power; it would be reported separately and never as real-customer accuracy.

## Where each detail lives

| Topic | Document |
|---|---|
| Data findings and their queries | [`DATA_QUALITY.md`](DATA_QUALITY.md) |
| Pipeline, contracts, lineage, update policy and stack | [`DATA_ENGINEERING.md`](DATA_ENGINEERING.md) |
| Evaluation, test sets and leakage controls | [`EVALUATION.md`](EVALUATION.md) |
| Capacity, cost and layer placement | [ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md) |
| Workflow choice and scope | [ADR-001](../ADRs/ADR-001-workflow-prioritization.md), [ADR-002](../ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md) |
| Runtime and learned component | [ADR-003](../ADRs/ADR-003-intake-single-runtime-worker-d1.md), [ADR-006](../ADRs/ADR-006-learned-extractor-workers-ai.md) |
| All decisions | [`Docs/ADRs/`](../ADRs/README.md) |
| How to run it | [README](../../README.md), [runbook](../Plans/intake-demo.md) |
