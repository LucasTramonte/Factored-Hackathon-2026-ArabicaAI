# Release history

One row per release. The prose notes are on [GitHub Releases](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/releases). This table adds what a Release page doesn't: the decisions, the evidence and the exact deployed state behind each version. The procedure is in [`CONTRIBUTING.md`](../../CONTRIBUTING.md#releasing).

To trace a change, go from the release to its PRs, then from each PR to the ADR, finding or evaluation it cites.

| Version | Date | Tag commit | Milestone | PRs | Decisions | Evidence | Deployed state | Known limitations |
|---|---|---|---|---|---|---|---|---|
| _none yet_ | | | | | | | | |

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
  - the deliverables in `Docs/deliverables/`, including the judge feedback register.
- **Decisions:** ADR-002 (scope, accepted), ADR-003 (runtime), ADR-004 (capacity and cost), ADR-005 (evaluation data protocol), ADR-006 (learned extractor).
- **Deployed state to record:**
  - the Worker version that is live when the tag is cut (`77f72eb4` on 2026-10-01; confirm with `wrangler deployments list`);
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
