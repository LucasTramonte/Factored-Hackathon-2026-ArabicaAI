# Suspicious-charge intake: initial evaluation delivery

26 September 2026 • Authored synthetic scenarios • Human gold-label review pending

**Delivered:** a proposed customer/scope definition, KPI dictionary and instrumentation plan; handoff-only and deterministic checklist references; 42 ES/PT cases; reproducible scoring, notebook and case-level results.

| Authored evaluation split | Correct next action | Unsafe observed | Safe complete / completion-ready |
|---|---:|---:|---:|
| Handoff-only reference | 4/24 | 0/24 | 0/4 |
| Deterministic checklist | 22/24 | 0/24 | 4/4 |

The two checklist failures are unsupported ES/PT paraphrases. Keep them visible; the evaluation set must not be tuned into a supposed unseen test. Translated pairs are correlated, gold labels were authored with rule knowledge, and safety-review fixes reused this suite. These results are an initial regression benchmark, not generalization or production evidence. The 4/4 completion-ready result is **not** the episode-level safe complete intake KPI; episodes, abandonment, operating cost and real service latency remain unmeasured.

Independent review identified parsing and scorer boundary gaps; regressions were added and fixed. All 26 tests pass (12 foundation + 14 intake), compilation and clean-kernel notebook execution pass. A separate read-only smoke check against the full-data cache confirms an owned transaction and rejects a foreign confirmation on one source transaction; this does not establish full-data performance or coverage.

## Reviewable artifacts

- [Customer, scope, KPI and instrumentation contract](../../../Docs/intake/customer-and-measurement-contract.md)
- [Executed notebook](executed.ipynb)
- [HTML analysis](analysis.html) — download to view
- [Case-level results and provenance hashes](results.json)
- [Reproduction and iteration guide](../../../evals/intake/README.md)

## Next team review

Confirm customer boundaries and required intake evidence, then review the authored gold cases. Andrés/Lucas should help create a fresh unseen ES/PT set and multi-turn episodes. Compare the future learned extractor against these fixed references on that same workload. Manoella's service layer must enforce identity and permissions, persist accepted handoffs and instrument actual tool outcomes. No business savings, fraud losses or operating improvement is claimed.
