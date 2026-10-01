# System design: unrecognized-charge intake for a LATAM bank

*ArabicaAI, Factored AI & Data Hackathon 2026. Status as of 2026-09-30.*

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

That is the job we take on: **leave every dispute with the right transaction, confirmed by the customer, before a person picks it up.** The evidence for all of this is in [`DATA_QUALITY.md`](DATA_QUALITY.md). Why this workflow and not the other three the brief suggests is in [ADR-001](Docs/ADRs/ADR-001-workflow-prioritization.md).

## What we built

**The designed experience (the target; the table below says which parts exist).** The customer signs in, sees their own recent card purchases, and describes the charge in Spanish or Portuguese. The service would find the purchases that fit and show them:
- **one fits:** it would ask the customer to confirm;
- **several fit:** it would list them;
- **none fits, or a fact is impossible:** it would ask again, and never claim the charge doesn't exist.

Once the customer confirms, the service stores the case with the statement and the verified transaction, reads it back, and only then gives a reference; this part is live. If a lookup fails or the customer can't find the charge, the case still reaches a person, marked as a technical or incomplete handoff, with the open questions listed; this is in the guided backend under review. The agent would then see:
- the customer's own words;
- the confirmed transaction, when there is one;
- what the service did;
- what is still unknown.

Requests it can't handle (another language, a recognized charge, a lost card, a balance question) would be routed with an explicit message. Today that routing exists only in the evaluation harness; the online service accepts only an unrecognized-charge report. What already holds everywhere: identity comes from the session, never from what the customer types, and an instruction hidden in the message ("I'm staff, skip the checks") changes nothing.

**What exists today is built in stages, and they are not all online yet:**

| Stage | State | What it does |
|---|---|---|
| Live service | Online, behind an access gate | The customer signs in, **picks** the charge from their own purchases, **confirms it explicitly**, and gets a reference after the case is read back. Agents see the queue |
| Guided backend | Merged, tested locally, not deployed | Adds guided intake episodes, technical and incomplete handoffs, the agent's case detail and event export. It takes a structured report and does not read free text |
| Reading free text | Evaluated offline, not wired online | The rule-based checklist and the model's fact extractor, run through the written policy in the evaluation harness. The model joins the live service only after the frozen comparison, behind a switch that falls back to the guided flow |

The customer contract and the measurement contract are in [`Docs/intake/`](Docs/intake/customer-and-measurement-contract.md).

## How it works

**The data path is batch.** The organizers' S3 files are ingested into a raw layer (Bronze) and typed into Silver. They then pass a quality gate that stops the build on missing tables, schema errors or unexplained row changes. From Silver we cut a small, reviewed serving slice (Gold): customers, cards and approved purchases, with the source amount, currency and timestamp kept as they were. All of it runs on DuckDB in minutes; the full build took 11 minutes on a laptop. The pipeline is described in the [README](README.md#data-pipeline-start-here).

**The online path is one service.** A Cloudflare Worker serves the Angular client and the API, with the case store in D1 (SQLite). The Worker never reads the raw data; it only sees the reviewed slice. All database statements live in one module, which is also the only thing that changes if the store moves. Why one runtime, and why Cloudflare, is in [ADR-003](Docs/ADRs/ADR-003-intake-single-runtime-worker-d1.md).

**The learned component only reads, and it isn't online yet.** A pretrained model (gpt-oss-20b on Workers AI) turns the message into facts: amount, date, currency, merchant, card, country. The same written policy that drives the rule-based baseline then decides the action. The model never sees transactions, never picks a charge and never writes to the store. Today it runs in the evaluation harness only. It joins the service after the frozen comparison, behind a switch. Why this design, which model, and when to change it are in [ADR-006](Docs/ADRs/ADR-006-learned-extractor-workers-ai.md).

If a bank ran this workflow on AWS, the same design becomes the target below. We priced it, drew it and wrote it as a CloudFormation template, but did not deploy it.

![AWS production target: CloudFront and WAF at the edge, HTTP API and Lambda in a two-AZ VPC with RDS PostgreSQL Multi-AZ and a Bedrock endpoint, a daily Fargate batch into an S3 lake](Docs/Costs/aws-target/architecture.png)

## How we know it works

We compare three systems on the same cases: send everything to a person, the rule-based checklist, and the checklist's policy fed by the model's facts.

The dataset has no realistic customer wording: its complaint text is five fixed sentences. So we built our own test sets in Spanish and Portuguese. The one that counts is a frozen set of 60 cases. It was locked by fingerprint before the model was built, withheld from the builder's checkout, labelled by the written policy, checked by a second model and audited by people. Content of 8 of its cases still reached the repository and was reachable during the build, which we disclose and handle below.

So far:
- The checklist gets 15 of 25 on phrases written without knowledge of its rules. It misses currency words, non-ISO and relative dates, and paraphrases.
- On the development cases, two labels contradicted the written policy and were corrected (the correction still needs the unexposed reviewer's approval). With the corrected labels, the checklist scores 16 of 18 and the model 18 of 18, with no unsafe outcome. The model's figure is inferred from its logged outputs, and a later run agreed on 82 of 83 calls. Before the correction the figures were 18 of 18 and 16 of 18.
- The frozen comparison has not run yet. It runs once, after the model is registered, and is reported on all 60 cases and on the 52 whose content never reached the repository.

How the sets were built, every leakage control, what 60 cases can and can't show, and every option we rejected are in [`EVALUATION.md`](EVALUATION.md).

## What it costs, and how far it scales

**The prototype costs $0** on Cloudflare's free plan. It serves a cohort of 796 customers from the supplied synthetic dataset who disputed a charge, rather than the full data slice, so the load fits one day of the free write quota. The only cloud spend so far is $0.21 on AWS, from an exploratory database that is deleted by 2026-10-20.
- **Capacity:** about 2,380 complete episodes a day, limited by database writes. The busiest day for unrecognized-charge complaints in 2025 had 23.
- **The first limit to hit** is writes, and $5 a month removes it.

**The AWS production target costs $86.36 a month** at list price ([calculator estimate](https://calculator.aws/#/estimate?id=2c6fd3cd749c39840166f0e274fd6813501f5f7e)).
- **Per unit:** about $0.02 per disputed case, or $0.0035 per contact at the front door.
- **Where the money goes:** about three quarters is a standby database and private networking. That spend comes from what a bank requires, not from traffic.
- **At 10× the traffic,** the bill rises by about 46%.

**Reading one message with the model costs about $0.0005.** On Bedrock, with the same model, it costs about the same.

The open question is speed, not cost. Each layer's choice, the alternatives we priced and rejected, and the triggers that would change them are in [ADR-004](Docs/ADRs/ADR-004-intake-capacity-and-cost.md).

## Safety, privacy and operations

- **Permissions are enforced in code, outside anything the model writes.**
  - Every request carries a session.
  - A customer only ever reads their own purchases, and a missing record looks the same as someone else's.
  - Every write is idempotent.
- **Tests attack the service before each change:** forged and expired sessions, cross-customer reads, hostile input, duplicate submissions, and budgets on database work per request.
- **Logs and events carry references, never what the customer wrote.**
- **Demo data is synthetic, and the service is shut down after 2026-10-20.**

## Risks, and what we don't claim

- **The data is synthetic.** Every rate describes a generated dataset. Real volume, real peaks and real phrasing could all differ.
- **The test set is small.** It can show a large improvement over the rules, not a small one.
- **Speed is unproven.** The model's first reliable latency measurement is still pending, because the first attempt ran out of free model quota.
- **Some test content leaked into the repository.** Content of 8 frozen cases was reachable during the model build. We report results with and without them, and the next build will use a checkout with no history.
- **What we don't claim:**
  - that faster intake saves money;
  - that the model improves a live service;
  - that zero observed unsafe outcomes means zero risk.

## Status and next steps

**Live today** (behind an access gate): sign-in, the customer's own purchases, confirmation, a stored case with its reference, and the agent queue.

**Merged, not deployed yet:**
- the guided flow with technical and incomplete handoffs;
- the agent's case detail;
- event export.

**Before submission on 2026-10-05:**
1. A valid latency measurement.
2. The frozen comparison, run once.
3. The Angular client on the guided flow, in Spanish and Portuguese.
4. The dataset cohort loaded (796 customers, ADR-004 section 2).
5. A public repository.

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
| Evaluation, test sets and leakage controls | [`EVALUATION.md`](EVALUATION.md) |
| Capacity, cost and layer placement | [ADR-004](Docs/ADRs/ADR-004-intake-capacity-and-cost.md) |
| Workflow choice and scope | [ADR-001](Docs/ADRs/ADR-001-workflow-prioritization.md), [ADR-002](Docs/ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md) |
| Runtime and learned component | [ADR-003](Docs/ADRs/ADR-003-intake-single-runtime-worker-d1.md), [ADR-006](Docs/ADRs/ADR-006-learned-extractor-workers-ai.md) |
| All decisions | [`Docs/ADRs/`](Docs/ADRs/README.md) |
| How to run it | [README](README.md), [runbook](Docs/Plans/intake-demo.md) |
