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

1. **Customers sign in with a Cognito email one-time code.** Amazon Cognito's passwordless flow (`USER_AUTH` with `EMAIL_OTP`), pool `arabicaai-demo` in us-east-2, Essentials tier. Agents move to it later. Only an admin enrols users (`back-end/scripts/cognito/enroll.sh`). Each email maps to one demo customer through the immutable attribute `custom:customer_id`.
2. **The Worker owns the session.** The browser calls Cognito directly; Cognito's CORS was verified. The Worker verifies the ID token: RS256, issuer, audience, `token_use`, `email_verified`, and required `exp`, `iat` and `sub`. It then mints its own session cookie. From there identity comes from the session only, as before.
3. **Roles are Cognito groups:** `customer`, `agent`, `admin`, `auditor`.
4. **The Basic team gate covers only `/agent`, `/agent/*` and `/demo/*`.** Customer routes are public behind the session check. Public API paths are rate-limited per IP at 60 requests a minute.
5. **Cloudflare Access is removed from the hostname.**
6. **The demo picker exists only in local development** (`DEMO_PICKER=1`).
7. **The Worker and D1 stay the single runtime.** The rest of ADR-003 stands.

## Consequences

- **+** A real identity service, which the brief accepts. We write no OTP code of our own.
- **+** An AWS piece of the production target is in use now.
- **−** A second provider, and three public ids in config (region, pool id, app client id).
- **−** The pool's sign-in policy must list `PASSWORD` as an allowed first factor; AWS rejects `[EMAIL_OTP]` alone. No user has a known password, and the client requests and accepts only `EMAIL_OTP`.
- **−** Failed code attempts happen at Cognito. They appear in CloudTrail, not in the Worker's logs.
- **−** Cognito's default sender caps at about 50 emails a day until SES is the sender.
- **−** The rate limit is counted per Cloudflare location, so it is approximate, and it is keyed by IP, so a shared NAT shares it.
- **−** Agents still use the shared team password until a later task moves them to Cognito.

## Alternatives considered

- **Cloudflare Access as customer identity.** Access identifies team members at the edge, not bank customers, and Lucas's document asks the application to own the boundary. Rejected: wrong population and wrong layer. Reopen if the service only ever serves internal staff.
- **A Worker-owned OTP sent through SES.** We would write and secure code for what Cognito does natively. Rejected: more code on a security path. Reopen if Cognito's cost or limits block the demo.
- **Cognito Hosted UI redirect.** It leaves our page and its language switch. Rejected: worse sign-in for the same identity. Reopen if we need federation or MFA that the direct API can't give.
- **Full AWS runtime now** (Lambda, API Gateway, RDS). It means rebuilding the service and re-proving the adversarial suite in three days. Rejected for the window. Reopen after submission, on the path ADR-004 prices.

## Implementation notes

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

Removing Cloudflare Access is a manual step in the Zero Trust dashboard after this branch deploys ([runbook](../Plans/intake-demo.md#customer-sign-in-cognito)).
