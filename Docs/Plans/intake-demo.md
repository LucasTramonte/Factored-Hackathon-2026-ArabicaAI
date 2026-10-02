# Charge-intake demo: runbook

## What it does

The V1 workflow ([ADR-002](../ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md)):

1. A customer signs in with an email one-time code and sees only their own charges.
2. They pick one, describe it and explicitly confirm.
3. They get a reference once the case is stored.
4. An agent, signed in with their own email code, reads the case.

The reference means "accepted for human review". It is not a fraud decision, a refund, a card block or a resolution. The MVP is deterministic, and no model is called. The runtime is one Cloudflare Worker with D1 ([ADR-003](../ADRs/ADR-003-intake-single-runtime-worker-d1.md)). Capacity and cost are covered in [ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md).

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

## One-day dataset slice

The production source is the authorized S3 `data/` prefix configured in the `Makefile`. S3 is read-only. The browser and the Worker never touch it. The sample uses a separate ignored DuckDB under `data/demo_s3`, so the full analytical database is never replaced.

```bash
make intake-sample-bronze AWS_PROFILE=default    # exact fact-day path; it doesn't list other partitions
make intake-sample-silver
make intake-sample-quality
make intake-sample-slice                          # D1 seed + manifest under data/demo_s3/
make intake-seed-local                            # migrations, fictitious seed and slice into local D1
make intake-cohort-slice                          # Gold cohort parts + manifest under data/gold_cohort/ (full DuckDB)
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

The Worker `factored-hackathon-2026-arabicaai` runs at https://factored-hackathon-2026-arabicaai.lucas-tramonte.workers.dev/. Customers and agents sign in with a Cognito email code; there is no team password once this branch deploys ([ADR-007](../ADRs/ADR-007-customer-identity-cognito-email-otp.md)). Until Phase 1 deploys, Cloudflare Access (email allowlist) still fronts the whole hostname.

- On 2026-09-29, production D1 held both migrations, the fictitious seed and no cases.
- Loading the Gold slice into production is a reviewed, manual step (`back-end/README.md`, "Deployment").
- On 2026-10-01, PR #54 merged migration 0008 without applying it to remote D1, so every Workers Build from `main` after 20:55 UTC stopped at the deploy guard and the live version stayed `17450a30`.
- On 2026-10-02, the migration was applied by hand at 02:35 UTC and a manual `npm run deploy` at 02:40 UTC published `3412aff1` from `main` `093e0e7`; remote D1 holds migrations 0001-0008.
- Build settings and the post-deploy checklist are in [back-end/README.md](../../back-end/README.md).

### Customer sign-in (Cognito)

Customers sign in with an email one-time code from the Amazon Cognito user pool `arabicaai-demo` (`us-east-2`, Essentials tier, account `arabica`). Email is the username, self sign-up is off, and each customer user carries the immutable attribute `custom:customer_id`, which the Worker maps to a customer loaded in D1. The pool id and the public app client id (`arabicaai-web`, no secret) are plain `vars` in `back-end/wrangler.jsonc`. Cognito requires `PASSWORD` in the pool's allowed first factors, so it is listed, but no user is ever given a known password, and the client requests and accepts only `EMAIL_OTP`. An admin-created user starts in `FORCE_CHANGE_PASSWORD`; on 2026-10-01 that status did not block the `EMAIL_OTP` challenge (no `admin-set-user-password` workaround was needed), and the first email-code sign-in confirmed the user, which is now `CONFIRMED`. Groups: `customer`, `agent`, `admin`, `auditor`.

Production has no demo identity picker once Phase 1 deploys: `/demo/identities` and `/demo/session` exist only when `DEMO_PICKER=1` (local development), so customers sign in with their email code.

`COGNITO_TEST_JWKS` is a local-test variable only; never set it as a Worker var or secret (the deploy guard refuses it in `vars`). `DEMO_PICKER` must never be set as a Worker var or secret either: with no team gate it would let anyone become any customer or agent (the deploy guard refuses it in `vars`; it cannot see secrets).

```bash
back-end/scripts/cognito/setup.sh                                  # creates or finds pool, attribute, client, groups; prints the vars
back-end/scripts/cognito/enroll.sh <email> <customer_id> [group]   # customer; no invitation email is sent
back-end/scripts/cognito/enroll.sh <email> - agent                 # agent, admin or auditor: no customer id
```

Both use `--profile ${AWS_PROFILE:-arabica}` and can be rerun. Judges' and teammates' emails are enrolled with `enroll.sh`; each person who reviews reports on `/agent` is enrolled with `enroll.sh <email> - agent` (a customer-only account gets 403 there); the customer id cannot change after creation, so delete the user first to re-map one. Once Phase 1 deploys, a person removes Cloudflare Access from the hostname in the Zero Trust dashboard; until then Access still fronts the sign-in page.

#### Before deploying this change (agent sign-in)

1. Enrol each agent with `back-end/scripts/cognito/enroll.sh <email> - agent`; otherwise nobody can open the agent view.
2. Deploy.
3. Sign in once as a customer and once as an agent on the live URL.
4. Remove the Cloudflare Access application in the Zero Trust dashboard.
5. Delete the `DEMO_ACCESS_USERNAME` and `DEMO_ACCESS_PASSWORD` Worker secrets (`cd back-end && npx wrangler secret delete DEMO_ACCESS_USERNAME && npx wrangler secret delete DEMO_ACCESS_PASSWORD`); the Worker no longer reads them.

### Notification email (SES)

The Worker will send notification emails through Amazon SES v2 (`us-east-2`, account `arabica`) from `rzuniga@aptsny.co`; the team has no verified domain, so the sender is a single verified email identity. `SES_REGION` and `SES_FROM` are plain `vars` in `back-end/wrangler.jsonc`. The IAM user `arabicaai-worker-ses` has one inline policy, `ses-send-only`, allowing only `ses:SendEmail` on `arn:aws:ses:us-east-2:849110176017:identity/rzuniga@aptsny.co`, and no managed policies.

The account is in the SES sandbox (200 emails a day, 1 a second), and SES delivers only to verified addresses. On 2026-10-02 a production-access request was filed (`put-account-details`, mail type `TRANSACTIONAL`, under 50 emails a day, recipients limited to Cognito-enrolled users, bounces and complaints stop sends to that address). It was denied the same day: `ProductionAccessEnabled` is `false` and the review status is `DENIED`. The account stays in the sandbox, so each recipient's address must be created as an SES email identity and its owner must click AWS's verification email. Re-filing with more detail from the SES console is optional. Check it with `aws sesv2 get-account --profile arabica --region us-east-2 --query '[ProductionAccessEnabled,Details.ReviewDetails.Status]'`.

```bash
back-end/scripts/ses/setup.sh   # creates or finds the sender identity and the send-only user; prints verification status and the user ARN
```

Human steps (the access key never passes through an agent or the repository):

1. Open the AWS verification email sent to `rzuniga@aptsny.co` and click its link; `setup.sh` then prints `verified=True`.
2. Create the access key and set the three Worker secrets:

   ```bash
   aws iam create-access-key --user-name arabicaai-worker-ses --profile arabica   # copy the two values once
   cd back-end && npx wrangler secret put SES_ACCESS_KEY_ID && npx wrangler secret put SES_SECRET_ACCESS_KEY
   npx wrangler secret put EMAIL_KEY   # 32 random bytes, base64: openssl rand -base64 32
   ```

3. For each judge, run `aws sesv2 create-email-identity --email-identity <judge email> --profile arabica --region us-east-2` and ask them to click AWS's verification email.

## Known limits

- Customer identity is a Cognito email code mapped to one demo customer; it is not bank authentication. Agents sign in with their own email code in the `agent` group; there is no shared team password.
- Sessions last one hour and are stored in D1.
- A retry with the same key and content returns the same reference, and different content gets 409. A charge with a report still received or in review can't be reported again under a new key (409) until a person closes it; two confirmations in the same instant can still open two.
- If the browser tab is closed with a request pending, the pending state is lost, but no duplicate is created.
- No historical complaint is linked to a transaction, so none is joined here by `customer_id` alone.

Next steps and the gap to the target workflow are in the [intake roadmap](intake-roadmap.md).
