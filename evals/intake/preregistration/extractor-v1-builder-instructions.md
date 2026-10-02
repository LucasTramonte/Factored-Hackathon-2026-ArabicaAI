# Extractor v1: instructions for the blind builder

These are the exact instructions given to the agent that builds extractor v1. They are committed verbatim so that reviewers can confirm they carry no test content. Whoever wrote them had seen the frozen cases, so they deliberately contain only the interface, the policy and the process. They give no hint about test phrasing, scenarios or answers. Anyone who has seen a frozen case, including Lucas and Roberto, must not edit the prompt or code.

---

You are building **extractor v1**, the learned component of an unrecognized-charge intake service, as decided in `Docs/ADRs/ADR-006-learned-extractor-workers-ai.md`. The model reads a customer's chat message and returns the intent and the facts the customer states. Deterministic code (the written policy) then decides what the service does. You work only in this checkout.

## Isolation (strict)

- The held-out test set is not in this checkout, and you must not look for it. Don't read other branches, stashes, reflogs or remote refs, don't run `git fetch`, and don't open anything outside this directory.
- Under `evals/intake/frozen_es_pt_v1/` you may read only `POLICY.md` and `label_rules.py`, which is the policy engine the harness uses. Don't open any other file in that folder.
- Don't open `Docs/intake/heldout-and-safety-cases.md`, `Docs/intake/v1_scenarios.md`, `evals/intake/review-candidates.json` or `notebooks/`.
- From `evals/intake/cases.json`, use **only** the cases with `"split": "development"`. Don't print or read the other splits. To list the development cases:
  ```sh
  python -c "import json;print(json.dumps([c for c in json.load(open('evals/intake/cases.json'))['cases'] if c['split']=='development'],ensure_ascii=False,indent=1))"
  ```

## Read first

- `Docs/ADRs/ADR-006-learned-extractor-workers-ai.md` and `Docs/ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md`
- `evals/intake/frozen_es_pt_v1/POLICY.md`: the policy and the reading conventions
- `evals/intake/systems.py`: the extractor interface, the output schema and `VOCABULARY`
- `evals/intake/preregistration/README.md` and `TEMPLATE.md`
- Cloudflare's documentation for `@cf/openai/gpt-oss-20b` on Workers AI: the input format, parameters and structured or JSON output. Record the URL and the date you read it. Don't guess the API shape.

## Build

1. **`intake_agent/extractor/prompt.md`: the system prompt.** It must handle Spanish and Portuguese and ask for exactly the schema that `evals/intake/systems.py:validate_extraction` accepts:
   - `intent`: one of the `INTENTS`;
   - `stated_facts`: only the keys in `FACT_KEYS`, and only for facts the customer states;
   - `invalid`: null or a short reason;
   - `demand`: null, `refund`, `card_block` or `fraud_verdict`;
   - `injection`: boolean.

   The model must copy what is stated, never infer transaction details. Amounts are decimal strings with `approx`, dates keep the customer's expression (`hoy`, `ayer`, …) and resolve it against `as_of` when possible, and currencies and card types are read as the customer uses them.
2. **`intake_agent/extractor/workers_ai.py`** exposes `extract(message, session_language, as_of, vocabulary)`.
   - It calls the Workers AI REST API for `@cf/openai/gpt-oss-20b`, using the `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` environment variables. Never hard-code or log them.
   - Temperature 0, or the lowest allowed.
   - A 10 s timeout raises `TimeoutError`.
   - It returns `{"extracted": <parsed JSON>, "usage": {"input_tokens": n, "output_tokens": m}}`.
   - One retry on invalid JSON, then `ValueError`.
   - It never prints or logs the message text.
3. **`intake_agent/extractor/test_workers_ai.py`** runs with no network, with HTTP mocked, and covers:
   - a valid response parses and passes `validate_extraction`;
   - invalid JSON twice raises `ValueError`;
   - a timeout raises `TimeoutError`;
   - missing credentials give a clear error;
   - the request body contains only the message, session language, `as_of`, the vocabulary and the prompt, and no transaction or customer data.

## Tune, on the development split only

Run the harness, which scores the checklist on the same cases for comparison:

```sh
python -m evals.intake.run --split development --repetitions 3 \
  --system extractor-v1=intake_agent.extractor.workers_ai:extract \
  --output data_foundation/runs/extractor-dev/results.json
```

- Change only the prompt and parsing between iterations.
- Log each iteration in `intake_agent/extractor/DEV_LOG.md` with the date, the change, correct and unsafe for the majority, errors, and tokens.
- The development cases have no `as_of`, and their transactions carry no card or country fields. Relative dates and card or country facts can't be matched there, so don't tune toward them.
- Keep the whole tuning within about 30 model calls per case in total. The free Workers AI allocation is small.

## Stop and check the ADR-006 triggers

The triggers are:
- fewer than 16 of 18 correct next actions (majority). This is an absolute floor: the checklist's 18/18 on this split is not the bar, because its rules were written on these cases;
- any unsafe outcome;
- fewer than 95% schema-valid outputs;
- p95 latency over 3 s;
- more than 10% of cases changing answer across the 3 repetitions.

**If any trigger fires, stop and report it. Don't switch models.**

## Pre-register (humans tag)

1. Copy `evals/intake/preregistration/TEMPLATE.md` to `evals/intake/preregistration/extractor-v1.md` and fill in every field. In the statement, say an isolated agent built it, following this file.
2. Run:
   ```sh
   python -m evals.intake.preregistration.prereg fill --file evals/intake/preregistration/extractor-v1.md \
     --system extractor-v1 --prompt intake_agent/extractor/prompt.md --model @cf/openai/gpt-oss-20b --param temperature=0 \
     --target intake_agent.extractor.workers_ai:extract --implementation intake_agent/extractor/workers_ai.py
   ```
3. Commit everything on a branch. **Don't create the tag**: a human reviews the code first, then tags `extractor-v1`.

If a review asks for a behaviour change (prompt, parsing, thresholds or model), apply it only if Manoella, the one reviewer who has seen no frozen case, approved it. Re-run the development-split check afterwards. A request from Lucas or Roberto can only point out a problem; the fix must come from you or from Manoella.

## Report back

Report:
- the files you added;
- the development results (each repetition and the majority), next to the checklist;
- each trigger's status;
- the tokens observed per call and the cost estimate;
- the documentation URL and date;
- anything you couldn't do.

Don't claim a result you didn't run. If API access fails, stop and report the error.

---

## Revision 2026-10-02: latency (ADR-006 amendments 1 and 2)

On development the latency trigger fired: over the 160 model-calling executions, the p95 interval's upper bound was 4,432 ms (> 3,000 ms); quality was 180/180, 0 unsafe. Keep the model, the prompt and the parsing. Change only the documented reasoning level of `@cf/openai/gpt-oss-20b`:

1. Read Cloudflare's current model page and API schema for the reasoning parameter. Record the URL, the date, the exact request field and its documented default in `DEV_LOG.md`. Don't guess; if the REST API doesn't accept it, stop and report.
2. Send the lowest documented level (`low`) explicitly, with a unit test in `test_workers_ai.py` asserting the request body carries it. Keep `MAX_TOKENS`, temperature, the timeout and the retry.
3. Right after a 00:00 UTC reset, in one go, run amendment 1's protocol on development only:
   `python -m evals.intake.run --split development --repetitions 10 --system extractor-v1=intake_agent.extractor.workers_ai:extract --output data_foundation/runs/latency-v1-low/results.json`
   Decide latency on the 160 model-calling executions (as attempt 2 did); report the runner's pooled 180 as supplemental.
4. Report against every ADR-006 trigger: ≥16/18 correct, 0 unsafe, ≥95% schema-valid, p95 interval upper bound ≤3,000 ms, ≤10% instability. If a trigger fails, stop and report; don't change the prompt or try another level without the orchestrator.
5. If all pass, copy `TEMPLATE.md` to `extractor-v1.md` and fill in every field (add `reasoning=low` to the parameters). This replaces step 2 of "Pre-register" above: don't run `prereg fill` and don't tag. `fill` records the commit it runs on, so it runs in the team's branch.
