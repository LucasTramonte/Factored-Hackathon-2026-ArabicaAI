# Cloudflare traffic and performance evidence

**Observed production traffic: 964 Worker invocations, 244 asset requests and 0 runtime invocation errors in the selected 24-hour window.** This is operational evidence from the production dashboard, not a count of users or successful banking outcomes. The outbound-host table also contains **11 SES HTTP 4xx responses**; zero runtime errors does not mean every operation succeeded.

Target: `factored-hackathon-2026-arabicaai`, serving the [live demo](https://factored-hackathon-2026-arabicaai.lucas-tramonte.workers.dev/). Model accuracy and business claims remain in [Evaluation](../deliverables/EVALUATION.md) and [Business outcomes](../deliverables/BUSINESS_OUTCOMES.md).

## Source and scope

| Provenance | Recorded value |
|---|---|
| Source | Production Worker Metrics dashboard; [captured text](traffic-2026-10-04/dashboard.txt) |
| Selected window | October 3, 2026 20:00 → October 4, 2026 20:00 GMT−5 |
| UTC equivalent | **2026-10-04 01:00 → 2026-10-05 01:00 UTC**; endpoint inclusion not exposed by dashboard |
| Text captured | 2026-10-05 01:23:57.338 UTC |
| Version scope | **All deployed versions**; current deployment at capture: short ID `71e9e803`, 100% current traffic |
| Coverage limits | Sampling and timing aggregation not verified; complete historical version UUID/commit mapping not captured |

The current deployment is not the version for the entire window. The dashboard lists multiple historical versions, including collapsed entries. No user, bot, test or health-check exclusions were applied. The earlier runbook snapshot of 277 requests / 24 hours / 0 Worker errors has no retained provenance and is not combined with this window.

Screenshots: [selected window](traffic-2026-10-04/window.png), [overview](traffic-2026-10-04/overview.png), [CPU chart](traffic-2026-10-04/cpu.png), [wall-time chart](traffic-2026-10-04/wall-time.png), [request-duration chart](traffic-2026-10-04/request-duration.png).

## Traffic and errors

| Metric | Observed value | Population / denominator |
|---|---:|---|
| Worker invocations | **964** | Selected script, window and all versions |
| Runtime invocation errors | **0 / 964 (0%)** | Runtime outcomes; not the API HTTP error rate |
| Asset requests | **244** | Separate static-asset traffic; 179 HTTP 2xx + 65 HTTP 3xx; 0 HTTP 4xx/5xx/other |
| Asset cache hit rate | **87.70%** | Dashboard asset-cache metric; eligible denominator not exported |
| Subrequests | **120** | Dashboard total; not users or incoming requests |
| Request distribution | **964 across 13 edge locations** | Location counts reconcile to invocations; these are not visitor countries |

Asset serving can bypass Worker code; do not add assets and invocations into a unique-request or visitor total without reconciling overlap. See [static asset routing](https://developers.cloudflare.com/workers/static-assets/) and the app's [`wrangler.jsonc`](../../back-end/wrangler.jsonc).

The separate outbound-host table shows **45 responses**, below the top-level 120 subrequests. Its population/coverage difference is unresolved; the table is not a complete breakdown of the total:

| Outbound service | HTTP 2xx | HTTP 4xx |
|---|---:|---:|
| SES (`email.us-east-2.amazonaws.com`) | 10 | **11** |
| Cognito | 12 | 0 shown |
| IAM credentials | 4 | 0 shown |
| STS | 4 | 0 shown |
| Vertex AI | 4 | 0 shown |

These responses do not establish email delivery, model correctness or successful case resolution. The cause and customer impact of the SES 4xx responses are not established by this aggregate capture.

## Timing: displayed values, with limits

The following are **dashboard chart legend values**, labeled P50/P90/P99 by Cloudflare. Their aggregation across time buckets is unverified; they must not be presented as pooled whole-window percentiles or as p95.

| Dashboard series | P50 legend | P90 legend | P99 legend |
|---|---:|---:|---:|
| CPU time | 2.4 ms | 4.8 ms | 8.1 ms |
| Wall time | 84.19 ms | 283 ms | 604 ms |
| Request duration | 83.95 ms | 239 ms | 366 ms |
| Memory usage | 2.37 MB | 2.48 MB | 2.57 MB |

The top summary tiles instead show **CPU 3 ms, wall time 94 ms and request duration 94 ms**. These are different dashboard views; their relationship to the legend values is unverified. Timing sample sizes and missingness were not exported.

CPU measures execution work. Wall time includes I/O and `waitUntil()` work after the response; it is not client response duration. Invocation errors describe runtime outcomes and differ from HTTP 4xx/5xx responses. [Cloudflare metric definitions](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/).

**Still unmeasured here:** end-to-end p50/p95 under a documented workload with failed attempts retained. This capture does not establish the evaluation's under-two-second request p95 target. Browser LCP/INP/CLS and page/interaction counts are **unavailable in this account capture**: Web Analytics showed onboarding instead of site data at 2026-10-05 01:25:15.818 UTC ([captured text](traffic-2026-10-04/web-analytics.txt), [screenshot](traffic-2026-10-04/web-analytics.png)). No instrumentation or account settings were changed. This does not establish whether another account or analytics provider collects browser measurements. [Core Web Vitals](https://developers.cloudflare.com/web-analytics/data-metrics/core-web-vitals/).

## Observed route handler duration

A separate Observability query used the same selected window: `event = "request"`, grouped by `route`, numeric `median(ms)`, `p95(ms)` and count, with limit 100. It returned **24 groups / 635 structured request records**, a different instrumentation population from the 964 platform invocations. Source: [query and complete table](traffic-2026-10-04/route-timings.txt), [screenshot](traffic-2026-10-04/route-timings.png), captured 2026-10-05 01:28:21.113 UTC.

| Route | Request records | Median handler ms | P95 handler ms |
|---|---:|---:|---:|
| `/transactions` | 22 | 152 | 176 |
| `/intake/start` | 9 | 117 | 120 |
| `/intake/confirm` | 5 | 462 | 480 |
| `/intake/handoff` | 4 | 364 | 1,031 |
| `/reports` | 42 | 92 | 116 |
| `healthz` (monitoring, shown separately) | 382 | 68 | 276 |

The same structured-record population, grouped separately by numeric HTTP status, returned **635 records: 620 HTTP 2xx, 15 HTTP 4xx and 0 HTTP 5xx**. The detailed counts are 200: 593; 201: 19; 202: 7; 204: 1; 401: 9; 422: 6. Thus the observed 5xx rate is **0 / 635 (0%)** within these records only; it does not cover all 964 platform invocations. Source: [status query and counts](traffic-2026-10-04/http-status.txt), [screenshot](traffic-2026-10-04/http-status.png). The 4xx responses remain visible and are not treated as successful requests.

The query applied no status filter, so failures were not excluded; versions and methods were not separated. Counts are request records, not verified timed-observation denominators: missing numeric fields, sampling and the platform quantile algorithm remain unverified. `request.ms` measures the handler until it returns a Response and excludes network transfer, browser rendering and background `waitUntil()` work. These small route samples do not establish an end-to-end p95 target or a production latency guarantee.

## Reproduction and optional aggregate export

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), select the account owning the `lucas-tramonte.workers.dev` deployment, then **Workers & Pages → factored-hackathon-2026-arabicaai → Metrics**. Verify the script and deployment history before exporting. Capture the exact UTC range, units, filters, sample information and visible totals; screenshots must show these labels, with account personal details cropped out.
2. Export the aggregate GraphQL result using an already authorized operator/client. Endpoint: `https://api.cloudflare.com/client/v4/graphql`; authenticated JSON POST with `Authorization: Bearer` supplied privately by the operator. Do not extract Wrangler credentials or put tokens in this file, shell history, screenshots or Git. See [Analytics authentication](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/).
3. Paste the query and variables below into that client. Replace the account and UTC bounds. The dates below match the selected dashboard bounds, but its endpoint inclusion is unknown; exact reconciliation therefore remains pending. The tutorial uses an inclusive end (`datetime_leq`); preserve that convention in the record and avoid overlapping exports. This query has **not been executed for this record**.

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
  "datetimeStart": "2026-10-04T01:00:00.000Z",
  "datetimeEnd": "2026-10-05T01:00:00.000Z",
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
  --since 2026-10-04T01:00:00Z --until 2026-10-05T01:00:00Z
```

Review any further exports against the matching dashboard window before adding results to this page. Keep raw logs in ignored `data/` or outside the checkout. Commit only reviewed counts, timing aggregates, version metadata and sanitized screenshots: exclude headers, cookies, tokens, bodies, statements, customer identifiers, raw URLs/query strings, IPs and individual request/ray identifiers. Store the query, UTC bounds, export timestamp and coverage caveats with the evidence so the judge can distinguish measured results from pending work.
