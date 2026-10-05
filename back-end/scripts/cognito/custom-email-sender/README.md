# Selected-language Cognito emails

Cognito generates, expires and verifies every code. The small Lambda adapter only decrypts the native ciphertext and sends the email through SES. Language comes from the trusted `callerContext.clientId`, through a fixed ES/PT/EN map; missing/unmapped clients fall back to Spanish. Caller metadata cannot override recipient, identity or language. Both UI entry points snapshot the selected client for request and verification. The Worker accepts only three configured audiences with all other authentication checks unchanged.

## Public production clients

| Language | Public client id |
|---|---|
| ES (existing) | `5ak5cbjgdddso1c3h3i2aha7sn` |
| EN | `315cjcdpsbnj8fb2uqti36piio` |
| PT | `6sri1hhfiqmag7k36ks943kam` |

The EN/PT clients were created by copying supported creation fields from the existing public client, preserving auth flows, attributes, token settings and enumeration prevention; no secret, user or password change. The same ids must appear in the UI map, Worker `COGNITO_CLIENT_IDS` and stack `ClientLocales` JSON parameter.

## Checks and package

```sh
npm test --prefix back-end/scripts/cognito/custom-email-sender
sh back-end/scripts/cognito/custom-email-sender/package.sh
```

`dist/sender.zip` and dependencies are ignored. The only direct new package is AWS Encryption SDK; the Node 22 Lambda runtime supplies the SES SDK. All Cognito email categories have localized templates, plain-text fallback and escaped HTML. Invitation passwords unescape Cognito's reserved angle brackets. Unknown sources, wrong pool, missing recipient/code and delivery errors fail closed with sanitized errors. Logs contain only locale/template/status; `sent` means SES accepted, not inbox delivery.

## Isolated evidence and limits

The disposable pool `us-east-2_Ako4noYxC` and stack `arabicaai-otp-locale-probe-20261004` use the real Cognito→KMS→Lambda→SES path. The simulator address was rejected by Cognito before Lambda invocation with `LimitExceededException`; no simulator-delivery success is claimed. An owned test inbox was then used for bounded native requests. Cognito returned EMAIL_OTP challenges; normalized sender logs provide language/send evidence. Inbox rendering and successful code entry remain separate checks.

The metadata-based proposal failed its live probe: SELECT_CHALLENGE metadata did not reach the sender. Email-only users can skip selection and receive a code immediately. Neither path is used in the final implementation.

## Rollout record — 2026-10-04

Production stack `arabicaai-cognito-localized-email` is CREATE_COMPLETE. Its Active/Successful Lambda package SHA-256 (base64) is `+3BkbUfpPI2o4GRaKURmpKsxJgq4SEcY93O7s8GSJoU=`. The sender was attached to the production pool and every supported update field was read back successfully; MFA remains OPTIONAL. Private before/update/after snapshots are retained outside Git. The frontend/client selection and Worker audiences still require this PR's reviewed deployment.

Validation: 251 Worker unit, 127 integration and 8 budget tests passed; 216 focused Angular tests passed; production build passed with the existing 500 kB warning (515.93 kB bundle, below the 1 MB failure ceiling); relative Markdown links resolve. Independent specification and quality reviews passed. Real isolated native challenges produced sanitized SES-accepted logs for ES, EN and PT. This is not proof of inbox delivery or successful code entry. Minor known UX edge: changing UI language while an earlier code is pending changes the help text's subject; verification correctly retains the original client, and resend uses the new language.

## Activation

1. Validate `template.json`. Create a stack with `PoolId`, verified `SesIdentityArn`, matching `SesFrom`, and `ClientLocales` JSON. It creates an inert bootstrap Lambda, pool-scoped invoke permission, a KMS key, least-privilege execution role and seven-day logs. Never attach the bootstrap.
2. Package and upload `dist/sender.zip` with `aws lambda update-function-code`; wait for `LastUpdateStatus=Successful`. Confirm runtime dependency loading in the isolated pool first.
3. Run `attach.sh` with `AWS_PROFILE`, `POOL_ID`, `SENDER_ARN`, `KEY_ARN`, and a fresh private ignored `SNAPSHOT_DIR`. It snapshots configuration, projects all supported update fields, refuses a conflicting sender/key, checks for concurrent changes, attaches and verifies every updated field. Existing MFA remains OPTIONAL; user preferences are unchanged. Serialize operator configuration changes because Cognito has no conditional pool update.
4. Deploy the frontend and Worker audience allowlist together through reviewed CI. Until then the existing client continues sending Spanish. Test selected EN/PT/ES sign-in and retry from both customer/reviewer screens. Never print codes or tokens.

Only an authorized operator activates production. The updater requires KMS CreateGrant; Cognito creates its encryption grant during pool update. No Worker secret or D1 migration is required.

## Rollback and cleanup

Restore the privately saved pre-attachment LambdaConfig using a fresh all-fields read-modify-write projection; remove only this installation's CustomEmailSender/KMSKeyID, preserving unrelated triggers/settings. Restore the previous frontend/Worker together if their configuration must be reverted. The centered static template remains available for fallback; `otp-email.sh` changes that fallback only while a custom sender is attached.

The disposable pool and stack must be removed after evidence is captured; CloudFormation schedules KMS deletion with its waiting period. Do not delete the production key/function while Cognito references them. Keep snapshots private and committed evidence aggregate-only.

Sources: [sender categories and parameters](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-custom-email-sender.html), [activation and escaping](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-custom-sender-triggers.html), [common trusted caller context](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-working-with-lambda-triggers.html).
