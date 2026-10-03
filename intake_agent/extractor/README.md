# Extractor v1: running the evaluation on Amazon Bedrock

The learned component reads one customer message into the fixed vocabulary. The deterministic policy decides the action ([ADR-006](../../Docs/ADRs/ADR-006-learned-extractor-workers-ai.md)). Evaluation calls go to Amazon Bedrock (amendment 6): the same weights (`openai.gpt-oss-20b-1:0`) and the same prompt, body and parsing as `workers_ai.py`. The online Worker is unchanged, and the extractor stays off online.

| File | Role | Who may change it |
|---|---|---|
| `prompt.md`, `workers_ai.py` (`build_body`, `parse`) | Behaviour: what the model is asked and how its answer is read | The isolated builder, with Manoella's approval (decision 5) |
| `bedrock.py` | Transport only: URL, Bearer key, the response wrapper | Anyone, including exposed authors |

## 1. A person checks access and refreshes a key before running

1. **Check access:** in the AWS console, account `arabica`, region **us-east-2**, confirm that the person generating the key is allowed to invoke `openai.gpt-oss-20b-1:0` and that the account has enough inference quota. OpenAI's gpt-oss models [do not require manual model activation](https://aws.amazon.com/about-aws/whats-new/2025/08/amazon-bedrock-automatic-access-openai-open-weight-models/); IAM controls still apply.
2. **Create or refresh a key:** open **Amazon Bedrock → API keys → Short-term API keys**. The key expires when the console session expires, at most 12 hours after generation, and works only in the region where it was generated ([AWS key reference](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-reference.html)). Before any smoke, development or frozen run, replace an expired key and export the new value. Ensure the remaining session lifetime covers the batch; a credentials failure stops the run.
3. **Enter it privately in your shell only.** This Bash prompt keeps the value out of shell history. Never commit or paste it into chat or logs:
   ```bash
   read -r -s -p 'Bedrock key: ' AWS_BEARER_TOKEN_BEDROCK
   export AWS_BEARER_TOKEN_BEDROCK
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
| `CredentialsError` (HTTP 401/403) | Check key expiry, its region and the principal's model-invocation permissions; refresh an expired key before a later authorized run |
| `ConfigurationError` | Check the region and the model id |
| Schema-valid outputs below 95% | Stop. Something in the answer format may differ, and fixing it is a parsing change: the builder's, with Manoella's approval |

## 3. The isolated builder sets the reasoning level

Follow the 2026-10-03 revision in [`extractor-v1-builder-instructions.md`](../../evals/intake/preregistration/extractor-v1-builder-instructions.md). Run it in a history-free snapshot from `evals/intake/preregistration/make_clean_checkout.py`, by an agent that has seen no frozen case. It re-runs development (10 repetitions) and reports every ADR-006 trigger.

## 4. Pre-register, tag, then run the frozen set once

A human reviews `extractor-v1.md` and tags `extractor-v1`. Then the frozen run happens **once** ([runbook](../../evals/intake/README.md)), and the result is reported on all 60 cases and on the 52 that were not exposed (amendment 5). This is still pending: Manoella approves amendment 6 and any behavioural revision, the isolated builder completes the development-only reasoning revision, and the pre-registration and human tag are checked before scoring.

The machine-readable registration must bind both the Bedrock transport and its shared behavioural implementation. After the approved builder changes are committed, use `--implementation intake_agent/extractor/bedrock.py --dependency intake_agent/extractor/workers_ai.py` with the Bedrock target and model id when running `prereg fill`. The prompt has its own required hash. `prereg check` verifies all three files in the working tree and at the registered commit; it accepts older single-file registrations for systems without dependencies. Filling records the current commit, so the later registration-document commit does not move the intended human tag.

**Cost:** about 360 calls before retries for the development re-check and the frozen run, billed per token on the team's AWS credits. Check [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/) and [account/model quotas](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas.html) before running. There is no Workers AI UTC-reset constraint, but Bedrock quotas can still throttle a batch. Report every attempted call, known tokens and `usage_unavailable_calls`; unknown usage is never free.
