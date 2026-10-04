# ADR-013 — Persistent sessions and Google sign-in for staff on GCP

- **Status:** Proposed
- **Date:** 2026-10-04
- **Deciders:** Lucas, Roberto, Manoella

## Context

**Current flow** (ADR-007):
1. A person signs in with an Amazon Cognito email one-time code (`USER_AUTH`, `EMAIL_OTP`), from the browser.
2. The Worker verifies the ID token and mints its own opaque session: 256 random bits, SHA-256 stored in D1, an HttpOnly cookie, **one hour** (`SESSION_MS`). Customer and agent sessions are separate cookies and separate `actor` values.
3. Roles are Cognito groups, read from the token **once**, at sign-in.
4. An admin's one code opens both views (#95), and an admin may act as any loaded customer (ADR-007, decision 10).

**The user-experience problem**, as measured in this project:
- **Every hour, a new code.** Sessions don't slide, so a judge exploring for more than an hour signs in again.
- **A reload looks like a sign-out.** The cookie survives, but the client keeps the signed-in state only in the tab (ADR-007, decision 8), so a reload shows the sign-in screen again.
- **Codes are scarce.** Cognito's default sender caps the whole AWS account at about 50 code emails a day (ADR-004, 2026-10-03 note). SES production access, the way to lift it, is pending. Team and evaluators share that budget.
- **Staff are treated like customers.** Agents, admins and auditors also receive email codes and carry a fake `custom:customer_id`, although they are not bank customers.

The team now has a Google Cloud project with trial credits (ADR-006, amendment 7). This ADR proposes how to use it for a better sign-in and session experience. It does not implement the migration.

## Decision

1. **Sessions persist, within limits, before any provider changes.** This is phase 0, and it fixes most of the problem with no new provider:
   - **Sliding expiry with an absolute cap.** Each authenticated request extends the session's idle deadline, up to an absolute cap set at sign-in.
     - Customers: 15 minutes idle, 2 hours absolute. Short, as a bank customer session should be.
     - Staff (agent, admin, auditor): 2 hours idle, 12 hours absolute.
     - The cap never moves, and act-as keeps the cap of the session it replaces.
   - **`GET /auth/me`** returns the live session's actor, roles and customer id (never the token). After a reload the client restores its state from it instead of showing the sign-in screen. The cookie, not the tab, decides.
   - The extension write is batched with the session read (one D1 round trip) and skipped when the deadline was extended less than a minute ago, so the per-request D1 budget barely moves (ADR-004).
2. **Staff sign in with Google; customers keep a bank-style passwordless sign-in.** Bank customers can't be assumed to have Google accounts, and their sign-in shouldn't depend on one. Staff and evaluators are a small, known list.
   - **Staff (agent, admin, auditor):** "Sign in with Google" through Google Identity Services in the browser. The resulting Google ID token is sent once to the Worker (`Authorization: Bearer`, as today), which verifies it:
     - JWKS from Google, issuer `accounts.google.com`, audience equal to our OAuth client id, `email_verified`, expiry, and a nonce the Worker issued;
     - then the Worker mints its own session and drops the Google token.
   - **Customers:** keep the email one-time code. Phase 2 may move it from Cognito to Google Identity Platform's email-link sign-in, but only if SES production access stays denied (decision 6). Identity Platform has no numeric email code: the one-time code travels inside a link, and a typed numeric code exists only by SMS (corrected 2026-10-04; [feasibility check](../Plans/gcp-identity-domain-email.md)).
3. **Authentication and authorization stay separate.**
   - The Google token proves only *who* signed in.
   - *What* they may do comes from a D1 table of staff (`staff_members`: verified email, role, active). The Worker **re-reads it on every authenticated request**, so revoking a role or deactivating a person takes effect on their next request, not at session expiry.
   - **No automatic provisioning:** a Google account that isn't in the table gets "not enrolled" (403), never a new account.
   - Customer identity stays as today: the immutable customer id is bound at enrolment, never read from a request.
4. **Token and session security.**
   - Cookies: `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`.
   - No token in `localStorage` or `sessionStorage`; the Google ID token lives only in memory until the Worker exchanges it.
   - State-changing requests also check `Origin`.
   - The session id rotates at sign-in and on every privilege change (act-as already does).
   - Only hashes are stored.
   - A session row records its subject (staff email hash or customer id) so all of one person's sessions can be revoked at once.
   - JWKS are cached by `jose`. If they can't be fetched, sign-in fails closed with 503, as today.
5. **Logout and expiry.**
   - Logout revokes the row and clears the cookie.
   - An expired idle or absolute deadline is refused, with the same audit events as today (`session_expired`).
   - Deactivating a staff member blocks every request at once (decision 3), and an operator can revoke all of a subject's sessions with one statement.
   - Signing out of Google does not sign the person out here. That is deliberate: the Worker's session is the only session.
6. **Admin and customer separation.** Staff sessions never carry a customer id. An admin sees a customer's view only through act-as (ADR-007, decision 10), which already marks, rotates and audits it. Customer and agent cookies stay separate, as AGENTS.md requires.
7. **Local development, demo and production.**
   - **Local:** the demo picker (`DEMO_PICKER=1`) stays local-only; a second OAuth client allows `http://localhost` origins.
   - **Production:** missing Google configuration **fails closed**. The staff sign-in button isn't shown, and the Worker refuses Google tokens. It never falls back to the picker.
   - **Demo:** the OAuth consent screen stays in "Testing", with the evaluators added as test users. That avoids Google's app verification, and the evaluators' emails are added to `staff_members` as admins when the organizers send them.
   - The client id is public (Worker `vars`); there is no client secret, because the browser flow returns an ID token.
8. **Cost and operations.**
   - Google sign-in through Google Identity Services and an OAuth client costs nothing per user.
   - If phase 2 uses Identity Platform, email and social sign-in ("Tier 1") is free up to 50,000 monthly active users, then $0.0055 per MAU ([pricing](https://cloud.google.com/identity-platform/pricing)).
   - Firebase email-link sending is limited to 5 a day on the free plan and 25,000 a day with billing enabled ([limits](https://firebase.google.com/docs/auth/limits)), so phase 2 needs the trial billing account.
   - No new server: verification runs in the Worker with the same `jose` code path as Cognito.
9. **Migration path.**
   - **Phase 0:** sliding sessions and `GET /auth/me`.
   - **Phase 1:** Google sign-in for staff behind a configuration switch, with `staff_members` seeded from the current Cognito `admin`, `agent` and `auditor` groups, and Cognito staff sign-in kept until every staff member has signed in once with Google.
   - **Phase 2 (optional):** customer email sign-in on Identity Platform. Only if SES production access stays denied, and only after an ADR-007 amendment.
   - Each phase is a separate PR with the adversarial auth tests AGENTS.md requires: method and path matrix, session swap, forgery and expiry, isolation, hostile input, concurrency, contracts and D1 budget.

## Consequences

- **+** Judges and staff stop re-entering codes every hour or after a reload.
- **+** Staff stop spending the account's 50 daily code emails at all.
- **+** Roles take effect on the next request, and nobody unknown is provisioned.
- **+** Customers keep a short, bank-like session.
- **+** No per-user cost at this scale, and no new runtime.
- **−** Two identity providers during phases 1 and 2 (Google for staff, Cognito for customers).
- **−** Evaluators need a Google account and must be added as test users.
- **−** Longer staff sessions widen the window if a laptop is left open. The 2-hour idle limit, immediate deactivation and subject-wide revocation bound it.
- **−** A sliding deadline means a write on some requests; batching and the one-minute skip keep it within ADR-004's ceilings, to be measured in phase 0.

## Alternatives considered

- **Keep Cognito for everyone and wait for SES production access.** It fixes the email cap but not the hourly codes or the reload. Rejected as the whole answer, but phase 0 applies either way. Reopen if SES access is granted and Cognito's hosted federation becomes the simpler route to Google sign-in.
- **Cloudflare Access with Google as the identity provider, for staff routes.** Simple, free for small teams, and in front of the Worker. ADR-007 removed Access because customers are a different population and the application must own the boundary. Using it for staff only would split authorization between the edge and the Worker. Rejected. Reopen if the service only ever serves internal staff.
- **Firebase Authentication for everyone, with the session kept in the client SDK.** The client would hold refresh tokens, and the Worker would verify a Firebase token on every call. That moves session state out of the Worker and into the browser. Rejected: the Worker-owned opaque session is easier to revoke and audit. Reopen for a native mobile client.
- **Long-lived sessions without sliding, for example 12 hours for everyone.** That is too long for bank customers, and there is no idle limit. Rejected. Reopen never for customers.
- **Server-side OAuth authorization-code flow in the Worker (`/auth/google/login` and callback).** It keeps every Google token off the browser, at the cost of a client secret, state storage and two more routes. The browser ID-token flow plus a nonce is enough for a staff list this small. Deferred, not rejected. Reopen if staff move to an enterprise identity provider (OIDC or SAML), where the server flow is standard.
