# Sign-in, domain and email on GCP: cost and feasibility (checked 2026-10-04)

**The question.** AWS has not granted SES production access, and Cognito's default sender allows 50 emails a day per account. Could GCP take over sign-in, give the service its own domain and DNS, and send the report-update emails ("Email me an update")?

**Short answer:**
- **Sign-in and domain:** yes, cheaply.
- **Email:** no. GCP has no transactional email service.
- **"Update me about this charge":** it is being moved into the app (#113), so it will no longer depend on email.

## What the project has today (read-only checks)

| Item | State on `factored-hackathon-arabica-ai` |
|---|---|
| Billing | Enabled. **No budget alert exists**: the Budget API is not enabled |
| Vertex AI, IAM, IAM Credentials, STS, Cloud Billing Catalog | Enabled. The keyless path to Vertex was verified end to end ([plan](ai-suggestion-plan.md)) |
| Identity Platform (`identitytoolkit`), Firebase | Not enabled |
| Cloud DNS, Cloud Domains | Not enabled |
| Cloud Run, Cloud Tasks, Secret Manager | Not enabled (they belong to the [GCP target](../Costs/gcp-target/README.md) only) |

## Options, with official prices and limits

Prices are list prices from the Cloud Billing Catalog API, read 2026-10-04. The limits come from [Firebase Authentication limits](https://firebase.google.com/docs/auth/limits).

| Need | GCP option | Price | Limit that matters | Feasible? |
|---|---|---|---|---|
| Staff and evaluators sign in | **Sign in with Google** (Identity Platform or a plain OAuth client) | $0. Tier 1 is free up to 50,000 monthly active users, then $0.0055 per user | — | **Yes.** ADR-013 phase 1. It stops spending Cognito's 50 daily codes on staff |
| Customers sign in without a password | Identity Platform **email link** | $0 up to 50,000 monthly active users | 25,000 emails a day with billing (5 a day without) | Yes, but it is a link, not the typed code the flow uses today. That changes the sign-in screen and needs an ADR-007 amendment |
| Customers get a typed numeric code | Identity Platform **SMS** code | Per SMS: Mexico $0.05, Colombia $0.01, Argentina $0.09, Brazil $0.02 | No daily cap on Identity Platform (Firebase's free tier: 3,000 a day) | Yes. It needs phone numbers, and the dataset's customers have no verified ones. At the dataset's 11 reports a day, about $0.55 a day for Mexico |
| A domain of our own | **Cloud Domains** | `.com` $12 a year, `.dev` $12, `.app` $14, `.com.mx` $20 | Registration runs through Squarespace's terms | Yes. But the Worker runs on Cloudflare, so registering or delegating the domain to Cloudflare and attaching it as a Workers Custom Domain is simpler: Cloudflare then issues the certificate and the DNS records |
| DNS | **Cloud DNS** | $0.20 a zone a month, plus $0.40 per million queries | — | Yes, about $0.20 a month, but redundant if the domain sits on Cloudflare |
| Report-update and status emails | **None on GCP** | — | — | **No.** Keep SES (production access is pending) or use a third-party transactional provider. Either needs a verified domain with SPF and DKIM records |

**At this project's volume:**
- Sign in with Google: $0.
- A domain: $12 a year.
- DNS: $0.20 a month, or $0 on Cloudflare.

**What it costs is time, not money.**
- Google sign-in for staff is about a day of work in the Worker, plus an OAuth client created by a person.
- Customer email-link sign-in changes the flow, and needs an ADR and new tests.
- Email delivery stays blocked on a provider decision whatever cloud is chosen.

## Recommendation

1. **For the submission:** keep Cognito codes for customers. Deliver "Update me" in the app (#113), with email only as an extra channel when SES can deliver.
2. **Next, if staff keep using up codes:** add Sign in with Google for team and evaluators (ADR-013 phase 1). A person creates the OAuth client: Google Auth Platform, then Clients, then Web application, with the Worker's origin.
3. **Domain:** only for branding or email authentication. Register on Cloudflare (or delegate to it) and attach `app.<domain>` as a Workers Custom Domain. Use Cloud Domains plus Cloud DNS only if the bank wants GCP to own DNS.
4. **Customer sign-in on Identity Platform:** only if SES production access stays denied after the submission, as a separate phase with Cognito as fallback (ADR-013 phase 2).
5. **Now, whatever else is chosen:** a person creates a budget alert on the billing account. For example $10 a month with alerts at 50%, 90% and 100%: enable `billingbudgets.googleapis.com`, then `gcloud billing budgets create`. The project has billing on, and no alert today.
