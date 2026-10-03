# Extractor v1: running the evaluation on Amazon Bedrock

The learned component reads one customer message into the fixed vocabulary. The deterministic policy decides the action ([ADR-006](../../Docs/ADRs/ADR-006-learned-extractor-workers-ai.md)). Evaluation calls go to Amazon Bedrock (amendment 6): the same weights (`openai.gpt-oss-20b-1:0`) and the same prompt, body and parsing as `workers_ai.py`. The online Worker is unchanged, and the extractor stays off online.

| File | Role | Who may change it |
|---|---|---|
| `prompt.md`, `workers_ai.py` (`build_body`, `parse`) | Behaviour: what the model is asked and how its answer is read | The isolated builder, with Manoella's approval (decision 5) |
| `bedrock.py` | Transport only: URL, Bearer key, the response wrapper | Anyone, including exposed authors |

## 1. A person enables the model and sets a key (once)

1. **Enable the model:** in the AWS console, account `arabica`, region **us-east-2**, open **Amazon Bedrock → Model access** and enable **OpenAI gpt-oss-20b**.
2. **Create a key:** open **Amazon Bedrock → API keys** and create a short-term key. Short-term keys expire with your console session, and they're the safer choice for a one-off run.
3. **Export it in your shell only.** Never commit or paste it:
   ```sh
   export AWS_BEARER_TOKEN_BEDROCK='<the key>'
   export AWS_REGION=us-east-2
   ```

## 2. Smoke check (about 20 calls)

```sh
.venv/bin/python -m evals.intake.run --split development --repetitions 1 \
  --system extractor-v1=intake_agent.extractor.bedrock:extract \
  --output data_foundation/runs/bedrock-smoke/results.json
```

Each outcome tells you what to do:

| Outcome | What it means |
|---|---|
| `CredentialsError` (HTTP 403) | The model access or the key is missing |
| `ConfigurationError` | Check the region and the model id |
| Schema-valid outputs below 95% | Stop. Something in the answer format may differ, and fixing it is a parsing change: the builder's, with Manoella's approval |

## 3. The isolated builder sets the reasoning level

Follow the 2026-10-03 revision in [`extractor-v1-builder-instructions.md`](../../evals/intake/preregistration/extractor-v1-builder-instructions.md). Run it in a history-free snapshot from `evals/intake/preregistration/make_clean_checkout.py`, by an agent that has seen no frozen case. It re-runs development (10 repetitions) and reports every ADR-006 trigger.

## 4. Pre-register, tag, then run the frozen set once

A human reviews `extractor-v1.md` and tags `extractor-v1`. Then the frozen run happens **once** (`evals/intake/README.md`), and the result is reported on all 60 cases and on the 52 that were not exposed (amendment 5).

**Cost:** about 360 calls in total for the development re-check and the frozen run, billed per token on the team's AWS credits. Check the current on-demand price on AWS's Bedrock pricing page before running; there is no daily cap.
