# Intake API (Cloudflare Worker + D1)

This is the only online implementation of the intake service ([ADR-003](../Docs/ADRs/ADR-003-intake-single-runtime-worker-d1.md)).

- **Worker (JavaScript, ES modules):** serves the API.
- **D1:** stores customers, charges, cases and sessions.
- **Angular build:** served from `front-end/` as static assets.

The Worker never reads S3, DuckDB or Silver. The data it serves is loaded as a reviewed seed from the Gold slice (`data_pipelines/gold/`).

The service does not decide fraud, issue refunds or authenticate bank customers. It confirms a report only after D1 has stored it.

## Layout

| Path | Responsibility |
|---|---|
| `src/index.js` | Entry point. It turns any unexpected error into a generic 503. It adds D1 counters only when `DEMO_EXPOSE_DB_METRICS=1`, which is set in local tests only. |
| `src/router.js` | Exact route table. The access gate runs before method checks and also covers the HTML documents (`/`, `/index.html`, `/agent`). Other methods on API paths get 405, unknown API paths get 404. Hashed bundles are served without the Worker. |
| `src/http.js` | JSON responses, cookies, and body parsing capped at 16 KB. |
| `src/auth/access-gate.js` | Basic gate for API routes, second to Cloudflare Access. It fails closed when not configured. |
| `src/auth/session.js` | Random 256-bit tokens. Only their SHA-256 is stored, and customer and agent sessions are kept separate. |
| `src/modules/customer/` | Login, own charges, and case creation with validation. |
| `src/modules/agent/` | Agent session and the read-only case view. |
| `src/store/d1.js` | Every SQL statement. This is the only module to replace if the store changes. |
| `src/config/identities.json` | Allowlisted demo identities, shared with the Gold slice. |
| `migrations/` | Versioned D1 schema (`wrangler d1 migrations`). Additive only. |
| `seeds/seed_fictitious.sql` | Fictitious identities and charges. Rerunning it is a no-op, and drift makes it fail. |
| `test/unit/` | Pure-module tests: validation, gate, sessions, failure injection, routing, the contract validator. |
| `test/integration/` | Tests against local D1: main flow, adversarial matrix, D1 budget. All JSON is checked against `front-end/contracts/`. |

## Run and test locally

These steps need Node 22 or newer and no Cloudflare account. From the repository root:

```bash
npm --prefix front-end ci && npm --prefix front-end run build
npm --prefix back-end ci && npm --prefix back-end run prepare-assets
npm --prefix back-end test          # unit tests, then integration tests on a throwaway local D1
```

To browse locally, create `back-end/.dev.vars` (ignored by Git) with `DEMO_ACCESS_USERNAME` and `DEMO_ACCESS_PASSWORD`. Then, from `back-end/`:

```bash
npx wrangler d1 migrations apply arabica-intake-demo --local
npx wrangler d1 execute arabica-intake-demo --local --file seeds/seed_fictitious.sql
npx wrangler d1 execute arabica-intake-demo --local --file ../data/demo_s3/intake_slice_seed.sql   # optional; from make intake-sample-slice
npx wrangler dev --local
```

## Deployment

The Worker `factored-hackathon-2026-arabicaai` deploys through Cloudflare Workers Builds from the production branch. Build settings:

- **Root directory:** `back-end`
- **Build command:** `npm ci && npm --prefix ../front-end ci && npm --prefix ../front-end run build && npm run prepare-assets && npm test`
- **Deploy command:** `npm run deploy`
- **Watch paths:** `back-end/**`, `front-end/**`

Preview builds share the production D1 binding. Keep them disabled until a separate preview database exists.

Runtime secrets `DEMO_ACCESS_USERNAME` and `DEMO_ACCESS_PASSWORD` live only in the Worker's settings, never in the repository or build logs. Without them, every API route returns 503. Cloudflare Access with an email allowlist or one-time PIN protects the whole hostname, static files included. `scripts/predeploy.mjs` refuses to deploy a placeholder D1 ID.

Schema changes: `npx wrangler d1 migrations apply arabica-intake-demo --remote`, after the same migration has passed the local tests. To load reviewed data, run `npx wrangler d1 execute arabica-intake-demo --remote --file <seed>` for the fictitious seed, or for a Gold slice seed whose manifest has been reviewed. Never upload `data/`, DuckDB, Parquet or credentials.

## Remote checks after a deploy

Record the date and the results of each check in ADR-004's implementation notes:

1. Cloudflare Access denies an email that isn't on the allowlist.
2. A missing Basic credential returns 401 on `/transactions`.
3. Each customer sees only their own charges.
4. A confirmed case returns a reference, and a retry returns the same one.
5. The agent view shows the case.
6. The case is still there after a new deploy.
7. A page load adds one Worker request (the document); bundles don't add any.
8. `GET /healthz` returns `{"status":"ok"}`.

## Limits

Free plan: 100,000 Worker requests per day, 10 ms of CPU per request, 50 D1 queries per invocation, 5 million rows read and 100,000 rows written per day, and 500 MB per database. Measured cost of one customer episode: 3 requests, 9 queries, 10 rows read, 7 rows written. [ADR-004](../Docs/ADRs/ADR-004-intake-capacity-and-cost.md) turns these numbers into capacity and cost.
