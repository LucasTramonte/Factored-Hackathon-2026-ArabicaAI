# Authentication and access runbook

How people get into the intake demo, what each role may do, and how to set it up, test it and take access away. The decision record is [ADR-007](../ADRs/ADR-007-customer-identity-cognito-email-otp.md); the route table is in [`back-end/README.md`](../../back-end/README.md#api-routes). This runbook closes issues #69 and #70.

No email address, access key, token or customer record is written here or anywhere in the repository. Commands use placeholders such as `<email>`. Git history still holds two addresses committed before 2026-10-03; history is never rewritten ([`AGENTS.md`](../../AGENTS.md)).

## 1. The identity model

```
email + one-time code ──► Amazon Cognito ──► signed ID token (groups, custom:customer_id)
                                                     │
                       Worker verifies the token ◄───┘  (RS256, issuer, audience, expiry, email_verified)
                                │
              Worker session cookie (1 hour, D1)  ──►  the only source of identity on later requests
```

- **Cognito verifies the email** and signs an ID token. The pool accepts only admin-created users (no self sign-up) and never reveals whether an address exists.
- **The Worker verifies the token** (`back-end/src/auth/cognito.js`) and creates its own session (`back-end/src/auth/session.js`). After that, the session cookie is the only source of identity. A `customer_id` in a request body or URL is never proof of identity, and is refused or ignored.
- **RBAC sets the baseline role** from the verified Cognito groups: `customer`, `agent`, `admin`, `auditor`.
- **ABAC decides each request** from attributes of the subject, the resource and the action:
  - **ownership:** every customer query carries `customer_id = <session customer>` in SQL (`back-end/src/store/d1.js`);
  - **queue membership:** agents read and move only handoffs in the approved queue (an acknowledged handoff, `e.state = h.kind||'_handoff'`), the one predicate shared by the list, the detail and the status step;
  - **workflow state and action:** a report moves only `received → in_review → closed`, one step at a time, and nothing refunds, blocks a card or decides fraud.
- **Row scoping on Cloudflare D1 is enforced by Worker query predicates and adversarial tests.** D1 has no row-level security, and none is claimed. In the future AWS target (RDS PostgreSQL, [ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md)), PostgreSQL RLS would add a database-level boundary under the same rules.

## 2. Roles

| Role | Cognito group | May | May not | Proof |
|---|---|---|---|---|
| `customer` | `customer` + a loaded `custom:customer_id` | See only its own charges, reports and intake episodes; start, confirm and hand off its own reports | Open any agent or audit route (401/403); act as another customer (404 that looks like "missing") | `adversarial.test.js`, `charges-resolution.test.js` (isolation), `email-session.test.js` |
| `agent` | `agent` | Read the approved queue and one report's detail; move a report one step | Open customer routes (401) or the audit (403); see cases outside the queue (`GET /agent/cases` was removed) | `agent-intake.test.js`, `failure-and-routing.test.js` |
| `admin` | `admin` + a loaded `custom:customer_id` | Everything a customer (on its own synthetic identity), an agent and an auditor may; the client shows an evaluation banner | Browse any customer's records outside the agent queue; there is no admin-only route | `email-session.test.js` (decision 8), `audit.test.js` |
| `auditor` | `auditor` | `GET /audit/events`: the newest sign-in events and review-status changes, references only | Any customer or agent route; any write | `audit.test.js` |
| anyone else | not enrolled | Nothing: Cognito sends no code, and the client says only that it could not send one | — | `cognito.service.spec.ts` |

The team (Lucas, Roberto, Manoella) and evaluators are `admin`. Role changes apply at the next sign-in: a live session keeps the roles it started with.

## 3. Prerequisites

- **AWS:** account `arabica`, region `us-east-2`, a local profile named `arabica` (the scripts default to it; override with `AWS_PROFILE` and `AWS_REGION`). Authenticate the profile with `aws configure --profile arabica` (access key) or `aws configure sso --profile arabica` then `aws sso login --profile arabica`. Never commit or paste the keys; never load credential files into an agent session.
- **Cloudflare:** `npx wrangler login`, for Worker secrets and remote D1.
- **Node 22 or newer** for Wrangler and the tests.

## 4. Create the pool (once)

```bash
back-end/scripts/cognito/setup.sh
```

Idempotent. It creates or finds the pool `arabicaai-demo`, the immutable attribute `custom:customer_id`, the public app client `arabicaai-web` (no secret, `USER_AUTH` with `EMAIL_OTP`, user-existence errors hidden) and the four groups, then prints three values.

**The sign-in code email.** The pool sends through SES (`EmailSendingAccount` `DEVELOPER`, sender `Arabica AI <lucastramonte3@gmail.com>`, set by hand on 2026-10-04 after production access). The code email itself is branded with `back-end/scripts/cognito/otp-email.html` (logo, the code large in a monospace box, Spanish, Portuguese and English): a person applies it once with `back-end/scripts/cognito/otp-email.sh <pool id>`. Cognito uses the MFA message template for passwordless codes, so the script sets MFA to `OPTIONAL` with that template; nobody has an MFA preference, so sign-in keeps its single code. Email clients run no scripts, so there is no copy button: the code is large and selectable, and Apple Mail and Safari autofill it from the message.

## 5. Configure the Worker

| Name | Where | Kind |
|---|---|---|
| `COGNITO_REGION`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | `vars` in `back-end/wrangler.jsonc` (the values `setup.sh` printed) | Public: they identify the pool and client and grant nothing |
| `SES_REGION` | `vars` | Public |
| `SES_FROM` (`ArabicaAI demo <address>`) | `npx wrangler secret put SES_FROM` | Secret, because it is a person's address; the deploy guard refuses it in `vars`. Its domain must not publish DMARC `p=reject` unless the domain itself is verified in SES with DKIM |
| `APP_URL` | `vars` | Public: the deployed origin, used by the notification emails for the logo image and the "see my reports" button |
| `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` | `npx wrangler secret put …` | Secret ([SES runbook](intake-demo.md#notification-email-ses)) |
| `EMAIL_KEY` | `npx wrangler secret put EMAIL_KEY` (`openssl rand -base64 32`) | Secret: encrypts stored notification addresses |
| `DEMO_PICKER`, `COGNITO_TEST_JWKS` | `back-end/.dev.vars` only | Local only; the deploy guard refuses them in `vars` |

## 6. Enrol people

```bash
sh back-end/scripts/cognito/enroll.sh <email> <customer_id>           # a customer (group customer)
sh back-end/scripts/cognito/enroll.sh <email> - agent                  # an agent: no customer id
sh back-end/scripts/cognito/enroll.sh <email> - auditor                # an auditor: no customer id
sh back-end/scripts/cognito/enroll.sh <email> <customer_id> admin     # team or evaluator: needs a loaded customer id
```

- No invitation email is sent; the person signs in with a code at once.
- `custom:customer_id` is immutable. Rerunning with a different id refuses; to re-map, remove the user (section 9) and enrol again.
- Groups only add up: enrolling an existing user in `admin` keeps `customer` and `agent`.
- The customer id must already be loaded in remote D1 (the fictitious seed or the cohort), or sign-in answers 403.
- Report emails reach any address: SES production access was granted (checked 2026-10-04, `ProductionAccessEnabled` true, 50,000 a day). No recipient verification is needed any more.

**Fictitious identities.** `demo-ana` (Roberto), `demo-bruno` (Lucas), `demo-carla` (Manoella), and `demo-diego`, `demo-elena`, `demo-marco` (evaluators), each with charges shaped for every report reason and the urgency lane. Load them with `npx wrangler d1 execute arabica-intake-demo --remote --file seeds/seed_fictitious.sql` from `back-end/` (idempotent upserts).

## 7. Onboard dataset customers

1. Build and load the cohort ([intake demo runbook](intake-demo.md)): `make intake-cohort-slice`, check it locally with `make intake-cohort-seed-local`, then a person loads each part remotely with `python -m data_pipelines.gold.run_cohort load --target remote`, one part per UTC day.
2. A loaded dataset customer **cannot sign in until a person maps a real address to its `customer_id`** with `enroll.sh <email> <customer_id>`. Dataset emails are never used: they are synthetic, and the data terms keep dataset ids and names out of Git.
3. **A dataset customer with no email mapping** exists in D1 but has no way in and no notification target, so no report email is ever queued for them. That is expected: the demo serves them only through a person who is given a mapping.
4. New data never replaces a loaded cohort in place ([new-data rehearsal](../Evidence/new-data-rehearsal.md)): it is a new cohort version, and mappings are made again for the customers it serves.

## 8. Test it

**Locally (no AWS):**

```bash
npm --prefix back-end test     # unit tests, then integration tests on a throwaway local D1
```

`run-local.mjs` signs ID tokens with a throwaway key (`COGNITO_TEST_JWKS`). The suites prove:

| Property | Where |
|---|---|
| expired, forged and wrong-audience tokens are refused | `test/unit/cognito.test.js`, `test/integration/audit.test.js` |
| a customer cookie can't act as an agent, and the reverse (session swap) | `test/integration/adversarial.test.js` ("sessions: actors cannot swap…") |
| a customer can't see, confirm or acknowledge another customer's records | `adversarial.test.js`, `charges-resolution.test.js`, `extractor-switch.test.js` |
| each route refuses the other role; no route lacks a role | `test/unit/failure-and-routing.test.js` |
| expiry and logout are enforced and audited | `test/integration/auth-audit.test.js` |

To click through locally, put `DEMO_PICKER="1"` in `back-end/.dev.vars` and run `npx wrangler dev --local`: the picker and the one-click agent session exist only then.

**Deployed:**

1. Sign in at `/` with a `customer` email: you see only that customer's charges.
2. Sign in at `/agent` with that same customer-only email: "This account is not an agent" (403).
3. Sign in with an `admin` email: the "admin · evaluation" banner shows on both views.
4. Type an address that isn't enrolled: no code arrives, and the screen never says whether it exists.
5. As an auditor, with an ID token from the sign-in: `curl -H "Authorization: Bearer <id token>" "$BASE/audit/events?limit=5"` returns references only; a customer token gets 403.
6. Wait an hour, or sign out: the next request is 401, and the audit shows `session_expired` or `logged_out`.

## 9. Remove or disable a user

```bash
P="--profile arabica --region us-east-2"
POOL=<COGNITO_USER_POOL_ID>
aws cognito-idp admin-remove-user-from-group $P --user-pool-id $POOL --username <email> --group-name admin   # take one role away
aws cognito-idp admin-disable-user $P --user-pool-id $POOL --username <email>                                # no new sign-in
aws cognito-idp admin-delete-user  $P --user-pool-id $POOL --username <email>                                # gone; needed to re-map a customer id
```

A Worker session already open lasts at most one hour. To end it at once, a person deletes the session rows in remote D1: `DELETE FROM sessions WHERE customer_id='<customer_id>'` for a customer. Agent sessions carry no personal identity, so ending one agent's session means `DELETE FROM sessions WHERE actor='agent'` (everyone signs in again). Run either with `npx wrangler d1 execute arabica-intake-demo --remote --command "…"`.

## 10. Troubleshooting "my email is not allowed"

| What you see | Cause | Fix |
|---|---|---|
| No code arrives | The address isn't enrolled, or it is a different address from the enrolled one (a work address versus a personal one) | Enrol the address you use (section 6) |
| "This account is not enrolled" (403) at `/` | Not in `customer` or `admin`, or the customer id isn't loaded in remote D1 | Add the group; load the seed or cohort part |
| "This account is not an agent" (403) at `/agent` | Not in `agent` or `admin` | `enroll.sh <email> - agent`, or `admin` |
| `enroll.sh` refuses with a different customer id | `custom:customer_id` is immutable | Delete the user (section 9), then enrol again |
| Signed in, but no report email | The sender's domain rejects SES mail (DMARC), or the email landed in spam | Section 5: send from an address whose domain allows it, or verify the domain in SES with DKIM; check spam |
| Banner gone after a reload | The banner lives in the tab, like the sign-in | Sign in again |

## 11. Evaluator access

We asked the organizers (Factored) whether evaluators need a trusted identity service, and which emails to enrol. Their answer:

- **A trusted identity service is not mandatory** for the evaluator flow. What judges value is a well-defined problem, backed by KPIs and values, and a demo whose limitations are fully listed.
- **Judges' emails:** after the submission, we ping the organizers' contacts and ask for them. We don't guess or hard-code evaluator emails.

Evaluator admins can open individual reports in the approved agent queue (statement and verified evidence, no customer id); there is no unrestricted customer browser. When the emails arrive, each evaluator is enrolled as `admin` on one of `demo-diego`, `demo-elena` and `demo-marco` (synthetic data only), and their address is verified in SES if they should receive report emails. The same identities are reused for later test runs. Evaluators never receive production credentials or records outside the synthetic demo.

## Known limitations

- **No per-agent assignment.** Every agent works the one approved queue. Assigning reports to people needs the agent's Cognito `sub` on the session (the `sessions` table allows no identity on agent rows today) and an assignee column; it is future work.
- **Agent sessions are anonymous in the audit:** a review-status change records a 12-character session reference, not a person.
- **The admin banner lives in the tab;** a reload drops it with the sign-in.
- **`admin` has no route of its own:** "configuration and aggregate insights" are the repository and the operator scripts, not an online console.
- **The auditor sees references only:** no customer id, email, statement or token, by design ([`intake-events.md`](../intake/intake-events.md)).
- **No RLS on D1;** isolation rests on Worker predicates and their tests.
- **Sessions last one hour** and survive a Cognito disable until they expire, unless a person deletes them (section 9).
- **Sender domain:** SES signs nothing for a bare address identity, so a sender whose domain publishes DMARC `p=reject` (a company domain, typically) gets bounced. Send from a verified domain with DKIM, or from an address whose domain does not reject.
- **Email is attempted once,** after the response; a failure is not retried, and "sent" means SES accepted the request, not that it was delivered.
