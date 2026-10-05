# Release history

One row per release. The prose notes are on [GitHub Releases](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/releases). This table adds what a Release page doesn't: the decisions, the evidence and the exact deployed state behind each version. The procedure is in [`CONTRIBUTING.md`](../../CONTRIBUTING.md#releasing).

To trace a change, go from the release to its PRs, then from each PR to the ADR, finding or evaluation it cites.

| Version | Date | Tag commit | Milestone | PRs | Decisions | Evidence | Deployed state | Known limitations |
|---|---|---|---|---|---|---|---|---|
| `v0.1.0` Factored checkpoint baseline | 2026-10-01 | `518fe3c` | — (before milestones) | #1–#55 | ADR-002 to ADR-006 | [v0.1.0](#v010-factored-checkpoint-baseline) | Worker `77f72eb4`; D1 0001–0007; cohort `c32369c464eec13a`; extractor off | [v0.1.0](#v010-factored-checkpoint-baseline) |
| `v0.2.0` Customer reporting and team access | 2026-10-03 | `64ae03a` | [`v0.2.0`](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/milestone/1?closed=1) | #56–#84 | ADR-007 to ADR-010; ADR-004 notes | [v0.2.0](#v020-customer-reporting-and-team-access) | Worker `f76c7f7b` (`main-64ae03a`); D1 0001–0017; extractor off | [v0.2.0](#v020-customer-reporting-and-team-access) |
| `v0.3.0` Admin, alerts and the measured extractor | 2026-10-04 | `0a743bb` | [`v0.3.0`](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/milestone/2?closed=1) | #85–#113 | ADR-011 to ADR-014; ADR-006 amendments 6–9 | [v0.3.0](#v030-admin-alerts-and-the-measured-extractor) | Worker `22e99b3f` (`main-0a743bb`); D1 0001–0025; extractor and AI suggestions off | Extractor and AI suggestions off online; demo alert flags are authored; SES sandbox |
| `v0.4.0` | 2026-10-04 | `45d933d` | `v0.4.0` | #114–#120 | ADR-012 amendment 1, ADR-014, ADR-015 | [v0.4.0](#v040) | Deploy run 21:06 UTC; Worker version not recorded; D1 0001–0028; AI suggestions on | Worker version not recorded; the extractor v2 held-out evaluation is owed |
| `v0.5` | 2026-10-05 | `d5cd089` | `v0.5.0` | #122–#131 | ADR-015 explained closure contract (migration 0029) | [v0.5](#v05) | Deploy run 02:19 UTC; Worker version not recorded; D1 0001–0029; AI suggestions on | Tagged `v0.5`, without a patch number; Worker version not recorded; no support assistants |

Unreleased on main: #132 (report support assistants, off) and #134, milestone v0.6.0.

`v1.0.0` is the final hackathon submission ([`CONTRIBUTING.md`](../../CONTRIBUTING.md#versioning)).

## `v0.1.0`: Factored checkpoint baseline

The state the judges reviewed at the 2026-10-01 checkpoint. Tagged on `518fe3c` (#55); its [GitHub Release](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/releases/tag/v0.1.0) was published on 2026-10-03, with `v0.2.0`.

- **Scope:** PRs #1–#55: the Bronze → Silver → quality pipeline; the findings register (DF-001 to DF-026); the Gold cohort of 796 customers in D1; the guided report with read-back reference and human handoff; the agent queue and detail; the extractor behind a switch that is off; the evaluation harness and the frozen set; the deliverables.
- **Decisions:** ADR-002 (scope, accepted), ADR-003 (runtime), ADR-004 (capacity and cost), ADR-005 (evaluation data protocol), ADR-006 (learned extractor).
- **Deployed state:** Worker `77f72eb4` on 2026-10-01; D1 migrations 0001–0007; cohort `slice_version` `c32369c464eec13a` (one part, `4fe90381be8d8fef`); extractor off.
- **Known limitations:** the frozen comparison hadn't run; the extractor failed its latency trigger (p95 3.58 s); refreshing the cohort for new data was manual; report status lasted only for the session; sign-in was a simulated test session behind a shared password; the data is synthetic.

## `v0.2.0`: Customer reporting and team access

Tagged on `64ae03a` (#84) on 2026-10-03; [GitHub Release](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/releases/tag/v0.2.0).

### Highlights

- Customers, agents, the team and evaluators sign in with their own Amazon Cognito email code; there is no shared password. Admins get both views and an evaluation banner; an auditor reads the sign-in and review audit.
- A customer reports a charge in four taps (a one-tap reason prefills the statement), in Spanish, Portuguese or English, follows it under "Your reports", and is emailed when a person moves it forward. A "?" entry covers a charge that isn't in the list and always ends with a person.
- Agents see one queue with urgent reports first (large charges, and any lost or stolen card), the customer's reason, and set received → in review → closed.

### Engineering

- Identity and access: Cognito sign-in for customers (#61) and agents, audit events, route-to-role table (#65); server-side logout (#60); admin superset and evaluator identities (#80); the auditor route and the removal of `GET /agent/cases` (#83, issue #69).
- Reports: reports outlive the tab (#62); notification emails through SES (#63); review status and one open report per charge (#64); status on each charge (#72); English reports (#74, ADR-008); recent charges as the normal resolution path (#75, ADR-009); report reasons (#81, ADR-010) and their provenance flag (migration 0017); the "?" help entry (#82); "I can't find the charge" asks what the customer remembers (#58).
- Urgency lane for large charges and lost cards; the model reads not-found answers in shadow (#66, #83).
- Data: full-population Gold tables with reconciliation (#56); the cohort selects from Gold (#78), now refusing Gold tables built from different Silver files.
- Client: intro and travelling disc (#57); design-system pass (#73).
- CI and deploy: the stack cascade keeps stacked PRs mergeable (#68, #71); deploys run from GitHub Actions only after CI is green, apply additive migrations themselves, smoke-test and roll back automatically (#84).

### Evaluation

- Live metrics by language from the remote export (#76). That export holds five team and reviewer episodes (Spanish 1, Portuguese 4, English 0), all with safety not assessed; its p50/p95 measure episode span, not service latency ([EVALUATION §9](../deliverables/EVALUATION.md)).
- The frozen AI-vs-rules comparison is prepared but not run: it waits for the evaluation-host decision in #77.

### Documentation

- ADR-007 (customer identity, decisions 8 and 9), ADR-008, ADR-009, ADR-010, and dated budget notes in ADR-004.
- The [auth runbook](../Plans/auth-runbook.md) (issue #70); the submission build, its limits and a timed new-data rehearsal (#67); the product-flow and roles plans (#59, #79, archived).

### Known limitations

- The account stays in the SES sandbox (production access denied on 2026-10-02): only verified recipients receive email.
- No per-agent assignment: every agent works the one approved queue; agent sessions carry no personal identity.
- The admin banner lives in the tab: a reload drops it with the sign-in.
- Urgency is a stated policy, not fitted; reasons are authored, not learned from real statements.
- Reports from before migration 0017's deploy show "Not recorded" as their reason.
- The one-open-report check is not atomic across different episodes: two simultaneous confirmations of the same charge can open two reports.
- Notification email is attempted once, after the response; a failure is not retried, and "sent" means SES accepted the request, not that it was delivered.
- Closing a report records that a person finished the review; it does not record a bank resolution, a refund or the customer's satisfaction.
- The extractor is off online; the frozen comparison hasn't run.
- The rate limit is approximate (per Cloudflare location) and keyed by IP; the data is synthetic.

### Deployed state

- Worker version `f76c7f7b-765d-4952-a22a-13263a8e060b`, tag `main-64ae03a`, deployed 2026-10-03 15:16 UTC by the GitHub Actions `deploy` workflow.
- D1 migrations 0001–0017 on remote `arabica-intake-demo`.
- Cohort: 796 dataset customers, `slice_version` `c32369c464eec13a` (one part, `4fe90381be8d8fef`), from the cohort manifest (`data/gold_cohort/2026-06-17/manifest.json`). Remote `seed_loads` holds that part, `4fe90381be8d8fef`, loaded 2026-10-01 12:45:10 (a person's read-only query, 2026-10-04).
- Demo alert flags (#106): the fictitious seed's three `bank_flagged` updates (`demo-tx-015`, `-020`, `-025` for Diego, Elena and Marco) were missing on remote D1 and were applied by a person on 2026-10-04; a read-back shows all three set.
- Extractor switch: off.

## `v0.3.0`: Admin, alerts and the measured extractor

Tagged on `0a743bb` (#113), the deployed `main`, on 2026-10-04; [GitHub Release](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/releases/tag/v0.3.0). Prepared from #85–#110 in #112; #111 to #113 merged and deployed before the tag, so they are included.

### Highlights

- **The bank speaks first.** When the bank's own fraud flag marks a charge, the customer sees one in-app alert at sign-in and can report it in two taps; the report joins the urgent lane (#106, ADR-011). The data ruled out the charge amount as a trigger, and the demo's flags are authored on fictitious customers.
- **Admins work as any customer.** One sign-in code opens the customer and agent views; an admin lists the demo customers and acts as any of them from the banner, with updates emailed to the admin, never to the customer (#95–#97, #101).
- **Agents see more, customers lose less.** The agent detail shows the customer's other reports and when the case was first opened (#88); a receipt asks one thumbs question (#89); "Not resolved" on a closed report starts a new one citing it (#90); a reload keeps the session (#110).
- **The extractor is measured.** On the frozen set it ran once: 53/60 correct against the checklist's 23/60, 0 unsafe in 180 runs (#111).
- **AI suggestions are built, and ship off.** On "I can't find the charge", the model can suggest up to three of the customer's own charges after the reference is returned; the customer confirms, a person reviews. `INTAKE_AI_ENABLED` is `"0"` in production (#113, ADR-014).

### Engineering

- One open report per charge now holds under concurrent confirmations (#87).
- Email: an update the customer asks for is reported as requested, and a failed send can be retried (#104); an admin's update goes to the admin (#101).
- Client fixes: the sign-in code step names the sender (#92); FAQ answers scroll into view (#99); "I can't find the charge" clears an earlier pick (#103); demo identities are named on screen (#85).
- AI suggestion path (#113): the run starts after the response, under a daily cap, a retirement date and a randomized 50/50 pilot arm, with Workload Identity Federation to Vertex AI (no Google key). Every failure falls back to today's incomplete handoff.
- KPI read for dispute managers, with time indexes (#113).
- D1 migrations 0018–0025, applied by the deploy.

### Evaluation

- The offline evaluation moved to Google Vertex AI after Bedrock proved blocked on the AWS Free plan (#91, #93, ADR-006 amendments 6–7).
- At `reasoning_effort: "low"`, extractor v1 passes every development trigger: 18/18 by majority, 0 unsafe, p95 upper bound about 2,340 ms (#98, amendments 8–9).
- Extractor v1 was pre-registered (#107) and tagged `extractor-v1` (`3ad34b5`). The frozen comparison ran once on 2026-10-04 (#111): 53/60 correct by majority of 3, against 23/60 for the checklist and 14/60 for always-handoff; 46/52 against 20/52 on the cases never exposed; 0 unsafe in 180 runs; pooled p95 2,048 ms. McNemar 32 vs 2 (p ≈ 7×10⁻⁸). Only aggregates are committed ([EVALUATION](../deliverables/EVALUATION.md)).
- The online port matches the evaluated Python on 753/753 policy cases and 26/26 parse cases (#113).
- The unrecognized-charge baseline report and DF-027 (#94).

### Documentation

- ADR-011 (proactive alert), ADR-012 (AI online only where the evidence shows it), ADR-013 (sessions and staff sign-in), ADR-014 (online AI suggestions, no fraud model), the launch-pitch script (#105, #107, #111).
- The four deliverables consolidated (business outcomes, data engineering, system design, evaluation), the readiness program and the AI suggestion plan (#111).
- The v0.2.0 release record and the KPI ideas (#86); this record (#112).

### Known limitations

- The extractor and AI suggestions are off online; every live path is deterministic.
- The model endpoint behind AI suggestions retires on 2026-10-21; after that date the path records `retired` and falls back.
- The alert's flags are authored; `fraud_score`'s provenance is unconfirmed, so no detection rate is claimed.
- SES stays in the sandbox: only verified recipients receive email.
- Five team episodes are the only live record; they support no rate.
- The data is synthetic.

### Deployed state

- **Code deployment:** Worker version `22e99b3f-4652-41ed-8e53-a3d61999b296`, tag `main-0a743bb`, activated at 100% on 2026-10-04 13:29:40 UTC by the GitHub Actions `deploy` workflow (run on `0a743bb`, success). Read-only `npx wrangler deployments list`, 2026-10-04.
- D1 migrations 0001–0025 on remote `arabica-intake-demo`: a read-only `wrangler d1 migrations list --remote` shows none pending.
- Cohort: 796 dataset customers, `slice_version` `c32369c464eec13a` (one part, `4fe90381be8d8fef`), from the cohort manifest (`data/gold_cohort/2026-06-17/manifest.json`). Remote `seed_loads` holds that part, `4fe90381be8d8fef`, loaded 2026-10-01 12:45:10 (a person's read-only query, 2026-10-04).
- Demo alert flags (#106): the fictitious seed's three `bank_flagged` updates (`demo-tx-015`, `-020`, `-025` for Diego, Elena and Marco) were missing on remote D1 and were applied by a person on 2026-10-04; a read-back shows all three set.
- Switches: extractor off; `INTAKE_AI_ENABLED` `"0"`. The `VERTEX_WIF_SIGNING_KEY` secret is set but unused while the switch is off.

## `v0.4.0`

Tagged on `45d933d` and published 2026-10-04 21:08 UTC; [GitHub Release](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/releases/tag/v0.4.0).

- **Scope:** PRs #114–#120: AI and KPI work recovered after #113 (#114); the v0.3.0 tag docs (#115); AI suggestions live on extractor v2, wait times from bank history and receipt fixes (#116); the progress map (#117); agent–customer messages (ADR-015), visible form errors, clearer agent status and Worker observability (#118); Outcome 1 cuts, DF-028, the first-response appendix and the architecture diagram (#119); branded HTML emails (#120).
- **Decisions:** ADR-012 amendment 1 (AI suggestions on in the demo), ADR-014, ADR-015.
- **Deployed state:** deploy run on `45d933d` succeeded 2026-10-04 21:06 UTC; Worker version not recorded; D1 migrations 0001–0028; AI suggestions on (`INTAKE_AI_ENABLED = "1"`, `INTAKE_AI_SHARE_B = "1"`).

## `v0.5`

Tagged on `d5cd089` and published 2026-10-05 02:39 UTC; [GitHub Release](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/releases/tag/v0.5). The tag has no patch number; its milestone is `v0.5.0`.

- **Scope:** PRs #122–#131: clearer reports and an optional guided tour (#122); saved suggestion outcomes and report progress refresh (#123); explained report closure (migration 0029) with preserved lifecycle updates (#124); README intro (#125); team ownership (#126); sign-in code email layout (#127); sign-in code emails in the selected language (#128); Cloudflare traffic evidence (#129); the help entry's choose step (#130); report email language and the account badge (#131).
- **Decisions:** no new ADR; ADR-015's explained closure contract (2026-10-04).
- **Deployed state:** deploy run on `d5cd089` succeeded 2026-10-05 02:19 UTC; Worker version not recorded; D1 migrations 0001–0029; AI suggestions on. No support assistants.
