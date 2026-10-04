# Extractor v1: running the evaluation on Google Vertex AI

The learned component reads one customer message into the fixed vocabulary. The deterministic policy decides the action ([ADR-006](../../Docs/ADRs/ADR-006-learned-extractor-workers-ai.md)).

Evaluation calls go to **Google Vertex AI** (amendment 7), using the managed open-model API `openai/gpt-oss-20b-maas`. That's the same weights as before, with the same prompt, body and parsing as `workers_ai.py`. Amazon Bedrock (amendment 6) is blocked on the project's AWS Free plan; its transport was removed after extractor v1 was registered on Vertex. The online Worker is unchanged, and the extractor stays off online.

| File | Role | Who may change it |
|---|---|---|
| `prompt.md`, `workers_ai.py` (`build_body`, `parse`) | Behaviour: what the model is asked and how its answer is read | The isolated builder, with Manoella's approval (decision 5) |
| `vertex.py` | Transport only: URL, Bearer token, the response wrapper | Anyone, including exposed authors |

## 1. A person signs in once per run

Use project `factored-hackathon-arabica-ai`. It is linked to the Google Cloud trial billing account, and the Vertex AI API (`aiplatform.googleapis.com`) is the only API needed. While the account isn't upgraded, the trial credits cover the calls and nothing more is charged.

```bash
gcloud auth login                     # once per machine
gcloud config set project factored-hackathon-arabica-ai
export VERTEX_PROJECT=factored-hackathon-arabica-ai VERTEX_LOCATION=global
export VERTEX_ACCESS_TOKEN="$(gcloud auth print-access-token)"   # valid about one hour: refresh before each run
```

Never commit or paste the token. If a run fails with `CredentialsError` and HTTP 401, the token has expired: run the last line again. HTTP 403 means the signed-in account lacks permission on the project; refreshing won't help (see the table in section 2).

**Quick probe** (one call, a content-free message):

```bash
curl -s -X POST -H "Authorization: Bearer $VERTEX_ACCESS_TOKEN" -H "Content-Type: application/json" \
  "https://aiplatform.googleapis.com/v1/projects/$VERTEX_PROJECT/locations/global/endpoints/openapi/chat/completions" \
  -d '{"model":"openai/gpt-oss-20b-maas","messages":[{"role":"user","content":"Say OK"}],"max_tokens":200}'
```

A working probe returns `choices[0].message.content` (the reasoning arrives separately, in `reasoning_content`), plus `usage` with `traffic_type: ON_DEMAND`.

## 2. Development runs (never the frozen set)

```sh
.venv/bin/python -m evals.intake.run --split development --repetitions 1 \
  --system extractor-v1=intake_agent.extractor.vertex:extract \
  --output data_foundation/runs/vertex-smoke/results.json
```

Amendment 1's latency protocol is the same command with `--repetitions 10` (at least 150 model-calling executions). It decides on the pooled `latency_p95_interval_ms` upper bound (≤ 3,000 ms).

| Outcome | What it means |
|---|---|
| `CredentialsError`, HTTP 401 | Expired or invalid token: refresh `VERTEX_ACCESS_TOKEN` |
| `CredentialsError`, HTTP 403 | The account lacks Vertex AI permission: the project owner grants it the Vertex AI User role (`roles/aiplatform.user`) on `VERTEX_PROJECT`, and `gcloud auth list` shows the right account |
| `ConfigurationError` | Check `VERTEX_PROJECT`, `VERTEX_LOCATION` and the model id |
| Schema-valid outputs below 95% | Stop. Fixing it is a parsing change, which is the builder's job, with Manoella's approval |

## 3. Reasoning level, only if the latency trigger fires

Amendment 2 lowers the reasoning level only when the latency trigger fires. **On Vertex it fired** (2026-10-03: 180 executions at the provider default, p95 2.64 s, interval upper bound 3.08 s > 3.00 s; 180 of 180 correct, 0 unsafe). So the isolated builder follows [`extractor-v1-builder-instructions.md`](../../evals/intake/preregistration/extractor-v1-builder-instructions.md), in a history-free snapshot from `evals/intake/preregistration/make_clean_checkout.py`.

## 4. Pre-register, tag, then run the frozen set once

A human reviews `extractor-v1.md` and tags `extractor-v1`. Then the frozen run happens **once** ([runbook](../../evals/intake/README.md)). The result is reported on all 60 cases and on the 52 that were not exposed (amendment 5). Manoella approves amendment 7 first.

**Planned evaluation date: 2026-10-05 UTC**, after those approvals, the human tag and the custodian's verified publication of the frozen corpus. The registered `openai/gpt-oss-20b-maas` endpoint [retires on 2026-10-21](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/maas/openai/gpt-oss-20b) (ADR-006 amendment 8), so the batch must finish before that date. If the prerequisites delay the run, choose another date before retirement; a different model or host requires a new registration. This is a planned run, not a completed evaluation.

Run from the repository root, keeping the registered Vertex target and model (the model id is fixed in `vertex.py`):

```sh
.venv/bin/python -m evals.intake.run \
  --cases evals/intake/frozen_es_pt_v1.candidate.json --split frozen_es_pt_v1 --repetitions 3 \
  --system extractor-v1=intake_agent.extractor.vertex:extract \
  --preregistration extractor-v1=evals/intake/preregistration/extractor-v1.md \
  --output data/frozen-run/results.json
```

The runner verifies the registration hashes and tag before scoring. Run the three repetitions back to back in one batch, recording its start/end times and any model-build metadata, as the registration requires.

The registration binds the Vertex transport and its shared behavioural implementation. Run `prereg fill` with `--implementation intake_agent/extractor/vertex.py --dependency intake_agent/extractor/workers_ai.py`, the Vertex target `intake_agent.extractor.vertex:extract` and the model id `openai/gpt-oss-20b-maas`. The prompt has its own required hash. `prereg check` verifies all three files in the working tree and at the registered commit. Filling records the current commit, so the later registration-document commit doesn't move the intended human tag.

**Cost:** about 360 calls before retries, billed per token against the trial credits. That is roughly 1,900 input and 250 output tokens per call (development smoke, 2026-10-03). Check the [Vertex AI pricing page](https://cloud.google.com/vertex-ai/generative-ai/pricing) for the current per-token price. Report every attempted call, the known tokens and `usage_unavailable_calls`; unknown usage is never counted as free.
