# ADR-005 — Evaluation data protocol: design and holdout windows, and a blind frozen set

- **Status:** Proposed
- **Date:** 2026-09-29
- **Deciders:** Lucas Tramonte, Roberto Z, Manoella R

## Context

The brief asks for valid labels, leakage prevention, appropriate evaluation splits and a learned component evaluated against a baseline on the same held-out workload (problem statement, Sound Data and ML Practice; kickoff p. 12). Three facts from the [data quality register](../../DATA_QUALITY.md) shape how we can meet that:

- Source text is fixed templates (DF-001). No text model can be trained or tested on it, so the intake comparison needs authored cases.
- `process_date` isn't an event date (DF-004). A split on it would mix periods.
- Ambiguity is rare in the data (DF-012), so a sample drawn from it wouldn't exercise the hard cases.

So leakage can happen in two places: dataset statistics that reach design decisions from the period we'd test on, and evaluation cases that the people building or tuning a system have seen. This record sets one rule for each, for everyone on the team.

## Decision

1. **Two windows by business timestamp.** The design window is everything before **2026-01-01**. The holdout window runs from 2026-01-01 to 2026-06-18. Every split uses the business timestamp (`transaction_date`, `creation_date`, `interaction_date` and so on), never `process_date`.
2. **What each window may inform:**
   - Only the design window may inform anything that shapes a system or its evaluation: fitted statistics, thresholds, prompt content, few-shot examples, fixture realism, and the training data of any learned component.
   - Structural contracts may use all rows. That covers schema, domains, keys and link validity, like the quality gate and `full`-scope findings. They aren't fitted and apply the same way to every period.
   - Dimension tables are current snapshots. They are used for structural facts only.
   - A model trained on dataset rows is scored on the holdout window once, after the model and its thresholds are frozen.
   - `data_profiles/findings/run_findings.py` bounds every `design` query to the design window and has no option to move it.
3. **The intake comparison uses a blind, frozen, authored set.**
   - The cases are drafted in an isolated session with an allowlist of readable files. The session can't see the checklist, the existing cases or the extractor.
   - A person labels every case with the policy-correct next action, blind to scenario family and to any system output. A second person labels a subset, and we report Cohen's kappa.
   - Disagreements and uncertain cases are adjudicated in writing.
   - The set is frozen by SHA-256 and a git tag before any system is tuned against it. The git history then proves the order.
   - Labels follow the policy given the facts, including the session time `as_of`, not what a baseline can currently parse.
4. **Tuning boundaries:**
   - The extractor and its thresholds are tuned only on the existing `development` split.
   - The frozen set is run once per system version. A fix after that produces a new system version, never new cases.
   - The Gold demo slice (business day 2026-02-26) is serving data and is never used for tuning.
5. **Reporting:**
   - Results are reported per scenario family and language, with Wilson intervals.
   - Systems are compared on the paired cases with McNemar's test.
   - Any pooled rate is labelled "authored coverage mix, not prevalence".
   - ES/PT siblings are treated as pairs, not independent cases.

## Consequences

- **+** One rule for the whole team: a data statistic either comes from the design window or it doesn't inform a design choice.
- **+** The runner and its tests enforce the window. It isn't left to discipline.
- **+** The freeze order is auditable from git, which is stronger evidence than a statement.
- **−** The holdout window can't help with tuning, even when a question looks harmless.
- **−** An authored coverage set can't estimate real prevalence or real phrasing (DF-001, DF-012). Results say how systems behave on stated scenarios, not how often each scenario occurs.
- **−** About 60 cases give wide intervals (about ±8 points on a 90% rate). Siblings reduce the effective sample further.
- **−** Dimension snapshots can carry post-design information (DF-013, DF-014). We accept that for structural facts only.

## Alternatives considered

- **Random row split.** It mixes periods and lets near-identical template text appear on both sides (DF-001). Rejected. Reopen it only for a model whose inputs are time-invariant and deduplicated, and the ADR for that model would have to justify it.
- **No holdout: design on the full period.** Simpler, and today no model is trained on dataset rows. Rejected, because it would make any later trained component unverifiable. Reopen it if the team drops every learned component.
- **Build the frozen set from source transcripts.** They hold 42 templates with no dispute phrasing (DF-001). Rejected. Reopen it if the organizers supply free text.
- **Rolling-origin cross-validation over months.** Useful for a trained forecaster. We train none. Rejected for now. Reopen it with the first trained time-dependent model.

## Implementation notes

- Register and queries: [`DATA_QUALITY.md`](../../DATA_QUALITY.md) and `data_profiles/findings/`. Run with `make findings`.
- The disclosure in the register records the one full-period profiling that happened before this protocol.
- The frozen set's files, manifest and tag are added in their own PR. The manifest records the drafting model, the files the drafting session read, the labellers, kappa and the assumptions (45-day lookback, fixture density).
