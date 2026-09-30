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
object mode, no tools, and `urlopen(timeout=10)` per attempt. That socket
timeout was not an elapsed deadline; see the correction below. One retry
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

## 2026-09-30 UTC: nonbehavioral review correction — HTTP attempt deadline

The reviewer reported that `urlopen(timeout=10)` limits individual socket
operations, allowing a fragmented response body to finish after ten elapsed
seconds. An independent local-only HTTP test reproduced this before the
fix: it served a valid body in fragments at 0, 6, and 12 seconds, each wait
shorter than the socket timeout. The test failed because extraction returned
success instead of raising `TimeoutError`; the three-check RED run took
12.027 seconds. Checks refusing an existing process timer and a non-main
thread also failed before implementation.

The adapter now arms a POSIX `ITIMER_REAL` deadline around each complete
HTTP open/read attempt. `SIGALRM` raises the existing sanitized timeout
error, the timer is canceled and the previous handler restored, and a
monotonic elapsed check rejects late success if a native call deferred the
Python handler. The monotonic check separately failed before its addition.
The socket timeout remains as a second bound. Every allowed invalid-output
retry gets a fresh ten-second deadline; a timeout itself is not retried.

`python3 -m unittest intake_agent.extractor.test_workers_ai -v` then passed
**14 tests in 10.016 seconds**, including the real local HTTP test. That
test requires the observed timeout after at least 9.5 seconds and before
11.5 seconds, ahead of the final body fragment at twelve seconds; it does
not mock a raised timeout. Tests also cover alarm handler restoration,
timer cancellation, preserved active timers, thread refusal, and late
success rejection. The earlier schema, retry, request, credentials, and
usage checks remain in the run. Parent will run fresh supported-interpreter
and project-suite checks; no new full-suite pass is claimed here.

This small synchronous CLI implementation requires a POSIX main thread and
an available process real-time timer. It refuses unsupported threads or
platforms, or an already active process timer, before sending the HTTP
request. The application must permit delivery of `SIGALRM` and must not
concurrently repurpose this process-global timer. Python executes signal
handlers in its main thread; OS scheduling, blocked signals, or native
calls that defer Python signal handling can delay the exception. The
monotonic check prevents a deferred call from being accepted as timely,
but this is not a universal hard real-time cancellation guarantee. A
threaded/non-POSIX runtime or native calls needing forcible cancellation
would require an independently supervised process rather than a silent
fallback to socket timeouts.

Only `workers_ai.py`, its tests, and this log changed. Prompt, model,
schema, tuning, and the pre-existing harness findings were untouched. This
correction made **zero model calls**. Prior credential checks describe
the earlier environment only; the parent is separately checking authorized
Wrangler access without providing auth files to this builder. No credentials
were read, and no registration, tag, push, or PR was created here.

## 2026-09-30 UTC: parent provider probe and envelope compatibility

The parent verified existing authorized Wrangler OAuth `ai:write` access
and ownership of the project's Cloudflare account, then ran a provider I/O
probe using an existing development message with the unchanged prompt and
adapter. It bypassed the evaluation wrapper to inspect provider I/O; it was
not an authentication/scoring scenario and is not evidence that an
unauthenticated harness case calls the model. The builder received metadata
only, and did not read authentication files or make live calls.

The parent reported **two model calls** in that initial probe:

| Provider call | Observed input tokens | Observed output tokens |
|---|---:|---:|
| Initial attempt | 1,534 | 267 |
| Invalid-output retry | 1,534 | 390 |
| Initial probe total | 3,068 | 657 |

The combined adapter call took **6,487 ms**. Both HTTP API envelopes were
successful, but their `result` contained `choices`, not `response`; the
adapter therefore raised `ValueError` after its one retry. This is
provider-envelope compatibility evidence, not successful extraction,
three-repetition majority scoring, development tuning, or an ADR trigger
evaluation. The reported combined time is not a measured per-call p95.
Using the previously documented price, these two calls have an estimated
list-price cost of **$0.0008107 USD** before the shared free allocation;
this is not an observed bill or cost per successful intake. Neuron values
were not provided to the builder.

A third parent provider-I/O probe used authenticated development input,
again without scoring the wrapper: **one request, 3,220 ms, 1,534 input /
275 output / 1,809 total tokens**. Its `choices` was a list; the first
choice had keys `index`, `message`, `logprobs`, `finish_reason`,
`stop_reason`, and `token_ids`. The message had keys `role`, `content`,
`refusal`, `annotations`, `audio`, `function_call`, `tool_calls`, and
`reasoning_content`. `content` was a string and `finish_reason` was `stop`.
The parent reported that `validate_extraction(json.loads(content))` passed.
No message, case, or model-output text was supplied to the builder. Two
setup attempts failed before calling the API and made zero requests.

Across these parent provider probes, the actual total is **three model
calls, 4,602 input and 932 output tokens**. Their estimated combined
list-price cost is **$0.0012000 USD** before the shared free allocation.
These are observed provider-token counts with a calculated price estimate,
not a bill, scored majority result, or development trigger assessment.

For the nonbehavioral I/O correction, a synthetic chat-completion envelope
test was written first and failed because the adapter rejected valid
`choices[0].message.content`. The parser now reads that field when the
existing `response` field is absent. The same extraction validator and
usage accounting still apply. An empty-choices check then failed with an
uncaught `IndexError`; it now follows the existing one-retry invalid-output
path and ends in sanitized `ValueError`. No free-form repair or semantic
normalization was added.

`python3 -m unittest intake_agent.extractor.test_workers_ai -v` passed
**16 offline tests in 10.018 seconds**, including the real local HTTP
deadline test. Compilation and whitespace checks also passed. Prompt,
model, parameters, extraction schema, and shared harness were unchanged.
No development-majority results or passed triggers are claimed, and
pre-registration remains absent.

Documentation rechecked on **2026-09-30 UTC**:

- Cloudflare OpenAI compatibility:
  <https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/>.
- The model output schema still only declares an object:
  <https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/sync-output.json>.
- The official chat-completion content convention:
  <https://developers.openai.com/api/docs/guides/conversation-state>.

Cloudflare's compatibility page documents Chat Completions endpoints, but
does not spell out this model's native `/ai/run` envelope. The native
envelope compatibility correction is supported by the parent's observed
field metadata as well as the official chat-completion convention. The
builder's fixtures contain synthetic content, never captured model text or
frozen examples. Initial zero-call/missing-credential statements above
describe the earlier offline work, not the parent's subsequent probes.
