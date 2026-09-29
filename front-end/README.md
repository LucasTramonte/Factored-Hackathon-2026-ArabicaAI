# Intake web client (Angular)

The customer and agent views for the synthetic charge-intake demo. The client doesn't decide fraud, block a card or issue a refund; customer and agent sign-ins are simulated. The API is the Cloudflare Worker in [`back-end/`](../back-end/README.md), and the response shapes it relies on are in [`contracts/`](contracts/intake-api.schema.json).

| Path | Responsibility |
|---|---|
| `src/app/core/http/api.service.ts` | Same-origin JSON client. Maps each HTTP status to a user message and never shows server text. |
| `src/app/features/customer/` | Sign in, choose one of your own charges, describe it and confirm. After a failure, a retry resends the frozen request with the same key. |
| `src/app/features/agent/` | Separate simulated agent session and a read-only case queue. |
| `src/app/shared/` | API models and `formatSourceTime`, which shows the source wall time without shifting its timezone. |
| `contracts/` | JSON Schema for API responses, validated by the back-end integration tests. |

From the repository root, with Node 22:

```bash
npm --prefix front-end ci
npm --prefix front-end test -- --watch=false --browsers=ChromeHeadless
npm --prefix front-end run build        # back-end/scripts/prepare-assets.mjs copies dist/ into the Worker
```

For live development, run `npx wrangler dev --local` in `back-end/` (port 8787). Then run `npm --prefix front-end start -- --proxy-config proxy.conf.json` and open `http://127.0.0.1:4200`.
