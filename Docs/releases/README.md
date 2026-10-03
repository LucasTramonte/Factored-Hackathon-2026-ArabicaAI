# Release history

One row per release. The prose notes are on [GitHub Releases](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/releases). This table adds what a Release page doesn't: the decisions, the evidence and the exact deployed state behind each version. The procedure is in [`CONTRIBUTING.md`](../../CONTRIBUTING.md#releasing).

To trace a change, go from the release to its PRs, then from each PR to the ADR, finding or evaluation it cites.

| Version | Date | Tag commit | Milestone | PRs | Decisions | Evidence | Deployed state | Known limitations |
|---|---|---|---|---|---|---|---|---|
| `v0.1.0` Factored checkpoint baseline | 2026-10-01 | `518fe3c` | — (before milestones) | #1–#55 | ADR-002 to ADR-006 | [v0.1.0](#v010-factored-checkpoint-baseline) | Worker `77f72eb4`; D1 0001–0007; cohort `c32369c464eec13a`; extractor off | [v0.1.0](#v010-factored-checkpoint-baseline) |
| `v0.2.0` Customer reporting and team access | at tag | squash commit of the review follow-ups PR | [`v0.2.0`](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/milestone/1) | #56–#82 and the review follow-ups PR | ADR-007 to ADR-010; ADR-004 notes | [v0.2.0](#v020-customer-reporting-and-team-access) | recorded at tag | [v0.2.0](#v020-customer-reporting-and-team-access) |

`v1.0.0` is the final hackathon submission ([`CONTRIBUTING.md`](../../CONTRIBUTING.md#versioning)).

## `v0.1.0`: Factored checkpoint baseline

The state the judges reviewed at the 2026-10-01 checkpoint. Tagged on `518fe3c` (#55); its GitHub Release was published with `v0.2.0`.

- **Scope:** PRs #1–#55: the Bronze → Silver → quality pipeline; the findings register (DF-001 to DF-026); the Gold cohort of 796 customers in D1; the guided report with read-back reference and human handoff; the agent queue and detail; the extractor behind a switch that is off; the evaluation harness and the frozen set; the deliverables.
- **Decisions:** ADR-002 (scope, accepted), ADR-003 (runtime), ADR-004 (capacity and cost), ADR-005 (evaluation data protocol), ADR-006 (learned extractor).
- **Deployed state:** Worker `77f72eb4` on 2026-10-01; D1 migrations 0001–0007; cohort `slice_version` `c32369c464eec13a` (one part, `4fe90381be8d8fef`); extractor off.
- **Known limitations:** the frozen comparison hadn't run; the extractor failed its latency trigger (p95 3.58 s); refreshing the cohort for new data was manual; report status lasted only for the session; sign-in was a simulated test session behind a shared password; the data is synthetic.

## `v0.2.0`: Customer reporting and team access

### Highlights

- Customers, agents, the team and evaluators sign in with their own Amazon Cognito email code; there is no shared password. Admins get both views and an evaluation banner; an auditor reads the sign-in and review audit.
- A customer reports a charge in four taps (a one-tap reason prefills the statement), in Spanish, Portuguese or English, follows it under "Your reports", and is emailed when a person moves it forward. A "?" entry covers a charge that isn't in the list and always ends with a person.
- Agents see one queue with urgent reports first (large charges, and any lost or stolen card), the customer's reason, and set received → in review → closed.

### Engineering

- Identity and access: Cognito sign-in for customers (#61) and agents, audit events, route-to-role table (#65); server-side logout (#60); admin superset and evaluator identities (#80); the auditor route and the removal of `GET /agent/cases` (review follow-ups PR, issue #69).
- Reports: reports outlive the tab (#62); notification emails through SES (#63); review status and one open report per charge (#64); status on each charge (#72); English reports (#74, ADR-008); recent charges as the normal resolution path (#75, ADR-009); report reasons (#81, ADR-010) and their provenance flag (migration 0017); the "?" help entry (#82); "I can't find the charge" asks what the customer remembers (#58).
- Urgency lane for large charges and lost cards; the model reads not-found answers in shadow (#66, review follow-ups).
- Data: full-population Gold tables with reconciliation (#56); the cohort selects from Gold (#78), now refusing Gold tables built from different Silver files.
- Client: intro and travelling disc (#57); design-system pass (#73).
- CI: the stack cascade keeps stacked PRs mergeable (#68, #71).

### Evaluation

- Live metrics by language from the remote export (#76).
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
- The extractor is off online; the frozen comparison hasn't run.
- The rate limit is approximate (per Cloudflare location) and keyed by IP; the data is synthetic.

### Deployed state

Recorded when the tag is cut: the Worker version (`npx wrangler deployments list`, deployed with `--tag v0.2.0`), D1 migrations 0001–0017, the cohort `slice_version`, the extractor off.
