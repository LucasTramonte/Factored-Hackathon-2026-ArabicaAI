# Intake API (Cloudflare Worker + D1)

This is the only online implementation of the intake service ([ADR-003](../Docs/ADRs/ADR-003-intake-single-runtime-worker-d1.md), Proposed).

- **Worker (JavaScript, ES modules):** serves the API.
- **D1:** stores customers, charges, cases, sessions, and guided intake episodes, turns, events and handoffs.
- **Angular build:** served from `front-end/` as static assets.

The Worker never reads S3, DuckDB or Silver. The data it serves is loaded as a reviewed seed from the Gold slice (`data_pipelines/gold/`).

The service does not decide fraud, issue refunds or authenticate bank customers. It confirms a report only after D1 has stored it and read it back. It calls no model: the extractor switch (below) is off and can't turn on yet.

## Layout

| Path | Responsibility |
|---|---|
| `src/index.js` | Entry point. It turns any unexpected error into a generic 503. It adds D1 counters only when `DEMO_EXPOSE_DB_METRICS=1`, which is set in local tests only. |
| `src/router.js` | Exact route table. There is no team gate: every API route relies on its handler's session check (customer or agent), behind the per-IP limit. Other methods on API paths get 405, unknown API paths get 404. Hashed bundles are served without the Worker. |
| `src/http.js` | JSON responses, cookies, and body parsing capped at 16 KB. |
| `src/auth/cognito.js` | Verifies Cognito ID tokens; `bearerClaims` is shared by customer and agent sign-in (422/401/503). |
| `src/auth/session.js` | Random 256-bit tokens. Only their SHA-256 is stored, and customer and agent sessions are kept separate. |
| `src/modules/customer/` | Login, own charges, and case creation with validation. |
| `src/modules/intake/` | Guided intake: start, confirm and incomplete handoff, with strict validation. No free-text classification. |
| `src/modules/agent/` | Agent session, the read-only case view, the intake queue and detail, and the received → in review → closed steps. |
| `src/store/d1.js` | Every SQL statement. This is the only module to replace if the store changes. Multi-statement writes run as one atomic `db.batch()`. |
| `src/config/identities.json` | Committed demo identities (fictitious, plus the one-day slice's customer), shared with the Gold slice. Dataset cohort customers are listed from D1 instead. |
| `migrations/` | Versioned D1 schema (`wrangler d1 migrations`). Additive only. Remote D1 holds 0001–0008 (0006: customer source and country; 0007: the `seed_loads` load log; 0008: the short reference). 0009–0013 (notifications, review status, one open report per charge, auth audit, urgency) come with PRs #60 to #66 and go to remote D1 before each merges. |
| `scripts/intake-store.mjs` | Local D1 binding for the operator scripts, through Wrangler's `getPlatformProxy`. It uses the store in `src/store/d1.js`, so the scripts contain no SQL. |
| `scripts/close-idle-intakes.mjs`, `scripts/export-intake-events.mjs` | Manual operator scripts: bounded idle closure and the privacy-checked event export (below). |
| `scripts/reset-demo-activity.sql` | Deletes demo activity in foreign-key order and keeps the seed (below). |
| `seeds/seed_fictitious.sql` | Fictitious identities and charges. Rerunning it is a no-op, and drift makes it fail. |
| `test/unit/` | Pure-module tests: validation, sign-in, sessions, failure injection, routing, the contract validator. |
| `test/integration/` | Tests against local D1: main flow, adversarial matrix, guided intake, agent intake views, operator scripts and D1 budgets. All JSON is checked against `front-end/contracts/`. `run-local.mjs` runs `budget.test.js` last, in its own test-runner call, so its fixtures can't affect the other suites. |

## Run and test locally

These steps need Node 22 or newer and no Cloudflare account. From the repository root:

```bash
npm --prefix front-end ci && npm --prefix front-end run build
npm --prefix back-end ci && npm --prefix back-end run prepare-assets
npm --prefix back-end test          # unit tests, then integration tests on a throwaway local D1
```

The event-export tests run the Python scorer `evals/intake/episodes.py`, which needs only the standard library (Python 3.10 or newer). The tests and the exporter pick the interpreter in this order (`scripts/scorer-python.mjs`):
1. `INTAKE_PYTHON`, if set and non-empty, for example `INTAKE_PYTHON=python3 npm --prefix back-end test`;
2. else the repository's `.venv/bin/python`, if it exists (`make setup` creates it);
3. else `python3` from `PATH`.

CI sets `INTAKE_PYTHON: python`.

If you applied an earlier, pre-merge version of migration 0004 to your local D1, recreate the database: delete `back-end/.wrangler/state`, then reapply the migrations and seeds. The final 0004 dropped two indexes and added CHECK constraints before merge. Local state is ignored and disposable.

To browse locally, create `back-end/.dev.vars` (ignored by Git) with `DEMO_PICKER="1"` for the demo identity picker (`/demo/identities`, `/demo/session`) and the one-click agent session (`POST /demo/agent-session` without `Authorization`); without it the picker routes answer 404 and the agent session needs a Cognito token. `DEMO_PICKER` is local only and never set in production, where customers and agents sign in with their email code. Then, from `back-end/`:

```bash
npx wrangler d1 migrations apply arabica-intake-demo --local
npx wrangler d1 execute arabica-intake-demo --local --file seeds/seed_fictitious.sql
npx wrangler d1 execute arabica-intake-demo --local --file ../data/demo_s3/intake_slice_seed.sql   # optional; from make intake-sample-slice
npx wrangler dev --local
```

## API routes

There is no team password. Customers sign in with an email one-time code (`POST /auth/session`, group `customer` or `admin`) and agents with the same code (`POST /demo/agent-session`, group `agent` or `admin`, else 403; see [Access](#access)). The `/`, `/index.html` and `/agent` documents are public, each customer route answers 401 without a valid customer session, each agent route answers 401 without a valid agent session, and the auditor route needs a verified Cognito token on every call. A known path with another method returns 405 and an `Allow` header. An unknown path under `/demo/`, `/agent/`, `/audit/`, `/admin/`, `/transactions/`, `/cases/` or `/intake` returns a JSON 404 and is never served as the app. Bodies are capped at 16 KB (413). Every API path (customer, agent, `/auth/*`, `/demo/*` and unknown API paths) allows 60 requests a minute per IP through the Workers Rate Limiting binding `API_LIMIT`, then answers 429 with `Retry-After: 60`; the count is per Cloudflare location and approximate, and it is keyed by IP, so users behind a shared NAT share the budget. After sign-in, identity comes only from the session cookie, never from a request body. Every JSON body matches `front-end/contracts/intake-api.schema.json`.

| Method and path | Session | Purpose | Main statuses |
|---|---|---|---|
| `GET /healthz` | none | Liveness; one D1 query | 200 |
| `GET /demo/identities` | none | Committed identities, then up to 1,000 dataset customers from D1, each with `country` (one query) | 200, 503; 404 without `DEMO_PICKER=1` |
| `POST /demo/session` | none | Simulated customer login for a committed identity or a D1 dataset customer; malformed ids are rejected before any query | 200, 422, 503 (committed identity not loaded); 404 without `DEMO_PICKER=1` |
| `GET /transactions` | customer | The customer's own charges, one page, with `has_more` | 200, 401 |
| `POST /cases` | customer | Legacy one-step confirmed case | 201, 200 (replay), 401, 404, 409, 422, 503 |
| `POST /intake/start` | customer | Start an explicit guided ES/PT/EN unrecognized-charge report (10–2,000 code points, no U+0000, UUID key); optional `previous_protocol` links an own acknowledged closed report. No case reference is returned. A same-key replay returns the original, immutable start receipt (`state: selection_required`) even after the episode was abandoned or handed off, so it does not describe the current state | 201, 200 (same key and content), 401, 404 (previous report missing/foreign/unacknowledged), 409 (key conflict or previous report open), 422, 503 (retry the same key) |
| `POST /intake/confirm` | customer | Confirm one owned transaction; returns the protocol only after the case and handoff are read back | 201, 200 (same key and content replays the receipt), 401 (expired or revoked, including in the reservation itself; renew as the same customer and retry the same key), 404 (episode or transaction not owned; foreign and missing look identical), 409 ("Episode already submitted with different content or key" once a handoff exists; "Episode is no longer open" after abandonment, when there is no reservation), 422, 503 (acceptance unknown; retry the same key) |
| `POST /intake/handoff` | customer | Ask for human review without a confirmed transaction (`kind: incomplete`); same receipt rules. Optional `details` (what the customer remembers; same text rules as the statement) is appended to the stored statement once, with a newline, and is part of the replay content | same as confirm, without the transaction 404; 422 when statement and details exceed 2,000 code points together |
| `POST /auth/session` | none | Customer sign-in from `Authorization: Bearer <Cognito ID token>` in group `customer` or `admin`, with a loaded customer id | 200, 401, 403 (not enrolled), 422 (no token), 503 (JWKS unreachable) |
| `POST /auth/logout` | none | Revokes the presented customer session | 204 |
| `GET /reports` | customer | The customer's own acknowledged reports, newest first, 20 a page with `has_more`: reference, kind, status, next step and the confirmed charge id (null without one) | 200, 401, 422 (any query parameter) |
| `POST /reports/feedback` | customer | The receipt's one question, "was it easy to report this charge?" (`{ protocol, easy }`), for an own report: the first answer stands, stored on the report and never in events | 200 (same answer again too), 401, 404 (foreign and missing look identical), 409 (a different answer), 422 |
| `POST /reports/update` | customer | Queue one status email for an own report, at most one per report per five minutes | 202, 401, 404 (foreign and missing look identical), 409 (no email on file), 422, 429 |
| `POST /demo/agent-session` | none | Agent login from `Authorization: Bearer <Cognito ID token>` in group `agent` or `admin` (`mode: email_otp`); any body is ignored. With `DEMO_PICKER=1` and no `Authorization`, a one-click local session (`mode: simulated_login`) | 200, 401, 403 (not in group `agent` or `admin`), 422 (no token), 503 (JWKS unreachable) |
| `GET /agent/intakes` | agent | Newest 50 acknowledged intake handoffs (complete, incomplete, technical) with `has_more`; pending reservations are excluded | 200, 401 |
| `GET /agent/intake-detail?protocol=<uuid>` | agent | Statement, verified evidence (or `null`), server actions, open questions and recorded service history (100 events, `history_has_more`); `customer_history` summarises at most 20 other acknowledged reports in the customer's newest 21 episodes, with `has_more` when the window is full; `first_opened_at` is the UTC ISO first-agent-open timestamp (one epoch-ms write, then no writes on later reads) | 200, 401, 404, 422 (anything but exactly one valid `protocol`) |
| `POST /agent/intake-status` | agent | Move a report one step, received → in review → closed, with a history row and one email to the customer; a replay writes nothing | 200, 401, 404, 409 (any other step), 422 |
| `GET /audit/events?limit=` | none; `Authorization: Bearer <Cognito ID token>` in group `auditor` or `admin` on every call | The newest sign-in events and review-status changes, `limit` (1–100, default 50) of each, with `has_more`; references only (no customer id, email, statement or token); writes nothing | 200, 401, 403 (not `auditor` or `admin`), 422 (no token, or a bad `limit`), 503 (JWKS unreachable) |
| `GET /admin/customers` | customer session opened by a token in group `admin` ([ADR-007](../Docs/ADRs/ADR-007-customer-identity-cognito-email-otp.md), decision 10) | The committed identities, then the loaded dataset cohort (`identityList`) | 200, 401 (no customer session), 403 (not an admin's session), 503 |
| `POST /admin/act-as` | same | Body exactly `{ customer_id }`: replaces the session with one for that customer (`actAsSession`), keeps the admin mark, stores no email, and records one reference-only `admin_actions` row | 200, 401, 403, 422 (anything but one allowed id), 503 |

The client's "?" help entry ([ADR-010](../Docs/ADRs/ADR-010-report-reasons-and-help-entry.md), decision 5) starts with the same `POST /intake/start` and no charge selected. If the customer then finds the charge in the list, it goes through `POST /intake/confirm` and its ownership check, as from a charge row; otherwise `POST /intake/handoff` ends it as an incomplete handoff that a person reviews. A lost or stolen card is `high` on every kind of handoff, so the receipt carries the call-your-bank line either way.

A closed report offers "Not resolved" in the client. It starts a **new** report, never a reopened one, because closing records that a person finished the review, not a resolution. Any unfrozen draft is cleared first. The same charge is preselected when still listed; otherwise it uses the "?" entry. Normal customer clarification, confirmation, handoff read-back and one-open-report protection still apply.

The optional `previous_protocol` on `POST /intake/start` is stored independently of the editable statement as `intake_episodes.previous_handoff_id` (additive migration 0020). The insertion resolves the public protocol through a 1:1 handoff/episode join and rechecks same-session ownership, acknowledged state, closed status and the live customer session atomically. A malformed protocol is 422, a missing/foreign/unacknowledged source 404, and an open source 409; none creates a new episode. A failed linked insert rechecks live same-customer authority before reporting source status; revocation, expiry or identity swaps uniformly return 401. The source stays closed. Repeating the same start key and link returns the same episode; changing/removing the link conflicts. Starts that omit it retain the original hash and response contract. No customer identifier or internal handoff id is accepted, and no link is inferred from free text.

The relationship supports incomplete reports as well as confirmed charges. A reviewer's SQL can join the new episode directly to its previous handoff; the aggregate re-report metric counts acknowledged linked follow-ups divided by all acknowledged reports accepted in a specified UTC interval. The grain is one new handoff, `accepted_at` supplies event time, and pending reservations are excluded. This measures a customer asking for another review, not a confirmed failure or resolution:

```sql
SELECT COUNT(*) AS acknowledged_reports,
       SUM(CASE WHEN pe.customer_id=e.customer_id THEN 1 ELSE 0 END) AS linked_followups
FROM intake_handoffs h JOIN intake_episodes e ON e.episode_id=h.episode_id
LEFT JOIN intake_handoffs previous ON previous.handoff_id=e.previous_handoff_id
LEFT JOIN intake_episodes pe ON pe.episode_id=previous.episode_id
WHERE e.state=h.kind||'_handoff' AND h.accepted_at>=:from_utc AND h.accepted_at<:to_utc;
```

Unlinked older reports are not retroactively inferred as follow-ups. `reset-demo-activity.sql` clears nullable previous links before handoffs, so the episode/handoff foreign-key cycle does not block the existing reset order.

Native local D1 measured linked start `7 / 19 / 12 / 2`, linked replay `7 / 17 / 2 / 2` (queries / reads / writes / round trips), checked in `test/integration/report-again.test.js`. Unlinked-start ceilings remain unchanged. The additive deploy applies 0020 after local migration tests; no remote migration command is needed. Demo reset clears nullable links before deleting handoffs.


Agent writes record the first detail open once and the review status; nothing refunds, blocks a card or decides fraud. A customer session never opens an agent route and an agent session never opens a customer route.

The history counts and latest status/time describe only the bounded episode window. Pending, in-progress and abandoned episodes use slots but never count as acknowledged reports. `has_more` conservatively flags a full 21-episode window or 20-report summary, even when it contains zero reports; that is not evidence of a customer's first report. Late acknowledgements outside the creation-time window may also be omitted. The UI calls these **other** reports, since a newer report may appear when an agent opens an older one.

Migration 0018 stores `first_opened_at` as epoch milliseconds and keeps it stable. `accepted_at` remains UTC ISO text, and both fields are returned as UTC ISO strings. In JavaScript, pickup milliseconds are `Date.parse(first_opened_at) - Date.parse(accepted_at)`. In D1 convert `accepted_at` before subtracting, retaining its milliseconds:

```sql
SELECT first_opened_at - CAST(ROUND((julianday(accepted_at)-2440587.5)*86400000) AS INTEGER) AS pickup_ms
FROM intake_handoffs
WHERE first_opened_at IS NOT NULL;
```

`GET /agent/intakes` is the agents' only queue: the *approved queue* of acknowledged handoffs (`e.state = h.kind||'_handoff'`), the same predicate that detail and status transitions use. That is the ABAC rule for agents: role `agent`, a resource in the approved queue, and only the next workflow step. The legacy `GET /agent/cases`, which listed every confirmed case with its customer id and name, was removed (issue #69). A guided complete case whose reservation is still `handoff_pending` after a lost read-back is not in the queue: the customer got 503 and no reference, and a same-owner retry with the same key completes it. A case written by the legacy `POST /cases` is never in the queue. There is no per-agent assignment yet ([auth runbook](../Docs/Plans/auth-runbook.md#known-limitations)).


## Receipt feedback and the aggregate report

Migration `0019_report_feedback.sql` stores one boolean ease answer per acknowledged handoff, with an epoch-millisecond timestamp. The ownership check and live customer-session check run inside the same atomic insert/read-back batch. A repeated matching answer preserves both the answer and timestamp; a different answer gets 409. Expiry or revocation while the body arrives, or immediately before the insert, gets 401 without storing or returning feedback. Customer statements and answers never enter event exports or logs.

The receipt currently asks one prototype question in each interface language:

| Language | Question |
|---|---|
| Spanish | ¿Fue fácil reportar este cargo? |
| Portuguese | Foi fácil relatar esta cobrança? |
| English | Was it easy to report this charge? |

These strings are in `front-end/src/app/shared/i18n/lang.service.ts`. **Bank approval is not recorded in the repository.** The [measurement contract](../Docs/intake/customer-and-measurement-contract.md#kpi-dictionary) proposes a 1–7 effort rating and does not approve the binary wording. Bank approval of the exact localized question and answer labels remains a human step before customer release; this prototype does not claim it has that approval. Binary thumbs are an ease signal, not the contract's 1–7 metric, CSAT, successful intake, assessed safety or resolution.

While an answer is pending, the thumbs expose `aria-disabled` and the synchronous handler refuses duplicate clicks. They remain focusable so the focused button is not lost while waiting. A persistent empty status region receives the thanks text after success or 409; when a focused thumb disappears, thanks takes focus. Closing the chat, choosing another control or starting another receipt keeps the customer's chosen focus. A 409 records that an answer exists without inventing its value.

For Manoella's report, `store.reportFeedbackSummary({ sinceMs, untilMs })` returns aggregate-only rows by report language: `reports`, `respondents`, `unanswered`, `thumbs_up`, `thumbs_down`. It joins each acknowledged handoff to its single episode and at most one feedback row, filters `accepted_at` to the half-open UTC window, and counts answers only when `created_at < untilMs`. Pending reservations are excluded; closed acknowledged reports remain included. No customer, transaction, episode or report identifier is returned. SQL groups the source rows; only at most three language rows enter JavaScript memory. This manual read is outside online request budgets.

From `back-end/`, after applying local migrations, choose the desired UTC acceptance window and run this local-only read:

```bash
node --input-type=module <<'JS'
import { quietThirdPartyDiagnostics, withIntakeStore } from './scripts/intake-store.mjs';
quietThirdPartyDiagnostics();
const window = { sinceMs: Date.parse('2026-10-03T00:00:00.000Z'), untilMs: Date.parse('2026-10-04T00:00:00.000Z') };
try {
  await withIntakeStore({}, async store => console.log(JSON.stringify({ window, by_language: await store.reportFeedbackSummary(window) })));
} catch {
  console.error('Feedback summary failed'); process.exitCode = 1;
}
JS
```

Report `thumbs_up / respondents` with both counts and `respondents / reports` beside it. A zero denominator is undefined; an absent language row means no acknowledged reports in that window. `unanswered` includes missing answers and answers after the cutoff, never negative ratings. Invitation display is not logged, so invitation coverage is unknown and older pre-feedback receipts can be in this cohort. This acceptance cohort excludes failed or abandoned starts; it cannot replace the eligible-start denominator in the measurement contract. Customer segment is absent from D1, so no segment comparison is produced. Prototype or synthetic answers are not real participant measurements and must be labelled accordingly.

## Access

| Who | Cognito groups | Customer view | Agent view | Banner | Test |
|---|---|---|---|---|---|
| Customer | `customer` + a loaded `custom:customer_id` | yes | no (403) | no | `email-session.test.js`: "any other group is one 403 and writes nothing" |
| Agent | `agent` | no (403) | yes | no | `email-session.test.js`: "a token without customer or admin, or without a loaded customer, is 403 with no cookie and no session write" |
| Team and evaluators | `admin` + a loaded `custom:customer_id` | yes, and as any loaded customer (`/admin/act-as`) | yes | yes | `email-session.test.js`: "an admin with its own customer id is also a customer; roles carry only known groups"; "an admin token gets an agent session too" |
| Auditor | `auditor` | no (403) | no (403) | no | `test/integration/audit.test.js`: reads `GET /audit/events` with its token; customer and agent tokens are 403 |
| Anyone else | not enrolled | no code is sent (Cognito's generic answer; the client says it could not send) | same | — | `cognito.service.spec.ts`: "maps each Cognito error type to a status, never to AWS text" (401) |

The sign-in never reveals whether an address exists (`--prevent-user-existence-errors`, `scripts/cognito/setup.sh`). The pool accepts only admin-created users. Enrolment, removal, troubleshooting and the full identity model are in the [auth runbook](../Docs/Plans/auth-runbook.md).

To enrol a team member or an evaluator (an admin also needs a loaded customer id for the customer view):

```sh
sh back-end/scripts/cognito/enroll.sh <email> <customer_id> admin
```

The six fictitious identities are `demo-ana`, `demo-bruno`, `demo-carla`, `demo-diego`, `demo-elena` and `demo-marco`. Report emails reach an address only after it is verified in SES while production access is pending ([ADR-007](../Docs/ADRs/ADR-007-customer-identity-cognito-email-otp.md#implementation-notes)).

## Operator scripts: idle closure and event export

Both scripts are manual. Nothing schedules them. They use the local D1 in `back-end/.wrangler/state/v3` by default, the same one `wrangler dev --local` uses. `--remote` switches to the remote D1 binding: it exists, but this work didn't authorize or use it, and a remote run needs the team's decision first. `--config <path>` points at another Wrangler configuration and uses the local state next to that file. Run them from `back-end/`.

On failure a script prints one fixed line (`Idle closure failed` or `Export failed`) and exits 1. It never prints SQL, D1 errors, scorer output, statements or identifiers. To make that hold, the scripts set `WRANGLER_LOG=none`, `WRANGLER_WRITE_LOGS=false` (no Wrangler debug log file) and `WRANGLER_SEND_METRICS=false`, and silence Node deprecation warnings before Wrangler loads. For a diagnosis, reproduce the failure with the unit fixtures, not by re-enabling logs on real data.

```bash
node scripts/close-idle-intakes.mjs [--limit 100] [--max-pages 1] [--now <epoch ms>]
node scripts/export-intake-events.mjs [--output ../data/intake-events/events.jsonl] [--limit 100] [--max-pages 100] [--python <interpreter>]
```

- **Idle closure** ends guided episodes still in `selection_required` whose deadline has passed: 10 minutes after the last activity, or the bound session's expiry, whichever comes first. *Activity* is the start or its latest same-key replay.
  - **Output:** one `intake_ended` per closed episode, `abandoned`/`not_assessed`, appended at the episode's next sequence number, with the deadline as its `ts` and `duration_ms`.
  - **Pages:** each page is one atomic batch of at most `--limit` (1–100) episodes, and `--max-pages` (1–100) pages share one cutoff. `--now` takes decimal epoch milliseconds and is rejected if empty, signed, fractional, or more than 60 s in the future.
  - **Result:** `{closed, pages, complete, cutoff, metrics}`. `complete: false` means a final probe still found due episodes, so run it again. A repeated sweep writes nothing.
  - **Only this sweep enforces the deadline; the online path does not.** A customer who returns after the deadline but before a sweep still confirms or hands off, and a same-key start replay renews the episode. Outcome counts and durations therefore depend on when the sweep runs, so run it immediately before an export, at the same cutoff.
  - **Reservations:** episodes with a handoff reservation (`handoff_pending`) are never closed and never acknowledged. Only the same customer's live session can finish them.
- **Event export** reads every episode in keyset pages (`--limit` 1–100 episodes, cursor = last episode id), each page one D1 statement with complete per-episode event groups, and appends them to a temporary file. It then validates the whole file with `python -m evals.intake.episodes` (`--python`, else `INTAKE_PYTHON`, else `.venv/bin/python`) and renames it into place. The output is `{episodes, pages, complete: true, started_at, summary, metrics}`. `started_at` labels when the run began; it is not a data bound. The export is all-or-nothing. If the episodes don't fit in `--max-pages` (at most 100 pages, 10,000 episodes), if any group exceeds 101 events or an event exceeds 4,096 characters, or if an event carries a field or reference outside the reviewed allowlist (which has no `scenario`), or a `model_version` other than `guided-0.1` or the registered extractor's, the run fails and the previous artifact stays. `--limit` and `--max-pages` must be plain decimal integers in range, checked before the database is opened. A partial population is never published.
- **Where artifacts go:** only under the repository's ignored `data/intake-events/`, ending in `.jsonl`. The export rejects a path that resolves outside it through a symlink, a `data/` that links into another repository path, and a nested directory that doesn't exist yet. It creates nothing through a link. Artifacts hold opaque references and aggregate usage only; see `Docs/intake/intake-events.md` for the allowlist, the cutoff and the timing rules.
- **Costs** (D1, local counters, ADR-004): one idle page of 100 is 2 queries, 1,100 rows read and 300 written. A sweep with nothing due reads 6, and the final due probe reads 1. An export page reads 2 rows per episode plus its events (at most 702 for 100 guided episodes); CI checks each page against that formula.

## Extractor switch (off; ADR-006 decision 6)

`src/modules/intake/ai-transport.js` holds the call site for the learned extractor, in shadow mode. It is off, and it can't turn on yet: it runs only when all of these hold.

- `INTAKE_AI_ENABLED` is exactly `"1"`. It is not in `wrangler.jsonc`, and a unit test keeps it out.
- An `AI` binding exists. `wrangler.jsonc` has none (also test-enforced), so `wrangler dev --local` never reaches Workers AI. It is added at release.
- `APPROVED_EXTRACTOR` is set to the blind builder's adapter (`extractApproved({message, language, asOf, vocabulary, invoke, deadline})`). It is `null` today. Exposed authors don't write the prompt, the request body, the parsing, the validation or the retry (ADR-006 decision 5).
- The adapter's `modelVersion` equals `extractor-v1@` plus the first 12 hex digits of the SHA-256 of the prompt text (`PROMPT` in `src/modules/intake/extractor-prompt.js`). That text is a verbatim copy of `intake_agent/extractor/prompt.md`, the bytes pinned by pre-registration, and a unit test checks them. A placeholder or a stale prompt never runs.
- The shadow call runs in `ctx.waitUntil` after the response, so a start never waits for the model. Keep the switch off in production until the frozen run is done: each shadow start spends one or two calls of the free Workers AI allocation. When it is turned on, ADR-004 must also justify the extra query and round trip per start.

When on, a new (not replayed) `POST /intake/start` stores the episode exactly as today, then calls the adapter with the statement, the session language and the adapter's vocabulary only, within one 10 s deadline. `asOf` is `null`, because the Worker doesn't know the customer's local time. The response, the contract and the guided flow are unchanged whatever the call returns. The customer still picks and confirms the transaction, identity still comes from the session, and the model output is never stored, logged or returned. The episode's events carry the extractor's `model_version`, and `intake_ended` carries the measured `llm_calls` and tokens when the shadow call finishes before the customer confirms or hands off. If the customer is faster, the episode ends with the pre-recorded unknown usage (a unit test covers this), so measured token totals over-represent slower customers; report the share of unknown-usage episodes next to any token or cost figure. The start pre-records one call with unknown usage, so a timeout, an error, malformed output or a crash is reported as `usage_unavailable_calls` with null totals, never as free. A failure doesn't end the episode or create a technical handoff.

D1 cost: off, nothing changes. On, a new start adds one query and one round trip (the usage update). Unit tests measure this; local D1 has no AI binding.

## Resetting demo activity

`scripts/reset-demo-activity.sql` deletes report feedback and handoff status history, then intake events, turns, handoffs and episodes, then cases, then sessions: that order respects `intake_handoffs.complete_case_id → cases`, which makes the older `DELETE FROM cases; DELETE FROM sessions;` fail. Customers, transactions, context cards and provenance stay. Locally:

```bash
npx wrangler d1 execute arabica-intake-demo --local --file scripts/reset-demo-activity.sql
```

The remote run is ADR-004's retention step after 2026-10-20 and follows a final export. It isn't part of tests or CI.

## Deployment

The Worker `factored-hackathon-2026-arabicaai` deploys from GitHub Actions ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)), and only from a green `main`:

```
merge to main → quality (Python, Angular, Worker unit + local D1) ──green──► deploy
  deploy: build → D1 Time Travel bookmark → apply pending additive migrations → wrangler deploy → smoke test
                                                                                   └─ fails → wrangler rollback
```

- **Gated by CI:** the job starts only when the `quality` workflow succeeds on a push to `main`, so a red spec never ships. `workflow_dispatch` reruns it by hand.
- **One at a time, in order:** the `deploy-production` concurrency group never runs two deploys at once, and a newer merge supersedes a queued older one.
- **Migrate on deploy:** `npm run deploy` (`scripts/predeploy.mjs`) applies pending *additive* migrations before the new Worker exists and stops on anything else (see below).
- **Labelled:** each Worker version is tagged `main-<short sha>`; a release deploy uses `--tag vX.Y.Z` ([`CONTRIBUTING.md`](../CONTRIBUTING.md#releasing)).
- **Smoke test and automatic rollback:** `/healthz` and `/` answer 200, `POST /auth/session` without a token 422, `/transactions` without a session 401; otherwise `wrangler rollback` restores the previous Worker version and the job fails.
- **Secrets:** the repository secrets `CLOUDFLARE_API_TOKEN` (Cloudflare template "Edit Cloudflare Workers" plus **D1 Edit**, on this account only) and `CLOUDFLARE_ACCOUNT_ID`. Without them the job warns and deploys nothing.
- **Cloudflare Workers Builds is disconnected** so the same commit never deploys twice (Workers & Pages → the Worker → Settings → Builds → Disconnect). It used to build and deploy in parallel with CI, without waiting for it.

### Rollback

- **Worker:** `npx wrangler rollback` (the previous version) or `npx wrangler rollback <version-id>`; `npx wrangler deployments list` shows the versions and their `main-<sha>` tags. Because migrations are additive, an older Worker runs on the newer schema.
- **Database:** D1 Time Travel keeps 30 days. Each deploy that migrates prints the bookmark taken just before it; restore with `npx wrangler d1 time-travel restore arabica-intake-demo --bookmark=<bookmark>` (or `--timestamp=<unix seconds>`). A restore discards every write after that point, so it is a person's decision, never automatic.

### Staging (not yet)

There is one D1 database, so preview builds stay disabled: a preview would bind production data. A staging environment is the next step after `v1.0.0`: a second D1 (`npx wrangler d1 create arabica-intake-staging`), an `env.staging` block in `wrangler.jsonc` with its id, and a `staging` job in `deploy.yml` that migrates and smoke-tests it before `production`. Until then, every migration runs on a fresh local D1 in CI and must be additive.

Preview builds share the production D1 binding. Keep them disabled until a separate preview database exists.

Smart Placement is on (`placement.mode = "smart"`). It is adaptive: Cloudflare may run the Worker nearer D1 once telemetry shows a benefit, and the `cf-placement` response header shows where it actually ran. Each D1 query from São Paulo took about 150 ms before this change (ADR-004).

The deploy order for the agent sign-in change is below. `DEMO_PICKER` must never be set as a Worker var or secret: with no team gate it would let anyone become any customer or agent. `scripts/predeploy.mjs` refuses `DEMO_PICKER` and `COGNITO_TEST_JWKS` in `vars` (it cannot see secrets), refuses to deploy a placeholder D1 ID, and brings remote D1 up to the code's migrations before `wrangler deploy`: it applies every pending additive migration itself, and stops for a person on one that drops, renames or rebuilds (the CI check `test/unit/predeploy.test.js` catches that in the PR). It reads and applies `d1_migrations` with the build token, so that token needs D1 edit access. If the state can't be read, the deploy stops. Non-production branch builds must stay disabled: a preview would bind the production D1.

Schema changes are applied by the deploy itself (above); a person runs `npx wrangler d1 migrations apply arabica-intake-demo --remote` only for a non-additive migration, after it has passed the local tests. To load reviewed data, run `npx wrangler d1 execute arabica-intake-demo --remote --file <seed>` for the fictitious seed, or for a Gold slice seed whose manifest has been reviewed. Never upload `data/`, DuckDB, Parquet or credentials.

### Before deploying this change (agent sign-in)

1. Enrol each agent with `back-end/scripts/cognito/enroll.sh <email> - agent`; otherwise nobody can open the agent view.
2. Deploy.
3. Sign in once as a customer and once as an agent on the live URL.
4. Remove the Cloudflare Access application in the Zero Trust dashboard.
5. Delete the `DEMO_ACCESS_USERNAME` and `DEMO_ACCESS_PASSWORD` Worker secrets (`cd back-end && npx wrangler secret delete DEMO_ACCESS_USERNAME && npx wrangler secret delete DEMO_ACCESS_PASSWORD`); the Worker no longer reads them.

## Remote checks after a deploy

Record the date and the results of each check in ADR-004's implementation notes:

1. Cloudflare Access is no longer on the hostname: `/` loads without any credential.
2. `/agent` loads without any credential; `/agent/intakes` without an agent session returns 401 `Start a demo agent session first`; `/transactions` without a session returns 401 `Start a demo session first`; an enrolled agent signs in with an email code and sees the queue.
3. Each customer sees only their own charges.
4. A confirmed case returns a reference, and a retry returns the same one.
5. The agent view shows the case.
6. The case is still there after a new deploy.
7. A page load adds two Worker requests (the document and the identity list); bundles don't add any.
8. `GET /healthz` returns `{"status":"ok"}`.

## Limits

Free plan: 100,000 Worker requests per day, 10 ms of CPU per request, 50 D1 queries per invocation, 5 million rows read and 100,000 rows written per day, and 500 MB per database. A page load adds 2 Worker requests (document + identity list) that touch no D1. Measured D1 cost on local D1 (budget test, 2026-09-30):

- **Legacy customer episode** (login, list, `POST /cases`): 3 API requests, 10 queries, 10 rows read, 7 rows written.
- **Guided complete episode** (login, list, start, confirm): 4 API requests, 30 queries, 69 rows read, 36 rows written, 15 round trips.
- **Guided incomplete episode** (login, list, start, handoff): 4 API requests, 26 queries, 53 rows read, 28 rows written, 14 round trips.

The guided flow writes about 4 to 5 times more rows per episode, and rows written is the binding daily quota. [ADR-004](../Docs/ADRs/ADR-004-intake-capacity-and-cost.md) turns these numbers into capacity and cost, per request and per episode.
