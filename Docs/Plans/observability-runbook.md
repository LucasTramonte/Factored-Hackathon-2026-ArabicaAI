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

**Privacy invariant** (AGENTS.md): no statement, message, email address, customer id, token, raw path or query string is ever logged. `test/unit/observability.test.js` fails if a reference or query text leaks.

**To look at them:**
1. Cloudflare dashboard → **Workers & Pages** → `factored-hackathon-2026-arabicaai` → **Observability**. Logs and traces are there, with a query builder.
2. Useful queries:
   - `event = "unhandled_error"`: anything that broke;
   - `event = "request" AND status >= 500`: server errors;
   - `event = "request"`, grouped by `route`, p95 of `ms`: slow routes;
   - `event = "suggestion_run"`, grouped by `outcome`: how the AI is doing; `breaker = true` means the circuit breaker is skipping the model.
3. **Live tail from a terminal:** `cd back-end && npx wrangler tail --format json`. Wrangler's OAuth login has the `workers_tail` scope.

**To query the logs from a terminal or script** (optional): wrangler's OAuth login has no observability scope, so a person creates an **account API token** with the **Workers Observability Read** permission (dashboard → My Profile → API Tokens → Create Custom Token; the permission name comes from third-party documentation). Keep it in a password manager or an environment variable, never in the repository.

**Limits** ([Cloudflare, 2026-10-02](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)): on the Workers Free plan, 200,000 log events a day with 3 days of retention. Each request writes two events (the invocation log and the `request` line), so the demo's few hundred requests a day use under 1%. If volume grows, lower `head_sampling_rate` before the cap is reached.

**Request metrics:** the [Cloudflare traffic evidence record](../Evidence/cloudflare-traffic.md) provides the read-only GraphQL query, metric definitions and export checklist for judges. A historical note on 2026-10-04 reported 277 requests in 24 hours with 0 Worker errors, but retained no exact UTC bounds, deployment version or export. It is not fresh auditable evidence; production-account export is pending. Invocation errors are not the HTTP error rate.

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
