# Release history

One row per release. The prose notes are on [GitHub Releases](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/releases). This table adds what a Release page doesn't: the decisions, the evidence and the exact deployed state behind each version. The procedure is in [`CONTRIBUTING.md`](../../CONTRIBUTING.md#releasing).

To trace a change, go from the release to its PRs, then from each PR to the ADR, finding or evaluation it cites.

| Version | Date | Tag commit | Milestone | PRs | Decisions | Evidence | Deployed state | Known limitations |
|---|---|---|---|---|---|---|---|---|
| `v0.1.0` Factored checkpoint baseline | 2026-10-01 | `518fe3c` | — (before milestones) | #1–#55 | ADR-002 to ADR-006 | [v0.1.0](#v010-factored-checkpoint-baseline) | Worker `77f72eb4`; D1 0001–0007; cohort `c32369c464eec13a`; extractor off | [v0.1.0](#v010-factored-checkpoint-baseline) |
| `v0.2.0` Customer reporting and team access | 2026-10-03 | `64ae03a` | [`v0.2.0`](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/milestone/1?closed=1) | #56–#84 | ADR-007 to ADR-010; ADR-004 notes | [v0.2.0](#v020-customer-reporting-and-team-access) | Worker `f76c7f7b` (`main-64ae03a`); D1 0001–0017; extractor off | [v0.2.0](#v020-customer-reporting-and-team-access) |

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
- Cohort: 796 dataset customers (`slice_version` not re-read at tag time); fictitious seed `b9e12385148edf82` (six identities).
- Extractor switch: off.
