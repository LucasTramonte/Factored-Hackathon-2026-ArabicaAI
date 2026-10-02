# Evaluation: how we test the intake workflow

**Workflow:** transaction-dispute intake, narrowed to unrecognized card charges with a human handoff ([ADR-002](../ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md)).

**Question:** does a learned component that reads the customer's message do better than a rule-based baseline, on the same cases, without becoming less safe?

This document is the evaluation deliverable, like [`DATA_QUALITY.md`](DATA_QUALITY.md) is for data quality and [ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md) is for capacity and cost. It covers:
- what we test and why;
- the test sets we built;
- how we keep test data from leaking into the systems;
- every option we considered, used or rejected, and why.

**Status (2026-09-30):**
- **Ready:** the baselines are scored, the frozen test set is built, verified and committed by hash, and the harness and statistics are in place.
- **Not run yet:** the frozen comparison, which runs once per system version after the extractor is pre-registered. No result for the learned component on the frozen set exists yet.

## 1. What is compared

| System | What it is |
|---|---|
| Always-handoff reference | Sends every case to a person. It is the floor any useful system must beat |
| Checklist baseline (`evals/intake/baseline.py`) | Hand-written rules. They read amounts, dates, currencies and merchants with fixed patterns |
| Extractor v1 ([ADR-006](../ADRs/ADR-006-learned-extractor-workers-ai.md)) | A pretrained model (gpt-oss-20b on Workers AI) that **only turns the message into facts**. The same written policy as the checklist then decides the action from those facts, the session and the customer's own purchases |

So the comparison measures one thing: **how well each system reads the message.** Identity, ownership, confirmation and permissions stay deterministic in both, outside anything a model writes.

**What we report**, following the brief (problem statement, p. 6):
- correct next action;
- unsafe outcomes, meaning a disclosure or action the customer isn't entitled to;
- missed and unnecessary handoffs;
- p50 and p95 latency;
- cost per attempted case.

All come with their counts and denominators.

"Safe automated resolution" has no numerator for intake, because the right ending is always a person. It is reported as `not defined`. The proposed read-only recent-transactions path would supply it, measured separately.

## 2. The nature of the problem: we lack realistic messages, not labels

The data decides what kind of evaluation is possible:

- **The source text is fixed templates.** There are 5 distinct complaint descriptions in 67,095 complaints, and 42 texts in 171,321 transcripts (DF-001). A model tested on them would only show it can recall a template.
- **No complaint points to a transaction** (DF-003). The data can't tell us which charge a customer disputed.
- **There is no Portuguese text or Portuguese-speaking customer:** all 42 transcript texts are Spanish (DF-001). Ambiguous or duplicate charges almost never occur (DF-012).

Once a message's facts are known, the correct action follows from the written policy ([`POLICY.md`](../../evals/intake/frozen_es_pt_v1/POLICY.md)). So labels are cheap and exact. What the dataset doesn't have is **realistic customer wording**. That shapes every choice below. Techniques built for a shortage of labels, which assume a large pool of real unlabeled messages, don't fit (section 6).

## 3. The test sets: all built by our team

None of the test messages comes from the organizers' data, because it has no usable free text. **We built every set ourselves.**

| Set | Size | Who built it and how | What it may be used for |
|---|---|---|---|
| `development` | 18 | The team | Tuning only. Never reported as an unseen result |
| `evaluation` | 24 | The team, written with knowledge of the corpus | Regression, not an unseen estimate |
| `v1_authored` | 25 | Andrés wrote the phrases without knowing the checklist rules; the team added fixtures, the mapping and gold, all still pending adjudication (three rows are open disagreements) | Regression. The checklist's first check on phrases written without knowledge of its rules (15/25). It is not an unseen estimate |
| `safety` | 22 | The team: red-team cases for injection, other people's cards, refunds and similar | Safety regression |
| **`frozen_es_pt_v1`** | **60** (30 situations, each in Spanish and Portuguese) | **The team.** We wrote the method and the drafting instructions, which spell out the policy, its rules, and the constraints for the synthetic customers and purchases. An isolated model session turned them into `POLICY.md`, the tested rules script `label_rules.py`, the fixture and the messages. We reviewed and tested the result (see below) | **The one unseen comparison, run once per system version** |

**How the frozen set was built** ([details](../../evals/intake/frozen_es_pt_v1/README.md)):
1. **Spec first.** An isolated drafting session (Codex), following our written instructions and allowed to read only an allowlist of files, generated the synthetic customers and purchases within our constraints and wrote a structured spec for each situation: the intent and the facts the customer states. It then wrote a Spanish and a Portuguese message from each spec. The two messages use different wording; one isn't a translation of the other.
2. **Gold by construction.** A tested rules script (`label_rules.py`) applies the written policy to the spec and the fixture, and never reads the message.
3. **Independent verification.** A model of another family (Claude, in a fresh context that could read only the policy and the messages) re-derived the facts and the answer. It agreed on 60/60 answers and on the facts of 58/60.
4. **Human review where it counts.** People answered plain-language multiple-choice questions on every verifier disagreement, plus a seeded random audit. They never saw codes, nor which option was the construction or verifier answer. Two aids are disclosed: Lucas's Spanish review showed a Claude-written Portuguese translation under each message, and Roberto answered after seeing AI suggestions.
   - **Audit:** 0 label errors in 18 random cases, with an exact 95% upper bound of 15.3% (Clopper–Pearson).
   - **Disagreements:** where a reviewer read the policy differently, we decided the rule in writing, and that decision applies to every similar case.

**Current baseline scores** (checklist / always-handoff, correct next action, 0 unsafe everywhere):

| Split | Checklist | Always handoff |
|---|---|---|
| development | 16/18 | 4/18 |
| evaluation | 22/24 | 4/24 |
| v1_authored | 15/25 | 12/25 |
| safety | 20/22 | 8/22 |

The checklist's misses on `v1_authored` are the gap a learned reader should close: currency words, non-ISO and relative dates, and paraphrases.

## 4. How we prevent data leakage

Leakage can happen in two ways here. Statistics from the test period can shape design choices, and people who built or tuned a system can see test cases. Each control below is enforced by code or visible in git history, not left to good intentions.

| Risk | Control | Where it is enforced |
|---|---|---|
| Data from the test period shapes design | Two windows by business timestamp: design before 2026-01-01, holdout after. Only the design window informs prompts, thresholds or fixtures. `process_date` is never used as the event date (DF-004) | `data_profiles/findings/run_findings.py` bounds every design query and has no option to move the window. A test fails if a design query isn't bounded ([ADR-005](../ADRs/ADR-005-evaluation-data-protocol.md)) |
| The model's builder sees test cases | The frozen files stay off the repository behind a SHA-256 commitment. The extractor is built by an isolated agent in a clean checkout where those files don't exist. Since 2026-09-30 that checkout is a history-free snapshot, because a shared-history worktree exposed old versions of a status page (see the disclosures) | `COMMITMENT.json`, and `make_clean_checkout.py`, which refuses a checkout if any withheld path exists or is tracked, or if more than one commit is reachable |
| The test set is changed after the fact | Every committed file (the cases, fixture, gold, verifier files, queues and review answers) must match its SHA-256 when published. Mutable working state (review progress files and the session record) isn't committed and is disclosed as such. The checks run on the machine that holds the withheld files; CI skips them | `rehearse_publication.py`, and the invariance test in `test_label_rules.py` |
| The system is changed after seeing results | Pre-registration binds the prompt file and the implementation file, by hash, to a git tag. The model name is fixed inside that hashed implementation file. The runner refuses to score the frozen set without a valid registration | `evals/intake/preregistration/prereg.py`, `evals/intake/run.py` |
| The frozen set is scored repeatedly until a result looks good | Rule, not code: each registered version is scored once, a fix is a new version, and every version's result is reported. Run outputs are local, so each published result will name its registration, tag and commit | [ADR-005](../ADRs/ADR-005-evaluation-data-protocol.md), decision 4 |
| Tuning on test material | Tuning happens only on `development`. Within a corpus, a scenario family lives in exactly one split, and the runner rejects a corpus that breaks that. Across corpora, the frozen set reuses three skill names from `cases.json`. One of them, `no_match`, is a development family, so the extractor is tuned on that skill and then scored on it with different cases, which is how a held-out test normally works. The other two appear only in `safety`. No frozen case was ever in development | `validate()` in `evals/intake/run.py` (within a corpus) |
| People who saw test cases steer the model | Anyone who has seen a frozen case (Lucas, Roberto, and the assistant sessions that helped them) may not change the model's prompt, parsing or parameters. Policy or label changes need the approval of Manoella, who hasn't seen any frozen case | [ADR-006](../ADRs/ADR-006-learned-extractor-workers-ai.md), decision 5 |
| Test content spreads through documents | Status pages carry aggregates and rules only, never messages or fixture detail | `REVIEW_STATUS.md`, redacted on 2026-09-30 (see the disclosure below) |

**What we disclose**, instead of hiding it:
- **One full-period profiling:** before the time windows existed, we profiled several facts over the full period once. For every fact later used in design, the design-window values agree to one decimal place ([`DATA_QUALITY.md`](DATA_QUALITY.md), Disclosure).
- **The drafting session read one extra file:** the repository's agent configuration, which contains no cases.
- **Roberto's Spanish review isn't blind:** he answered after seeing AI suggestions, so it isn't counted as an independent audit.
- **Frozen-case detail reached git, and the blind build could reach it.** The facts:
  - Until 2026-09-30, `REVIEW_STATUS.md` listed the IDs of 6 frozen cases next to the policy question each one raised and the rule's answer, and named one message's language.
  - Two earlier versions of the same file (commits `f847c47` and `798889f`, later removed in `59067f1`) described 2 more cases with fragments of their messages and their answers.
  - `test_review.py` pins the IDs of 2 cases, with no content.
  - The extractor v1 build ran in a `git worktree`, which shares the repository's history, so all of this was reachable from the builder's checkout. Its [committed instructions](../../evals/intake/preregistration/extractor-v1-builder-instructions.md) allowed only `POLICY.md` and `label_rules.py` in that folder and forbade other branches and reflogs, but not the branch's own history, and git can't prove what was read.
  - Manoella was also told the page was safe to read.

  **In total, 8 of the 60 frozen cases had content exposed (2 of them with message fragments), plus 1 more case ID.** What we did:
  - redacted the page;
  - the frozen result will be **reported with and without those 8 cases**, so any effect of the exposure is visible;
  - the blind checkout is now a history-free snapshot (one commit, no shared objects), tested so that an earlier commit's text can't be reached. The next blind build uses it.
- **Two development labels were corrected:** they contradicted the written policy. The trail and the before and after scores are in the [development log](../../intake_agent/extractor/DEV_LOG.md).

## 5. Statistics, and what 60 cases can and can't show

- **Paired comparison:** exact McNemar test on the cases where the two systems disagree, since both run on the same cases.
- **Rates:** Wilson intervals. **Audit error:** an exact Clopper–Pearson upper bound.
- **Latency:** p95 with a distribution-free order-statistic interval, which needs at least 72 calls to exist. The gate, fixed before any measurement ([ADR-006](../ADRs/ADR-006-learned-extractor-workers-ai.md), Proposed; amendment 1):
  - at least 150 model-calling executions on the development split, pooled across all repetitions into the runner's `repetition: "all"` summary row, each at its wall time with timeouts at their full duration;
  - the p95 of that pooled sample, with the equal-tailed 95% interval reported as `latency_p95_interval_ms`;
  - **pass only if the interval's upper bound is at most 3,000 ms.** Otherwise the latency trigger fires, and the response is a lower reasoning level, not a larger model.
- **Repeated runs:** 3 repetitions of the model, scored by per-case majority, with run-to-run variability reported.
- **Breakdowns:** by scenario family (the skill tested) and by language. A pooled rate is labelled "authored coverage mix, not prevalence".

**The honest limit is size.** We simulated the exact McNemar test (`stats.mcnemar_exact`, α = 0.05, 4,000 draws per row) with 60 paired cases. Each row assumes the share of cases only the model gets right (b) and the share only the checklist gets right (c). Other assumptions give other figures, so the table shows the order of magnitude, not a promise:

| Assumed b / c | Net gain | Chance of detecting it (60 cases) | The same, if each Spanish/Portuguese pair behaves as one case (30) |
|---|---|---|---|
| 10% / 2% | about 8 points | 28% | 4% |
| 15% / 3% | about 12 points | 50% | 15% |
| 25% / 3% | about 22 points | 91% | 53% |

So the frozen set can only show a **large** improvement. That may be enough, because the checklist misses 40% of `v1_authored`. We also state it up front, and before the frozen run we will register the analysis:
- group each Spanish/Portuguese pair so we don't overstate certainty (Miller, 2024);
- declare the smallest effect the sample can detect;
- report whether both languages get the same answer for the same situation. That invariance check comes free with the paired design (Ribeiro et al., 2020).

## 6. Options we considered

| Option | Decision | Why |
|---|---|---|
| Test on the organizers' complaint or transcript text | Rejected | Fixed templates (DF-001). A model would be tested on recall, not reading |
| Random row split of the dataset | Rejected | It mixes time periods and puts near-identical templates on both sides ([ADR-005](../ADRs/ADR-005-evaluation-data-protocol.md)) |
| Train our own text model | Rejected | There is no realistic text to learn from; on templates it would learn a lookup |
| **Pretrained model, zero-shot, extracting facts only** | **Used** | This is transfer learning without training data. The model reads, and the rules decide, so its errors are measurable and its reach is limited |
| Weak supervision (labeling functions, as in Snorkel) | Rejected for evaluation | Our checklist *is* a set of labeling functions. Using it to label test cases would build its known errors into the answer key the model must beat |
| Semi-supervision | Rejected | It needs a large pool of real unlabeled messages, which we don't have |
| Active learning | Deferred to production | With real traffic, the messages where the checklist and the model disagree are the most useful ones for a person to label (query by committee). No traffic exists yet |
| A model as judge to score answers | Rejected | Our outputs are facts and actions that can be checked exactly. A model judge adds inconsistency, cost and known biases (position, verbosity, preferring its own family) without adding information |
| **A model as an independent checker of the test answers** | **Used** | Claude re-derived the answers from the messages, of a different family from the drafting session, and a human audit bounds how often it could be wrong |
| Hand-written cases from spec, gold by rules (outline, then paraphrase) | **Used** for the frozen set | The label is exact by construction, and people only review where the checker disagrees, plus a random audit |
| A larger synthetic tier (code samples situations, another model writes the messages, automatic and human checks) | **Proposed, pending a decision** | It would give the statistical power the 60 cases lack: about 90% to detect an 8-point gain with 200 cases. It would be reported separately and never as real-customer accuracy. It needs a paid Workers AI plan, because the free allocation served fewer than about 280 calls in one day, and a choice of generator model |
| Public benchmarks (MASSIVE for Spanish/Portuguese slots, BANKING77 for banking intents) | Rejected | MASSIVE is virtual-assistant speech in European Spanish and Portuguese, and BANKING77 is English intent classification. Neither tests reading a LATAM dispute message |
| Prediction-powered inference (few labels plus many model predictions) | Rejected | Labels aren't our bottleneck. Realistic messages are |
| Clustered errors, power analysis and invariance reporting | **Adopted**, to be registered before the frozen run | They make the small sample's limits explicit instead of hidden |
| Latency judged on 48 calls against a fixed 3 s trigger | Replaced | 48 calls can't estimate a p95; the trigger would fire 43% of the time at a true p95 of exactly 3 s |

## 7. What the results will and won't claim

**They will say:**
- how each system behaves on stated scenarios, per skill and per language;
- how often it was unsafe, with counts and denominators;
- how fast it answered and what it cost per case.

**They won't say:**
- how often those scenarios happen in real life;
- that the model improves a live service;
- that zero observed unsafe outcomes means zero risk.

The Portuguese results show the system handles Portuguese, not that there is Portuguese demand. Offline results, simulations and projections are labelled separately, as the brief asks.

## 8. Normal resolution path (provisional, ADR-009 Proposed)

The recent-charges view shows a signed-in customer their own recent charges, read-only ([ADR-009](../ADRs/ADR-009-recent-charges-resolution.md)). It is scored by [`evals/inquiry/score.py`](../../evals/inquiry/score.py) on its own stream and never mixed with the intake episodes above.

**Population:** 12 authored cases, each an explicit request run against local D1: Spanish, Portuguese and English × a normal list, an empty one and a first page with more to come, plus an expired session (es), another customer trying to acknowledge the view (pt) and a failure to record the view (en). They test stated situations. They are not a sample of how often customers ask.

**Safe automated resolution** means a view was recorded, the client acknowledged it as displayed, its coverage was declared and nothing unsafe happened. **Unsafe** means another customer's row was served or acknowledged, or a view was recorded or acknowledged without a live session. It is a gate, reported as a count and never netted against successes.

| | Cases | Attempted | Safe automated resolution (95% Wilson) | Unsafe |
|---|---|---|---|---|
| All | 12 | 11 | 10 of 12, 83% (55–95%) | 0 |
| Spanish | 4 | 3 | 3 of 4, 75% (30–95%) | 0 |
| Portuguese | 4 | 4 | 4 of 4, 100% (51–100%) | 0 |
| English | 4 | 4 | 3 of 4, 75% (30–95%) | 0 |

The two cases that are not successes are the designed ones: the expired session is refused before anything is served, and when recording the view fails the rows are still shown but there is no view to acknowledge. **Cost per success** is $0.00: the ADR-004 cost per attempted case on Workers Free ($0) × 11 attempts ÷ 10 successes. On Workers Paid it would depend on real monthly volume, which these cases do not measure.

This shows that, in authored cases, the service served the customer's own charges and the client displayed them. It does not show that a bank resolved anything or that a customer was satisfied. The figures are provisional while ADR-009 is Proposed. To reproduce, from the repository root (the empty `public/` stands in for the compiled client, so `live-flow.test.js`, which needs the real pages, fails in this run):

```bash
rm -f data/charge-views/authored.jsonl && mkdir -p back-end/public && (cd back-end && INQUIRY_OUT=data/charge-views/authored.jsonl node test/run-local.mjs); rmdir back-end/public
.venv/bin/python -m evals.inquiry.score data/charge-views/authored.jsonl
```

**Live page loads** are reported separately, as descriptive counts and display rates only, never as resolutions: a page load is not an explicit request. A person reads them with `cd back-end && npx wrangler d1 execute arabica-intake-demo --remote --json --command "SELECT language, row_count, has_more, coverage, retrieved_at, displayed_at FROM charge_views"`. Those figures are pending until the path is deployed.

## Where to look

- Harness, baselines and splits: [`evals/intake/`](../../evals/intake/README.md)
- Frozen set method and review status: [`evals/intake/frozen_es_pt_v1/`](../../evals/intake/frozen_es_pt_v1/README.md), [`REVIEW_STATUS.md`](../../evals/intake/frozen_es_pt_v1/REVIEW_STATUS.md)
- Pre-registration and blind build: [`evals/intake/preregistration/`](../../evals/intake/preregistration/README.md)
- Protocol and learned component: [ADR-005](../ADRs/ADR-005-evaluation-data-protocol.md), [ADR-006](../ADRs/ADR-006-learned-extractor-workers-ai.md)
- Extractor development log, including the latency measurements: [`intake_agent/extractor/DEV_LOG.md`](../../intake_agent/extractor/DEV_LOG.md)

**References:**
- Ribeiro et al., "Beyond Accuracy: Behavioral Testing of NLP Models with CheckList", ACL 2020.
- Miller, "Adding Error Bars to Evals", 2024.
- Northcutt et al., "Pervasive Label Errors in Test Sets", NeurIPS 2021.
- Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena", NeurIPS 2023.
- Ratner et al., "Snorkel", VLDB 2017.
- Huyen, *Designing Machine Learning Systems* (2022), ch. 4, and *AI Engineering* (2025), chs. 3–4 and 8.
- Shah et al. (2018) and Rastogi et al. (2020) for outline-then-paraphrase data collection.
- Dwork et al. (2015) for using a holdout once.
