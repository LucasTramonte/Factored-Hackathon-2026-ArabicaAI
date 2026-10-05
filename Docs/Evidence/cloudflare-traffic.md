# Cloudflare traffic and performance evidence

**Status: pending production export (2026-10-04).** No fresh production metrics were collected for this record. The available browser and Wrangler session could access a personal account, not the account serving the production Worker. An authorized production operator must supply the aggregate export below. Missing values mean **not measured here**, never zero.

Target: `factored-hackathon-2026-arabicaai`, serving the [live demo](https://factored-hackathon-2026-arabicaai.lucas-tramonte.workers.dev/). This record supports operational performance claims for judges; it does not measure model accuracy, unique customers, resolved cases or business impact. Those claims belong to [Evaluation](../deliverables/EVALUATION.md) and [Business outcomes](../deliverables/BUSINESS_OUTCOMES.md).

End-to-end p50/p95 still require a timed workload with failed attempts retained. The platform and handler measurements below do not establish the under-two-second request p95 target in the evaluation deliverable.

## Evidence to collect

| Provenance | Recorded value |
|---|---|
| Production account and Worker verified by operator | Pending |
| UTC window start / end, including boundary convention | Pending |
| Exported at (UTC), operator and source artifact | Pending |
| Worker version UUID(s), deploy times and corresponding commit/release | Pending |
| Sampling, retention, export limits and missing fields | Pending |

Use one bounded window and record every deployment within it; split results by version where the source supports it. A current version alone cannot identify all traffic in a historical window. The earlier runbook note of **277 requests / 24 hours / 0 Worker errors** lacks exact bounds, version and a retained export. It is historical context, excluded from this evidence table.

| Metric | Population / calculation | Result |
|---|---|---|
| Worker requests | `sum.requests` for this script and window; includes any test, bot and health-check invocations unless a source filter demonstrably excludes them | Pending |
| Invocation error rate | `100 × sum.errors / sum.requests`; undefined when requests = 0 | Pending |
| Subrequests per invocation | `sum.subrequests / sum.requests`; undefined when requests = 0; not visitors | Pending |
| CPU p50 / p99 | Source quantiles over selected invocations; retain source unit and schema description before converting | Pending |
| Wall-time p50 / p95 | Selected timed invocations from dashboard or logs; report sample count and missing timing count | Pending |
| Route handler p50 / p95 (`request.ms`) | Structured `event = request` records, grouped by route/method; report timed count and missingness | Pending |
| HTTP 5xx rate | Structured request records with status 500–599 / records with known HTTP status; report unknown status count separately | Pending |
| Browser LCP / INP / CLS p75 | Only a verified Web Analytics/RUM collection, with measured page/interaction counts, device scope and UTC window | Not verified / pending |

CPU measures execution work; wall time includes I/O and `waitUntil()` work after the response. Neither is client response duration. Invocation errors describe runtime outcomes and differ from HTTP 4xx/5xx responses. Quantiles are source estimates and must not be averaged across buckets. [Cloudflare metric definitions](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/).

Static assets served without running the Worker are outside invocation counts; this app's routing is in [`wrangler.jsonc`](../../back-end/wrangler.jsonc). Do not label Worker requests as all site traffic or users. [Static asset routing](https://developers.cloudflare.com/workers/static-assets/). Browser speed needs a working beacon and actual observations; RUM is not established by having Worker logs. [Core Web Vitals](https://developers.cloudflare.com/web-analytics/data-metrics/core-web-vitals/).

## Read-only collection by a production operator

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), select the account owning the `lucas-tramonte.workers.dev` deployment, then **Workers & Pages → factored-hackathon-2026-arabicaai → Metrics**. Verify the script and deployment history before exporting. Capture the exact UTC range, units, filters, sample information and visible totals; screenshots must show these labels, with account personal details cropped out.
2. Export the aggregate GraphQL result using an already authorized operator/client. Endpoint: `https://api.cloudflare.com/client/v4/graphql`; authenticated JSON POST with `Authorization: Bearer` supplied privately by the operator. Do not extract Wrangler credentials or put tokens in this file, shell history, screenshots or Git. See [Analytics authentication](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/).
3. Paste the query and variables below into that client. Replace the account and UTC bounds. These example dates are placeholders, not an observed window. The tutorial uses an inclusive end (`datetime_leq`); preserve that convention in the record and avoid overlapping exports. This query has **not been executed for this record**.

```graphql
query GetWorkersAnalytics($accountTag: string, $datetimeStart: string,
                          $datetimeEnd: string, $scriptName: string) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(limit: 100, filter: {
        scriptName: $scriptName,
        datetime_geq: $datetimeStart,
        datetime_leq: $datetimeEnd
      }) {
        sum { requests errors subrequests }
        quantiles { cpuTimeP50 cpuTimeP99 }
        dimensions { scriptName }
      }
    }
  }
}
```

```json
{
  "accountTag": "PRODUCTION_ACCOUNT_ID",
  "datetimeStart": "2026-10-03T00:00:00.000Z",
  "datetimeEnd": "2026-10-03T23:59:59.999Z",
  "scriptName": "factored-hackathon-2026-arabicaai"
}
```

Adapted from the [official Workers GraphQL tutorial](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/): selecting only `scriptName` as a dimension requests a whole-window aggregate rather than time/status buckets. Inspect the response for GraphQL `errors`, the expected account/script, empty results and truncation before publishing. An empty result or access failure is not zero traffic. Confirm CPU units from the live schema. Record any adaptive sampling limits; log sampling settings do not prove analytics completeness. If a trend chart is needed, use bounded time buckets separately and never average their percentiles into a whole-window p95.

4. For route timing and HTTP status, use **Observability**, filtering `event = "request"` in the same window, with count and p50/p95 of `ms` by `route` and `method`. Keep failures and report missing fields. `request.ms` ends when the handler returns a Response; it excludes browser/network transfer and background work. Label it **handler duration**, not end-to-end speed. See the [observability runbook](../Plans/observability-runbook.md).
5. For invocation-log wall time on the six supported report routes, reuse [`summarize_worker_latency.py`](../../scripts/summarize_worker_latency.py) on a private export (maximum 64 MiB per file). It does not summarize custom `request.ms` events. It groups by route, method and version, reports missingness and nearest-rank quantiles, and explicitly does not establish export coverage. Its `failed_requests` combines HTTP status ≥400 and non-ok outcomes, so it is not the HTTP 5xx numerator above.

```bash
# From the repository root, after obtaining a private invocation-log export.
# This helper uses an exclusive --until; record that separately from GraphQL.
python3 scripts/summarize_worker_latency.py data/traffic-evidence/worker-export.json \
  --since 2026-10-03T00:00:00Z --until 2026-10-04T00:00:00Z
```

Review aggregate results against the matching dashboard window before filling this page. Keep raw logs in ignored `data/` or outside the checkout. Commit only reviewed counts, timing aggregates, version metadata and sanitized screenshots: exclude headers, cookies, tokens, bodies, statements, customer identifiers, raw URLs/query strings, IPs and individual request/ray identifiers. Store the query, UTC bounds, export timestamp and coverage caveats with the evidence so the judge can distinguish measured results from pending work.
