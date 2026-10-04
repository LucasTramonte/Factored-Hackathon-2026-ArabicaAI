# Monitoring: the live Worker and the AI suggestion path

Two Cloud Monitoring alert policies watch extractor v2 (`google/gemini-3.5-flash-lite`, [ADR-006 amendment 10](../../../Docs/ADRs/ADR-006-learned-extractor-workers-ai.md#post-freeze-amendment-2026-10-04)) on project `factored-hackathon-arabica-ai`. They read Vertex AI's **native** per-project metrics on resource `aiplatform.googleapis.com/PublisherModel`. These are the metrics that diagnosed the 2026-10-04 `gpt-oss-20b` degradation, so no log-based metric is needed. The Worker runs on Cloudflare and its logs aren't in GCP.

| Policy (file) | Fires when | Why this threshold |
|---|---|---|
| **Throttled or failing (429/5xx)** (`vertex-suggestions-errors.json`) | At least 3 responses with `response_code` 429 or 5xx in a 15-minute window, summed across locations | The Worker retries a 429 once, so one transient 429 can log up to 2 rows. Three in 15 minutes means repeated throttling or failure, the same signal that opens the Worker's circuit breaker (3 of the last 5 calls in 5 minutes) |
| **Live demo `/healthz` failing** (`worker-healthz-down.json`, uptime check `arabica-intake-healthz`) | The uptime check calls `/healthz` on the live Worker every 5 minutes from several regions and expects `"status":"ok"`, which the Worker returns only after a D1 ping. The policy fires when more than one region fails for 5 minutes | Cloudflare's free plan has no external uptime monitor. One region failing can be the network; several failing for 5 minutes means customers can't reach the service |
| **Slow model responses** (`vertex-suggestions-latency.json`) | p95 of `model_invocation_latencies` (`latency_type = total`) above 5,000 ms in a 15-minute window, **and** at least 3 calls in that window | Healthy p95 is about 2.1–2.2 s (development, 180 calls). The Worker gives up at 10 s, so 5 s fires before customers lose suggestions to timeouts. The call-count condition stops one slow call from firing it at demo volume |

Both auto-close after an hour without a breach.

**Notifications.** The project has no notification channel. Incidents show in the Cloud Console (Monitoring → Alerting), but nobody is paged until a person attaches a channel:

```bash
gcloud beta monitoring channels create --project factored-hackathon-arabica-ai --type=email \
  --display-name="Intake on-call" --channel-labels=email_address=<a team address>
gcloud monitoring policies update <policy> --project factored-hackathon-arabica-ai --add-notification-channels=<channel>
```

**To change a policy,** edit its JSON here and run `./apply.sh`. The script is idempotent: a policy whose `displayName` already exists is updated in place, never duplicated. `scripts/test_gcp_monitoring.py` checks the files offline in CI. Before raising a threshold, read the latest hours in Metrics Explorer (`publisher/online_serving/model_invocation_latencies`). If the model changes, update `model_user_id` in both files.

**Created** 2026-10-04 by `./apply.sh`, by a person's session: `alertPolicies/17465679292594165528` and `alertPolicies/11013800498811905432` (Vertex), `uptimeCheckConfigs/arabica-intake-healthz-XY2T5LYAVWY` and `alertPolicies/10930623930790389731` (`/healthz`).

**The Worker's own logs** live in Cloudflare, not here. See [`Docs/Plans/observability-runbook.md`](../../../Docs/Plans/observability-runbook.md).
