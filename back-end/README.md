# Cloudflare variant of the intake demo

This is a **separate, bounded** deployment of the existing synthetic demo. Angular is served as Worker Static Assets; a JavaScript Worker implements the same customer and agent API; D1 stores customers, charges, accepted cases, and one-hour sessions. The existing FastAPI/PostgreSQL version remains intact. Neither browser nor Worker reads S3. The ignored SQL seed is exported only from the one-day, quality-gated PostgreSQL sample produced by the existing Bronze/Silver loader.

The Worker does not decide fraud, issue refunds, or authenticate bank customers. It provides a simulated identity and confirms a request only after D1 commits it. Cloudflare Access plus the Worker's Basic gate restrict the team preview; those gates are not banking authentication.

## Local checks — no Cloudflare account needed

Use Node **22 or newer** for Wrangler 4.143.0. Cloudflare Builds currently supplies Node 24 by default. From the repository root:

```bash
npm --prefix demo-ui ci
npm --prefix demo-ui run build
npm --prefix cloudflare ci
npm --prefix cloudflare run prepare-assets
npm --prefix cloudflare test
```

The test command creates a temporary local D1 database, applies migrations, seeds fictitious fixture data, starts Wrangler, checks the HTTP flow, and removes the temporary database. It does not touch the persistent local PostgreSQL demo or a remote Cloudflare resource.

To browse the Worker locally, create `cloudflare/.dev.vars` (ignored by Git) with your own `DEMO_ACCESS_USERNAME` and `DEMO_ACCESS_PASSWORD`, then from `cloudflare/`:

```bash
npx wrangler d1 migrations apply arabica-intake-demo --local
npx wrangler d1 execute arabica-intake-demo --local --file seed_fictitious.sql
npx wrangler dev --local
```

The placeholder D1 ID in `wrangler.jsonc` is valid for **local development only**. `npm run deploy` refuses to publish it. To include the previously reviewed dataset row locally, first run the one-day PostgreSQL sample load documented in [the demo plan](../Docs/Plans/intake-demo.md), then from the repository root:

```bash
.venv/bin/python -m cloudflare.export_sample
cd cloudflare
npx wrangler d1 execute arabica-intake-demo --local --file ../data/cloudflare_sample_seed.sql
```

This export reads only the fixed allowlisted customer and at most 20 transaction IDs named by the existing `intake_demo.sample_loads` manifest. The exporter rejects missing ownership, incomplete provenance, or a wrong event date; D1 rejects a divergent seed rerun. Its output stays under ignored `data/`; it contains no cases. The D1 provenance table stores source file, product ID, business date, and mapping; the public API never returns it.

## Prepare the remote resource

These are **one-time account actions**. The team pilot has a Worker and D1 database with migrations and the fictitious seed applied; other accounts must repeat setup with their own D1 ID. Verify runtime secrets and the live flow before sharing the URL.

1. In Cloudflare **Workers & Pages**, use the Worker named `factored-hackathon-2026-arabicaai`; keep any existing Pages project unchanged. Create a D1 database named `arabica-intake-demo` under **D1 SQL Database**. Copy its non-secret database UUID into `cloudflare/wrangler.jsonc` in place of the all-zero placeholder. The Worker name in Cloudflare must match the config `name`.
2. Configure Cloudflare **Access** on the production `*.workers.dev` Worker URL with an allowlist of team email addresses. Protect previews too, or disable them until you have a separate preview database. A preview deployment otherwise uses the configured binding and can write to the same D1 database.
3. Under the Worker's **Settings → Variables and Secrets**, set runtime `DEMO_ACCESS_USERNAME` and a long, unique `DEMO_ACCESS_PASSWORD`. Do not add them to the build command, GitHub, `.env`, or repository. The Worker returns 503 for non-health routes until both exist. Access and this Basic gate protect all routes, including static files.
4. On a machine authenticated to your Cloudflare account, apply migrations and load only reviewed demo data. From `cloudflare/` run:

   ```bash
   npx wrangler d1 migrations apply arabica-intake-demo --remote
   npx wrangler d1 execute arabica-intake-demo --remote --file seed_fictitious.sql
   # Optional: run the bounded export shown above, inspect its local SQL file, then:
   npx wrangler d1 execute arabica-intake-demo --remote --file ../data/cloudflare_sample_seed.sql
   ```

   The seed can be rerun: identical data remain the same; divergent values raise a constraint error. Do **not** upload the local PostgreSQL cases, `data/` directory, DuckDB, Parquet, or credentials.
5. Connect the Worker to this GitHub repository. In **Settings → Builds**, select `feat/lucas-intake-demo` as the production branch and disable preview builds until they have a separate D1 database. Set **Root directory** to `cloudflare`, where `wrangler.jsonc` lives. The checkout still includes the sibling Angular directory. Set **Build command** to:

   ```bash
   npm ci && npm --prefix ../demo-ui ci && npm --prefix ../demo-ui run build && npm run prepare-assets && npm test
   ```

   Set **Deploy command** to `npm run deploy`. Cloudflare Builds supports a configurable production branch and commands. Restrict watch paths to `cloudflare/**` and `demo-ui/**` if you want to avoid builds from unrelated reports. The deploy guard stops the build until the real D1 UUID is committed. A GitHub connection alone does not deploy the existing Docker image.
6. After the first successful deployment, open the Worker URL from an allowed email account. Confirm Access denies an unlisted email; the Basic gate denies a missing password; customer login lists only that identity's charges; case creation returns a reference; retry returns the same reference; and the agent view reads the persisted case. Restarting a Worker isolate must not erase a case or session because both are in D1. Check `GET /healthz` separately.

## Limits and costs

The Free plan currently allows 100,000 Worker requests/day and 10 ms CPU per request, while D1 allows 5 million rows read/day, 100,000 rows written/day and up to 500 MB per database. At the workbook's 10 planned requests per episode, 9,000 episodes/day would imply 90,000 Worker requests/day **before extra requests**, close to the cap. Static asset requests may be free, but this demo routes all requests through the Worker to enforce its Basic gate, so measure them. Test actual CPU, D1 row scans, retries, and peak behavior before claiming the free plan can support any target volume. AI model calls have separate prices. The `workers.dev` address is suitable for a private hackathon demo, not a bank production SLA.

Official references: [Git build settings](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [Worker static assets](https://developers.cloudflare.com/workers/static-assets/), [D1 migrations](https://developers.cloudflare.com/d1/platform/migrations/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Access for workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
