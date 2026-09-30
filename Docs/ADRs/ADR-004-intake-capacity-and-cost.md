# ADR-004 — Intake capacity and cost for the evaluation window

- **Status:** Proposed
- **Date:** 2026-09-29
- **Deciders:** Lucas Tramonte, Manoella R, Roberto Z
- **Supersedes:** the decision section of the former `Docs/Costs/Intake/INTAKE_COST_REVIEW.md` (removed; this record and the workbook replace it)

## Context

The brief asks for capacity limits, latency and cost trade-offs, cost per attempted case, the workload behind each figure, and the cost assumptions. On Slack, Factored confirmed that the dataset sample (about 780–900 call-center interactions a day) doesn't represent production volume. They said a prototype isn't expected to handle full volume, and that recognizing sizing limits is part of the evaluation. So this record sizes the service against the volumes we measured and the limits of the platform, and it makes no production forecast.

- **Window:** 2026-09-29 → 2026-10-31. Submissions close on 2026-10-05 and finalists are announced on 2026-10-15 (kickoff deck, p. 6); the service stays up through judging.
- **Runtime:** Cloudflare Workers + D1 ([ADR-003](ADR-003-intake-single-runtime-worker-d1.md)).
- **MVP:** deterministic, with no model calls ([ADR-002](ADR-002-v1-workflow-unrecognized-charge-intake.md)).
- **Current state:** on 2026-09-29, production D1 held the fictitious seed and no cases.

### Demand evidence (synthetic sample, full Silver build, 2023-06-17 → 2026-06-18)

| Measure | p50 | p95 | Max |
|---|---|---|---|
| Call-center interactions per day | 664 | 818 | 894 |
| `Queja` interactions per day | 111 | 145 | 169 |
| `Cargo no reconocido` complaints per day (2025) | 11 | 17 | 23 |

The single busiest hour held 60 interactions. The hour-of-day profile is flat (about 4.2% of the day in every hour), which real contact centres don't show, so peaks are handled with a 3× factor that is an **assumption**. The sizing scenarios use a p95 day:

- **S1:** 17 episodes/day. In-scope complaints, the closest proxy for V1 demand.
- **S2:** 145/day. Every `Queja` contact.
- **S3:** 818/day. Every contact of any reason.
- **S4:** 8,180/day. A 10× stress case over S3.

None of these is a forecast.

### Measured cost of one episode

The measurements come from `back-end/test/integration/budget.test.js`, which runs against local D1 and reads D1's own row counters. Storage was measured on SQLite with the Worker's migrations.

| Unit | Worker requests | D1 queries | D1 rows read | D1 rows written | Source |
|---|---|---|---|---|---|
| Page load (gated HTML document + identity list) | 2 | 0 | 0 | 0 | code |
| Customer: login + list + create case | 3 | 9 | 10 | 7 | measured |
| Agent refresh (session + 50-case page) | 2 | 4 | ≤155 | 3 | 13 rows measured with few cases; 155 is the full-page upper bound |
| **Episode (one of each)** | **7** | **13** | **165** | **10** | |

Rows written include D1's index writes. A case takes about **367 bytes** with a typical 77-character statement and about **4.3 KB** at the 2,000-character maximum. Worker CPU per request is **not measured yet**. The handlers are light (a SHA-256, JSON and indexed queries), and the workbook assumes 5 ms against the 10 ms limit until Workers analytics gives a real number.

## Decision

1. **Run on the Workers + D1 Free plan through 2026-10-31.** The daily quotas bound the service at **10,000 episodes a day**, with rows written as the binding quota (100,000 per day ÷ 10 per episode). That is 588× S1, 69× S2 and 12× S3.

   **That figure is a daily-quota bound, not a whole-window capacity.** Storage is cumulative. At 10,000 episodes a day, the 500 MB database cap lasts about 136 days with typical cases (367 bytes) but only **about 12 days with 2,000-character statements** (4.3 KB). Across the window, stored cases use at most 0.5% (S1), 4% (S2) and 22% (S3) of the cap, even at maximum statement length. S4 would need 223% at maximum length, so storage binds before the daily quotas there.

   > **2026-09-30 note: legacy flow only.** The 10,000-a-day bound, the storage figures above and the table below describe the legacy one-step `/cases` flow (3 customer requests, 10 rows written per episode including the agent refresh). The guided flow (`/intake/start` → `/intake/confirm`), with its final schema (0004 edited before merge; see the implementation notes), writes 36 rows per complete customer episode, measured and CI-capped. With one agent look it writes 39 measured, or 42 at the CI ceilings (the agent login ceiling allows 6 writes, not the 3 measured). The same Free quota of 100,000 rows written therefore bounds it at 100,000 ÷ 42 ≈ **2,380 complete episodes a day** (2,564 on measured values). It stores about 5.0 KB per complete episode, and up to 21 KB at the 2,000-code-point maximum. At that rate S3 uses 34% of the daily write quota and S4 exceeds it. With maximum-length 4-byte statements, S3 also fills the 500 MB database within the window. An earlier note here cited 41 rows and about 2,100 a day; that was before the 0004 edit. Figures and method: *Guided intake flow, measured 2026-09-30* under Implementation notes.

   | Scenario | Episodes/day | Worker requests | Rows read | Rows written | Highest use of a daily Free limit | Within daily Free limits | 70% upgrade policy |
   |---|---|---|---|---|---|---|---|
   | S1 | 17 | 119 (0.1%) | 2,805 (0.06%) | 170 (0.2%) | 0.2% | yes | not triggered |
   | S2 | 145 | 1,015 (1.0%) | 23,925 (0.5%) | 1,450 (1.5%) | 1.5% | yes | not triggered |
   | S3 | 818 | 5,726 (5.7%) | 134,970 (2.7%) | 8,180 (8.2%) | 8.2% | yes | not triggered |
   | S4 | 8,180 | 57,260 (57%) | 1,349,700 (27%) | 81,800 (82%) | 82% | yes | **triggered: move to Workers Paid** |

2. **Upgrade triggers, checked weekly in Workers and D1 analytics:**
   - **Workers Paid ($5/month):** any daily Free limit above 70% for 3 days in a row, or any Worker CPU p95 above 8 ms.
   - **Split or move the database:** one D1 database passing 400 MB (80% of the 500 MB Free cap; 10 GB on Paid), or D1 write p95 above 200 ms. PostgreSQL through Hyperdrive, or path O4 in ADR-003.
   - **Single writer:** D1 runs one writer per database, at about 1,000 queries/s with 1 ms queries. S4 at a 3× peak needs 2.8 writes/s, so this isn't the limit at any scenario above.
3. **No capacity claim beyond what was measured.** The per-episode figures come from local tests. Production latency (p50/p95) and CPU are reported only after the remote run in the implementation notes.
4. **Cost envelope.** Before tax, in USD per month:

   | Scenario | Cloudflare Free | Workers Paid | AWS serverless equivalent | AWS O4: API + Lambda + RDS + NAT, no DynamoDB (indicative) |
   |---|---|---|---|---|
   | S1 | $0 | $5.00 | $0.01 | $50.48 |
   | S2 | $0 | $5.00 | $0.09 | $50.50 |
   | S3 | $0 | $5.00 | $0.53 | $50.60 |
   | S4 | $0 (within limits; the policy calls for Paid) | $5.00 | $5.34 | $51.75 |

   The table uses these assumptions:
   - **Workers Paid:** every scenario stays inside the included usage (10 M requests, 30 M CPU-ms, 25 B rows read and 50 M rows written a month), so only the base fee applies.
   - **AWS serverless equivalent:** API Gateway HTTP API at $1.00/M, without the 12-month free tier; Lambda with 512 MB, 100 ms and the always-free 1 M requests and 400k GB-s; DynamoDB on demand, with D1 rows mapped to request units; CloudFront Free for static files.
   - **AWS O4:** uses RDS instead of DynamoDB, so it adds only the shared API Gateway and Lambda costs to RDS and NAT. It adds a NAT gateway ($0.045/h) and its public IPv4 ($0.005/h), both from the official VPC page, to an RDS db.t4g.micro with 20 GB. The RDS figures ($11.68 + $2.30) are indicative, because the fetched pricing page didn't show them, and must be confirmed in the AWS Pricing Calculator (point 6).

   **Cost per attempted case is $0 on Free.** On Paid it is $5 ÷ (episodes per month): $0.0098 at S1 and $0.0002 at S3. **Cost per successful automated resolution is `not defined`**, because V1 has no automated resolution (ADR-002).
5. **AI is only an envelope, not a plan.** No model runs in the MVP. If a later ADR approves one, the per-episode costs at 12k input and 2k output tokens (unmeasured) are:

   | Model | Cost per episode | Free episodes/day | S1 per month | S3 per month |
   |---|---|---|---|---|
   | Workers AI gpt-oss-20b | $0.0030 | 36 (10k-neuron daily allocation) | $1.53 | $73.62 |
   | Workers AI llama-3.3-70b | $0.0080 | 14 | $4.09 | $196.96 |
   | Claude Haiku 4.5 | $0.022 | — | $11.22 | $539.88 |
   | Claude Sonnet 5 | $0.044 | — | $22.44 | $1,079.76 |

   The monthly figures ignore the free allocation. Claude through Bedrock: the rate comes from the calculator, and whether credits apply to Marketplace-billed models is unverified. At S3 volume, AI would cost about 15× (gpt-oss-20b) to 215× (Sonnet 5) the $5 Workers Paid base, so it has to earn its place in the evaluation first.
6. **Official AWS Pricing Calculator estimate (follow-up, no deployment).** The account is Lucas's, on the Free plan: $100 in credits available until 2027-03-22, no card on file, Roberto and Manoella invited. It is used for estimating only. Steps:
   1. Open [calculator.aws](https://calculator.aws/) → *Create estimate* → region **US East (N. Virginia)**.
   2. Create four groups:
      - **Edge:** CloudFront (static assets).
      - **API:** API Gateway HTTP API plus Lambda at 512 MB and 100 ms.
      - **Data:** first DynamoDB on demand; then, as a separate estimate, RDS PostgreSQL db.t4g.micro Single-AZ with 20 GB gp3 and 7-day backups, plus a NAT gateway.
      - **AI, optional:** Bedrock, Claude Haiku 4.5.
   3. Enter the S3 and S4 monthly volumes from the workbook's *Cloudflare capacity* and *Monthly cost* sheets. For S3 that is 5,726 × 30 Worker requests, of which 4,090 × 30 are API calls that touch D1, plus 8,180 × 30 writes and 134,970 × 30 reads.
   4. Save the public link and export CSV to `Docs/Costs/Intake/aws-pricing-calculator-<YYYY-MM-DD>.csv`. Record the link, the date and the RDS lines here, and replace the indicative RDS inputs in the workbook.
   5. State in the record that the calculator excludes tax and credits and doesn't check Free-plan eligibility for this account.
7. **Operating the window:**
   - **Monitoring:** Workers observability logs and traces are enabled at 100% sampling. A weekly check covers requests per day, errors, CPU p95, D1 rows read and written, and database size, against the triggers in point 2.
   - **Access:** Cloudflare Access (email allowlist or one-time PIN, free up to 50 users) required in front of the whole hostname, with its denial of unlisted emails still to be confirmed on the remote checklist, and the Basic gate on the API and HTML documents. Neither is customer authentication.
   - **Retention:** demo activity is kept until 2026-10-31. That covers guided intake episodes, turns, events and handoffs, cases and sessions. After a final event export for the record, it is deleted on the remote D1 with `back-end/scripts/reset-demo-activity.sql`. The script deletes intake events, turns, handoffs and episodes, then cases, then sessions, and a unit test runs it against the migrations. No case or episode is deleted by age before then, so judges see the cases shown in the recorded demo. Before each recorded demo, the team may run the same script. Customers, transactions, context cards and provenance stay until the seed version is replaced. Expired sessions are purged on every login. D1 Time Travel keeps 7 days on Free for recovery. No real customer data is ever loaded. Nothing here has been run remotely.

     > **2026-09-30 note.** This record originally used `DELETE FROM cases; DELETE FROM sessions;` and allowed "a reset of cases and sessions only". That recipe fails since migration 0004: it added `intake_handoffs.complete_case_id → cases(case_id)`, and D1 enforces foreign keys, so the ordered script replaces it. **Export limit:** the final export is all-or-nothing and bounded at 100 pages × 100 = 10,000 episodes. That is below the S3 volume over the window (818 × 32 ≈ 26,000 episodes). At S3 and above, the final export would need segmented exports, which aren't implemented. This is recorded as a limitation.
   - **Remaining deployment work before any real pilot:** real authentication; a preview database separate from production (until then, non-production branch builds stay disabled); alerting on the triggers; a load test against the deployed Worker; a cross-key duplicate rule; a data-handling approval for any AI provider.

## Consequences

- **+** Hosting cost is $0 for the whole window, with every figure traceable to a measurement or an official price. The workbook recalculates when any input changes.
- **+** The first limit we'd hit (rows written) is known, and so is the cheapest way past it ($5/month).
- **+** A CI budget test catches a regression that multiplies queries or rows per request, such as a new scan on a hot path, before it shows up on the bill.
- **−** Sizing rests on a synthetic, flat-hourly sample. Real peaks and real volume could be very different, which is exactly the limitation Factored asked us to state.
- **−** CPU and remote latency are unmeasured until the deploy check runs.
- **−** (2026-09-30) The guided flow writes about 3.9× the legacy rows per episode: 39 vs 10 including one agent look, or 36 vs 7 for the customer requests alone. The Free plan's daily capacity drops from 10,000 to about 2,400 complete episodes, and long statements make storage bind within the window at S3. S4 needs Workers Paid.
- **−** (2026-09-30) The guided endpoints' figures are local D1 counters on fixture workloads. Their CPU, remote latency and production row counts are not measured.
- **−** The agent-refresh read figure is an upper bound, and actual refresh behaviour is an assumption.
- **−** AWS RDS prices are indicative until the calculator estimate is recorded.

## Alternatives considered

- **Size on the hosted-FastAPI options** (Render, Lightsail) from the former review. Their fixed prices don't track load, and those runtimes were rejected in ADR-003. Rejected.
- **Buy Workers Paid now.** Measured use is under 9% of Free even at S3. Rejected. Reopen it on any trigger in point 2.
- **Quote the AWS O4 path as the plan.** It costs about $50/month for no benefit at these volumes. Rejected for the window, but kept as the documented scale path with the calculator follow-up.

## Implementation notes

- **Workbook:** [`Docs/Costs/Intake/INTAKE_COST_ESTIMATE.xlsx`](../Costs/Intake/INTAKE_COST_ESTIMATE.xlsx), generated by `scripts/intake_cost/build_workbook.py`. `--print` outputs the same figures computed in Python. Every derived cell is a formula over the *Inputs* sheet, and an independent recalculation on 2026-09-29 matched the Python figures.
- **Budget ceilings in CI** (per request: queries / rows read / rows written):
  - login 4/8/6;
  - list 2/25/0;
  - create 4/12/6;
  - agent login 3/6/6;
  - agent list 2/250/0.

  Tighten them if the measured values stay lower after the deploy.

  > **2026-09-30 note.** The committed test's legacy ceilings are login 5/10/6/3, list 2/25/0/2, create 4/12/6/4, agent login 3/6/6/1 and agent list 2/250/0/2 (queries / rows read / rows written / round trips). Round-trip caps were added in `aa0c804`, and login moved from 4/8/6/2 in `c9eecb8` (context cards). This work doesn't change them. The guided ceilings are in the next section.
- **Measured in production, 2026-09-29.** One manual episode after the deploy of version `529907dd`: Workers Logs export, 13 invocations and 13 D1 spans. It's a single sample, not a load test.
  - **Placement:** the Worker ran in GRU (São Paulo, region SAM). The D1 primary is in ENAM and was served from ORD (Chicago).
  - **CPU per request:** 0–4 ms, under the 10 ms Free limit. The workbook's 5 ms assumption was conservative.
  - **D1 round trip from the Worker:** 136–186 ms, median 148 ms. Latency is dominated by the distance to D1, not by compute.
  - **Wall time per request:**

    | Request | Wall time |
    |---|---|
    | `GET /demo/identities` | 1 ms |
    | `GET /` (document) | 252 ms |
    | `GET /transactions` | 297 ms |
    | `POST /demo/agent-session` | 309 ms |
    | `GET /agent/cases` | 278 ms |
    | `POST /demo/session` | 524 ms |
    | `POST /cases` | 605 ms |

    The customer path (login, list, case) adds up to about 1.4 s of server time.
  - **Static bundles:** they no longer reach the Worker. The episode made 7 Worker requests, as modelled.
  - **Functional checks:** Access and the Basic gate held, the customer saw only their own charges, a case got a reference, and the agent view showed it. All requests succeeded and there were no errors.
  - **Change made after this measurement:**
    - **Smart Placement** (`placement.mode = "smart"` in `wrangler.jsonc`, checked by `test/unit/config.test.js`) is an adaptive setting. Cloudflare moves the Worker closer to D1 only if observed telemetry shows that helps, so no location is claimed until the `cf-placement` header confirms it.
    - **Login writes in one batch:** purging expired sessions, revoking the old token and inserting the new one run as one atomic `db.batch()`, so login drops to 2 round trips. The budget test now caps round trips per request (login 2, list 2, create 4, agent 1–2).

    Re-measured at 11:05 BRT on 2026-09-29, one episode after the deploy of `aa0c804`:

    | Request | Before | After |
    |---|---|---|
    | `POST /demo/session` | 514 ms | 418 ms (2 round trips) |
    | `POST /demo/agent-session` | 302 ms | 161 ms (1 round trip) |
    | `GET /transactions` | 290 ms | 294 ms |
    | `POST /cases` | 595 ms | 611 ms |

    The batch works. Smart Placement had not moved the Worker yet: it needs observed traffic first, and per-query time was still about 145 ms. Check the `cf-placement` response header (`local-GRU` means not moved; `remote-…` means moved) and re-measure once it reads `remote-…`.

    Caveats:
    - Cloudflare needs some traffic before it moves the Worker.
    - The gated HTML document now makes one trip near D1 (about 130 ms from Brazil), while bundles are still served at the edge.
    - If D1 read replicas are adopted later, revisit placement, because reads could then be served nearer the user.
    - No effect expected on the data-integration or AI phases: more queries per request make proximity to D1 worth more, a model call from North America fits the same placement, and a batch maps to a transaction if the store moves to PostgreSQL.
- **Guided intake flow, measured 2026-09-30 (backend Task 5, final schema).** No remote D1, deploy or model call was used.

  > **Dated note (final fix wave, 2026-09-30).** Migration 0004 was edited before merge; it has never been applied remotely. It no longer creates `intake_episodes_updated` or `intake_handoffs_queue`. Migration 0005's idle and queue indexes replaced them and no query used them, so they cost writes for nothing. 0004 now adds CHECK constraints: `intake_episodes.state` must be one of the six states the code writes, `intake_handoffs.destination` must be `case_service`, and `priority` must be `normal`.
  >
  > **Effect of the edit.** Rows written fell for start (13 → 11), start replay (3 → 2), confirm (25 → 22), incomplete (17 → 14) and each abandoned episode in the idle page (4 → 3). The CHECKs added one counted read to each statement that writes an episode row: start 6 → 7, replay 4 → 5, confirm 54 → 56, incomplete 38 → 40 (checked by applying the old and new 0004 to separate scratch D1s). `EXPLAIN QUERY PLAN` over the 38 distinct statements a full flow runs shows no new scan. Every statement is a `SEARCH`, except the two newest-first lists (`/agent/cases`, `/agent/intakes`), which walk their ordering index under `LIMIT` as before.
  >
  > **Local databases.** Anyone who applied the pre-merge 0004 to a local D1 must recreate it: delete `back-end/.wrangler/state`, then reapply migrations and seeds. Local state is ignored and disposable. The figures below are for the final schema; earlier values are kept in the dated notes.

  *Method.* `back-end/test/integration/budget.test.js` reads D1's own counters (`X-D1-Metrics`) on local D1 (Miniflare, Wrangler 4.143.0) through the real Worker. `run-local.mjs` runs it after every other integration suite, so it measures against their retained rows, and its fixtures can't affect them. To separate per-statement costs, a scratch harness (not committed) called the same route handlers against a fresh local D1, read each statement's D1 `meta`, and ran `EXPLAIN QUERY PLAN`. It did this on the seed alone, after a second round, and after bulk fixtures of 5,004 and then 25,006 episodes (60,124 events, 15,006 handoffs, 25,006 sessions, 5,003 cases). Storage comes from SQLite `dbstat` over the Worker's migrations (`back-end/test/unit/intake-storage.test.js`).

  *Per request* (queries / rows read / rows written / round trips) in the CI run, with neighbouring rows present. On an empty store, reads are lower by the look-ahead rows explained below (for example confirm 48, confirm replay 35). Queries, writes and round trips are fixed per path.

  | Request | Measured (final) | Before the 0004 edit | CI ceiling (final) |
  |---|---|---|---|
  | `POST /intake/start` | 6 / 7 / 11 / 2 | 6 / 6 / 13 / 2 | 6 / 8 / 11 / 2 |
  | start replay (same key) | 6 / 5 / 2 / 2 | 6 / 4 / 3 / 2 | 6 / 6 / 2 / 2 |
  | `POST /intake/confirm` | 18 / 56 / 22 / 8 | 18 / 54 / 25 / 8 | 18 / 60 / 22 / 8 |
  | confirm replay | 17 / 42 / 0 / 7 | same | 17 / 45 / 0 / 7 |
  | `POST /intake/handoff` (incomplete) | 14 / 40 / 14 / 7 | 14 / 38 / 17 / 7 | 14 / 42 / 14 / 7 |
  | incomplete replay | 14 / 33 / 0 / 7 | same | 14 / 36 / 0 / 7 |
  | `GET /agent/intakes`, 50 rows behind 50 tied pending reservations | 2 / 203 / 0 / 2 | same | 2 / 225 / 0 / 2 |
  | `GET /agent/intake-detail`, complete | 3 / 12 / 0 / 3 | same | 3 / 15 / 0 / 3 |
  | `GET /agent/intake-detail`, incomplete | 3 / 7 / 0 / 3 | same | 3 / 10 / 0 / 3 |

  The rule for the new ceilings: queries, writes and round trips equal the measured counts, since each is fixed per code path, and a new query or write should fail CI. Rows read get a margin of about 10%, and at least 2 rows, over the populated value, but a ceiling is never raised. That is why start and start replay keep a read margin of 1 after the CHECKs added a read. The largest request, confirm, uses 18 of the 50 queries D1 allows per invocation.

  *Why confirm replay read 42 against a provisional ceiling of 40.*
  - No replay statement scans a population. `EXPLAIN QUERY PLAN` shows an index `SEARCH` for every statement on the path; none is a `SCAN`.
  - Seven statements each read exactly one more row once another index entry follows the looked-up key: `findOwnedIntakeHandoff`, the same lookup at the end of the persistence batch, `readIntakeReceipt`, and the four event `INSERT … SELECT`s of the acknowledgment batch. Each looks up `intake_episodes_owner (customer_id, episode_id)` or the `intake_events (episode_id, seq)` range.
  - So 35 on an empty store becomes 42 once the looked-up keys have a following index entry. At a few episodes that depends on where the random UUIDs fall: it was 42 in some small runs and 35 in others. It was 42 at every larger population measured, including 5,004 and 25,006 episodes, and in the CI run. The other ten statements read the same at every size.
  - Replay breakdown (empty → populated): session 1, episode 1, reservation lookup 2 → 3, session 1, persistence batch 0 + 3 + 0 + 1 + (2 → 3), receipt read-back 5 → 6, acknowledgment batch 2 + 4 × (3 → 4) + 2 + 3.
  - The 42 is a bounded per-lookup constant, so the ceiling is 45 rather than a larger allowance. Making the owner index `UNIQUE` was tried on a scratch copy; it changed several plans and still grew with population.

  *Rows written by index.* Migration 0005's `intake_episodes_idle` adds one write when a start inserts an episode and one when the renewal `UPDATE` rewrites `updated_at`/`expires_at`. Its `intake_handoffs_queue_protocol` adds one per handoff insert. Before the 0004 edit, these explained Task 5's increases: start 11 → 13, replay 2 → 3, confirm 24 → 25, incomplete 16 → 17. The renewal `UPDATE` also matches the just-inserted row on a first start and costs 2 of its 11 writes. Skipping it on first insert is a possible later saving, not made here.

  *Per episode.* Customer requests only, as enforced in CI:
  - **Complete** (login, list, start, confirm): 4 requests, 30 / 69 / 36 / 15, ceiling 30 / 72 / 36 / 15 (was 30 / 66 / 41 / 15).
  - **Incomplete** (login, list, start, handoff): 4 requests, 26 / 53 / 28 / 14, ceiling 26 / 56 / 28 / 14 (was 26 / 50 / 33 / 14).
  - **Abandoned:** login and start, 14 rows written, plus 3 when the idle sweep closes it.
  - **With one agent look, for capacity:** a complete episode also carries the page load (2 Worker requests, no D1) and one agent look (session, queue and detail: 3 requests, 1 + 203 + 12 rows read, 3 rows written). That is **9 Worker requests, 285 rows read and 39 rows written** measured, or 318 read and 42 written at the CI ceilings (was 282 / 44 measured and 318 / 47 at the ceilings). The one-look-per-handoff agent behaviour is an assumption, as in the legacy model.

  *Housekeeping and export* (store calls, CI-enforced).
  - **Idle page:** an atomic page closing 100 episodes costs 2 queries, 1,100 rows read, 300 rows written and 1 round trip (11 read and 3 written per closed episode); ceiling 2 / 1,210 / 300 / 1.
    - *History:* the first Task 5 sweep hard-coded the end event at sequence 1 and read 800 / wrote 400. The fix wave appended the end at the episode's next sequence number and checked that the latest event is the abandoned end (1,100 / 400). The final wave reads the latest event once per episode and skips an episode whose latest event already ends it, so reads stay 1,100. The 0004 edit dropped writes to 300.
    - The page limit bounds the cost, not the population: 1,100 at CI size, 5,004 and 25,006 episodes.
  - **Sweep with nothing due:** 2 / 6 / 0 / 1 (ceiling 2 / 10 / 0 / 1). The final due probe that sets `complete` costs 1 / 1 / 0 / 1 (ceiling 1 / 3 / 0 / 1).
  - **Export page:** 1 query reading **2 rows per episode (its page entry and the look-ahead that ends its event range) plus its events**. CI measured 416 rows for 100 episodes with 216 events, and 327 for a page of 77 episodes (174 events) after a cursor; the last episode in the table has no look-ahead. The CI ceiling is computed per page as 2 × episodes + events + 2. It is at most 702 for a full page, because the guided producer writes at most 5 events per episode.
  - **Scan sensitivity:** on a scratch store of 130 episodes, the old flat ceiling of 700 accepted an injected full scan of `intake_episodes` (530 rows), and the computed ceiling of 402 rejects it. A full scan of `intake_events` read 23,300 rows and fails both.
  - **Full export:** one page query per page. The integration run exported 18 episodes in 3 pages of 7, reading 82 rows.

  *Paths without a CI budget.*
  - **Technical handoff:** the technical-handoff branch of confirm needs a failing transaction lookup. That can't happen on local D1 without fault injection, so CI doesn't budget it. A scratch run with an injected lookup error, on the pre-edit schema, measured technical confirm 14 / 38 / 17 / 7, its replay 15 / 33 / 0 / 7 and its agent detail 3 / 7 / 0 / 3. It was not re-measured after the 0004 edit; its writes follow the incomplete path's. These figures are not CI-enforced.

  *Queue scan and pending density.* The queue walks `intake_handoffs_queue_protocol` newest first and skips pending reservations. It reads about 1 + 2 × (51 + P) rows, where P is the number of pending reservations ahead of the 51st acknowledged one: 203 in the 50 + 50 tied fixture. A pending reservation exists only while an acknowledged read-back is outstanding (a lost response or an expired session), and nothing expires it. So P has no structural bound, and the fixture is a qualified workload, not a universal scan bound. Watch the count of `handoff_pending` episodes in the weekly check.

  *Storage per episode* (dbstat: rows, index entries and B-tree free space; repeated runs agreed within 1%; CI bound in brackets; before the 0004 edit in parentheses):

  | Statement | Complete | Incomplete |
  |---|---|---|
  | typical 77 code points | 4,997 B [5,500] (5,161) | 3,318 B [3,700] (3,482) |
  | 2,000 ASCII characters | 12,534 B [13,800] (12,739) | 7,045 B [7,800] (7,209) |
  | 2,000 four-byte code points (worst case) | 21,299 B [23,400] (21,422) | 11,674 B [12,900] (11,837) |

  Typical complete episode by table: episode 614 B, 2 turns × 348 B, 5 events × 434 B, handoff 1,024 B, case 492 B. The statement is stored twice for a complete episode, once in the episode and once in the case. Sessions are excluded because they are purged at expiry.

  *Capacity on Free.* Using the CI ceilings (9 requests, 318 rows read, 42 rows written per complete episode), the daily quotas allow 11,111 episodes by requests, 15,723 by rows read and **2,380 by rows written** (was 2,127). Rows written binds; measured values give 2,564 (was 2,272). Storage is cumulative. At 2,380 episodes a day the 500 MB database lasts about 38 days with typical statements, 15 days at 2,000 ASCII characters and 9 days at the 4-byte worst case. Scenario use of the daily Free limits (ceiling basis), and storage over the 32-day window (storage at the CI bounds):

  | Scenario | Episodes/day | Requests | Rows read | Rows written | Storage after 32 days (typical / 2,000 ASCII / 4-byte max) | 70% policy |
  |---|---|---|---|---|---|---|
  | S1 | 17 | 153 (0.2%) | 5,406 (0.1%) | 714 (0.7%) | 3.0 / 7.5 / 12.7 MB | not triggered |
  | S2 | 145 | 1,305 (1.3%) | 46,110 (0.9%) | 6,090 (6.1%) | 26 / 64 / 109 MB | not triggered |
  | S3 | 818 | 7,362 (7.4%) | 260,124 (5.2%) | 34,356 (34%) | 144 / 361 / 613 MB | daily limits not triggered; at the 4-byte maximum storage passes the 400 MB trigger and the 500 MB cap |
  | S4 | 8,180 | 73,620 (74%) | 2,601,240 (52%) | 343,560 (344%) | 1.4 / 3.6 / 6.1 GB | **writes exceed the Free quota: move to Workers Paid first**; requests also pass 70% |

  Before the 0004 edit, rows written were 799 / 6,815 / 38,446 / 384,460 a day for S1–S4.

  The 70% triggers in point 2 are unchanged. On Workers Paid, S4 needs 10.3 M rows written, 78 M read and 2.2 M requests a month, all inside the included usage, so only the $5 base applies, and 6.1 GB fits the 10 GB database limit. **Cost per attempted case** is $0 on Free and $5 ÷ monthly episodes on Paid ($0.0098 at S1, $0.0002 at S3, $0.00002 at S4). **Cost per successful automated resolution stays `not defined`**: a guided handoff is not an automated resolution (ADR-002), and the separate recent-transactions path has no numerator yet (`Docs/Plans/recent-transactions-resolution-decision.md`).

  *What these figures don't show.*
  - They are local D1 counters on bounded fixture workloads (at most 25,006 episodes, and a 50 + 50 pending queue). That is not a universal scan bound, a production measurement or an approved Gold import size.
  - Worker CPU, remote D1 latency and Workers Logs events per guided request are not measured. The only remote evidence is still the legacy episode of 2026-09-29, about 148 ms per D1 round trip from GRU. At that rate, confirm's 8 round trips would spend about 1.2 s waiting on D1. That is a projection, not a measurement.
  - Retries, replays, renewals, queue refreshes beyond one per handoff, and operator runs add to these costs.
  - Production safety is `not_assessed`.
  - Outcome counts depend on sweep discipline. The idle deadline is applied only by the manual sweep, so an episode is abandoned only if a sweep runs before the customer returns. The procedure is to sweep immediately before each export, at the same cutoff. Enforcing the deadline online would change the reviewed same-owner resume behaviour and needs a team decision.
  - **Legacy case list:** `GET /agent/cases` lists every guided complete case row. That includes one whose reservation is still `handoff_pending` after a lost read-back, where the customer got 503 and no reference, and a same-owner retry completes it. `/agent/intakes` is the authoritative guided queue. Pending reservations stay in the KPI denominator as pending until retried. The legacy query is unchanged on purpose, per the plan's global constraints.
  - The workbook (`INTAKE_COST_ESTIMATE.xlsx`) still models the legacy `/cases` flow. It was not regenerated for the guided flow.
- **Observability limits:**
  - Workers Logs Free allows 200,000 events per day. After that, 1% head sampling applies for the rest of the day. One episode produced about 29 events, so full-fidelity logs cover about 6,900 legacy episodes per day, which is below the legacy flow's 10,000-episode capacity. Log events per guided episode have not been measured, and the guided flow's own capacity is about 2,400 a day. `head_sampling_rate` can be lowered if that matters.
  - Logs are retained for 3 days on Free.
  - `Authorization` and `Cookie` are redacted, and request bodies are logged only as sizes. The client IP (`cf-connecting-ip`) is logged, which is personal data, so exported logs stay in ignored `data/observability/` and are never committed.
- **Sources (checked 2026-09-29):**
  - Cloudflare: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Zero Trust plans](https://www.cloudflare.com/plans/zero-trust-services/).
  - AWS: [Free plan](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html), [Lambda](https://aws.amazon.com/lambda/pricing/), [API Gateway](https://aws.amazon.com/api-gateway/pricing/), [DynamoDB on demand](https://aws.amazon.com/dynamodb/pricing/on-demand/), [VPC/NAT](https://aws.amazon.com/vpc/pricing/), [CloudFront](https://aws.amazon.com/cloudfront/pricing/), [RDS for PostgreSQL](https://aws.amazon.com/rds/postgresql/pricing/), [Pricing Calculator](https://docs.aws.amazon.com/pricing-calculator/latest/userguide/what-is-pricing-calculator.html).
  - Anthropic API list prices.
