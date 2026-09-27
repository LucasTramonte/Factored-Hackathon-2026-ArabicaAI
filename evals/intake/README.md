# Suspicious-charge intake: initial evaluation

Start with the [customer and measurement contract](../../Docs/intake/customer-and-measurement-contract.md), then the [baseline notebook](../../notebooks/02_suspicious_charge_intake_baselines.ipynb).

The next [team review package](../../Docs/intake/team-review.md) includes `review-candidates.json`: 24 additional ES/PT messages with proposed labels and blank human-review fields. They remain unscored and are not loaded by the default runner or notebook. They were authored with implementation knowledge, so they are not a blinded holdout.

From the repository root:

```sh
make test compile PYTHON=.venv/bin/python
.venv/bin/python -m evals.intake.run
# Optional, requires the completed exploration cache; opens it read-only:
.venv/bin/python -m evals.intake.source_smoke
.venv/bin/jupyter nbconvert --execute --to notebook \
  --ExecutePreprocessor.kernel_name=arabica-exploration \
  --output-dir=data_foundation/runs/intake-evaluation --output=executed \
  notebooks/02_suspicious_charge_intake_baselines.ipynb
```

The stdlib CLI writes case-level predictions and summaries to ignored scratch; the notebook uses the existing notebook dependencies. No model credentials, AWS access or extra dependencies are needed for the 42 authored cases. The optional smoke probe uses the local full-data cache and emits only pass/fail evidence, never source IDs.

`cases.json` contains fake transaction/customer IDs, source provenance, 18 development cases and 24 evaluation cases. Spanish/Portuguese pairs stay in the same scenario-family split. Gold expectations need independent human review. Rules were authored with corpus knowledge; later safety fixes reuse the suite. This is a reproducible initial benchmark, not a blinded held-out performance estimate. Do not tune against it and relabel it unseen.

`baseline.py` implements handoff-only and checklist references plus strict scoring. `run.py` reports counts/denominators and case-level failures. `source_smoke.py` demonstrates parameter-bound customer ownership checks against the existing exploration schema; it is not a production banking service. Production authentication, durable conversation state, actual customer confirmation UI, case persistence, tracing, retry policy and service integration belong to the team's implementation.

The decision-point completion-ready proxy is not the episode-level primary KPI. Operating cost and episode completion are null until measured. Local one-call timings exclude service/model/network work. Zero observed unsafe cases does not establish production safety.

## Iteration record

1. Wrote safety/denominator tests before implementation; implemented two transparent references.
2. Ran 42 authored cases; preserved two paraphrase failures rather than tuning evaluation phrases into the rules.
3. Independent review found grouped/Unicode-signed money suffix matching, malformed source handling, and safety-scoring omissions. Added failing regression examples, fixed boundaries, and reran the suite. Corrected independence language in the contract/report.
4. Next iteration requires human-reviewed intent cases and a fresh unseen ES/PT set, followed by multi-turn episode evaluation. No learned extractor or impact claim is included in this initial delivery.
