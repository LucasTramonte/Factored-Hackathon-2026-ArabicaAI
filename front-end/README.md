# Intake web client (Angular)

The customer and agent views for the synthetic charge-intake demo. The client doesn't decide fraud, block a card or issue a refund; customer and agent sign-ins are simulated. The API is the Cloudflare Worker in [`back-end/`](../back-end/README.md), and the response shapes it relies on are in [`contracts/`](contracts/intake-api.schema.json).

| Path | Responsibility |
|---|---|
| `src/app/core/http/api.service.ts` | Same-origin JSON client. Maps each HTTP status to a user message and never shows server text. |
| `src/app/features/customer/` | One connected screen under `/`: intro, sign-in and home as in-page steps (the Worker only serves documents at `/` and `/agent`). Choose one of your own charges, describe it and confirm. After a failure, a retry resends the frozen request with the same key. |
| `src/app/features/agent/` | Separate simulated agent session and a read-only case queue. |
| `src/app/shared/` | API models, `formatSourceTime` (source wall time, never shifted), `i18n/` (every interface string in ES, PT and EN; the `Strings` type makes a missing translation a compile error) and `mark/` (the disc-and-slit mark). |
| `contracts/` | JSON Schema for API responses, validated by the back-end integration tests. |

From the repository root, with Node 22:

```bash
npm --prefix front-end ci
npm --prefix front-end test -- --watch=false --browsers=ChromeHeadless
npm --prefix front-end run build        # back-end/scripts/prepare-assets.mjs copies dist/ into the Worker
```

For live development, run `npx wrangler dev --local` in `back-end/` (port 8787). Then run `npm --prefix front-end start -- --proxy-config proxy.conf.json` and open `http://127.0.0.1:4200`.

## Design system

Tokens and components come from the ArabicaAI design system (graphite neutrals, one cobalt accent, status colours reserved for ok/warn/err, Geist and Geist Mono, radius 12/10/6/pill, no shadows). They are compiled into `src/styles.css`: `:root` holds the light values, `@media (prefers-color-scheme: dark)` and `[data-theme="dark"]` the dark ones. Component classes are prefixed `.ar-`; app layout classes are unprefixed, with breakpoints at 1180, 960 and 720 px. `prefers-reduced-motion` disables the disc travel and the intro word rotation.

The interface language comes from the visitor's choice (`localStorage` key `arabica.lang`), else `navigator.language`, never from the customer's country. Evidence (amounts, IDs, timestamps, currency codes) is never translated; amounts keep their source currency and totals are per currency, computed from the loaded charges only.

`angular.json` sets `optimization.fonts: false` for production: Angular's default downloads Google Fonts at build time to inline them, and the Workers Builds runner does not always have egress to `fonts.googleapis.com`, which failed the build. The browser still loads the fonts from the `<link>` in `index.html`.

Loading the fonts that way is a third-party request: every visitor's browser contacts `fonts.googleapis.com` and `fonts.gstatic.com`, which sees the visitor's IP address. That is acceptable for the synthetic demo behind Cloudflare Access. A deployment with real customers should self-host the Geist files instead, and add a `font-src 'self'` Content-Security-Policy.

The interface copy describes what V1 does: a deterministic guided report reviewed by a person. It makes no claim of an AI agent, because the MVP calls no model ([ADR-002](../Docs/ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md)). API failures are shown in the interface language, keyed by HTTP status (`errorText` in `shared/i18n/`); server text is never shown.
