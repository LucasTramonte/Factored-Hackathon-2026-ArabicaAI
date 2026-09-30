# Extractor v1 development log

## 2026-09-30 UTC (2026-09-29 America/Bogota): offline implementation

An isolated agent built this initial implementation following
`evals/intake/preregistration/extractor-v1-builder-instructions.md` verbatim.
The agent accessed only `POLICY.md` and `label_rules.py` under the frozen
directory, and only development cases from `cases.json`. No frozen case,
message, fixture, review record, or result was accessed. Official challenge
source startup was performed within this checkout, including all four
indexed PDFs; it did not expand the extractor's scope.

Initial change: an ES/PT extraction prompt and a stdlib Workers AI REST
adapter for `@cf/openai/gpt-oss-20b`, temperature 0, `max_tokens=512`, JSON
object mode, no tools, and a 10-second HTTP timeout per attempt. One retry
is allowed for invalid output; both observed calls' token counts are summed
on a successful retry. The existing `validate_extraction` checks model
output. Missing credentials, API failures, and missing/invalid provider
token usage stop with a generic error; no fabricated token zeros are
returned. Neither the adapter nor the prompt receives retrieved customer
records, transactions, identity, confirmation, or tool state.

No model tuning iterations took place. No prompt/parsing revisions were
made in response to model results or exposed reviewers. Future behavioral
revisions require the unexposed reviewer's approval under ADR-006, then a
new development check; no model switch is authorized here.

### Offline verification

- Nine stdlib `unittest` checks were written before production code and
  first failed because the adapter was absent. They then passed with HTTP
  mocked and the real extraction validator. Coverage includes JSON text
  and structured responses, two invalid outputs, session-field rejection,
  retry usage totals, direct/wrapped timeouts, missing credentials, the
  permitted request body, HTTP failures, and unavailable usage.
- A supported Python 3.14 run also passed those nine checks, and surfaced a
  resource warning. A failing check then demonstrated that an HTTP error
  response was not closed; adding `error.close()` corrected it. The final
  nine-check run with `python3` passed without warnings. A fresh supported
  interpreter/project-suite run is left to the parent agent.
- `python3 -m py_compile intake_agent/extractor/workers_ai.py
  intake_agent/extractor/test_workers_ai.py` and `git diff --check` passed.
- `make test PYTHON=python3` was attempted and failed before collection:
  that interpreter has no `pytest`. The default `python3` is Python 3.9,
  below the repository's Python 3.10+ prerequisite. No project-suite pass
  is claimed. No dependencies or frameworks were added.

### Development evaluation: blocked before inference

The exact requested command was attempted using `python3`:

```sh
python3 -m evals.intake.run --split development --repetitions 3 \
  --system extractor-v1=intake_agent.extractor.workers_ai:extract \
  --output data_foundation/runs/extractor-dev/results.json
```

It stopped before any HTTP call:

```text
RuntimeError: Missing Workers AI credentials: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
```

Environment presence was checked without printing values or reading
credential files. Both variables were absent. No results file was produced.

| Result | Extractor correct / unsafe / errors / tokens | Checklist comparison |
|---|---|---|
| Repetition 1 | Not run | ADR-006 documents 18/18 development correct; no new baseline run here |
| Repetition 2 | Not run | Same documented baseline, not a measured comparison |
| Repetition 3 | Not run | Same documented baseline, not a measured comparison |
| Per-case majority | Not available | No extractor comparison available |

| ADR-006 trigger | Status |
|---|---|
| Fewer than 16/18 majority correct | Not assessed |
| Any unsafe outcome | Not assessed |
| Fewer than 95% schema-valid outputs | Not assessed; mocked fixtures are not model outputs |
| p95 latency above 3 s | Not assessed |
| More than 10% changing answers across repetitions | Not assessed |

Model calls: **0**. Observed model tokens per call, measured latency,
model-build metadata, and observed inference cost: **not available**.
The mocked token counts are test inputs, not measurements. The documented
price estimate for a future observed run is
`(input_tokens * 0.20 + output_tokens * 0.30) / 1_000_000` USD before the
shared free allocation; prices must be rechecked when the real run occurs.
Unsuccessful outputs yield exceptions, so the existing harness does not
retain their token usage; a full cost report must account for those failed
attempts separately rather than treating them as free.

### Official documentation read

All URLs below were fetched on **2026-09-30 UTC**:

- Model usage and parameters:
  <https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/>
  (Markdown fetched at the page's `index.md`).
- Model synchronous input/output schemas:
  <https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/sync-input.json>
  and <https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/sync-output.json>.
- REST authentication and envelope:
  <https://developers.cloudflare.com/workers-ai/get-started/rest-api/>.
- Response text and optional usage fields:
  <https://developers.cloudflare.com/api/resources/ai/>.
- JSON output convention:
  <https://developers.cloudflare.com/workers-ai/features/json-mode/>.
- Token prices:
  <https://developers.cloudflare.com/workers-ai/platform/pricing/>.
- Provider data handling:
  <https://developers.cloudflare.com/workers-ai/platform/data-usage/>.

The model-specific input schema advertises JSON output; the general JSON
mode page's supported-model list omits gpt-oss-20b. The model's raw output
schema only specifies an object. Mocks use the general documented
`result.response` / `result.usage` shape; actual model compatibility remains
unverified until credentials are available. Do not claim live API behavior
from these mocks.

### Remaining gates

Supply Workers AI credentials through the environment in the isolated
checkout, verify the live response contract, then run the three-repeat
development evaluation and record every trigger, token count, failure, and
cost. Stop and report if any trigger fires; do not switch models.
Pre-registration is deliberately absent until real development evidence
exists. There has been no human review, completed registration, tag, frozen
evaluation, live-service integration, push, or PR creation by this builder.
