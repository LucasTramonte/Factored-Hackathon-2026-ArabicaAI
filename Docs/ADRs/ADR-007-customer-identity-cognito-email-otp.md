# ADR-007 — Customer identity: Amazon Cognito email one-time codes

- **Status:** Proposed
- **Date:** 2026-10-02
- **Deciders:** Lucas Tramonte, Roberto Z, Manoella R
- **Supersedes:** ADR-003 decision 5 (access control: Cloudflare Access plus the Basic gate)

## Context

- The brief asks us to "demonstrate authentication with a trusted test session or identity service" and to enforce access to each customer's records "in the service or tool layer" (problem statement, p. 5).
- Until this change the customer signed in through a simulated picker. Anyone past Cloudflare Access could act as any demo customer (ADR-003, limitations table).
- Lucas's "Authentication and stack decision" (second version, a team document not kept in the repository) sets the direction: no Cloudflare Zero Trust, the application owns the identity boundary, the session is the only source of identity, SES is for email delivery only, and AWS is the production target.
- ADR-002 decision 2 still holds: identity comes from the session.

## Decision

1. **Customers sign in with a Cognito email one-time code.** Amazon Cognito's passwordless flow (`USER_AUTH` with `EMAIL_OTP`), pool `arabicaai-demo` in us-east-2, Essentials tier. Agents use it too (group `agent`, task 1.6). Only an admin enrols users (`back-end/scripts/cognito/enroll.sh`). Each email maps to one demo customer through the immutable attribute `custom:customer_id`.
2. **The Worker owns the session.** The browser calls Cognito directly; Cognito's CORS was verified. The Worker verifies the ID token: RS256, issuer, audience, `token_use`, `email_verified`, and required `exp`, `iat` and `sub`. It then mints its own session cookie. From there identity comes from the session only, as before.
3. **Roles are Cognito groups:** `customer`, `agent`, `admin`, `auditor`.
4. **No Basic team gate.** Customer and agent routes are public behind their session checks; an agent session needs an ID token in group `agent`. Every API path is rate-limited per IP at 60 requests a minute. (Until task 1.6 the Basic gate covered `/agent`, `/agent/*` and `/demo/*`.)
5. **Cloudflare Access is removed from the hostname.**
6. **The demo picker exists only in local development** (`DEMO_PICKER=1`). Admins get their own server-checked picker (decision 10).
7. **The Worker and D1 stay the single runtime.** The rest of ADR-003 stands.
8. **`admin` is a superset.** An admin token may start a customer session (with its own `custom:customer_id`, which must be loaded) and an agent session, and may read the audit. Both session responses list the verified roles, and the client shows an evaluation banner when they include `admin`. An admin enters one code: the client exchanges the same ID token for the other view's session too, then drops it, so the two sessions stay separate cookies (2026-10-03). The banner lives in the tab, like the sign-in: a reload drops both, and signing in again brings it back. Admin sees customer data only as the agent queue does, on synthetic demo data; it has no route of its own. Tests: `back-end/test/unit/email-session.test.js`.
9. **`auditor` reads the audit, and nothing else.** `GET /audit/events` returns the newest sign-in events and review-status changes (references only) to a verified token in group `auditor` (or `admin`), checked on every call; no session is started, so the read writes nothing. Customer and agent tokens get 403. Tests: `back-end/test/integration/audit.test.js` (issue #69).
10. **An admin may act as any loaded customer (2026-10-03).** The hackathon evaluators are admins and need to see the service from any customer's side; an ordinary customer must never learn that another exists. So the picker returns for admins only, server-side, and decision 6 still holds for everyone else:
    - A customer session opened by a verified token in group `admin` carries an `admin` mark (migration 0021). `GET /admin/customers` (the committed identities and the loaded cohort) and `POST /admin/act-as` with exactly `{ customer_id }` need that mark: no session is 401, any other customer session is 403, and an agent cookie or a bearer token alone is no customer session.
    - Act-as replaces the admin's session with one for the chosen customer, under the same allowlist as the local picker, and keeps the mark so the admin can switch again. The swap is single-use in one D1 batch: of concurrent calls with one cookie, one wins and the rest are 401. From there identity comes from the session, as everywhere; the body names the customer only on this admin-authorised call.
    - It stores no email, and the customer's own address on file is untouched. No automatic report-status email (received, in review, closed) goes to the admin's address; those go only to the customer's address on file. An update the admin explicitly requests while acting goes to the admin's own address: every admin session records the admin's own customer id at sign-in (migration 0022), act-as carries it forward, and an admin session without it (created before 0022) reads as expired, so another customer's id is never taken for the admin's.
    - Each act-as writes one `admin_actions` row in the session batch: the 12-hex references of the admin's presented session and of the new one, and the request id. Never a customer id, email or token.
    - Accepted limits: the row links sessions, not people, and a session row (with its customer id) is purged after expiry, so the audit says that an admin acted as someone at that time, not later whom. Act-as is a demo affordance on synthetic data; a bank would need a reason, a time box and the customer's consent.
    - Tests: `back-end/test/integration/admin.test.js`; D1 ceilings in `budget.test.js` (ADR-004).

## Consequences

- **+** A real identity service, which the brief accepts. We write no OTP code of our own.
- **+** An AWS piece of the production target is in use now.
- **−** A second provider, and three public ids in config (region, pool id, app client id).
- **−** The pool's sign-in policy must list `PASSWORD` as an allowed first factor; AWS rejects `[EMAIL_OTP]` alone. No user has a known password, and the client requests and accepts only `EMAIL_OTP`.
- **−** Failed code attempts happen at Cognito. They appear in CloudTrail, not in the Worker's logs.
- **−** Cognito's default sender capped the account at about 50 emails a day until SES became the sender (2026-10-04, implementation notes).
- **−** The rate limit is counted per Cloudflare location, so it is approximate, and it is keyed by IP, so a shared NAT shares it.
- **Resolved:** agents no longer share a team password; they sign in with a Cognito email code in group `agent` (`feat(agent): agents sign in with Cognito; the team password retires`, branch `feat/auth-hardening`).

## Alternatives considered

- **Cloudflare Access as customer identity.** Access identifies team members at the edge, not bank customers, and Lucas's document asks the application to own the boundary. Rejected: wrong population and wrong layer. Reopen if the service only ever serves internal staff.
- **A Worker-owned OTP sent through SES.** We would write and secure code for what Cognito does natively. Rejected: more code on a security path. Reopen if Cognito's cost or limits block the demo.
- **Cognito Hosted UI redirect.** It leaves our page and its language switch. Rejected: worse sign-in for the same identity. Reopen if we need federation or MFA that the direct API can't give.
- **Full AWS runtime now** (Lambda, API Gateway, RDS). It means rebuilding the service and re-proving the adversarial suite in three days. Rejected for the window. Reopen after submission, on the path ADR-004 prices.

## Implementation notes

**Branded emails (2026-10-04).** SES production access was granted, and the pool now sends through SES (`EmailSendingAccount` `DEVELOPER`) from `noreply@arabicaai-demo.com`, a domain identity verified in SES with Easy DKIM, a custom MAIL FROM and `_dmarc p=none` (registered through GCP Cloud Domains on trial credits, renewal disabled, DNS to move to Cloudflare before 2026-10-20), which lifts the 50-a-day default cap and the English default message. Report emails use the same sender (`SES_FROM`), and the IAM send policy names that identity only. A personal Gmail sender was the stopgap and was dropped: DKIM by `amazonses.com` fails DMARC alignment for `gmail.com`, so receivers file it as spam or show "via amazonses.com". Bounces and complaints are handled as SES production access requires (`back-end/scripts/ses/setup.sh`): account suppression, a configuration set with an SNS destination, and CloudWatch reputation alarms. The sign-in code uses the MFA message template (the only template Cognito applies to passwordless codes), so `back-end/scripts/cognito/otp-email.sh` sets MFA `OPTIONAL` with `otp-email.html`. Before changing the pool, the script verifies the SES sender, refuses to replace configured SMS or TOTP MFA, and refuses if any user has an MFA preference (which would cause a second code). `--check` performs only these checks; `--rollback` restores MFA `OFF` and Cognito's default code email. Notification emails gained an HTML version with the logo embedded as an inline attachment (no hosted file to fetch), the reference in a mono box and a button to the app (`APP_URL`). The Cognito code email can carry no attachment, so its logo is the hosted `/arabicaai-logo.png`, available once the client build that ships it is deployed. A sender on a domain with DMARC `p=reject` bounces unless that domain is verified in SES with DKIM; a bare address identity is not signed for its domain.

Commits on `feat/cognito-email-signin`:

- `59e8f94` Cognito user pool for email one-time-code sign-in; setup and enrolment scripts.
- `f018c37` The enrolment script and runbook say what they do.
- `6853465` The Worker verifies Cognito ID tokens.
- `13a9167` ID tokens must carry `exp`, `iat` and `sub`.
- `ce7c6c0` The Worker mints its session from a verified ID token (`POST /auth/session`).
- `4c2f827` The demo identity picker answers only when `DEMO_PICKER=1`.
- `4439a23` Email sign-in shares the login budget; an encoded path stays gated.
- `690ea45` The Angular client signs in with an email code on Cognito.
- `a3a708a` A refused renewal logs out; the sign-in note says what it is.
- `cb39fc9` Renewal resends the same key; the i18n spec resets the stored language.
- `d4ccb52` A failed Worker exchange asks for a new code; a failed logout drops the open report.
- `95661a6` Customer paths are public behind the session; the team gate stays on agent and demo paths.
- `b79b0c2` Per-IP rate limit on the public API paths.
- `b898a9e` The promise is the first line on the first screen; the charges caption cites the window.
- `474b27b` The charges caption says only what every data source supports.

Removing Cloudflare Access is a manual step in the Zero Trust dashboard after this branch deploys ([runbook](../Plans/intake-demo.md#customer-sign-in-cognito)).

On `feat/auth-hardening`, `feat(agent): agents sign in with Cognito; the team password retires` removes the Basic gate and `src/auth/access-gate.js`. After it deploys, a person deletes the `DEMO_ACCESS_USERNAME` and `DEMO_ACCESS_PASSWORD` Worker secrets ([runbook](../Plans/intake-demo.md#customer-sign-in-cognito)).

Enrolling a team member or an evaluator (decision 8):

```sh
sh back-end/scripts/cognito/enroll.sh <email> <customer_id> admin   # an admin also needs a loaded customer id for the customer view
```

An enrolled person receives sign-in codes and report emails at once: since SES production access (2026-10-04), no recipient needs verifying in SES. Production access lifts that restriction; it doesn't guarantee delivery, which depends on the sender domain's DKIM and DMARC.

**The sign-in code email can't be customized while the pool uses `COGNITO_DEFAULT` (2026-10-03).** Passwordless codes use Cognito's default template while MFA is off: "When MFA is inactive, Amazon Cognito sends one-time passwords with the default template" ([email settings, message options, footnote 3](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html#user-pool-email)). The same table's footnote 1 says email OTP itself "requires … Amazon SES email configuration"; our pool sends codes under `COGNITO_DEFAULT`, so that footnote doesn't match what we observe. The custom message trigger's `emailMessage` and `emailSubject` take effect only with `EmailSendingAccount = DEVELOPER` ([custom message trigger](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-custom-message.html)), and `DEVELOPER` needs SES production access, which was denied on 2026-10-02; in the SES sandbox Cognito can't email unverified users, so sign-in would break ([email settings](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html)). The sign-in screens carry the guidance instead: sender `no-reply@verificationemail.com`, subject "Your authentication code", 8 digits, in English, as captured on 2026-10-02 (`feat(client): the code step says which email to look for`, branch `feat/sign-in-code-help`). To lift it: request SES production access again with the transactional use case, then use a custom message Lambda (`CustomMessage_Authentication`, documented as the MFA-code trigger; confirm it fires for passwordless codes when someone does this) or the MFA template.

The full procedure (setup, enrolment, removal, local and deployed tests, troubleshooting and the RBAC/ABAC model) is the [auth runbook](../Plans/auth-runbook.md).
