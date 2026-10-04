# Frozen ES/PT evaluation set (`frozen_es_pt_v1`)

This is the blind, held-out set on which the checklist baseline and the learned extractor are compared, once each. It has 60 single-turn decision points (30 per session language), 30 paired ES/PT situations, 4 synthetic customers and 32 approved card purchases. It is a coverage set, not a prevalence sample. The protocol is [ADR-005](../../../Docs/ADRs/ADR-005-evaluation-data-protocol.md), and the data facts behind the fixture come from the design window of the [data quality register](../../../Docs/deliverables/DATA_ENGINEERING.md).

**Status (2026-09-29):**
- Built and verified.
- Portuguese and Spanish human reviews are done: 0 label errors in 18 random audit cases, with a 95% upper bound of 15.3%.
- Five policy questions raised by the review were decided (all five rules kept).
- The case files are withheld until extractor v1 is pre-registered. See [what's committed](#whats-committed-and-whats-withheld) and [REVIEW_STATUS.md](REVIEW_STATUS.md).

## How the gold answers are made

1. **Spec first.** An isolated drafting session (Codex, reading only an allowlist of files) wrote a structured spec for each situation: the intent and the facts the customer states. It then wrote a Spanish and a Portuguese message from each spec.
2. **Gold by construction.** [`label_rules.py`](label_rules.py) applies the written [policy](POLICY.md) to the spec and the fixture. It never reads the message text. [`test_label_rules.py`](test_label_rules.py) pins its behaviour on a separate fixture.
3. **Independent verification.** A model from another family (Claude, in a fresh context that could read only `POLICY.md` and `verifier_input.jsonl`) re-derived the facts and the answer from each message. It agreed with construction on all 60 answers and on the facts of 58, and flagged 4 readings just after midnight.
4. **Human review, only where it counts.** Reviewers answer multiple-choice questions, never codes, on every verifier disagreement plus a seeded random audit (12 PT, 6 ES). Lucas reviewed both languages, the Spanish ones with a translation aid, so that the extractor's author never sees a case. They never see which option is the construction or verifier answer. Answers are appended to `reviews/<reviewer>.jsonl` as they're given.
5. **Policy decisions.** Where a reviewer differs from construction, we decide which reading of the policy is right, and that decision applies to every similar case. The audit then reports errors over n with an exact Clopper–Pearson bound (`evals/intake/stats.py`).

The method follows the outline-then-paraphrase pattern with validation from Shah et al. (2018) and Rastogi et al. (2020). ES/PT siblings serve as invariance tests in the sense of CheckList (Ribeiro et al., 2020), and the holdout is used once (Dwork et al., 2015).

## What's committed and what's withheld

The extractor's author must not see the cases before pre-registering the extractor. So only the method is in git:

| Committed now | Withheld on the reviewer's machine until extractor v1 is tagged |
|---|---|
| `POLICY.md`, `DATA_FACTS.md`, `TASK.md` (the drafting instructions) | `draft.json` (fixture, specs, messages, construction gold) |
| `label_rules.py`, `test_label_rules.py`, `prepare_review.py`, `test_review.py`, `test_artifacts.py`, `continue_review.py` | `build_phase1.py` (it embeds the messages) |
| `COMMITMENT.json` (SHA-256 of every withheld file) | `verifier_input.jsonl`, `verifier_output.jsonl`, `queues.json` |
| `REVIEW_STATUS.md` | `reviews/` (answers), `review_state*.json`, `session_record.json` |

The withheld paths are listed in `.git/info/exclude` on the reviewer's machine so they can't be committed by accident. A backup exists outside the repository. When they're published, each file must match `COMMITMENT.json`. The artifact tests skip with a stated reason while the files are absent.

## Running things

```sh
python -m pytest evals/intake -q                          # rules, stats and runner tests (artifact tests skip if withheld)
python evals/intake/frozen_es_pt_v1/continue_review.py show              # next PT question
python evals/intake/frozen_es_pt_v1/continue_review.py roberto-message   # Spanish review message (local only)
python evals/intake/frozen_es_pt_v1/continue_review.py roberto-answers "1b 2a ..."
python evals/intake/frozen_es_pt_v1/rehearse_publication.py       # local: verify hashes, export, validate, draft manifest (no scoring)
# once, after the extractor-v1 tag; scores the checklist and the always-handoff reference alongside the model
python -m evals.intake.run --cases evals/intake/frozen_es_pt_v1.candidate.json --repetitions 3 \
  --system extractor-v1=intake_agent.extractor.vertex:extract \
  --preregistration extractor-v1=evals/intake/preregistration/extractor-v1.md --output data/frozen-run/results.json
```

## Known limitations

- The set is authored and synthetic: it says how systems behave on stated scenarios, not how often those scenarios occur (DF-001, DF-012).
- There are 60 cases and the siblings are paired, so the effective sample is small. Intervals are wide.
- Segment is confounded with customer (one segment per fixture customer).
- The 45-day lookback window is an assumption (DF-003).
- The checklist baseline receives no `as_of`, by design, so relative dates are outside what it can resolve. The comparison measures exactly that gap.
- Errors that the generator and the verifier share would pass without a flag. The audit bounds that rate.
