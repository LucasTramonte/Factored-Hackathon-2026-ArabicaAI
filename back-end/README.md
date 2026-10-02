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

There is no team password. Customers sign in with an email one-time code (`POST /auth/session`, group `customer`) and agents with the same code (`POST /demo/agent-session`, group `agent`, else 403). The `/`, `/index.html` and `/agent` documents are public, each customer route answers 401 without a valid customer session, and each agent route answers 401 without a valid agent session. A known path with another method returns 405 and an `Allow` header. An unknown path under `/demo/`, `/agent/`, `/transactions/`, `/cases/` or `/intake` returns a JSON 404 and is never served as the app. Bodies are capped at 16 KB (413). Every API path (customer, agent, `/auth/*`, `/demo/*` and unknown API paths) allows 60 requests a minute per IP through the Workers Rate Limiting binding `API_LIMIT`, then answers 429 with `Retry-After: 60`; the count is per Cloudflare location and approximate, and it is keyed by IP, so users behind a shared NAT share the budget. After sign-in, identity comes only from the session cookie, never from a request body. Every JSON body matches `front-end/contracts/intake-api.schema.json`.

| Method and path | Session | Purpose | Main statuses |
|---|---|---|---|
| `GET /healthz` | none | Liveness; one D1 query | 200 |
| `GET /demo/identities` | none | Committed identities, then up to 1,000 dataset customers from D1, each with `country` (one query) | 200, 503; 404 without `DEMO_PICKER=1` |
| `POST /demo/session` | none | Simulated customer login for a committed identity or a D1 dataset customer; malformed ids are rejected before any query | 200, 422, 503 (committed identity not loaded); 404 without `DEMO_PICKER=1` |
| `GET /transactions` | customer | The customer's own charges, one page, with `has_more` | 200, 401 |
| `POST /cases` | customer | Legacy one-step confirmed case | 201, 200 (replay), 401, 404, 409, 422, 503 |
| `POST /intake/start` | customer | Start an explicit guided ES/PT unrecognized-charge report (10–2,000 code points, no U+0000, UUID key). No case reference is returned. A same-key replay returns the original, immutable start receipt (`state: selection_required`) even after the episode was abandoned or handed off, so it does not describe the current state | 201, 200 (same key and content), 401, 409 (same key, other content), 422, 503 (retry the same key) |
| `POST /intake/confirm` | customer | Confirm one owned transaction; returns the protocol only after the case and handoff are read back | 201, 200 (same key and content replays the receipt), 401 (expired or revoked, including in the reservation itself; renew as the same customer and retry the same key), 404 (episode or transaction not owned; foreign and missing look identical), 409 ("Episode already submitted with different content or key" once a handoff exists; "Episode is no longer open" after abandonment, when there is no reservation), 422, 503 (acceptance unknown; retry the same key) |
| `POST /intake/handoff` | customer | Ask for human review without a confirmed transaction (`kind: incomplete`); same receipt rules. Optional `details` (what the customer remembers; same text rules as the statement) is appended to the stored statement once, with a newline, and is part of the replay content | same as confirm, without the transaction 404; 422 when statement and details exceed 2,000 code points together |
| `POST /auth/session` | none | Customer sign-in from `Authorization: Bearer <Cognito ID token>` in group `customer` | 200, 401, 403 (not enrolled), 422 (no token), 503 (JWKS unreachable) |
| `POST /auth/logout` | none | Revokes the presented customer session | 204 |
| `GET /reports` | customer | The customer's own acknowledged reports, newest first, 20 a page with `has_more`: reference, kind, status and next step | 200, 401, 422 (any query parameter) |
| `POST /reports/update` | customer | Queue one status email for an own report, at most one per report per five minutes | 202, 401, 404 (foreign and missing look identical), 409 (no email on file), 422, 429 |
| `POST /demo/agent-session` | none | Agent login from `Authorization: Bearer <Cognito ID token>` in group `agent` (`mode: email_otp`); any body is ignored. With `DEMO_PICKER=1` and no `Authorization`, a one-click local session (`mode: simulated_login`) | 200, 401, 403 (not in group `agent`), 422 (no token), 503 (JWKS unreachable) |
| `GET /agent/cases` | agent | Legacy read-only case list, 50 per page | 200, 401 |
| `GET /agent/intakes` | agent | Newest 50 acknowledged intake handoffs (complete, incomplete, technical) with `has_more`; pending reservations are excluded | 200, 401 |
| `GET /agent/intake-detail?protocol=<uuid>` | agent | Statement, verified evidence (or `null`), server actions, open questions and recorded service history (100 events, `history_has_more`) | 200, 401, 404, 422 (anything but exactly one valid `protocol`) |
| `POST /agent/intake-status` | agent | Move a report one step, received → in review → closed, with a history row and one email to the customer; a replay writes nothing | 200, 401, 404, 409 (any other step), 422 |

The only agent write is the review status; nothing refunds, blocks a card or decides fraud. A customer session never opens an agent route and an agent session never opens a customer route.

`GET /agent/intakes` is the authoritative queue for guided reports. The legacy `GET /agent/cases` is unchanged and the client no longer calls it: it lists every confirmed case row, including a guided complete case whose reservation is still `handoff_pending` after a lost read-back. In that case the customer got 503 and no reference, and a same-owner retry with the same key completes it. Until then the episode counts as pending in the event export.

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

`scripts/reset-demo-activity.sql` deletes intake events, turns, handoffs and episodes, then cases, then sessions: that order respects `intake_handoffs.complete_case_id → cases`, which makes the older `DELETE FROM cases; DELETE FROM sessions;` fail. Customers, transactions, context cards and provenance stay. Locally:

```bash
npx wrangler d1 execute arabica-intake-demo --local --file scripts/reset-demo-activity.sql
```

The remote run is ADR-004's retention step after 2026-10-20 and follows a final export. It isn't part of tests or CI.

## Deployment

The Worker `factored-hackathon-2026-arabicaai` deploys through Cloudflare Workers Builds from the production branch. Build settings:

- **Root directory:** `back-end`
- **Build command:** `npm ci && npm --prefix ../front-end ci && npm --prefix ../front-end run build && npm run prepare-assets && npm test`
- **Python for `npm test`:** the event-export tests run the stdlib-only scorer. The build image needs `python3` on `PATH`, or the build environment must set `INTAKE_PYTHON`. This is a deployer action in the Workers Builds settings; it isn't verified from this repository.
- **Deploy command:** `npm run deploy`
- **Watch paths:** `back-end/**`, `front-end/**`

Preview builds share the production D1 binding. Keep them disabled until a separate preview database exists.

Smart Placement is on (`placement.mode = "smart"`). It is adaptive: Cloudflare may run the Worker nearer D1 once telemetry shows a benefit, and the `cf-placement` response header shows where it actually ran. Each D1 query from São Paulo took about 150 ms before this change (ADR-004).

The deploy order for the agent sign-in change is below. `DEMO_PICKER` must never be set as a Worker var or secret: with no team gate it would let anyone become any customer or agent. `scripts/predeploy.mjs` refuses `DEMO_PICKER` and `COGNITO_TEST_JWKS` in `vars` (it cannot see secrets), refuses to deploy a placeholder D1 ID, and it also refuses while the remote D1 lacks a migration in `migrations/`. It reads `d1_migrations` with the build token, so that token needs D1 read access. If the state can't be read, the deploy stops. Non-production branch builds must stay disabled: a preview would bind the production D1.

Schema changes: `npx wrangler d1 migrations apply arabica-intake-demo --remote`, after the same migration has passed the local tests. To load reviewed data, run `npx wrangler d1 execute arabica-intake-demo --remote --file <seed>` for the fictitious seed, or for a Gold slice seed whose manifest has been reviewed. Never upload `data/`, DuckDB, Parquet or credentials.

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
