# Charge-intake demo: runbook

## What it does

The guided workflow ([ADR-002](../ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md)), extended by the reviewed customer lifecycle:

1. A customer signs in with an email one-time code and sees only their own charges.
2. They pick one, describe it and explicitly confirm.
3. They get a reference once the case is stored.
4. A human teammate, signed in separately as a reviewer, reads the report, sends a response and advances it to review.
5. The reviewer finishes the review with an explanation; the customer reads it and can create a linked follow-up with “Todavía necesito ayuda”.

The reference means "accepted for human review". It is not a fraud decision, a refund, a card block or a resolution. The identified-charge flow is deterministic. For eligible missing-charge reports, [ADR-012](../ADRs/ADR-012-ai-online-only-where-evidence-shows.md) permits a model to read supplied details into facts and suggest only owned charges; the customer confirms or rejects them. Unavailable or unclear suggestions retain the human handoff. No model decides identity, ownership, status or financial action. The runtime is one Cloudflare Worker with D1 ([ADR-003](../ADRs/ADR-003-intake-single-runtime-worker-d1.md)). Capacity and cost are covered in [ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md).

| Part | Path | Role |
|---|---|---|
| Batch data | `data_pipelines/bronze`, `silver`, `quality`, `gold` | Bounded one-day sample → validated D1 seed and manifest |
| API | `back-end/` | Worker + D1: sessions, customer scope, idempotent cases, agent view |
| Web client | `front-end/` | Angular customer and agent views; response contracts in `front-end/contracts/` |

## Local run (no Cloudflare account)

You need Python 3.10+ and Node 22+. From the repository root:

```bash
make setup                 # Python pipeline dependencies in .venv
make intake-setup          # npm ci for front-end and back-end
make intake-test           # Gold slice tests, Angular specs, Worker unit and integration tests
```

`make intake-test` builds the UI and runs the Worker against a throwaway local D1. For browsing, see [back-end/README.md](../../back-end/README.md).

## Customer lifecycle rehearsal (2026-10-04)

The [dated evidence](../Evidence/customer-clarity-lifecycle-2026-10-04.md) records the local authored API rehearsal and automated UI checks. These are regression evidence, not fresh tester findings or held-out extractor results. A local Chrome customer and separate in-app-browser reviewer rehearsal also verified saved progress, replies, plain-text explanation, passive refresh and linked follow-up. Three fresh testers remain **pending external**; SES acceptance and inbox delivery of a report email were confirmed in production on 2026-10-04 at 20:16 UTC ([observability runbook](observability-runbook.md)); deployed OTP and assistive-technology checks remain untested.

### Human-operated demonstration protocol

Use synthetic records in an isolated local database or the authorized demo. Preserve shared activity: never reset the shared demo to make a scenario fit. Keep a customer browser/profile, another customer's profile and an authorized reviewer profile separate; do not share cookies or one-time codes. A teammate operates the reviewer role; there is no automatic reviewer or timed closure.

Repeat the following in Spanish and Portuguese, then smoke-check English. Record only aggregate checkpoint outcomes and language, never statements, closing explanations, customer identifiers, tokens or inbox addresses in evidence.

1. Find an owned charge, report it with an explicit confirmation, and note the acknowledged reference. Retry the same submission key: it must recover the same reference. A failed write/read-back must not say it was saved.
2. Use the missing-charge entry: provide sufficient details for an eligible suggestion, confirm one suggested owned charge; on another report reject the suggestions. Demonstrate no clear match and service-unavailable fallback separately. Both keep a saved human handoff; no suggested charge becomes verified bank evidence.
3. In the separate reviewer session, open that report, send a response and move `received → in_review`. Return to the customer view and observe the actual response/progress update. Refresh manually and refocus the tab; hidden/offline tabs pause background refresh. A failed refresh preserves the last confirmed state and reports staleness.
4. In the field labelled “Explica qué se revisó y qué debe hacer el cliente”, enter an explanation and choose **Enviar explicación y terminar revisión** (equivalent PT/EN labels). The state becomes `closed`, with the stored plain-text explanation. Missing/invalid new explanations return 422; previous closed/null reports show the legacy missing-explanation message. Finishing this demo review is no bank investigation, refund, card block, fraud finding or resolution.
5. In the customer view read the latest reply and explanation. Closed messages are read-only. Choose **Todavía necesito ayuda** / **Ainda preciso de ajuda** / **I still need help**, submit a linked follow-up and check its new reference while the source stays closed.
6. Reload, log out and sign back in using a fresh customer session. Recover complete, incomplete and technical reports and their original content, messages and progress. Use another customer's session to verify the reports and threads are absent; foreign references must look like missing references. The recent list holds 20 reports; the “more reports” notice means older reports remain stored, not that this phase offers unlimited navigation.
7. Open Help and replay the tour: check Tab/Shift-Tab containment, Escape, focus return, scroll/resize, completion/skip persistence, and ES/PT/EN copy. Tour steps must not submit or answer a report. Manually confirm this on the assembled page and with assistive technology before claiming that coverage.

The customer "AI help · this session only" panel and the reviewer "Prepare reply" (#132, [ADR-016](../ADRs/ADR-016-report-support-assistants.md)) are off in production and not part of this demo.

### Status email checkpoints

With authorization, request **one** report update to the user's own test inbox. A normal customer receives their own report; an administrator acting as a customer receives that report update at the administrator's address. Keep the report readable if email fails. Record each checkpoint separately:

| Checkpoint | Required evidence | Current Task 6 status |
|---|---|---|
| Queued | Owned request returns 202 and corresponding reference-only outbox row | Demonstrated locally; unconfigured local sender skips |
| Provider accepted | Authorized operator observes SES message id / outbox `sent` | Confirmed 2026-10-04 20:16 UTC for a report email (see [observability runbook](observability-runbook.md)) |
| Inbox received | User confirms receipt or authorized inbox read | Confirmed 2026-10-04 20:16 UTC (see [observability runbook](observability-runbook.md)) |
| Link recovery/privacy | Inspect generic reference/status/language template and token-free app link; open received link signed out, then sign in and recover only owned reports | Template unit checks pass; received-link browser check pending external |

HTTP 202 means queued, and schema `sent` means SES accepted, neither means delivered. Do not include customer statement or closing explanation in email. Respect the five-minute queued/accepted cooldown, ten-second failed/skipped retry and server `Retry-After`; do not keep clicking to collect evidence.

### Three fresh testers (pending external)

A human organizer recruits at least three people unfamiliar with the interface; agents do not contact anyone. Give each a synthetic charge and only three tasks: find it, create a report, find the latest reviewer response. A human reviewer supplies the response through the app. Do not coach; record any intervention as help needed. Ask afterward who acts next and what “review finished” means. Use ES/PT across the sessions, recording language/device and whether they had seen the interface.

For each task record completion (`completed`, `with help`, `not completed`), wrong-turn count, help-needed count and next-actor understanding (`correct`, `unclear`, `incorrect`). Publish only aggregate counts with the number of observed testers/tasks and the definition of each measure; keep personal/raw observations private. These are formative findings, never a population completion rate or causal improvement. At this record: **0 testers observed; study not run; no completion rate defined**.

## One-day dataset slice

The production source is the authorized S3 `data/` prefix configured in the `Makefile`. S3 is read-only. The browser and the Worker never touch it. The sample uses a separate ignored DuckDB under `data/demo_s3`, so the full analytical database is never replaced.

```bash
make intake-sample-bronze AWS_PROFILE=default    # exact fact-day path; it doesn't list other partitions
make intake-sample-silver
make intake-sample-quality
make intake-sample-slice                          # D1 seed + manifest under data/demo_s3/
make intake-seed-local                            # migrations, fictitious seed and slice into local D1
make intake-cohort-slice                          # Gold tables, then cohort parts + manifest under data/gold_cohort/
make intake-cohort-seed-local                     # load the cohort parts into local D1, skipping loaded parts
```

Defaults: `INTAKE_DATE=2026-02-26`, `INTAKE_DATA_DIR=data/demo_s3`. The dataset identity is allowlisted in `back-end/src/config/identities.json`, which the Worker and the slice both read. Adding an identity means editing that file together with a reviewed seed. There is no public customer search. For an offline build, pass `--local-source "$PWD/data"` to `run_ingestion.py` with `DATA_DIR`/`DUCKDB_PATH` pointed at a separate ignored directory.

The slice checks and writes the following ([data_pipelines/gold/README.md](../../data_pipelines/gold/README.md)):

- a ready quality run for this exact database and day;
- unique IDs and N:1 product/customer ownership;
- at most 20 allowlisted rows;
- one Bronze row per selected transaction;
- the original Bronze amount and currency (`amount_usd` is deliberately unused);
- the timezone-free source timestamp.

The seed can be rerun safely, and D1 rejects any row that changed since it was stored.

**Checked on 2026-02-26:**

- Bronze/Silver held 150,000 customers, 400,000 products, 13,164 FX records and 3,787 transactions.
- 625 transactions were `Purchase/Approved`, and the allowlisted customer had one.
- The focused quality run reported 0 errors and 1 warning: 4,407/150,000 customer rows had `customer_status` outside its domain.
- The product and customer of the selected transaction each joined once.
- A two-way `EXCEPT ALL` found no row differences between local CSV and S3 Bronze for the four tables.
- On 2026-09-29 the Gold slice produced the same transaction and provenance statements as the previous loader.

These checks describe one day and the dimensions, not the whole dataset.

The observed customer CSV has fields such as `first_name`, `last_name` and `last_updated` that the summary dictionary omits, and the products file has extra fields too. The [Silver mapping](../../data_pipelines/silver/table_specs.py) decides which columns are used. Omissions are recorded rather than silently dropped.

## Deployed preview

The Worker `factored-hackathon-2026-arabicaai` runs at https://factored-hackathon-2026-arabicaai.lucas-tramonte.workers.dev/. Customers and agents sign in with a Cognito email code; there is no team password ([ADR-007](../ADRs/ADR-007-customer-identity-cognito-email-otp.md)).

- On 2026-09-29, production D1 held both migrations, the fictitious seed and no cases.
- Loading the Gold slice into production is a reviewed, manual step (`back-end/README.md`, "Deployment").
- On 2026-10-01, PR #54 merged migration 0008 without applying it to remote D1, so every Workers Build from `main` after 20:55 UTC stopped at the deploy guard and the live version stayed `17450a30`.
- On 2026-10-02, the migration was applied by hand at 02:35 UTC and a manual `npm run deploy` at 02:40 UTC published `3412aff1` from `main` `093e0e7`; remote D1 holds migrations 0001-0008.
- On 2026-10-02 and 2026-10-03 the same happened with migrations 0014, 0015 and 0016 (five failed builds). Since PR #84, deploys run from GitHub Actions after CI passes, and `npm run deploy` applies pending additive migrations itself, so a merge no longer waits for a person.
- Build settings and the post-deploy checklist are in [back-end/README.md](../../back-end/README.md).

### Customer sign-in (Cognito)

The full procedure (roles, enrolment, removal, tests, troubleshooting, evaluator access) is the [auth runbook](auth-runbook.md); this section keeps the deploy-time notes.

Customers sign in with an email one-time code from the Amazon Cognito user pool `arabicaai-demo` (`us-east-2`, Essentials tier, account `arabica`). Email is the username, self sign-up is off, and each customer user carries the immutable attribute `custom:customer_id`, which the Worker maps to a customer loaded in D1. The pool id and the public app client id (`arabicaai-web`, no secret) are plain `vars` in `back-end/wrangler.jsonc`. Cognito requires `PASSWORD` in the pool's allowed first factors, so it is listed, but no user is ever given a known password, and the client requests and accepts only `EMAIL_OTP`. An admin-created user starts in `FORCE_CHANGE_PASSWORD`; on 2026-10-01 that status did not block the `EMAIL_OTP` challenge (no `admin-set-user-password` workaround was needed), and the first email-code sign-in confirmed the user, which is now `CONFIRMED`. Groups: `customer`, `agent`, `admin`, `auditor`.

Production has no demo identity picker: `/demo/identities` and `/demo/session` exist only when `DEMO_PICKER=1` (local development), so customers sign in with their email code.

`COGNITO_TEST_JWKS` is a local-test variable only; never set it as a Worker var or secret (the deploy guard refuses it in `vars`). `DEMO_PICKER` must never be set as a Worker var or secret either: with no team gate it would let anyone become any customer or agent (the deploy guard refuses it in `vars`; it cannot see secrets).

```bash
back-end/scripts/cognito/setup.sh                                  # creates or finds pool, attribute, client, groups; prints the vars
back-end/scripts/cognito/enroll.sh <email> <customer_id> [group]   # customer; no invitation email is sent
back-end/scripts/cognito/enroll.sh <email> - agent                 # agent, admin or auditor: no customer id
```

Both use `--profile ${AWS_PROFILE:-arabica}` and can be rerun. Judges' and teammates' emails are enrolled with `enroll.sh`; each person who reviews reports on `/agent` is enrolled with `enroll.sh <email> - agent` (a customer-only account gets 403 there); the customer id cannot change after creation, so delete the user first to re-map one.

Agent sign-in shipped with the Cognito phases (PRs #61 and #65); its one-time deploy steps are history.

### Notification email (SES)

The Worker sends notification emails through Amazon SES v2 (`us-east-2`, account `arabica`) from `ArabicaAI <noreply@arabicaai-demo.com>`. The `arabicaai-demo.com` domain identity is verified with Easy DKIM and a custom MAIL FROM. `SES_REGION` is a plain var in `back-end/wrangler.jsonc`; `SES_FROM` is a Worker secret, and the deploy guard refuses it in `vars`. The IAM user `arabicaai-worker-ses` has one inline policy, `ses-send-only`, allowing only `ses:SendEmail` on that domain identity, and no managed policies.

The account has SES production access (granted after a second request; checked 2026-10-04: `ProductionAccessEnabled` true, 50,000 emails a day, 14 a second), so any address can receive mail. The first request of 2026-10-02 had been denied. Check it with `aws sesv2 get-account --profile arabica --region us-east-2 --query '[ProductionAccessEnabled,SendQuota]'`. What still bounces is a sender whose domain publishes DMARC `p=reject` while only the address, not the domain, is verified in SES: SES then signs nothing for that domain and strict receivers drop the mail (seen 2026-10-04 with a company address). Send from a verified domain with DKIM, or from an address whose domain does not reject.

Emails are sent as raw MIME: plain text plus an HTML version with the ArabicaAI logo, the reference in a monospace box, the urgent note in a warning box and a button to the app (`src/notify/templates.js`, `email.js`). The logo travels inside the message as an inline attachment (`src/notify/logo.js`, the same bytes as `front-end/public/arabicaai-logo.png`), so it shows even when the site is unreachable; `APP_URL` in `wrangler.jsonc` is only the button's target.

`POST /reports/update` confirms only that D1 queued the request. The background sender records `queued`, `failed`, `skipped`, or `sent` in `email_outbox`; in this schema `sent` means SES accepted the API request and returned a message id, not that the recipient's mailbox delivered it. A failed or unconfigured attempt has a ten-second retry delay (so concurrent clicks cannot duplicate a send); queued or SES-accepted requests keep the five-minute suppression window. The customer interface uses the same distinction and never claims delivery from the 202 response. The outbox contains only reference metadata, never the address, statement, or email body.

```bash
SES_IDENTITY=<sender domain or address> ALERT_EMAIL=<bounce/complaint/alarm recipient> back-end/scripts/ses/setup.sh
# creates or finds the sender identity and the send-only user; sets the suppression list, the identity's default
# configuration set (BOUNCE and COMPLAINT events to an SNS topic) and two CloudWatch reputation alarms; prints the state
```

Human steps (the access key never passes through an agent or the repository):

1. For an address identity, click the AWS verification link; for a domain, publish the DKIM CNAMEs, MAIL FROM and `_dmarc` records where its DNS lives. `setup.sh` then prints `verified=True`. Confirm the SNS subscription email so bounce, complaint and alarm notifications arrive. Set the sender once: `cd back-end && npx wrangler secret put SES_FROM` (value `ArabicaAI <noreply@domain>`).
2. Create the access key and set the three Worker secrets:

   ```bash
   aws iam create-access-key --user-name arabicaai-worker-ses --profile arabica   # copy the two values once
   cd back-end && npx wrangler secret put SES_ACCESS_KEY_ID && npx wrangler secret put SES_SECRET_ACCESS_KEY
   npx wrangler secret put EMAIL_KEY   # 32 random bytes, base64: openssl rand -base64 32
   ```

3. Judges need no SES verification: production access is on. Enrol their email in Cognito (auth runbook, sections 6 and 11). A judge we haven't enrolled requests access from the sign-in screen, which emails the team inbox in the `ACCESS_REQUEST_TO` secret.
4. Before the demo, sign in as that customer, request one report update, confirm the message arrives in that mailbox, and have an operator check the corresponding reference-only outbox row. Agents do not run the remote query or inspect a person's inbox. Bounce and complaint events are tracked; delivery events are not. Mailbox receipt is the delivery proof, while the stored provider message id proves only SES acceptance.

## Known limits

- Customer identity is a Cognito email code mapped to one demo customer; it is not bank authentication. Agents sign in with their own email code in the `agent` group; there is no shared team password.
- Sessions last one hour and are stored in D1.
- A retry with the same key and content returns the same reference, and different content gets 409. A charge with a report still received or in review can't be reported again under a new key (409) until a person closes it, even when two confirmations arrive in the same instant.
- If the browser tab is closed with a request pending, the pending state is lost, but no duplicate is created.
- No historical complaint is linked to a transaction, so none is joined here by `customer_id` alone.

Next steps and the gap to the target workflow are in the [intake roadmap](intake-roadmap.md).
