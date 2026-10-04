# Evaluation: does a model read dispute messages better than rules?

**Workflow:** transaction-dispute intake, narrowed to unrecognized card charges with a human handoff ([ADR-002](../ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md)).

**Question:** when a customer describes a charge in their own words, does a pretrained model turn that message into the right next step more often than hand-written rules, on cases neither was tuned on, without becoming less safe?

**Answer, from the one held-out run (2026-10-04):** yes, by a wide margin, on our authored Spanish and Portuguese cases. Extractor v1 got 53 of 60 cases right against the checklist's 23, with 0 unsafe outcomes. On the 52 cases whose content never leaked it got 46 against 20. Section 1 has the figures. Most of this document is about how far that result can be trusted: how the cases were made, how we kept them away from the people and agents who built the model, and what the method can't show.

## 1. The result

The frozen comparison ran once, on the registered extractor v1 (tag `extractor-v1` at commit `3ad34b5`, `prereg check` passing). It will not run again for this version. A changed prompt, parser, parameter or model is a new version with its own registration.

The model ran 3 times per case, back to back in one batch that ended 2026-10-04 02:42 UTC. A case counts as correct when at least 2 of the 3 runs get both the action and the candidate charges right.

| Frozen set | Extractor v1 (majority of 3) | Checklist | Always hand off to a person |
|---|---|---|---|
| All 60 cases | **53/60, 88.3%** (77.8–94.2%) | 23/60, 38.3% (27.1–51.0%) | 14/60, 23.3% (14.4–35.4%) |
| 52 cases never exposed | **46/52, 88.5%** (77.0–94.6%) | 20/52, 38.5% (26.5–52.0%) | 12/52, 23.1% (13.7–36.1%) |
| Spanish (30) | 27/30 | 12/30 | 7/30 |
| Portuguese (30) | 26/30 | 11/30 | 7/30 |
| Unsafe outcomes | 0 of 180 runs | 0 | 0 |
| Cases that needed a person and didn't get one | 0 of 12 | 12 of 12 | 0 of 12 |

Intervals are 95% Wilson. The 60 cases are an authored coverage mix, so the pooled rate describes that mix, not how often each situation happens in real life.

**Paired comparison.** Both systems ran on the same cases, so we only compare where they disagree:
- **All 60 cases:** the model alone was right on 32 and the checklist alone on 2. Exact McNemar: p ≈ 7×10⁻⁸.
- **The 52 unexposed cases:** 28 against 2, p ≈ 8.7×10⁻⁷.
- **Situations instead of cases.** Each situation appears twice, once per language, so the 60 cases aren't independent. The registered, more conservative analysis counts the 30 situations: the model did better on 20, worse on 2 and the same on 8 (sign test p ≈ 1.2×10⁻⁴).
- **Same answer in both languages:** the model gave the same answer to both versions of a situation in 27 of 30, the checklist in 15.

**Where the model missed.** The 7 misses sit in five scenario families:
- mixed Spanish and Portuguese in one message: 0 of 2;
- a report that also demands a refund: 2 of 4;
- out of scope: 3 of 4;
- a single clear match: 3 of 4;
- an unsupported language: 1 of 2.

Six of the seven were the same wrong answer in all three runs: the model asked the customer to clarify when the policy says to route the case or confirm the charge. That is the safe direction to be wrong in, since the customer is asked again rather than given a wrong charge. Every family has fewer than five cases, so these are counts, not rates.

**Stability, latency and cost:**
- **Repetitions:** 52, 53 and 53 correct. One case of 60 changed its answer between repetitions, and there were no provider failures or timeouts.
- **Latency:** pooled over all 180 model calls, p50 1,313 ms and p95 2,048 ms, with a 95% interval of 1,934–2,308 ms. That passes the 3,000 ms gate fixed in advance. It was measured from a laptop in Brazil to Vertex AI's `global` endpoint, not from the Worker.
- **Tokens:** 331,233 input and 15,095 output, about 1,840 and 84 per call.
- **Cost:** about US$0.027 for the whole batch, or US$0.00015 per call, at the prices the builder recorded from Vertex AI's pricing page on 2026-10-03.

**The checklist did much worse here than in development** (16 of 18 there, 23 of 60 here). It was written by people who knew the development and evaluation cases. On the 25 `v1_authored` phrases, written by someone who didn't know its rules, it already fell to 15. The frozen set confirms that the rules fit the cases they were written against and don't generalize. It also never sent to a person any of the 12 cases that needed one; it asked for clarification instead.

The published aggregates hold no message, customer or case identifier:
- [`frozen-v1-cuts-2026-10-04.json`](../Evidence/evaluation/frozen-v1-cuts-2026-10-04.json): breakdowns by language, family and authored segment, for all cases and the unexposed ones;
- [`frozen-v1-unexposed-2026-10-04.json`](../Evidence/evaluation/frozen-v1-unexposed-2026-10-04.json): the paired tests.

Both carry the SHA-256 of the raw result (`9c0bf131…aaff2d`) and of the scored corpus (`515341c6…3c1bb1`). The raw result, which has per-case predictions, stays on the custodian's machine.

## 2. What is compared, and why only reading

| System | What it is |
|---|---|
| Always hand off | Sends every case to a person. The floor any useful system must beat |
| Checklist (`evals/intake/baseline.py`) | Hand-written rules that read amounts, dates, currencies and merchants with fixed patterns |
| Extractor v1 ([ADR-006](../ADRs/ADR-006-learned-extractor-workers-ai.md)) | OpenAI's gpt-oss-20b on Google Vertex AI (`openai/gpt-oss-20b-maas`, `reasoning_effort: "low"`, temperature 0), used zero-shot. It only turns the message into facts: intent, stated amount, date, merchant, demands, injection attempts |

Both the checklist and the model hand their facts to the same written policy ([`POLICY.md`](../../evals/intake/frozen_es_pt_v1/POLICY.md)), which picks the action from the facts, the session and the customer's own purchases. Identity, ownership, confirmation and permissions stay deterministic, outside anything a model writes. So the comparison isolates one capability, reading, and a model error can't become an action the policy wouldn't take.

We report what the brief asks for (problem statement, p. 6): correct next action, unsafe outcomes, missed and unnecessary handoffs, p50 and p95 latency, and cost per attempted case, always with counts and denominators. Unsafe means disclosing or doing something the customer isn't entitled to: another customer's data, an invented charge, a refund or block, or an unconfirmed match treated as complete. "Safe automated resolution" has no numerator for intake, because the right ending is always a person, so it is reported as `not defined`.

## 3. Why we had to write the test messages

The organizers' data can't test reading:
- **The free text is templates.** There are 5 distinct complaint descriptions across 67,095 complaints, and 42 texts across 171,321 transcripts ([DF-001](DATA_ENGINEERING.md#df-001-source-text-fields-are-fixed-templates)). A model tested on them shows only that it can recall a template.
- **No complaint points to a transaction** ([DF-003](DATA_ENGINEERING.md#df-003-claimed-amounts-are-not-linked-to-transactions)), so the data can't say which charge a customer disputed.
- **There is no Portuguese text at all,** and ambiguous or duplicate charges almost never occur ([DF-012](DATA_ENGINEERING.md#df-012-ambiguous-reports-are-rare-and-double-charges-absent)).

Labels, on the other hand, are cheap. Once a message's facts are known, the policy gives the right action exactly. What's missing is realistic customer wording. That one fact drives every choice below, including the rejection of methods built for a shortage of labels (section 9).

## 4. The test sets

Every set was written by our team; none comes from the organizers' data.

| Set | Size | How it was made | What it may be used for |
|---|---|---|---|
| `development` | 18 | The team | Tuning only. Never reported as an unseen result |
| `evaluation` | 24 | The team, knowing the corpus | Regression |
| `v1_authored` | 25 | Andrés wrote the phrases without knowing the checklist's rules; the team added fixtures and gold (three rows are still open disagreements) | Regression; the checklist's first test on phrases written blind to it (15/25) |
| `safety` | 22 | The team: injection, other people's cards, refund demands | Safety regression for the checklist |
| `frozen_es_pt_v1` | 60: 30 situations, each in Spanish and Portuguese | Described in section 5 | The one held-out comparison, once per system version |

## 5. How the frozen set was made and checked

The method is outline-then-paraphrase (Shah et al., 2018; Rastogi et al., 2020): fix the meaning first, then write the words, so the label never depends on reading the words.

1. **Spec first.** We wrote the drafting instructions: the policy, its rules and the constraints for synthetic customers and purchases. An isolated Codex session, allowed to read only an allowlist of files, generated 4 fictitious customers, 32 card purchases and 30 situation specs (the intent and the facts the customer states). It then wrote a Spanish and a Portuguese message from each spec, in different words; neither is a translation of the other.
2. **Gold by construction.** `label_rules.py` applies the written policy to the spec and the fixture. It never reads the message, so the answer key can't inherit a reading mistake. Its behaviour is pinned by its own tests.
3. **Independent check.** Claude, a different model family from the drafter, in a fresh context that could read only the policy and the messages, re-derived the facts and the answer from each message. It agreed on all 60 answers and on the facts of 58.
4. **People where it matters.** Reviewers answered plain-language multiple-choice questions on every disagreement, plus a seeded random audit of 18 cases. They saw neither codes nor which option was the construction's or the checker's.
   - **Audit result:** 0 label errors in 18, which bounds the label error rate below 15.3% with 95% confidence (exact Clopper–Pearson).
   - **Disagreements:** where a reviewer read the policy differently, we wrote down the rule and applied it to every similar case. All five questions kept the existing rule.
5. **Frozen by hash.** Every withheld file (fixture, specs, messages, gold, checker files, review answers) is committed only as a SHA-256 in `COMMITMENT.json`. The test suite recomputes those hashes on the machine that holds the files, and they matched before the run.

## 6. How we kept the test set away from the model

There are two ways test data leaks into a result here: statistics from the test period shape the design, or someone who saw test cases shapes the system. Each control is enforced by code or visible in git, not left to good intentions.

| Risk | Control | Enforced by |
|---|---|---|
| Test-period data shapes the design | Two windows by business timestamp: design before 2026-01-01, holdout after. Only the design window informs prompts, thresholds or fixtures. `process_date` is never treated as the event date ([DF-004](DATA_ENGINEERING.md#df-004-processing-partition-precedes-the-event-date-for-early-hour-events)) | `run_findings.py` bounds every design query and has no option to move the window; a test fails on an unbounded query ([ADR-005](../ADRs/ADR-005-evaluation-data-protocol.md)) |
| The model's builder sees test cases | The frozen files never enter the repository. The extractor was built by an isolated agent in a checkout where those files don't exist | `COMMITMENT.json`; `make_clean_checkout.py` refuses a checkout if a withheld path exists or is tracked, or if more than one commit is reachable |
| People who saw cases steer the model | Lucas, Roberto and the assistant sessions that helped them have seen frozen cases, so none of them may change the prompt, parsing or parameters. Behaviour and label changes need Manoella, who has seen none | [ADR-006](../ADRs/ADR-006-learned-extractor-workers-ai.md), decision 5 |
| The system changes after seeing results | Pre-registration binds the prompt, the implementation and its dependency by SHA-256 to a git tag, with the model id and parameters. The runner refuses to score the frozen set without a valid registration, and the check passed before this run | `prereg.py`, `run.py` |
| The test set changes after the fact | Every withheld file must match its committed hash when published | `rehearse_publication.py`, `test_artifacts.py` |
| Scoring repeatedly until it looks good | Each registered version is scored once, and every version's result is reported. This was the only run of extractor v1 | ADR-005, decision 4 (a rule, not code) |
| Tuning on test material | Tuning used only `development`. A scenario family lives in exactly one split within a corpus, and the runner rejects a corpus that breaks that. The frozen set shares one skill name (`no_match`) with development, scored on different cases, which is how a held-out test normally works | `validate()` in `run.py` |
| Test content spreads through documents | Status pages carry rules and aggregates, never messages or fixture detail | `REVIEW_STATUS.md` |

**What got through, and what it did to the result.** We found and disclosed these before the run:
- **8 of the 60 cases had content in git.** Until 2026-09-30, `REVIEW_STATUS.md` listed 6 case IDs with the policy question each raised, and two earlier versions of it held fragments of 2 more messages. A ninth ID appears in a test file with no content.
- **The builder could have reached them.** The extractor was built in a `git worktree`, which shares the repository's history. Its instructions forbade other branches and reflogs but not the branch's own history, and git can't prove what was read.
- **The fix:** we redacted the page and moved the blind checkout to a history-free snapshot, tested so an earlier commit's text can't be reached. We also registered in advance that the result would be reported with and without those 8 cases.

The 52-case cut answers whether the leak helped: the model scored 88.5% without the exposed cases and 88.3% with them. On the 8 exposed cases it got 7 right, and the checklist 3. There is no sign that exposure inflated the result, though 8 cases are too few to prove it had no effect.

**Other disclosures:**
- **One full-period profiling** happened before the time windows existed. For every fact later used in design, the design-window value agrees to one decimal place.
- **The drafting session read one file outside its allowlist,** the repository's agent configuration, which contains no cases.
- **Two reviews weren't blind.** Roberto answered the Spanish review after seeing AI suggestions, so it isn't counted as an independent audit. Lucas reviewed Spanish with a machine translation beside each message.
- **Two development labels were corrected** because they contradicted the written policy. The trail is in the [development log](../../intake_agent/extractor/DEV_LOG.md).
- **Two run-record gaps:**
  - The runner writes `gold_status: "Authored; pending team review"` into every result. That text predates the review and is stale; the gold was reviewed as described in section 5.
  - The runner records only the batch's end time, not its start, and the provider returned no model build metadata to record. The batch ran in one sitting of a few minutes, well inside the registered 24-hour limit.

## 7. The analysis, fixed before the run

The pre-registration ([`extractor-v1.md`](../../evals/intake/preregistration/extractor-v1.md)) fixed these choices before any frozen case was scored:
- **Primary metric:** correct next action by per-case majority over 3 repetitions, with Wilson intervals, on all 60 cases and on the 52 unexposed.
- **Comparison:** exact McNemar on the discordant cases, plus a situation-level analysis, because the Spanish and Portuguese versions of a situation are correlated (Miller, 2024).
- **Safety:** unsafe outcomes as a count over every run, never averaged against successes.
- **Breakdowns:** by language, scenario family and cross-language consistency (CheckList-style invariance, Ribeiro et al., 2020). Groups under 5 cases are descriptive only.
- **Latency:** p95 over all model calls, with a distribution-free order-statistic interval. The gate passes only if the interval's upper bound is at most 3,000 ms, which needs at least 72 calls.
- **Stability:** the model's run-to-run changes, counted separately from provider failures (amendment 9).
- **Reporting:** the result is published whatever it is.

**What 60 cases could detect.** Before the run we simulated the exact McNemar test with 60 paired cases (α = 0.05, 4,000 draws per row). Because each situation appears twice, the last column treats each language pair as one case (30):

| Assumed share only the model gets right / only the checklist | Net gain | Chance of detecting it | If each language pair counts as one case |
|---|---|---|---|
| 10% / 2% | about 8 points | 28% | 4% |
| 15% / 3% | about 12 points | 50% | 15% |
| 25% / 3% | about 22 points | 91% | 53% |

The set could only show a large improvement. The observed gain was about 50 points, so detection isn't the issue. Precision is: the model's rate is known only to within roughly 77–94%.

## 8. Limits of this method

These limit what the result means. None of them is hidden in the numbers above.

- **Authored, not real, messages.** Every message was written by a model from our specs. They cover the situations we thought of, in the style a model writes. Real customers write shorter messages, with typos and slang, and sometimes several topics at once. The result says the model reads our coverage set well, not how it does on real traffic.
- **The writer and the reader may share a style.** The messages were drafted by an OpenAI model (Codex) and the system under test is an OpenAI open-weight model. A shared style could make the messages easier for it to read. The independent checker was a different family (Claude) and agreed on 60 of 60 answers, which limits but doesn't remove the concern.
- **Correct means agrees with our policy.** Gold comes from our written policy applied to our specs. If the policy is wrong for a bank, both systems are judged against the same wrong answer. The result measures reading, not whether the policy is right.
- **Small and correlated.** 60 cases from 30 situations. Every family breakdown has fewer than 5 cases. The label audit bounds error only below 15.3%.
- **Single-turn.** Each case is one message. The live guided flow is a sequence of steps, and a conversational follow-up wasn't tested.
- **One host, one day, one endpoint that is going away.** Vertex AI exposes no immutable snapshot for `gpt-oss-20b-maas`, and Google retires the endpoint on 2026-10-21. The result doesn't transfer to its successor, which needs its own registration and fresh held-out cases, since this frozen set has now been used.
- **The baseline is ours.** The checklist is a reasonable rules engine, not the best one possible. A team that spent more time on rules, or a small trained classifier, could narrow the gap.
- **The latency wasn't measured where it would run.** It was measured from a laptop to Vertex AI, not from the Worker, and without the deterministic matching and database work an online request adds.
- **Nothing here measures a customer outcome.** It shows better reading. It doesn't show that a customer finishes a report faster or that an agent resolves anything sooner.
- **The model never ran on the 22 `safety` cases.** Its 0 unsafe comes from the frozen set's own adversarial situations; only the checklist was scored on the dedicated red-team set.

## 9. What else could have been tested

In rough order of value, with what stopped us:

1. **Real customer messages.** Shadow mode on live traffic, where the model reads but changes nothing, would give real wording and the share of customers who can't find their charge, the number that decides whether the AI path is worth running ([ADR-012](../ADRs/ADR-012-ai-online-only-where-evidence-shows.md), condition 3). There is no real traffic yet: the live service has 5 episodes, all team sessions.
2. **A second, larger held-out set from another model family.** About 200 cases written by a different generator (for example Gemini or Claude), with the same spec-first gold, would remove the shared-style concern and give about 90% power for an 8-point gain. This is also what a successor model needs, since the frozen set is spent. It needs a generator, an inference budget and a protocol decision.
3. **Harder language.** Code-switching between Spanish and Portuguese (the model's weakest family, 0 of 2), regional variants (Mexican, Colombian, Argentine, Brazilian), typos, voice-to-text output and very short messages. CheckList-style perturbations (change the amount format, make the date relative, add noise) would test these systematically.
4. **The red-team set against the model.** Running the 22 `safety` cases and a larger injection set through the model, not just the checklist.
5. **Other models and sizes.** gpt-oss-120b, a small fast model, and a frontier model on the same cases, to put accuracy, latency and cost on one chart and pick the successor with evidence.
6. **A stronger baseline.** Rules written blind by someone outside the team, or a small trained classifier, so the model has to beat a serious alternative.
7. **Fully blind native review.** Native speakers from each country, who have seen no AI suggestions, labelling a larger random sample. That tightens the 15.3% label-error bound.
8. **Latency and failure from the Worker itself.** The full suggestion path (token exchange, model call, matching, database), measured where it would run, under the 2,000 ms request target.
9. **A product outcome.** A pilot that measures whether suggestions cut the time an agent spends matching a charge, or how often customers confirm a suggested charge, against today's manual match.

## 10. Options we considered

| Option | Decision | Why |
|---|---|---|
| Test on the organizers' complaint or transcript text | Rejected | Templates; it would test recall, not reading |
| Random row split of the dataset | Rejected | Mixes time periods and puts near-identical templates on both sides |
| Train our own text model | Rejected | No realistic text to learn from; on templates it would learn a lookup |
| Pretrained model, zero-shot, extracting facts only | Used | Transfer without training data. The model reads and the rules decide, so its errors are measurable and its reach is limited |
| Weak supervision (Snorkel-style labelling functions) | Rejected | The checklist is a set of labelling functions; using it to label tests would bake its errors into the answer key |
| Semi-supervision | Rejected | Needs a large pool of real unlabelled messages, which we don't have |
| Active learning | Deferred | Useful once real traffic exists: cases where the checklist and the model disagree are the best ones for a person to label |
| A model as judge of the answers | Rejected | Facts and actions can be checked exactly; a judge adds cost, inconsistency and known biases |
| A model as independent checker of the gold | Used | A different family re-derived every answer; a human audit bounds its error |
| Spec-first cases with gold by rules | Used | Exact labels; people review only disagreements plus a random audit |
| Public benchmarks (MASSIVE, BANKING77) | Rejected | European Spanish and Portuguese assistant speech, or English intents; neither is a LATAM dispute message |
| Prediction-powered inference | Rejected | Labels aren't the bottleneck |
| Clustered analysis, power analysis, invariance | Adopted before the run | They make a small sample's limits explicit |
| Latency judged on 48 calls against a fixed 3 s | Replaced | 48 calls can't estimate a p95 |

**How we got here in development.** On Workers AI at the provider's default reasoning level, development was accurate but slow (pooled p95 3,582 ms, failing the gate), so amendment 7 moved the evaluation to Vertex AI and amendment 8 set `reasoning_effort: "low"`. At low, development scored 18 of 18 by majority, 0 unsafe, a p95 upper bound of about 2,340 ms, and instability that passed under Manoella's amendment 9 ruling. The full trail is in the [development log](../../intake_agent/extractor/DEV_LOG.md) and the [historical development cuts](../Evidence/evaluation/development-cuts-2026-10-01.json).

## 11. Other measurements

These come from separate streams and are never pooled with the frozen result.

**Recent-charges view** (provisional, [ADR-009](../ADRs/ADR-009-recent-charges-resolution.md) Proposed), scored by [`evals/inquiry/score.py`](../../evals/inquiry/score.py) on 12 authored requests against local D1:
- **Results:** 10 of 12 were safe automated resolutions (83%, 55–95%), 0 unsafe. Two of the 12 were written to fail (an expired session and a recording failure), so 10 is the maximum.
- **Limit:** the cases were written with the code they test. They show it does what its authors intended, not how it does on unseen requests.
- **To reproduce:** `make intake-ui-build`, then `INQUIRY_OUT=data/charge-views/authored.jsonl npm --prefix back-end run test:integration`, then `.venv/bin/python -m evals.inquiry.score data/charge-views/authored.jsonl`.

**Live service:** 5 report episodes exported from remote D1 on 2026-10-02, all team and reviewer sessions since the last demo reset, on the guided flow, which calls no model.
- **Outcomes:** 4 complete handoffs, 1 incomplete ("I can't find it"), 0 recorded unsafe. Safety is recorded as `not_assessed`, never as safe.
- **Episode span:** p50 11.6 s, p95 14.7 s. That includes the customer's reading and typing.
- **Cost:** $0 on Workers Free, with no model calls.
- **Limit:** five episodes support no rate.
- **To reproduce:** `node scripts/close-idle-intakes.mjs --remote` and `node scripts/export-intake-events.mjs --remote`, from `back-end/`. A person runs these, because the first one writes.

**Report-request latency:** the target is p95 below 2,000 ms. The only timed evidence is one `POST /intake/confirm` at 1,268 ms and one `POST /intake/start` at 368 ms, from an older version. **The target is not demonstrated.** [`summarize_worker_latency.py`](../../scripts/summarize_worker_latency.py) summarizes a future authorized export.

## Reproducing and where to look

The frozen run, the custodian's commands (the run is not repeated for this version):

```bash
.venv/bin/python -m evals.intake.preregistration.prereg check --file evals/intake/preregistration/extractor-v1.md
.venv/bin/python -m evals.intake.run --cases evals/intake/frozen_es_pt_v1.candidate.json --repetitions 3 \
  --system extractor-v1=intake_agent.extractor.vertex:extract \
  --preregistration extractor-v1=evals/intake/preregistration/extractor-v1.md --output data/frozen-run/results.json
.venv/bin/python -m evals.intake.report_cuts data/frozen-run/results.json evals/intake/frozen_es_pt_v1.candidate.json \
  --exposed <private exposed-id list> > data/frozen-run/cuts.json
.venv/bin/python -m evals.intake.frozen_report data/frozen-run/results.json --system extractor-v1 \
  --exposed <private exposed-id list> > data/frozen-run/unexposed-comparison.json
```

- Harness, baselines and splits: [`evals/intake/`](../../evals/intake/README.md)
- Frozen set method and review status: [`frozen_es_pt_v1/`](../../evals/intake/frozen_es_pt_v1/README.md), [`REVIEW_STATUS.md`](../../evals/intake/frozen_es_pt_v1/REVIEW_STATUS.md)
- Pre-registration and the blind build: [`evals/intake/preregistration/`](../../evals/intake/preregistration/README.md)
- Protocol and learned component: [ADR-005](../ADRs/ADR-005-evaluation-data-protocol.md), [ADR-006](../ADRs/ADR-006-learned-extractor-workers-ai.md); whether the model goes online: [ADR-012](../ADRs/ADR-012-ai-online-only-where-evidence-shows.md)

**References:**
- Ribeiro et al., "Beyond Accuracy: Behavioral Testing of NLP Models with CheckList", ACL 2020.
- Miller, "Adding Error Bars to Evals", 2024.
- Northcutt et al., "Pervasive Label Errors in Test Sets", NeurIPS 2021.
- Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena", NeurIPS 2023.
- Ratner et al., "Snorkel", VLDB 2017.
- Shah et al. (2018) and Rastogi et al. (2020) for outline-then-paraphrase data collection.
- Dwork et al. (2015) for using a holdout once.
- Huyen, *Designing Machine Learning Systems* (2022), ch. 4, and *AI Engineering* (2025), chs. 3–4 and 8.
