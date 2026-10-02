# Intake event contract v1 / v2

Roberto, 29 September 2026. Proposed for Lucas (backend) and Manoella (tools). Implements the instrumentation paragraph of the [customer and measurement contract](customer-and-measurement-contract.md) so the episode primary KPI, "safe accepted intake / all eligible episodes started", can be computed from a log instead of estimated. The offline scorer is `evals/intake/episodes.py`; run `.venv/bin/python -m pytest evals/intake/test_episodes.py`.

## Rules

- **One episode = one `case_id`**, minted by the service when intake starts, before any case row exists. It is stable for the whole conversation and reused on retries. It is not the customer-facing reference; that is `case_ref`, minted only after the case row is committed. Retries must not re-emit the chain events (`transaction_confirmed`, `handoff_created`, `handoff_accepted`): the service deduplicates before logging, and the scorer rejects an episode that repeats one. The contract's attempt ID is not needed for that; add it only if per-attempt latency becomes a question. Identical non-chain events (two equal `clarification_requested`) are counted twice; do not log a retry of the same turn. All reference fields must be non-empty strings; a `case_ref` of `null` is rejected, never counted as a receipt. `scenario` and `missing` values are ids from the fixed vocabularies, not free text.
- **Every event carries the base fields** below. Events are append-only JSON lines; the service assigns a non-negative `seq` within each episode and increases it for each emitted event. The scorer sorts by `seq`, including when timestamps tie; duplicate sequence numbers are rejected. All events within one episode have the same version; separate v1 and v2 episodes may share an export.
- **No customer content in events.** `customer_id`, the customer's statement, transaction evidence and names stay in access-controlled case storage. Events carry references (`session_ref`, `transaction_ref`, `case_ref`). The scorer rejects fields outside the contract, but the producer must also ensure that allowed reference values contain only opaque ids, never customer content.
- **An episode starts when an authenticated customer's request is classified as an unrecognized-charge report in a supported language.** Out-of-scope requests (balance inquiry, recognized billing dispute, English) are routed and never start an episode; they are decision points for the single-turn harness, not episodes. The contract's all-attempt safety and routing metrics are therefore not computable from this log; they come from `run.py`. Contract outcome names map as: completed → `accepted`; unsupported → `routed` when it happens after a start; authentication_failed never starts an episode.
- **A completed episode ends** with exactly one `intake_ended`, including abandonment (session expiry or silence after a timeout the service defines), withdrawal, technical failure and routing after start. An episode without `intake_ended` at scoring time is `pending` and stays in the denominator.
- **Acceptance is a chain, not a flag.** `safe_accepted` requires, in order: `transaction_confirmed` → `handoff_created` with `kind = complete` → `handoff_accepted` → `intake_ended` with `outcome = accepted` and `safety = assessed_safe`. Any link missing means the episode is not accepted, whatever the outcome field says.
- **`safety` is a gate.** `unsafe` episodes are counted and reported separately, never netted against accepted ones. `not_assessed` includes pending episodes and is reported as unknown, never as safe. Pending usage and ended episodes with unavailable token usage are counted in `usage_unknown_episodes`; neither is removed from the started denominator.

## Base fields (every event)

| Field | Type | Meaning |
|---|---|---|
| `event` | string | one of the six names below |
| `version` | string | `"1"` or `"2"`; one version per episode |
| `case_id` | string | episode key, service-minted at start |
| `ts` | string | exactly `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC, milliseconds); checked as a real UTC time |
| `seq` | integer | non-negative event order within an episode; unique per `case_id` |
| `session_ref` | string | opaque reference to the authenticated session, never the customer id |
| `language` | string | `es` or `pt`, the conversation language chosen at start |
| `model_version` | string | rule or model identifier, e.g. `checklist-0.1`, `claude-fable-5-1@prompt-v3` |

Authentication audit rows (`session_started`, `logged_out`, `session_expired`, `session_rejected`) live in `auth_events` (migration 0012) and are not intake events.

## Events

| Event | Extra fields | When |
|---|---|---|
| `intake_started` | `scenario` (string, optional: authored scenario id in evaluation runs) | request classified as unrecognized-charge intake |
| `clarification_requested` | `missing` (list of strings: `date`, `currency`, `amount`, `matching_transaction`, `transaction_disambiguation`, `customer_confirmation`, `valid_customer_confirmation`) | the assistant asks the customer for something; the values reuse `baseline.py`'s missing-information names |
| `transaction_confirmed` | `transaction_ref` (string, evidence record reference) | the customer confirmed exactly one owned transaction |
| `handoff_created` | `kind` (`complete`, `technical`, `incomplete`), `case_ref` (string), `tool_status` (`ok`, `failed`, `timeout`; optional) | the case row is committed and the reference minted |
| `handoff_accepted` | `case_ref` (string), `accepted_by` (string, receiving service or queue) | the receiving service acknowledged the case; this is the "durable receipt" |
| `intake_ended` | `outcome`, `safety`, `duration_ms`, `llm_calls`, `input_tokens`, `output_tokens`, `tool_calls`; v2 additionally requires `known_input_tokens`, `known_output_tokens`, `usage_unavailable_calls` (usage types below) | last event of the episode |

`outcome` values: `accepted`, `abandoned`, `withdrawn`, `technical_failure`, `routed`. `safety` values: `assessed_safe`, `unsafe`, `not_assessed`. Safety assessment is by the guardrail layer or a reviewer, recorded when known; the evaluation runner sets it from the decision-point safety check in `baseline.score()`, production sets `not_assessed` unless a check ran. An `intake_ended` with `outcome = accepted` but an incomplete chain is rejected, not counted.

Usage fields are actual measured values (monotonic request durations, provider-reported token counts), never estimates. `operating_cost` is left `null` by the scorer until the team fixes a price table; multiply tokens by price outside the scorer. *For the Worker's `guided-0.1` producer, `duration_ms` is instead a wall-clock episode span; for abandoned episodes it runs to the idle deadline (see Timing below). Its `latency_p50_ms`/`latency_p95_ms` therefore measure episode span, including customer think time, not service latency.*

### Usage compatibility and missingness

V1 events remain valid unchanged: all five usage fields are non-negative integers, with token totals fully measured. Their KPI values and ended-only usage sums retain their previous meanings. The CLI and `summarize(events)` interfaces are unchanged; summaries add `known_input_tokens`, `known_output_tokens` and `usage_unavailable_calls` for both versions. V1 token totals contribute to the known subtotals and v1 contributes zero unavailable calls.

V2 keeps `duration_ms`, `llm_calls` and `tool_calls` as required measured non-negative integers. It also requires non-negative integer `known_input_tokens`, `known_output_tokens` and `usage_unavailable_calls`. Booleans are not integers. `usage_unavailable_calls` counts model calls whose token usage is unavailable, including failed calls, and cannot exceed `llm_calls`. Known subtotals include only measured usage, including measured failed calls; unknown usage is never replaced with zero.

- With zero unavailable calls, `input_tokens` and `output_tokens` are non-negative integers equal to their corresponding known subtotals.
- With any unavailable call, both total token fields must be `null`, while known subtotals remain measured integers (possibly zero).
- The allowlist changes only for v2 `intake_ended`; the three additional fields are rejected on v1 events and on every other event. Customer content remains forbidden.

For each summary population (`all`, `es`, `pt`), an ended episode with unknown usage makes both combined token totals `null`. Known subtotals, unavailable-call counts, measured call counts and latency remain reportable. Pending episodes have no end measurements and do not contribute to usage sums; their unknown-episode count remains explicit. A population containing only pending episodes therefore retains v1's zero ended-only sums, not an assertion of zero actual usage. Empty populations also retain zero sums and undefined rates/latency. The scorer retains its bounded O(events) evaluation memory model.

## Denominators the scorer produces

| Output | Numerator / denominator |
|---|---|
| `safe_accepted_intake_rate` | safe accepted episodes / eligible episodes started (pending included) |
| `unsafe` | count of episodes ended with `safety = unsafe`; must be zero to release |
| `not_assessed` | ended episodes without a safety assessment plus pending episodes; reported as unknown |
| `outcomes` | counts by outcome, plus `pending` |
| `clarifications_per_episode` | `clarification_requested` events / eligible episodes started |
| `latency_p50_ms`, `latency_p95_ms` | over ended episodes' `duration_ms`; p50 is the median (interpolated for even counts), p95 is nearest rank |
| `llm_calls`, `tool_calls` | measured sums over ended episodes only; pending usage is unknown |
| `input_tokens`, `output_tokens` | sums over ended episodes only; both are `null` if any ended episode has unavailable usage |
| `known_input_tokens`, `known_output_tokens` | sums of measured token subtotals over ended episodes, including all v1 token totals |
| `usage_unavailable_calls` | sum of unavailable-usage model calls over ended v2 episodes; v1 contributes zero |
| `usage_unknown_episodes` | ended episodes with unavailable usage plus pending episodes |

Everything is reported for `all`, `es` and `pt`. Empty denominators are `null`, never zero. Decision-point rates from `run.py` are never mixed with these.

## Example episode

```json
{"event":"intake_started","version":"1","case_id":"ep-7f3a","ts":"2026-09-29T14:00:00.000Z","session_ref":"sess-91","language":"es","model_version":"claude-fable-5-1@prompt-v1","scenario":"V1-01","seq":0}
{"event":"clarification_requested","version":"1","case_id":"ep-7f3a","ts":"2026-09-29T14:00:04.120Z","session_ref":"sess-91","language":"es","model_version":"claude-fable-5-1@prompt-v1","missing":["date"],"seq":1}
{"event":"transaction_confirmed","version":"1","case_id":"ep-7f3a","ts":"2026-09-29T14:00:41.900Z","session_ref":"sess-91","language":"es","model_version":"claude-fable-5-1@prompt-v1","transaction_ref":"tx-ref-3b2","seq":2}
{"event":"handoff_created","version":"1","case_id":"ep-7f3a","ts":"2026-09-29T14:00:43.010Z","session_ref":"sess-91","language":"es","model_version":"claude-fable-5-1@prompt-v1","kind":"complete","case_ref":"CASO-2026-000123","tool_status":"ok","seq":3}
{"event":"handoff_accepted","version":"1","case_id":"ep-7f3a","ts":"2026-09-29T14:00:43.400Z","session_ref":"sess-91","language":"es","model_version":"claude-fable-5-1@prompt-v1","case_ref":"CASO-2026-000123","accepted_by":"case_service","seq":4}
{"event":"intake_ended","version":"1","case_id":"ep-7f3a","ts":"2026-09-29T14:00:50.000Z","session_ref":"sess-91","language":"es","model_version":"claude-fable-5-1@prompt-v1","outcome":"accepted","safety":"assessed_safe","duration_ms":50000,"llm_calls":4,"input_tokens":2310,"output_tokens":412,"tool_calls":2,"seq":5}
```

## Worker producer `guided-0.1` (implemented 2026-09-30)

The Worker's explicit guided flow (`POST /intake/start`, `/intake/confirm`, `/intake/handoff`; `back-end/README.md`) emits v2 events only, with `model_version = guided-0.1`. It stores each event in D1 `intake_events` in the same atomic batch as the state change it records, and assigns `seq` from 0. What it emits:

- **Start:** one `intake_started` when an authenticated customer starts an explicit ES/PT unrecognized-charge report. The report type is chosen by the customer, not classified from free text. A replayed start emits nothing.
- **Start replay receipt:** a same-key start replay returns the original, immutable start receipt, `state: selection_required`, even after the episode was abandoned or handed off. The receipt does not describe the current state.
  - After abandonment, with no reservation, a later confirm or handoff returns 409 "Episode is no longer open".
  - After a handoff, a request with a different key or content returns 409 "Episode already submitted with different content or key", and the same key and content replays the receipt (200).
- **Complete:** `transaction_confirmed` → `handoff_created` (`kind = complete`, `tool_status = ok`) → `handoff_accepted` (`accepted_by = case_service`) → `intake_ended` (`accepted`). All four are appended only after the confirmed case and handoff have been read back, and only with a live session of the same customer. The D1 case store is the receiving service, so `handoff_accepted` is that read-back, not a person's action.
- **Incomplete / technical:** `handoff_created` (`incomplete` + `ok`, or `technical` + `failed`) → `intake_ended` (`routed` or `technical_failure`). No `handoff_accepted` is emitted, so these can never count as safe accepted intake. A later report starts a new episode.
- **Abandoned:** one `intake_ended` (`abandoned`) from the idle-closure script (below).
- **Safety:** always `not_assessed`. Production safety is not assessed by this service, and `safe_accepted` is therefore 0 on real traffic.
- **References:** `case_id` is the server-minted episode UUID. `session_ref` is a random UUID minted per episode, not the session token, its hash or the customer id. `transaction_ref` is the handoff reservation UUID, an opaque evidence-record reference, never the source transaction id. `case_ref` is the customer-facing protocol: the confirmed case id for complete handoffs, otherwise the handoff id.
- **Extractor switch (off, can't turn on yet; `back-end/README.md`):** when on, the episode's events carry the registered extractor's `model_version` (`extractor-v1@<prompt-sha12>`) instead of `guided-0.1`, in the same order and with the same fields. `intake_ended` carries the shadow call's measured `llm_calls` and tokens, or null totals with `usage_unavailable_calls` when they are unknown (a timeout, an error or malformed output). Everything else is the guided flow below. With the switch off, every event is byte-identical to `guided-0.1`'s, and a unit test checks that.
- **Usage:** `llm_calls = 0`, `usage_unavailable_calls = 0`, and token totals equal the known subtotals (0), because the guided flow calls no model. Unknown usage can only come from a future model producer, and then follows the v2 rules above: null totals, measured known subtotals and a count of unavailable calls, never an invented zero. Pending episodes stay in `usage_unknown_episodes`.

### Timing

- **`duration_ms`** is server wall-clock time from the persisted start (`created_at`) to the invocation that writes the terminal acknowledgment. It includes customer think time, renewal and pending retries. A backward clock step is clamped to 0. It is not a monotonic clock across invocations, so it is not per-request latency.
- **Abandoned episodes:** the end event's `ts` is the idle deadline, min(last activity + 10 minutes, bound session expiry), and its `duration_ms` runs to that deadline. Only these two values are anchored to the deadline. *Whether* an episode is abandoned, and so which outcome and duration it gets, depends on when the sweep runs (see Idle abandonment).
- **Per-operation elapsed time** (monotonic, within one request) accumulates in the restricted `intake_handoffs.usage_json.operation_duration_ms`. It isn't exported. It excludes the final acknowledgment round trip, which starts after it is measured.

### Tool-call ledger

`tool_calls` counts business-tool work: start storage (1), the owned-transaction lookup, the handoff persistence, the receipt read-back and the finalization. Failed attempts count while the episode is open or its reservation is pending. Two exceptions return before the attempt is recorded, so their work is not counted: a lookup that finds no owned transaction (404), and a session found dead by the route's live check between the lookup and the reservation (401).

When the reservation's own SQL refuses to reserve, the attempt *is* recorded while the episode is open. That happens if the session expired within the statement, a sweep closed the episode, or the owned transaction vanished. The answer then comes from a fresh read: 401 without a live same-owner session, 409 "Episode is no longer open" for a closed episode with no reservation, and otherwise 503. Session reads, idempotency checks, housekeeping, export and replays after the episode ended are not tool calls. D1 measures them separately ([ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md)). If an operation and the write that records its usage both fail, the attempt can't be reconstructed, so `tool_calls` can undercount during a storage outage.

### Idle abandonment

An episode still in `selection_required` becomes due 10 minutes after its last activity or when its bound session expires, whichever comes first (open question 1 below, as implemented). *Activity* is the start or its latest same-key replay. Failed confirm or handoff attempts do not extend it, and neither does a confirm from a renewed session, which doesn't rebind the episode's expiry.

The deadline is evaluated **only when the manual sweep runs** (`back-end/scripts/close-idle-intakes.mjs`). Nothing schedules it, and the online path doesn't enforce it. A customer who returns after the deadline but before a sweep simply continues: confirm and handoff still succeed, and a same-key start replay renews the activity time and expiry, which revives the episode. The recorded outcome (accepted or routed versus abandoned) and the episode duration therefore depend on sweep timing. **Operator procedure:** run the idle sweep immediately before an export, with the same cutoff, and state that cutoff with the figures.

A sweep closes at most 100 episodes per atomic page at one cutoff, which may be at most 60 s past the server clock. It appends the end event at the episode's next sequence number. It reports `complete: false` while any unreserved episode is still due.

A `handoff_pending` episode (its reservation committed but its read-back or acknowledgment not confirmed) is never abandoned and never acknowledged by housekeeping. Only the same customer's live session can finish it, and until then it stays pending in the denominator.

### Export: run start, pages and allowlist

`back-end/scripts/export-intake-events.mjs` writes every episode, pending ones included, to one JSONL file under the ignored `data/intake-events/`, then scores it with `python -m evals.intake.episodes` before publishing it.

- **Pages and cursor:** keyset pages of at most 100 episodes ordered by episode id. Each page is a single D1 statement, so every episode's event group is complete and consistent as of its page. The run fails, keeping the previous artifact, rather than publish a partial population. A run is bounded to 100 pages (10,000 episodes). One page holds at most 100 episodes × 101 events × 4,096 characters in memory, and the scorer then makes one O(events) pass over the file.
- **Run start, not a data bound:** the output's `started_at` records when the run began. It does not bound the data. Pages are read one after another, so the export is not a snapshot across pages. An episode that starts or ends during a run appears in the state its page saw, and one that starts with an id below the cursor appears in the next run. For a fixed denominator, run the idle sweep immediately before the export, export after traffic stops, and state the sweep's cutoff with the figures.
- **Allowlist:** for each event, only the fields the Worker producers write, with `model_version` exactly `guided-0.1` or the registered extractor's (none is registered yet). That means no `scenario`, which is an evaluation-run label the service never writes; an injected one fails the run. Also required: version `2`, an allowed `model_version`, `accepted_by = case_service`; `case_id`, `session_ref`, `transaction_ref` and `case_ref` must be lowercase UUIDs. Anything else fails the run instead of being cleaned. Customer ids, names, statements, source transaction ids, evidence and model output never reach the file. The scorer then rechecks every field, sequence and usage rule.

### Legacy case list

`GET /agent/cases` (legacy, unchanged) lists every confirmed case row. That includes a guided complete case whose reservation is still `handoff_pending` after a lost read-back: the customer got 503 and no reference, and a same-owner retry completes it. `GET /agent/intakes` is the authoritative guided queue. The episode stays pending in this log, and in the denominator, until the retry acknowledges it.

### Retention

Episodes, turns, events, handoffs and cases stay until the shutdown after 2026-10-20 ([ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md)). Expired sessions are still purged at every login. After the window, the team takes a final export, then runs `back-end/scripts/reset-demo-activity.sql`, which deletes in foreign-key order.

## Open questions for Lucas and Manoella

1. Abandonment timeout: how long without a customer message before the service emits `intake_ended` with `abandoned`? Proposal: 10 minutes, or session expiry, whichever comes first. *As implemented on 2026-09-30:* this proposal (see Idle abandonment above).
2. Where `handoff_accepted` comes from in the demo: if the case store is the receiving service, the service emits it on commit; if a queue or agent console acknowledges, it emits it then. The KPI needs one of the two, agreed and written down. *As implemented:* the D1 case store is the receiving service, and the event follows the read-back after commit.
3. Whether `session_ref` should be a hash of the session id or a separate opaque token. Either is fine for the scorer; it must not be reversible to `customer_id` from the analytics export. *As implemented:* a separate random UUID per episode.

These record what the Worker does; they are not a recorded team decision.
