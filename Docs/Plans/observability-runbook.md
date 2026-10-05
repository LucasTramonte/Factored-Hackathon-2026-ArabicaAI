# Observability runbook

**Status (2026-10-04):** on in production, in three layers. Everything below runs on what is deployed today. Nothing needs Cloud Run or a second runtime (ADR-003).

| Layer | Where | What it answers | Set up |
|---|---|---|---|
| **Worker logs and traces** | Cloudflare Workers Logs (`observability` in `back-end/wrangler.jsonc`: logs and traces on, 100% sampled, persisted) | What each request did: route, status, latency, D1 work, unexpected errors, each AI suggestion run | On since #113; the Worker's own structured lines since this PR |
| **External availability** | Cloud Monitoring uptime check `arabica-intake-healthz` (GCP) | Can customers reach the service at all (Worker plus D1)? | Created 2026-10-04 ([`scripts/gcp/monitoring/`](../../scripts/gcp/monitoring/README.md)) |
| **Model provider** | Cloud Monitoring, Vertex AI's native metrics (GCP) | Is Gemini throttling, failing or slow? | Created 2026-10-04, same folder |

## 1. Worker logs (Cloudflare)

**What the Worker writes** (`back-end/src/log.js`): one JSON object per line, which Workers Logs indexes field by field.

| `event` | Fields | When |
|---|---|---|
| `request` | `route` (route-table key, never the raw path), `method`, `status`, `ms`, `ray` (`cf-ray`), `d1_queries`, `d1_rows_read`, `d1_rows_written` | Every request |
| `unhandled_error` | `route`, `method`, `error` (the class only, e.g. `TypeError`), `ray` | An exception reached the top; the customer got a 503 |
| `suggestion_run` | `outcome`, `arm`, `llm_calls`, `ms`, `breaker`, `suggested`, `location` | Each AI suggestion run, after the response |
| `transaction_discovery` | `outcome` (`candidates`, `none`, `ambiguous`, an intent, an assist failure kind, `stale`, `search_failure`, `needs_clarification`), `language`, `ms`, `intent`, `candidates`, `blocked` | Each discovery request after the switch and source checks (PR #133); never the description, criteria or charges |

**Privacy invariant** (AGENTS.md): no statement, message, email address, customer id, token, raw path or query string is ever logged. `test/unit/observability.test.js` fails if a reference or query text leaks.

**To look at them:**
1. Cloudflare dashboard → **Workers & Pages** → `factored-hackathon-2026-arabicaai` → **Observability**. Logs and traces are there, with a query builder.
2. Useful queries:
   - `event = "unhandled_error"`: anything that broke;
   - `event = "request" AND status >= 500`: server errors;
   - `event = "request"`, grouped by `route`, p95 of `ms`: slow routes;
   - `event = "suggestion_run"`, grouped by `outcome`: how the AI is doing; `breaker = true` means the circuit breaker is skipping the model.
   - `event = "transaction_discovery" AND outcome IN ("candidates", "none", "ambiguous")`, p95 of `ms` for successful searches only. Separately count failures by `outcome` and divide by the full discovery request count (all outcomes in the same window, including local blocks): the discovery gate is successful p95 ≤ 4 s and failures ≤ 5% (`evals/support_assist/README.md`); `blocked = "local"` is the regex block that cost no model call. Spend and token usage live in D1 `support_assist_runs` rows with version `support-discovery-v1@…`, not in logs.
3. **Live tail from a terminal:** `cd back-end && npx wrangler tail --format json`. Wrangler's OAuth login has the `workers_tail` scope.

**To query the logs from a terminal or script** (optional): wrangler's OAuth login has no observability scope, so a person creates an **account API token** with the **Workers Observability Read** permission (dashboard → My Profile → API Tokens → Create Custom Token; the permission name comes from third-party documentation). Keep it in a password manager or an environment variable, never in the repository.

**Limits** ([Cloudflare, 2026-10-02](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)): on the Workers Free plan, 200,000 log events a day with 3 days of retention. Each request writes two events (the invocation log and the `request` line), so the demo's few hundred requests a day use under 1%. If volume grows, lower `head_sampling_rate` before the cap is reached.

**Request metrics:** the [Cloudflare traffic evidence record](../Evidence/cloudflare-traffic.md) provides the read-only GraphQL query, metric definitions and export checklist for judges. A historical note on 2026-10-04 reported 277 requests in 24 hours with 0 Worker errors, but retained no exact UTC bounds, deployment version or export. It is not auditable evidence. The linked record now contains a separate production dashboard capture for October 4 01:00–October 5 01:00 UTC: 964 invocations and 0 runtime errors, with 11 SES HTTP 4xx responses in the outbound-host table. Invocation errors are not the HTTP error rate; see the record for coverage and timing limitations.

## 2. Alerts (GCP Cloud Monitoring)

| Policy | Fires when |
|---|---|
| Live demo: `/healthz` failing | The uptime check fails in more than one region for 5 minutes |
| Vertex AI: throttled or failing | 3 or more 429/5xx responses for `gemini-3.5-flash-lite` in 15 minutes |
| Vertex AI: slow | p95 total latency above 5 s over 15 minutes, with at least 3 calls |

**Notifications: a person's step.** No notification channel exists. Incidents appear in the Cloud Console (Monitoring → Alerting), but nobody is paged until a channel is added. The commands are in [`scripts/gcp/monitoring/README.md`](../../scripts/gcp/monitoring/README.md).

## 3. What observability already found

- **2026-10-04, Vertex:** Google's shared pool for `gpt-oss-20b` degraded, and the switch to extractor v2 followed ([ADR-006 amendment 10](../ADRs/ADR-006-learned-extractor-workers-ai.md#post-freeze-amendment-2026-10-04)).
- **2026-10-04, email** (found in #117, fixed the same day in #120): report emails didn't arrive. The Worker's SES sender was a personal address on a company domain that publishes DMARC `p=reject` without DKIM for SES, so receivers rejected the mail. The fix: a domain the team controls, `arabicaai-demo.com`, verified in SES with Easy DKIM, a custom MAIL FROM and DMARC `p=none`, as the sender (`noreply@`) of both the Worker and Cognito. Confirmed in production at 20:16 UTC (outbox `sent`, inbox delivery). Bounce and complaint handling is configured by `back-end/scripts/ses/setup.sh`: account suppression, an SNS event destination, and two reputation alarms.

## Why not Cloud Run for observability

Cloudflare provides the logs, traces and metrics this needs, on the plan we have. Moving would add a second runtime (ADR-003) and a migration from D1 to Cloud SQL, with its own data copy, the day before submission, to gain what three files and two GCP resources already give. Reopen if the logs need more than 3 days of retention or a SIEM export (Logpush needs a paid plan), or if a regulator requires the runtime in GCP.

## Reviewer assistance UI (implemented; activation pending)

In the agent report detail, **Prepare reply** requests a transient AI summary, missing-information checklist and unsaved draft. It does not send or change status. **Use draft in message** requires confirmation before replacing unsent text, then the reviewer edits and explicitly uses the existing **Send message**. Only that human send persists; it carries the generation's status/message-count snapshot.

A 409 retains editable text and blocks assisted sending. **Refresh report context**, then prepare/apply a fresh draft or explicitly confirm manual review of the refreshed context and retained text. Closed reports remain read-only. Report/session/language changes discard AI state and late responses; disabled assistance or provider errors leave manual messaging available. All controls/copy support ES/PT/EN; omitted conversation is labeled only when `context_truncated` is true. Do not record summary, draft, message or statement bodies in logs or telemetry.

The reviewer switch remains default-off. Synthetic local loopback-provider UI checks establish workflow behavior only; dedicated model-quality evaluation, ADR review, live pilot/spending approval and activation approval remain pending.

## Support-assist pilot and controlled activation (pending external)

Both `ASSIST_REVIEWER_ENABLED` and `ASSIST_CUSTOMER_ENABLED` remain absent/off in production; exactly `1` enables each independently. [Dedicated evaluation](../../evals/support_assist/README.md) and [aggregate local evidence](../Evidence/support-assist-pilot.md) do not authorize activation. Do not interpret the existing extractor's `suggestion_run` logs, model metrics or cost as support-assist evidence.

After a person approves scope/spending, review the exact frozen bundle and label audit before a synthetic-only live pilot. Pace actual calls within shared 200/UTC day and five/session/feature/rolling minute, counting development, timeouts and abandoned slots. 360 acceptance + 60 development require at least three UTC days, plus any other reserved calls. Never bypass these caps. Preserve reviewed private outputs outside logs, then score the full run and inspect its provenance/approval references. Human reply/handling timing is measured separately from automated status and generation; no observed operator timing exists yet.

Use existing Worker request logs for status/latency grouped by route-table keys `/agent/intake-assist` and `/intake/handoff/{reference}/assist`; raw references never enter route labels. Assistant accounting lives in bounded `support_assist_runs`: outcome, elapsed, known input/output tokens, unknown usage, one-call count and bundle version. No dedicated support model-output log or general export endpoint was added. A person's authorized metadata inspection/export must exclude UUID/session-hash/report-reference linkage from public aggregates. Reserved rows with no terminal result remain conservatively unknown; existing bounded idle housekeeping marks old reservations abandoned and removes metadata older than seven days (at most 100 per invocation). Confirm that existing sweep runs often enough; these features create no scheduler. Missing tokens are not zero cost; timed-out provider work can still be billed.

Human release checklist, still unperformed:

1. Inspect ADR/data scope, frozen labels/hashes, complete reviewed live safety/quality/performance/cost evidence, operator pilot and PR; separately approve each assistant switch. Normal green-main deployment applies additive migration 0030 before Worker release. No agent runs remote migrations, changes IAM, deploys, merges or activates.
2. On the actual production URL, record deployment SHA and matching frontend assets; verify login/OTP/logo and ES/PT/EN email requests, owned customer message persistence, waiting/status, explicit reviewer edit/send, reply, closure/follow-up, source/identity isolation and each approved switch. Retain aggregate evidence and exact UTC observation bounds. Local screenshots do not prove production behavior or email receipt.
3. Observe route errors/latency and dedicated usage/cost by feature. Any reviewed safety failure blocks the affected feature immediately; successful generation p95 > 8 s, failed/timeout share > 5%, deadline violation or spend beyond approved allowance requires investigation and disabling that feature. Report sample size/window and all failures; the existing provider alerts may also cover the extractor and are not a dedicated support gate.
4. A person disables only the failing assistant switch and confirms the production configuration/deployment. Recheck manual messages, factual status and existing extraction. Preserve private failure evidence; no automatic banking action, closure or model retry is introduced. Re-enable only after human review and explicit approval.
