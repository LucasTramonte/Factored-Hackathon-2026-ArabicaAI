# Authentication and stack decision for the intake demo

## Executive summary

The right decision is not to “move to AWS now because we have credits,” nor to “keep Cloudflare without touching auth.” The right decision is:

1. fix customer identity and authorization before any runtime change;
2. keep the production runtime simple and defensible for the challenge;
3. treat the AWS infrastructure as the scale and compliance path, not as a complete authentication solution by itself;
4. ensure the API never relies on the request body to decide who the user is.

The challenge requirement is explicit: authentication must be demonstrated with a trusted session or an identity service, and access to records and actions must be enforced in the service or tool layer. This is stated in [Docs/FACTORED_HACKATHON_2026.md](../FACTORED_HACKATHON_2026.md), and the team rule was reinforced in [AGENTS.md](../../AGENTS.md): “Identity comes from the session only, never from the request body or message text”.

---

## 1) Current state assessment

The demo picker provides a simulated session and customer scoping flow:

- [back-end/src/auth/session.js](../../back-end/src/auth/session.js): session generation and validation via cookie, with the token hash stored in D1 using SHA-256.
- [back-end/src/router.js](../../back-end/src/router.js): declares `/demo/session` public; protected routes check sessions in their handlers.
- [back-end/src/modules/customer/routes.js](../../back-end/src/modules/customer/routes.js): when `DEMO_PICKER=1`, the public demo identity picker accepts a `customer_id` from the JSON body without authenticating the caller or binding the caller to that customer. Later access to transactions and cases is scoped by the resulting session.

This is a good demo foundation, but it is not real banking authentication. The main security risk is:

- a `customer_id` from the JSON body must not be treated as authenticated identity;
- the code must enforce that identity comes from the session token (cookie / Authorization header) and never from an arbitrary payload value;
- any endpoint that lists customers or customer data must verify the session and compare the authenticated `customer_id` to the target `customer_id`.

For the demo picker, the actual boundary is:

- `POST /demo/session` accepts an allowed, loaded customer selection when `DEMO_PICKER=1`; this validates the selection, not the caller's identity. With the picker disabled, the endpoint returns 404;
- later customer routes use the cookie token to retrieve the session's stored `customer_id` and scope transactions, cases, and queries to that demo customer.

The rule “the user must always come from the authentication token in the header, never from the body” describes the required authenticated flow. The demo picker does not establish real customer identity: its cookie (`Cookie: demo_session=...`) preserves a customer selection originally supplied in JSON. Keep this flow limited to local development with synthetic demo data; session scoping alone does not prove that the caller is that customer.

---

## 2) Security red flags

### Is there a real red flag?

Yes, there is a red flag if this application were treated as a production environment.

The risk is not that the app will “crash a system,” but that trust and authorization are weak:

- if any endpoint accepts a customer via `body.customer_id` and uses it directly as identity, it enables spoofing;
- if the API exposes a global customer list without checking the current user’s session, it allows data leakage;
- if the app allows any authenticated user to act as any customer, it fails the challenge requirement.

### In the current context

In the current code, `requireSession(...)` validates the cookie token and returns the live session row, whose stored `customer_id` scopes customer routes. Case creation verifies that the session customer owns the transaction; no customer case-list/read route exists. For a picker-created session, these checks enforce demo session scoping without establishing real customer identity.

So the honest answer is:

- as a demo design, this is not a critical immediate bug;
- as a banking product design, it is a security red flag until real login and role separation are implemented.

---

## 3) Cloudflare vs AWS comparison

### Option A — keep the Cloudflare stack without Zero Trust

#### Services and stack

- Cloudflare Worker
- D1 (SQLite in the cloud)
- Pages or static assets served by the Worker
- R2 optional for artifacts or uploads
- Workers AI optional for extraction

#### Advantages

- zero immediate cost during the hackathon window;
- the solution already exists in the repo and was sized for it in [Docs/ADRs/ADR-003-intake-single-runtime-worker-d1.md](../ADRs/ADR-003-intake-single-runtime-worker-d1.md) and [Docs/ADRs/ADR-004-intake-capacity-and-cost.md](../ADRs/ADR-004-intake-capacity-and-cost.md);
- low friction for demo and judge review;
- supports application-managed sessions and team access with less operational overhead;
- business logic and persistence were designed to keep the online layer lean.

#### Disadvantages

- D1 is not a full production banking database; there is less control over authentication, RBAC, and auditability;
- the demo session does not replace a real identity service;
- without Zero Trust, the application must own the complete identity boundary, including team access, customer identity, session lifecycle, and policy enforcement;
- D1/SQLite has no PostgreSQL-style native row-level security, so every sensitive query must apply the scope predicate in application code and be covered by adversarial tests.

#### When it makes sense

- for the hackathon;
- for UX and workflow demos;
- to evaluate flow, latency, and cost;
- when the priority is proving the solution and AI workflow.

#### Conclusion

For this challenge, this is the best option for delivery speed and operational risk. It satisfies the requirement to “prove the system works” and to demonstrate access control in the service layer.

---

### Option B — AWS target architecture

#### Services and stack

- CloudFront + WAF
- S3 for static front-end assets
- API Gateway HTTP API
- Lambda
- RDS PostgreSQL Multi-AZ
- VPC with private subnets
- Bedrock / AI model layer
- KMS
- CloudWatch
- SES for email / OTP delivery
- Cognito or another identity service for customer identity

#### Advantages

- much stronger fit for production and compliance requirements;
- clearer separation of responsibilities and better auditability;
- more defensible for financial organizations;
- matches the infrastructure proposed in [Docs/Costs/aws-target/architecture.yaml](../Costs/aws-target/architecture.yaml).

#### Disadvantages

- higher cost and operational burden;
- more integration and security work;
- more engineering effort than the project needs for the challenge window;
- infrastructure alone does not solve auth: real identity and user authorization are still required.

#### When it makes sense

- when the product needs a real customer identity pilot with auditability;
- when the service is more than a hackathon demo;
- when banking compliance and stricter controls are required.

#### Conclusion

As a future architecture, AWS is strong. As the current immediate stack, it is an execution stage after auth is fixed, not a substitute for it.

---

## 4) SES + Lambda rationale: is it worth it?

### Short answer

Yes, but with one important caveat: SES is not a complete identity solution.

### What SES does well

- transactional email delivery (OTP, confirmation, reset)
- low operational cost for large-scale sending
- pairs well with Lambda and managed identity services

### What SES does not do well

- it does not replace the primary authentication service;
- it does not guarantee the account belongs to the user without OTP validation;
- it does not define the authenticated user for the application session.

### Best defensible architecture

For a bank-like project or a credible demo, the most defensible stack is:

- Cognito (or equivalent) for customer identity and session management;
- Lambda for business logic and orchestration;
- SES for OTP or confirmation email delivery;
- API Gateway or CloudFront + Worker at the front door;
- D1 / RDS in the data layer.

If the team chooses AWS and insists on Lambda + SES, the design should be:

- `Lambda` receives the login request;
- `SES` sends the verification code;
- the backend validates the OTP and issues a secure session (cookie or signed server-side token);
- the session becomes the source of truth;
- all data queries check the authenticated user and not the request body.

Without this flow, Lambda + SES is only a notification mechanism, not real authentication.

### Recommended decision

If the goal is a defensible and simple solution for the hackathon, Cloudflare without Zero Trust can still work with an application-managed validated session and backend authorization. If the team wants a more realistic AWS target, the stronger design is `Cognito + Lambda + SES + RDS`, not `Lambda + SES` alone.

---

## 5) What AWS adds without Cloudflare Zero Trust

AWS does not provide a magic “RBAC switch.” The concrete advantage is that the proposed AWS target can separate identity, policy evaluation, and data enforcement using services that match the workflow:

| Concern | Cloudflare without Zero Trust | AWS target | Practical advantage |
|---|---|---|---|
| Customer identity | Worker-owned login and D1 session rows | Cognito User Pool and verified JWTs | A managed identity lifecycle, token validation, recovery, MFA options, and rotation instead of a demo login becoming the permanent identity system |
| Coarse roles | Application code and session actor values | Cognito groups or custom claims, checked by Lambda | A standard source for `customer`, `agent`, `admin`, and `auditor`; still requires backend enforcement |
| Contextual policy | Worker conditionals and query predicates | Lambda policy module, optionally AWS Verified Permissions | ABAC rules can evaluate role, subject, customer scope, assignment, action, and resource state in one policy boundary |
| Row isolation | Every D1 query must add `customer_id` or assignment predicates | PostgreSQL RLS in RDS plus application checks | A database defense-in-depth boundary can reject rows outside the authenticated scope even when a handler forgets a filter |
| Auditability | Worker/D1 application logs | CloudWatch, CloudTrail, KMS-protected logs, and application audit tables | Stronger evidence of authentication, policy decisions, administrative actions, and data access |
| Network/data boundary | Edge runtime and D1 service boundary | Private VPC, private RDS, security groups, KMS, and IAM database authentication | Database access is not directly public and service permissions can be narrowed independently |

The benefit is therefore not that AWS replaces authorization. It gives us a more defensible control chain:

1. Cognito verifies the principal and issues a signed token.
2. API Gateway/Lambda verifies the token and derives the subject and role from trusted claims.
3. A policy layer evaluates the action and resource attributes.
4. Lambda sets the database request context and RDS PostgreSQL RLS enforces the row boundary.
5. CloudTrail, CloudWatch, and application audit records preserve the decision trail.

The current AWS template includes RDS, IAM database authentication, KMS, private subnets, and CloudWatch, but it does not yet include Cognito, a policy engine, RLS policies, or an audit schema. Those are required additions before calling the AWS design production-ready.

### What AWS does not solve automatically

- Cognito groups are coarse RBAC, not complete authorization.
- JWT claims identify a principal but do not prove that the principal may access a particular case or customer row.
- IAM controls AWS resources and service-to-service access; it is not the customer data policy.
- RLS only protects tables covered by policies and can be bypassed by privileged database roles, so migrations and admin paths must be controlled.
- SES only delivers OTP or notification messages; it is not an identity provider.

---

## 6) Authorization strategy: RBAC + ABAC + row-level security

The consolidated recommendation is not to choose one mechanism. Use each mechanism for the boundary it is good at:

### RBAC for stable role boundaries

Use four roles, issued by the identity system and checked server-side:

| Role | Baseline permissions | Data boundary |
|---|---|---|
| `customer` | Read own transactions, create/read own cases, continue own intake episodes | `customer_id = subject.customer_id` |
| `agent` | Read assigned cases and handoffs, read only the evidence needed for assigned work | `case.assigned_agent_id = subject.agent_id` |
| `admin` | Manage users, configuration, assignments, and policy metadata | No implicit access to all customer records; require explicit support/audit scope |
| `auditor` | Read audit events, policy decisions, and approved evidence metadata | Read-only; no case mutation and no unrestricted customer browsing |

RBAC is appropriate here because these four job functions are stable and easy to review. It is not sufficient by itself because “agent” does not mean every agent may read every case.

### ABAC for contextual decisions

Apply ABAC in the service/policy layer using attributes such as:

- `subject_id`, `role`, and `customer_id` from the verified session/token;
- `agent_id`, case assignment, branch or team scope;
- resource `customer_id`, `case_id`, classification, and workflow state;
- action (`read`, `create`, `assign`, `resolve`, `export`, `administer`);
- environment (`production`, `demo`), request purpose, and time-bound elevation.

Examples:

- allow a customer to read a transaction only when `resource.customer_id == subject.customer_id`;
- allow an agent to read a handoff only when the case is assigned to that agent or their approved queue;
- allow an admin to assign an agent, but not to export all customer data by default;
- allow an auditor to read an audit event but never to mutate a case.

ABAC is needed because the access decision depends on ownership, assignment, and workflow state, not only on the role name.

### Row-level security for database defense in depth

Use PostgreSQL RLS on `customers`, `transactions`, `cases`, `intake_episodes`, `intake_handoffs`, and audit tables in the AWS RDS design.

The request transaction should set trusted, server-derived context such as:

- `app.subject_id`
- `app.role`
- `app.customer_id`
- `app.agent_id`
- `app.scope_id` or assignment scope

Policies then enforce the row boundary. For example, customer reads require the row `customer_id` to equal `current_setting('app.customer_id')`; agent reads require an assignment or approved queue relationship. The application policy check remains mandatory because RLS is a backstop, not a replacement for endpoint authorization.

Use RLS for customer and agent data boundaries because the repository already treats `customer_id` as the critical ownership key, and because the AWS target uses PostgreSQL. Do not claim RLS for the current D1 deployment: D1 does not provide equivalent native row policies, so the Worker must enforce the predicates directly.

### Recommended policy architecture

For this project, the right balance is:

- Cognito groups or equivalent claims for role assignment;
- Lambda policy code for ABAC and endpoint decisions;
- PostgreSQL RLS for row isolation;
- CloudTrail/CloudWatch plus an application audit table for evidence;
- AWS Verified Permissions only if policies become numerous, centrally managed, or shared by multiple services. It is not necessary for the first AWS implementation.

This avoids overengineering the hackathon path while giving the production path a clear control model.

## 7) Final stack recommendation

### Recommendation 1: keep the main runtime on Cloudflare without Zero Trust for now

Reasons:

- the solution is already validated and sized for the project window;
- it reduces the risk of delaying challenge delivery;
- it satisfies the service-level security model as long as application-managed sessions authenticate identity and backend authorization is enforced;
- AWS is better seen as a scale/compliance plan, not as a replacement for the current working system.

### Recommendation 2: use AWS as the parallel production-grade architecture

Reasons:

- stronger security and private networking posture;
- KMS, observability, and auditability;
- better fit for stricter banking requirements;
- aligns with the infrastructure design in [Docs/Costs/aws-target/architecture.yaml](../Costs/aws-target/architecture.yaml).

### Recommendation 3: implement defensible authentication before any real migration

Minimum requirements:

- session with a random token, hashed and stored securely in the backend;
- cookie with `HttpOnly`, `Secure`, and proper `SameSite` settings;
- short expiry;
- revocation of the previous token when a new session starts;
- authorization by session, not by request body;
- all customer data queries filtered by the authenticated `customer_id`;
- no route that returns customer or transaction data without a validated user session.

---

## 8) Mandatory fixes independent of the stack

These fixes should exist in both Cloudflare and AWS.

### a) Real customer login

- authenticate the user via email + OTP or a trusted identity service;
- the session must be the source of truth;
- do not accept a customer number as proof of identity.

### b) Authorization by service and by endpoint

- `GET /transactions` must validate the authenticated session first;
- any `customer_id` coming from the URL or request body must be ignored for authorization if it does not come from the session;
- the API must return only the authenticated user’s data.

### c) Role separation

- customer
- agent
- admin
- auditor
- each role with explicitly allowed routes and actions

### d) Session management

- short expiration times;
- revocation on logout;
- invalid entries rejected without leaking information;
- audit logs for login and failed attempts.

### e) Remove global listing

- endpoints like `/demo/identities` must respect the authenticated user context;
- without a valid identity, the API must not list customers or any business entity data.

### f) Handoff and auditing

- every sensitive action must include a `session_ref` or `request_id`;
- logs must record who performed the action, what operation happened, and whether it was authorized;
- handoff and confirmation decisions must be traceable.

### g) Interface contract validation

- front-end and API must agree on which fields are legitimate;
- do not trust values from the DOM or client payload for authorization decisions.

---

## 9) Current red flags and required tasks

### Red flags that remain valid regardless of the stack

1. Any `customer_id` coming from the request body cannot be treated as authenticated identity.
2. Any route that lists customers or sensitive data without checking the user’s current session is an access leak.
3. Any endpoint whose authorization depends on the customer value in the payload is unsafe.
4. Team authentication does not replace customer identity.
5. SES + Lambda alone are not enough for real authentication; they are useful for OTP and notification.

### Implementation TODOs before migration

#### Auth and authorization

- [ ] implement customer login with email + OTP or a trusted identity provider;
- [ ] treat the session as the source of truth for identity;
- [ ] block any access path where the `customer_id` comes from the body instead of the session;
- [ ] apply RBAC by role (`customer`, `agent`, `admin`, `auditor`);
- [ ] remove global customer listing and restrict queries by the authenticated `customer_id`;
- [ ] log authentication, failures, and sensitive actions with `session_ref` or `request_id`;
- [ ] enforce short expiry and token revocation;
- [ ] support logout and invalidate the previous token when a new session starts.

#### Contract and service layer

- [ ] review every endpoint to ensure authorization occurs in the backend;
- [ ] standardize response and payload contracts between front-end and API;
- [ ] test session expiry, session swap, cross-account access, and hostile payload cases;
- [ ] confirm that agent and admin routes do not return unrelated customer data outside scope.

#### AWS parallel path

- [ ] add Cognito or an equivalent identity layer as the authentication layer;
- [ ] connect SES to the OTP flow only as a delivery channel;
- [ ] keep Lambda for business logic and orchestration;
- [ ] revalidate the infrastructure design for session handling, KMS, logs, and auditing;
- [ ] keep Cloudflare live while AWS runs in parallel;
- [ ] define cutover criteria: same session behavior, same authorization, same data contract, same adversarial tests.

#### Cutover criteria

- [ ] AWS and Cloudflare expose the same endpoints and role permissions;
- [ ] the customer only sees data for their own `customer_id`;
- [ ] the same session cannot escalate access between customers;
- [ ] the handoff, case, and audit flow behaves identically on both stacks;
- [ ] the team validates there is no data leakage, no language regression, and no edge-case regression.

---

## 10) Decision defensible to judges

The most defensible decision against the repo and challenge criteria is:

- do not treat AWS infrastructure as a security solution without real authentication;
- do not move to AWS just because there are credits;
- solve auth + authorization first;
- keep the Cloudflare stack as the challenge solution and AWS as the future production-scale architecture;
- if using AWS, prefer `Cognito + Lambda + SES + RDS` or `Cognito + Lambda + AWS managed auth`, never `SES + Lambda` alone as the primary identity source.

This is defensible because:

- the repo already documents the stack choice and cost/time trade-offs in [Docs/ADRs/ADR-003-intake-single-runtime-worker-d1.md](../ADRs/ADR-003-intake-single-runtime-worker-d1.md) and [Docs/ADRs/ADR-004-intake-capacity-and-cost.md](../ADRs/ADR-004-intake-capacity-and-cost.md);
- the challenge requires demonstrated authentication and service-layer authorization;
- the AWS architecture is strong for production, but it supplements identity rather than replacing it.

---

## 11) Conclusion

The strongest proposal is:

- keep Cloudflare running while the challenge still requires speed, validation, and review;
- proceed with AWS as a parallel production and compliance path without disabling Cloudflare before functional parity is proven;
- fix authentication and authorization before any traffic cutover, because those are structural requirements, not optional extras;
- treat SES as an OTP delivery mechanism, not as identity;
- treat the session token as the only source of truth for `customer_id` and permissions.

### Final architecture decision

1. Use Cloudflare now for the demo and judge flow.
2. Build AWS in parallel as the production-grade stack.
3. Keep both stacks live until auth, data access, RBAC, and workflow parity are proven.
4. Cut over only when the AWS version matches the Cloudflare behavior and passes the same adversarial checks, including unauthorized-access tests, session-expiry tests, and role isolation.

### RBAC policy that makes sense for the current data model

For the product we can realistically build on AWS, a sensible policy is:

- `customer`: only their own customer record, transactions, cases, and dispute workflow;
- `agent`: access to assigned cases and supporting evidence only;
- `admin`: access to configuration, user management, and audit logs, but never to all customer data without explicit scope;
- `auditor`: read-only access to audit and policy events.

This is consistent with the challenge and with the requirement that access must be enforced in the service or tool layer. It also matches the repo’s emphasis on privacy, access control, and operational boundaries as part of the required demonstration.

If the team wants a strong statement to share with the client or judges, the recommended phrase is:

> “The AWS architecture is the production-grade target, but authentication and authorization are structural requirements that must exist before any migration. The session token, validated server-side, is the source of truth for customer identity; the request body is never accepted as proof of identity or access right.”
