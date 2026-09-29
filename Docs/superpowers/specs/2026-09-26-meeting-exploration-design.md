# ArabicaAI meeting exploration

Status: approved to proceed to planning after the user's scope and schema review.

## Purpose and scope

Give Roberto and the team reproducible evidence for selecting one customer-service workflow. Work on the existing `feat/roberto-data-exploration` branch. Produce one executed Jupyter notebook and a one-page meeting brief comparing two or three candidates. Cover contact demand, complaint impact, and transaction fraud; an early meeting readout may use complete service tables, but completion of this task includes the transaction analysis.

The user's confirmed primary areas are contact-center information and fraud prevention. Complaints and transcripts support those areas. Fraud prevention analysis must distinguish descriptive patterns from information actually available before a transaction decision.

Dispute intake is a hypothesis, with account/payment inquiries as comparators. The analysis may conclude that the evidence does not distinguish candidates. It must not manufacture a winning workflow or claim business improvement from synthetic descriptive data.

## Sources and boundaries

- Read the four official PDFs indexed in `Docs/sources/README.md`; the complete PDF dictionary governs documented schema. Report discrepancies with actual headers. The credential-bearing newer dictionary is not a repository input.
- Follow `BUSINESS_OUTCOMES.md`, `ARCHITECTURE.md`, `REPRODUCIBILITY.md`, and repository data-processing rules. Existing scanner outputs are not proof that all quality or join checks passed.
- Input is the authorized S3 dataset downloaded under ignored `data/`. Record object inventory, sizes, coverage, and run time without credentials. Freeze the list of verified input files for each run; refuse incomplete required tables for the final run.
- Raw files are read-only. Credentials, raw customer rows, intermediate databases, caches, and generated reports remain outside tracked source. Committed notebooks have outputs cleared; executed copies and the brief are delivered under the task's `outputs/` directory.
- No model training, dashboard, application implementation, publication, or messages to the team are included.

## Notebook structure

`notebooks/01_customer_service_workflow_exploration.ipynb` will contain:

1. **Summary:** observed findings and candidate recommendation, written after execution.
2. **Context and methods:** decision, synthetic-data limitation, parameters, sources, metric definitions, quality policy, and coverage.
3. **Data quality:** exact headers, date coverage, missingness, invalid values, duplicate IDs, and any joins actually used.
4. **Contact demand:** contact-reason and category volumes; resolution, follow-up and escalation rates; handling/wait times; relevant channel and country breakdowns where supported.
5. **Complaint impact:** category/subcategory volume, status, SLA breaches, repeat-complainer flag, and resolution time for cases with usable resolution evidence. Show open cases separately.
6. **Fraud context:** labeled fraud prevalence, transaction categories/channels, and monetary exposure with currency and missingness made explicit. Fraud labels and scores are descriptive inputs, not proof of predictive performance or safe automation.
7. **Workflow comparison and takeaways:** two or three candidates, evidence, limitations, proposed safe automation boundary, baseline, metric, and team decisions still needed.

Keep exact-value tables beside readable charts: contact demand, contact outcomes, complaint impact, and fraud comparisons. Every chart identifies its population, date range, units and denominator. Do not show raw transcript text or customer identifiers in deliverables. Transcript metadata can establish language/coverage; full NLP analysis is outside this notebook.

## Analytical rules

- Preserve source field names. Read UTF-8 BOM safely. Missing or invalid booleans stay unknown rather than becoming false.
- Use interaction, complaint and transaction grains separately. Report raw row counts, distinct nonblank IDs, duplicate/conflicting IDs, and eligible analytical counts.
- Exclude every occurrence of a duplicated primary ID from primary entity-level metrics, rather than choosing an arbitrary record. Report the number and share excluded; compare raw-row rankings to reveal sensitivity to this policy. Blank IDs are also excluded and counted. Document this conservative rule visibly.
- Rates use eligible records with valid known values for the relevant field; display numerator, denominator, unknown count and total eligible population. A null outcome is not a successful or unsuccessful outcome. The dictionary describes `was_resolved` as resolved on first call: label it documented FCR, and distinguish the supplied flag from independently validated repeat-contact behavior.
- Use event dates for analysis and `process_date` for physical coverage. Include all available verified partitions for the descriptive baseline; report invalid event dates separately and omit them only from date-based views. Do not invent a period filter or ignore late arrivals.
- Use medians and appropriate upper percentiles for valid nonnegative durations. Separate unresolved/open complaints from observed resolution durations; do not assign them zero duration.
- Sum local amounts only within currency. USD comparisons use valid `amount_usd` and show conversion coverage. Do not substitute zero for missing conversion values.
- Treat `is_fraud` as the target, never a predictor. `fraud_score` requires provenance and timing verification before use as a baseline or feature. Treat `transaction_status` and `response_code` as potentially post-decision information. Any proposed historical feature must use only prior transactions. Fraud-labeled amounts are exposure, not proven realized loss.
- Validate dimension key uniqueness before enrichment; ambiguous or absent matches remain explicit unknown groups. Snapshot customer attributes are not historical attributes at event time.
- A complaint may reference an interaction through `origin_interaction_id`; validate both uniqueness and link coverage before use, and aggregate complaints before attaching them to interactions. Never join facts directly on `customer_id` or infer a disputed transaction from that key. A complaint-to-transaction relationship is not established by the dictionary.
- Do not use undocumented score weights. Compare demand, customer impact, data sufficiency, automation boundaries, handoff and evaluability side by side; describe judgment separately from measured evidence.

## Implementation and memory

Reuse existing deterministic file discovery where it fits. Keep orchestration, calculations and presentation inspectable from the notebook. Add only a small analysis helper if needed for tested parsing, quality checks and aggregation; do not refactor the baseline scanner as part of this task.

Stream CSV rows or bounded chunks with projected columns. Use standard-library SQLite in an ignored scratch location for cross-partition key counts and exact disk-backed aggregations when required. Never retain all fact IDs in a Python set. Bound SQLite memory/cache; intermediate storage may grow with input size. Python memory is bounded by chunk size, small dimension lookups and compact aggregate outputs, not fact-row count. Emit progress at table or file-batch boundaries.

Prefer existing installed notebook and plotting libraries. The notebook must document its runtime dependencies and accept a data-root parameter without embedding machine-specific source paths or credentials.

## Verification and delivery

Follow the repository's small-to-large progression. Before production scans, use a focused fixture covering BOM headers, cross-file duplicate IDs, conflicting IDs, missing/invalid flags, missing USD amounts, open complaints and ambiguous joins. Verify expected numerators/denominators and equivalent results across chunk sizes. Run a smoke subset, then verified complete required tables.

Validate notebook format, execute in a clean kernel top-to-bottom, reconcile chart/table counts, and inspect the saved HTML preview and figures at reading size. Fail clearly on required schema or coverage failures; do not publish partial execution as a finished notebook.

Deliver:

- Reusable source notebook on the exploration branch, with minimal supporting code and focused regression checks if needed.
- Executed notebook and a portable HTML preview under task `outputs/`.
- One-page meeting brief under task `outputs/`, with three strongest supported findings, candidate comparison, recommendation or unresolved choice, limitations, and proposed next ownership decisions.

The selected product workflow must eventually support Spanish and Portuguese, clarification/abstention, permission-safe tools, and human handoff. Supplied Spanish text alone cannot establish Portuguese capability. This notebook proposes an evaluation baseline and denominators; it does not claim the future system has passed evaluation.

## Acceptance criteria

The task is complete only when the separate branch is verified, all three analytical areas have executed on verified inputs, quality exclusions and metric denominators are auditable, charts and conclusions agree with outputs, regression checks pass, and the executed notebook/preview/brief are accessible. A running download, a written notebook without execution, or a hypothesis presented as a finding does not meet completion.
