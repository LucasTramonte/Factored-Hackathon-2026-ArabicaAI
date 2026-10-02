# Release history

One row per release. The prose notes are on [GitHub Releases](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/releases). This table adds what a Release page doesn't: the decisions, the evidence and the exact deployed state behind each version. The procedure is in [`CONTRIBUTING.md`](../../CONTRIBUTING.md#releasing).

To trace a change, go from the release to its PRs, then from each PR to the ADR, finding or evaluation it cites.

| Version | Date | Tag commit | Milestone | PRs | Decisions | Evidence | Deployed state | Known limitations |
|---|---|---|---|---|---|---|---|---|
| _none yet_ | | | | | | | | |
| `v0.2.0` Submission (proposed, not tagged) | | | | #60–#66 | ADR-007; ADR-004 notes | ADR-004 budget notes | Not deployed | SES sandbox; urgency is a stated policy; extractor off; frozen comparison not run; rate limit approximate and IP-keyed |

## Proposed first release: `v0.1.0`, Factored checkpoint baseline

This is a proposal; nothing has been tagged. It becomes the first row once a maintainer creates the release.

- **Why a baseline.** The repository has no tags or releases so far. Rather than tag old commits after the fact, the first release marks the state the judges reviewed at the 2026-10-01 checkpoint, with their feedback documented.
- **Tag commit:** the squash commit of the PR that adds this file, once CI is green on `main`.
- **Scope:** PRs #1–#51 plus that PR.
  - the Bronze → Silver → quality pipeline;
  - the findings register (DF-001 to DF-026);
  - the Gold cohort of 796 customers live in D1;
  - the guided report with read-back reference and human handoff;
  - the agent queue and detail;
  - the extractor wired behind a switch that is off;
  - the evaluation harness and the frozen set (the comparison not yet run);
  - the deliverables in `Docs/deliverables/`.
- **Decisions:** ADR-002 (scope, accepted), ADR-003 (runtime), ADR-004 (capacity and cost), ADR-005 (evaluation data protocol), ADR-006 (learned extractor).
- **Deployed state to record:**
  - the Worker version that is live when the tag is cut (`77f72eb4` on 2026-10-01, `3412aff1` since 2026-10-02; confirm with `wrangler deployments list`);
  - D1 migrations 0001–0007;
  - cohort `slice_version` `c32369c464eec13a` (one part, `4fe90381be8d8fef`);
  - the extractor off.
- **Known limitations:**
  - the frozen comparison hasn't run;
  - the extractor fails its latency trigger (p95 3.58 s);
  - refreshing the cohort for new data is manual and stops in three known places;
  - report status lasts only for the session;
  - sign-in is a simulated test session;
  - the data is synthetic;
  - the demo's shared access password is rotated after judging.

## Proposed release: `v0.2.0`, Submission

This is a proposal; nothing has been tagged.

- **Scope:** PRs #60–#66.
  - #60: server-side logout and the orchestration rules;
  - #61: Cognito email sign-in, the gate narrowed to agent and demo paths, the per-IP rate limit, ADR-007;
  - #62: the customer's reports from the server;
  - #63: SES notification emails, on handoff and on request;
  - #64: received → in review → closed by a person, and one open report per charge;
  - #65: agents on Cognito, no team password, audit events, the route-to-role table;
  - #66: the urgency lane and the shadow reading the agent sees.
- **Decisions:** ADR-007 (customer identity), and dated budget notes in ADR-004 for each change.
- **Migrations:** 0009–0013. They are not yet on remote D1, and each must be applied there before its PR merges (the deploy guard refuses otherwise).
- **Worker secrets that must exist:** `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` and `EMAIL_KEY`.
- **Human steps** (details in the [runbook](../Plans/intake-demo.md#customer-sign-in-cognito)):
  1. apply migrations 0009–0013 to remote D1, which holds only 0001–0008 today;
  2. verify the SES sender identity and set the three secrets;
  3. enrol each agent in the Cognito `agent` group;
  4. deploy, then sign in once as a customer and once as an agent;
  5. remove the Cloudflare Access application and delete the `DEMO_ACCESS_USERNAME` and `DEMO_ACCESS_PASSWORD` secrets;
  6. the account stays in the SES sandbox, so create each judge's address as an SES identity and ask them to click AWS's verification email.
- **Deployed state to record:** the Worker version, migrations 0001–0013, the extractor off.
- **Known limitations:**
  - production access was requested and denied on 2026-10-02; the account stays in the SES sandbox, so each recipient's address must be a verified SES identity (re-filing with more detail from the SES console is optional);
  - urgency thresholds are a stated policy, not fitted;
  - the extractor is off;
  - the frozen comparison hasn't run;
  - the rate limit is approximate (counted per Cloudflare location) and keyed by IP;
  - the data is synthetic.
