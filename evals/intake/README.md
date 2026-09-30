# Suspicious-charge intake: initial evaluation

Start with the [customer and measurement contract](../../Docs/intake/customer-and-measurement-contract.md), then the [baseline notebook](../../notebooks/02_suspicious_charge_intake_baselines.ipynb).

The next [team review package](../../Docs/intake/team-review.md) includes `review-candidates.json`: 24 additional ES/PT messages with proposed labels and blank human-review fields. They remain unscored and are not loaded by the default runner or notebook. They were authored with implementation knowledge, so they are not a blinded holdout.

From the repository root:

```sh
make test-evaluation compile PYTHON=.venv/bin/python
.venv/bin/python -m compileall -q evals
.venv/bin/python -m evals.intake.run
# Optional, requires the completed exploration cache; opens it read-only:
.venv/bin/python -m evals.intake.source_smoke
.venv/bin/jupyter nbconvert --execute --to notebook \
  --ExecutePreprocessor.kernel_name=arabica-exploration \
  --output-dir=data_foundation/runs/intake-evaluation --output=executed \
  notebooks/02_suspicious_charge_intake_baselines.ipynb
```

The stdlib CLI writes case-level predictions and summaries to ignored scratch; the notebook uses the existing notebook dependencies. No model credentials, AWS access or extra dependencies are needed for the 89 authored cases. The notebook's narrative and its development-versus-evaluation leakage check predate corpus v0.2 and were not re-executed. The optional smoke probe uses the local full-data cache and emits only pass/fail evidence, never source IDs.

`cases.json` (v0.2) contains fake transaction/customer IDs, source provenance and four splits: 18 development cases, 24 evaluation cases, 25 V1-authored regression cases and 22 safety cases. Spanish/Portuguese pairs stay in the same scenario-family split, and a family lives in exactly one split. Gold expectations need independent human review. Development and evaluation rules were authored with corpus knowledge; later safety fixes reuse the suite. This is a reproducible initial benchmark, not an unseen performance estimate. Do not tune against it and relabel it unseen.

The `v1_authored` split maps Andrés's V1 scenarios (`Docs/intake/v1_scenarios.md`, PR #9), written without knowledge of the checklist rules, into single-turn decision points; his labels are kept in `author_outcome`. The `safety` split holds red-team decision points for the Notion section 8 scenarios. Mapping, exclusions, label disagreements and the 28/09 results are in [heldout-and-safety-cases.md](../../Docs/intake/heldout-and-safety-cases.md). Rules were not changed after scoring these splits.

`baseline.py` implements handoff-only and checklist references plus strict scoring. `run.py` reports counts/denominators and case-level failures. `episodes.py` scores an episode event log (contract: `Docs/intake/intake-events.md`) into the episode KPIs, with `safe_accepted_intake_rate` over all eligible starts, pending episodes counted as `not_assessed`, and their usage marked unknown. It rejects fields outside the contract; event producers must also keep customer content out of allowed reference values. `source_smoke.py` demonstrates parameter-bound customer ownership checks against the existing exploration schema; it is not a production banking service. Production authentication, durable conversation state, actual customer confirmation UI, case persistence, tracing, retry policy and service integration belong to the team's implementation.

The decision-point completion-ready proxy is not the episode-level primary KPI. Operating cost and episode completion are null until measured. Local one-call timings exclude service/model/network work. Zero observed unsafe cases does not establish production safety, and does not mean zero wrongly refused cases: routing an in-scope request out (the two checklist misses) is scored as incorrect, not unsafe.

## Frozen held-out set

[`frozen_es_pt_v1/`](frozen_es_pt_v1/README.md) is the blind ES/PT set for comparing the checklist with a learned extractor ([ADR-005](../../Docs/ADRs/ADR-005-evaluation-data-protocol.md)). Its gold comes from structured specs through a tested rules script, checked by an independent verifier and a human audit. The case files are withheld behind a hash commitment until the extractor is pre-registered in [`preregistration/`](preregistration/README.md). `python -m evals.intake.run --cases <file>` scores any corpus, and the summary now includes Wilson intervals (`stats.py`).

## Iteration record

1. Wrote safety/denominator tests before implementation; implemented two transparent references.
2. Ran 42 authored cases; preserved two paraphrase failures rather than tuning evaluation phrases into the rules.
3. Independent review found grouped/Unicode-signed money suffix matching, malformed source handling, and safety-scoring omissions. Added failing regression examples, fixed boundaries, and reran the suite. Corrected independence language in the contract/report.
4. Next iteration requires human-reviewed intent cases and a fresh unseen ES/PT set, followed by multi-turn episode evaluation. No learned extractor or impact claim is included in this initial delivery.
5. Added the V1-authored regression (Andrés's phrases) and safety splits without touching the rules. Checklist: 15/25 V1-authored, 20/22 safety, 0 unsafe; ES/PT paired cases score identically. Misses are documented rule limits (no currency code, non-ISO dates, phrases outside the list, no merchant search, per-session-language phrase lists), kept as targets for the agent, not for rule tuning.


## Episode export CLI

From the repository root, score a bounded UTF-8 JSONL export from the Worker:

```bash
python -m evals.intake.episodes data_foundation/runs/intake-events.jsonl > data_foundation/runs/intake-summary.json
```

The input must follow `Docs/intake/intake-events.md`: one event object per line,
opaque references only, no customer content. The command writes JSON aggregates for
`all`, `es` and `pt` to stdout. Invalid JSON/event fields produce a line-numbered
error on stderr; invalid episode sequences/receipts reject the whole log. Errors
exit nonzero without echoing event content or emitting a partial summary.
An empty file produces zero counts and undefined (`null`) rates/latency. Pending
episodes remain in the denominator with unknown safety/usage. This measures safe
accepted intake, not automated resolution. Costs remain `null` until independently
measured. Memory is O(events), for bounded evaluation exports, not full-bank logs.
No new dependencies or scorer changes are needed.
