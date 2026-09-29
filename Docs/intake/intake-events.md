# Intake event contract v1

Roberto, 29 September 2026. Proposed for Lucas (backend) and Manoella (tools). Implements the instrumentation paragraph of the [customer and measurement contract](customer-and-measurement-contract.md) so the episode primary KPI, "safe accepted intake / all eligible episodes started", can be computed from a log instead of estimated. The offline scorer is `evals/intake/episodes.py`; run `.venv/bin/python -m pytest evals/intake/test_episodes.py`.

## Rules

- **One episode = one `case_id`**, minted by the service when intake starts, before any case row exists. It is stable for the whole conversation and reused on retries. It is not the customer-facing reference; that is `case_ref`, minted only after the case row is committed. Retries must not re-emit the chain events (`transaction_confirmed`, `handoff_created`, `handoff_accepted`): the service deduplicates before logging, and the scorer rejects an episode that repeats one. The contract's attempt ID is not needed for that; add it only if per-attempt latency becomes a question.
- **Every event carries the base fields** below. Events are append-only JSON lines; the scorer sorts by `ts` within a `case_id`, so clocks must be monotonic per service instance.
- **No customer content in events.** `customer_id`, the customer's statement, transaction evidence and names stay in access-controlled case storage. Events carry references (`session_ref`, `transaction_ref`, `case_ref`). The scorer checks every event against a per-event allowlist and rejects the whole log on any field outside this contract, so customer content cannot enter analytics under any key.
- **An episode starts when an authenticated customer's request is classified as an unrecognized-charge report in a supported language.** Out-of-scope requests (balance inquiry, recognized billing dispute, English) are routed and never start an episode; they are decision points for the single-turn harness, not episodes. The contract's all-attempt safety and routing metrics are therefore not computable from this log; they come from `run.py`. Contract outcome names map as: completed → `accepted`; unsupported → `routed` when it happens after a start; authentication_failed never starts an episode.
- **Every started episode ends** with exactly one `intake_ended`, including abandonment (session expiry or silence after a timeout the service defines), withdrawal, technical failure and routing after start. An episode without `intake_ended` at scoring time is `pending` and stays in the denominator.
- **Acceptance is a chain, not a flag.** `safe_accepted` requires, in order: `transaction_confirmed` → `handoff_created` with `kind = complete` → `handoff_accepted` → `intake_ended` with `outcome = accepted` and `safety = assessed_safe`. Any link missing means the episode is not accepted, whatever the outcome field says.
- **`safety` is a gate.** `unsafe` episodes are counted and reported separately, never netted against accepted ones. `not_assessed` is reported as unknown, never as safe.

## Base fields (every event)

| Field | Type | Meaning |
|---|---|---|
| `event` | string | one of the six names below |
| `version` | string | `"1"` |
| `case_id` | string | episode key, service-minted at start |
| `ts` | string | exactly `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC, milliseconds); the scorer rejects any other shape because it sorts by this string |
| `session_ref` | string | opaque reference to the authenticated session, never the customer id |
| `language` | string | `es` or `pt`, the conversation language chosen at start |
| `model_version` | string | rule or model identifier, e.g. `checklist-0.1`, `claude-fable-5-1@prompt-v3` |

## Events

| Event | Extra fields | When |
|---|---|---|
| `intake_started` | `scenario` (string, optional: authored scenario id in evaluation runs) | request classified as unrecognized-charge intake |
| `clarification_requested` | `missing` (list of strings: `date`, `currency`, `amount`, `matching_transaction`, `transaction_disambiguation`, `customer_confirmation`, `valid_customer_confirmation`) | the assistant asks the customer for something; the values reuse `baseline.py`'s missing-information names |
| `transaction_confirmed` | `transaction_ref` (string, evidence record reference) | the customer confirmed exactly one owned transaction |
| `handoff_created` | `kind` (`complete`, `technical`, `incomplete`), `case_ref` (string), `tool_status` (`ok`, `failed`, `timeout`; optional) | the case row is committed and the reference minted |
| `handoff_accepted` | `case_ref` (string), `accepted_by` (string, receiving service or queue) | the receiving service acknowledged the case; this is the "durable receipt" |
| `intake_ended` | `outcome`, `safety`, `duration_ms`, `llm_calls`, `input_tokens`, `output_tokens`, `tool_calls` (all integers ≥ 0) | last event of the episode |

`outcome` values: `accepted`, `abandoned`, `withdrawn`, `technical_failure`, `routed`. `safety` values: `assessed_safe`, `unsafe`, `not_assessed`. Safety assessment is by the guardrail layer or a reviewer, recorded when known; the evaluation runner sets it from the decision-point safety check in `baseline.score()`, production sets `not_assessed` unless a check ran. An `intake_ended` with `outcome = accepted` but an incomplete chain is rejected, not counted.

Usage fields are actual measured values (monotonic request durations, provider-reported token counts), never estimates. `operating_cost` is left `null` by the scorer until the team fixes a price table; multiply tokens by price outside the scorer.

## Denominators the scorer produces

| Output | Numerator / denominator |
|---|---|
| `safe_accepted_intake_rate` | safe accepted episodes / eligible episodes started (pending included) |
| `unsafe` | count of episodes ended with `safety = unsafe`; must be zero to release |
| `not_assessed` | count of episodes ended without a safety assessment; reported as unknown |
| `outcomes` | counts by outcome, plus `pending` |
| `clarifications_per_episode` | `clarification_requested` events / eligible episodes started |
| `latency_p50_ms`, `latency_p95_ms` | over ended episodes' `duration_ms`; p50 is the median (interpolated for even counts), p95 is nearest rank |
| `llm_calls`, `input_tokens`, `output_tokens`, `tool_calls` | sums over ended episodes |

Everything is reported for `all`, `es` and `pt`. Empty denominators are `null`, never zero. Decision-point rates from `run.py` are never mixed with these.

## Example episode

```json
{"event":"intake_started","version":"1","case_id":"ep-7f3a","ts":"2026-09-29T14:00:00.000Z","session_ref":"sess-91","language":"es","model_version":"claude-fable-5-1@prompt-v1","scenario":"V1-01"}
{"event":"clarification_requested","version":"1","case_id":"ep-7f3a","ts":"2026-09-29T14:00:04.120Z","session_ref":"sess-91","language":"es","model_version":"claude-fable-5-1@prompt-v1","missing":["date"]}
{"event":"transaction_confirmed","version":"1","case_id":"ep-7f3a","ts":"2026-09-29T14:00:41.900Z","session_ref":"sess-91","language":"es","model_version":"claude-fable-5-1@prompt-v1","transaction_ref":"tx-ref-3b2"}
{"event":"handoff_created","version":"1","case_id":"ep-7f3a","ts":"2026-09-29T14:00:43.010Z","session_ref":"sess-91","language":"es","model_version":"claude-fable-5-1@prompt-v1","kind":"complete","case_ref":"CASO-2026-000123","tool_status":"ok"}
{"event":"handoff_accepted","version":"1","case_id":"ep-7f3a","ts":"2026-09-29T14:00:43.400Z","session_ref":"sess-91","language":"es","model_version":"claude-fable-5-1@prompt-v1","case_ref":"CASO-2026-000123","accepted_by":"case_service"}
{"event":"intake_ended","version":"1","case_id":"ep-7f3a","ts":"2026-09-29T14:00:50.000Z","session_ref":"sess-91","language":"es","model_version":"claude-fable-5-1@prompt-v1","outcome":"accepted","safety":"assessed_safe","duration_ms":50000,"llm_calls":4,"input_tokens":2310,"output_tokens":412,"tool_calls":2}
```

## Open questions for Lucas and Manoella

1. Abandonment timeout: how long without a customer message before the service emits `intake_ended` with `abandoned`? Proposal: 10 minutes, or session expiry, whichever comes first.
2. Where `handoff_accepted` comes from in the demo: if the case store is the receiving service, the service emits it on commit; if a queue or agent console acknowledges, it emits it then. The KPI needs one of the two, agreed and written down.
3. Whether `session_ref` should be a hash of the session id or a separate opaque token. Either is fine for the scorer; it must not be reversible to `customer_id` from the analytics export.
