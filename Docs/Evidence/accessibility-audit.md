# Accessibility audit: customer `/` and agent `/agent`

W9, 1 October 2026. This audit checks the Angular client against WCAG 2.2 AA, and fixes small failures in place. It is evidence for the demo, not a conformance claim. Assistive-technology testing with a real screen reader has not been done.

## Method

- **Build audited:** branch `fix/intake-chat-focus-copy` at 07a2bbd (PR #46, which contains PR #45), on main be96dfe. After the fixes it is this branch.
  - Angular production build, copied into the Worker by `back-end/scripts/prepare-assets.mjs`.
  - Served by `wrangler dev --local` with a local D1: migrations applied, and only `back-end/seeds/seed_fictitious.sql` loaded (`demo-ana` with two charges, `demo-bruno` with one).
  - Placeholder `.dev.vars` for the demo gate. Nothing remote and no deploy.
- **Tool:** headless Google Chrome driven over the Chrome DevTools Protocol from a Node script, with no new dependencies. The script is a QA scratch harness and is not committed, so the ratios, clearances and obscured-control counts below are one-off measurements that can't be re-run from the repository.
  - **Keyboard:** `Input.dispatchKeyEvent` sends Tab, Enter and Space. Buttons are activated by keyboard, not by `element.click()`, so focus behaves as it does for a person.
  - **Names, roles, headings, landmarks and live regions:** `Accessibility.getFullAXTree`. Any interactive node without a name is reported.
  - **Text contrast (1.4.3):** WCAG 2.x relative luminance on computed colours.
    - Each text element is composited through its real paint stack at its own position: `document.elementsFromPoint` with pointer events forced on, the background of each layer, ancestor opacity, and SVG fills.
    - This is what found text crossing the decorative disc, which an ancestor-only walk misses.
    - Disabled controls are exempt.
  - **Non-text contrast (1.4.11):** button fill or border, field borders and native radio/checkbox `accent-color`, each against what is behind them. The focus ring is the outline colour of every element reached by Tab, against the colour behind it.
  - **Target size (2.5.8):** every visible target under 24×24 CSS px, with the spacing exception (a 24 px circle on its centre must not reach another target). Inputs inside a clickable `<label>` are reported separately.
  - **Focus not obscured (2.4.11):** a heuristic: the focused element counts as hidden when its centre and two corners are all covered by another element. Three sample points can miss partial overlap elsewhere on the element, so a 0 here means none was found at those points, not a proof that nothing is obscured.
  - **Reflow (1.4.10):** `scrollWidth` against `innerWidth`, plus any element extending past the viewport that isn't `position: fixed`.
  - **Language (3.1.1, 3.1.2):** `html[lang]` after each switch, and text in another language without an enclosing `lang`.
  - **Motion:** `prefers-reduced-motion: reduce` emulated. Any element still animating or transitioning is reported, and the intro words' opacity is sampled over time.
- **Matrix:**
  - Viewports and themes: 1440×900 light and dark, 1280×720 light, 320×640 light, and 320×640 dark with reduced motion.
  - For 2.4.11 the Tab walk also ran at 1440×900, 1440×800, 1366×768, 1280×720, 1181×800, 1180×800, 1024×768, 768×1024, 390×844 and 320×640.
  - All screenshots are 1× device pixel ratio.
- **States, customer `/`:** intro, login (the picker filtered to "demo", except in the `fix-a-*` screenshots, see the index), home, chat describe with a validation error, choose, receipt, and the chat in the English interface.
- **States, agent `/agent`:** before sign-in, then the queue with a detail open and closed.

## Findings

"Fixed in" refers to commit dc0282b on this branch (PR to `fix/intake-chat-focus-copy`).

| # | Criterion | Page | Before | After / evidence | Fix |
|---|---|---|---|---|---|
| 1 | 1.4.3 Contrast (Minimum) | `/` login, wider than 960 px | **Fail.** The bottom-anchored promise lines sat on the decorative disc, which has a fixed position. 1440×900 dark: line 1 at 2.13:1. 1440×900 light: 2.96:1. 1280×720 light: all three lines over the disc, at 1.03:1 (muted) and 2.96:1 (ink). | **Pass.** The disc now sits at `min(140px, 100dvh − 840px)`. Every promise line clears the disc edge, in ES, PT and EN: 1280×720 by 55, 99 and 143 px; 1440×900 and 1024×768 by 39, 83 and 127 px. No text-contrast failure remains in any state. | dc0282b (`styles.css`, 1 line). Screenshots `fix-a-*` |
| 2 | 2.2.2 Pause, Stop, Hide | `/` intro | **Fail.** "Hola / Olá / Hello" looped on an infinite 9 s cycle with no pause control (`animation-iteration-count: infinite`). | **Pass.** One pass only. Motion runs from 2.6 s to 6.8 s, which is 4.2 s, under the 5 s limit. Samples: 3.2 s Hola, 4.6 s Olá, 6.0 s Hello, then from 7 s onward the current language's word (Hola in ES) is shown statically, with no animation. Reduced motion is unchanged: the current word is static from the start. **The timing changed visually** (1.4 s per word instead of 3 s), so the team should review it. | dc0282b (`styles.css`, `customer.page.ts`/`.html`). Screenshots `fix-f-*` |
| 3 | 2.4.3 Focus Order | `/` chat, "Iniciar un nuevo reporte" (receipt and ended steps) | **Fail.** The button removes itself, so focus fell to `<body>`. | **Pass.** Focus goes to the chat heading. Spec: `customer.page.focus.spec.ts`. | dc0282b |
| 4 | 2.4.3 Focus Order | `/agent` "Entrar como agente y actualizar casos" | **Fail.** The button disables itself while busy, so focus fell to `<body>` after loading. | **Pass.** Focus goes to the queue heading on success, and back to the button on failure. Spec: `agent.page.spec.ts`. | dc0282b |
| 5 | 2.4.11 Focus Not Obscured (Minimum) | `/` home with the chat panel open, 1180 px wide and narrower | **Fail.** Tab reached page controls fully hidden behind the fixed chat panel: 6 at 320×640, 3 at 1024×768, 2 at 1180×800. At 1181 px and wider, 0. Screenshot `fix-2411-before-focus-hidden-1024.png`. | **Pass.** At 1180 px and below, the open panel makes `nav` and `main` inert. Tab cycles through the panel and its toggle only, and nothing is obscured at 320, 1024 or 1180. 1440 is unchanged: the whole page stays reachable and nothing is obscured. Closing with the toggle keeps focus on the toggle. Spec: inert only when narrow, never on the chat or its toggle. **Missed at first, fixed after review:** wider than 1180 px, when the panel grew to its full height (choose and error states), its top reached about y=36 and covered the topbar's ES/PT/EN switch, which Tab still reaches there (`scenario-ambiguous-es.png`, `scenario-expired-manual-es.png`, partly `scenario-unauthorized-es.png`, all 1280×800, captured before the fix). Above 1180 px the panel's `max-height` is now `100dvh − 180px`, so its top stays at least 96 px down, below the topbar. This follow-up was not re-measured with the harness. | dc0282b, review follow-up |
| 6 | 3.1.2 Language of Parts | `/` intro, chat (EN interface), language switch | **Fail.** "Español / Português / English", "Olá / Hello" and the report-language radios "Español / Português" had no `lang` (for example, in an ES page). | **Pass.** Each carries its own `lang`. The ES/PT/EN switch buttons carry `lang` too. | dc0282b |
| 7 | 3.1.2 Language of Parts | `/agent` "Casos abiertos" list | **Fail.** `.case-statement` has no `lang`. A PT statement is read with the page language (screenshot `scenario-agent-handoff-es.png`, bottom). The intake detail does set `lang` from the report language. | **Open.** `AgentCase` has no language field in the model or the contract (`front-end/contracts/`), so a fix needs an additive API change. | open |
| 8 | 1.4.11 Non-text Contrast | all | Pass | Buttons and fields are at least 3:1. The focus ring is at least 5.18:1 (light) and 6.11:1 (dark) on every element reached by Tab. Unpressed segmented-control buttons have no fill (1.03 to 1.06:1) and identity-row borders are 1.16 to 1.34:1. These controls are identified by their text or radio, so they aren't counted as failures. Not checked: whether the pressed and unpressed states of the segmented control differ from each other by 3:1. | — |
| 9 | 1.4.3 (rest) | all | Pass | The lowest text ratio outside finding 1 is 4.58:1, the "aceptada" ok chip in light. Muted text is 5.54:1. Card text on accent is 4.87:1. | — |
| 10 | 1.4.10 Reflow | `/`, `/agent`, 320 px | Pass | No horizontal scroll in any state. The off-screen disc is clipped by `.stage`. | — |
| 11 | 2.5.8 Target Size (Minimum) | all | Pass | The 18 px-tall link buttons (FAQ, "No lo reconozco") pass by the spacing exception. Radios and checkboxes are 18 px but sit inside clickable labels. | — |
| 12 | 2.1.1 / 2.1.2 Keyboard, No Keyboard Trap | all | Pass | Every control is reachable by Tab and activated by Enter or Space. No trap: at narrow widths with the chat open, Tab cycles the panel and toggle, and the toggle closes it. No focusable element is hidden, including during the intro's 4.4 s hidden-button phase (`visibility: hidden`). | — |
| 13 | 2.4.3 focus on step change | `/`, `/agent` | Pass | Focus moves to the new heading after Start, after login, on chat open, on the choose step (#46), on the receipt, and to the detail heading on `/agent`. Closing the detail returns focus to its row. On a failed Send/Retry, for example a 503, focus stays on the Retry button and the error is announced by `role="alert"`. | — |
| 14 | 4.1.2 Name, Role, Value | all | Pass | The AX tree has no interactive node without a name. | — |
| 15 | 3.1.1 Language of Page | all | Pass | `html[lang]` follows the ES/PT/EN switch. | — |
| 16 | 2.3.3 / reduced motion | `/` | Pass | With reduce, no element animates or transitions. The intro button is visible at 600 ms (at 4.4 s without reduce). | — |

Advisories (not WCAG failures, not changed):

- The intro step has no `h1`.
- Intro, login and `/agent` have no `main` landmark.
- The chat's describe-step fieldset is an unnamed group.
- The 1180 px breakpoint lives in both `customer.page.ts` (`matchMedia`) and the stylesheets, and the 6.8 s `introDone` timer must match the intro animation delays in `styles.css`. Each place now carries a comment naming the other, but nothing enforces them.
- At 1180 px and below, the language switch is unavailable while the chat is open: it sits in the inert `main`, so close the chat to switch.
- The chat log's customer lines carry no `lang` when the typed language differs from the interface.

## Safety scenarios

The scenarios come from the safety split in [heldout-and-safety-cases.md](../intake/heldout-and-safety-cases.md) and its "already covered" list. The outcomes they must show come from the [customer and measurement contract](../intake/customer-and-measurement-contract.md): clarification for ambiguity, a technical handoff on tool failure, and no data before authentication. The episode outcomes come from [intake-events.md](../intake/intake-events.md), Worker producer `guided-0.1`.

All captures use the fictitious seed only, with a 1280×800 or 320×640 viewport at 1×. Statuses are from the CDP network log.

Each capture is one of two kinds:
- **UI flow:** keyboard and pointer actions against the real local Worker.
- **Interception:** a CDP `Fetch` rule either answers in place of the server, or rewrites the request so that the server's real answer is shown.

| Scenario (source) | Screenshot | How produced | What it shows |
|---|---|---|---|
| Normal request (`single_match`; contract "complete intake") | `scenario-normal-es.png`, `scenario-normal-pt.png`, `scenario-normal-es-320.png` | UI flow. "No lo reconozco" on a charge row preselects it. The customer describes the charge, ticks the confirmation and sends. Calls: `start` 201, then `confirm` 201. | The complete receipt with its reference and the next step ("un agente revisa este caso. No se ha iniciado ningún reembolso"). **Gap:** a normal *resolution* that closes without an agent does not exist yet; it is pending a backend endpoint. Every path ends in a human handoff. |
| Ambiguous request (`ambiguous_matches`) | `scenario-ambiguous-es.png`, `scenario-ambiguous-pt.png` | UI flow. "Reportar un cargo", then describe. `start` 201. Then Confirm with nothing chosen. | Both owned charges are listed with none preselected, and the confirmation is disabled until one is chosen. Confirming without a choice is refused with "Elige uno de tus cargos y marca la confirmación". No charge is picked by ordering. |
| Unsupported request (`unsupported_language`, `account_inquiry`, `recognized_billing_dispute`) | `scenario-unsupported-en.png` | UI flow, English interface. Send without choosing a report language. No `/intake/start` call is made. | V1 takes reports only in ES or PT: the English interface asks for the report language and refuses to start without one. **No UI expression for other out-of-scope requests:** the report type is chosen by the customer, not classified from free text (intake-events, `guided-0.1`). So a balance question or a recognized billing dispute typed into the box is not routed. That routing exists only in the offline harness. |
| Handoff, human review without a confirmed charge (contract "incomplete handoff"; V1-05 / V1-10 debate) | `scenario-handoff-es.png`, `scenario-handoff-pt.png`, `scenario-handoff-es-320.png`, `scenario-agent-handoff-es.png` | UI flow. Describe, then "No encuentro el cargo". `start` 201, `handoff` 201. Agent view: agent sign-in, open the incomplete row. | The receipt "Enviado a revisión humana sin un cargo confirmado" with its reference. The agent detail shows kind `incomplete`, "Sin transacción verificada", open questions `matching_transaction` and `customer_confirmation`, and the history `intake_started`, `handoff_created kind=incomplete`, `intake_ended outcome=routed`. No `handoff_accepted` appears, so it can never count as safe accepted intake. |
| Unauthorized access (`foreign_confirmation`, `injected_identity`; safety split "Unauthorized access") | `scenario-unauthorized-es.png` | Interception that rewrites the request. Bruno's real session confirms his own charge, and the CDP rule rewrites the body's `transaction_id` to Ana's `demo-tx-001`. The **real** server answers `confirm` 404. | "No se encontró el cargo para esta sesión." Another customer's charge is not found for this session. Nothing is confirmed, and the form is released for correction. |
| Expired session, automatic (`expired_session_confirmation`) | `scenario-expired-auto-es.png` | UI flow with real expiry. All cookies are cleared through CDP before Confirm. Calls: `confirm` 401, `/demo/session` 200 (renewal of the same customer), then `confirm` 201 with the same body and key. | One 401 renews the same identity and retries the frozen request, ending in a normal receipt with no second case. |
| Expired session, manual | `scenario-expired-manual-es.png` | Interception. Both `confirm` and the renewal `/demo/session` answer 401. | "La sesión expiró…", the pending panel ("La aceptación no está confirmada… los datos de la solicitud no cambian"), "Renovar la misma sesión", and the charge chip "sin confirmar". |
| Tool failure (`tool_unavailable`; contract "technical handoff, not a completed intake") | `scenario-toolfail-es.png`, `scenario-toolfail-pt.png` | Interception. `confirm` answers 503 once; the server never sees the request. | "Servicio no disponible. La aceptación no se confirmó…", the frozen "Reintentar la misma solicitud", the pending panel, and the row chip "sin confirmar". No reference is shown, because none exists until the case row is read back. The server-side technical handoff (`handoff_created kind=technical`) belongs to a server lookup failure and is covered by back-end tests, not by this UI capture. |
| ES/PT ambiguity, session language (`session_language_mismatch`; contract, Spanish and Portuguese) | `scenario-mixed-es-pt.png` | UI flow. Spanish interface (report language `es`) with a Portuguese statement. `start` 201, `confirm` 201. | Following the safety-split assumption, the session language is a default, not a restriction: a PT message in an ES session is still served. The stored report language stays `es`. That assumption is still for the team to confirm. |
| ES/PT ambiguity, chosen language | `scenario-mixed-en-pt.png`, `scenario-agent-mixed-pt.png` | UI flow. English interface, the customer chooses "Português", then a PT statement. The agent view opens the newest intake. | The receipt in the interface language (EN). The agent detail shows "Idioma del reporte: pt" and the statement with `lang="pt"`. The open-cases list below shows finding 7, where the statement has no `lang`. |

## Screenshot index

Files are in `Docs/Evidence/screenshots/`. All are PNG at 1×, each under 200 KB. Only the fictitious seed was loaded, and the picker was filtered to "demo" wherever the login appears, except in the four `fix-a-*` captures. Those show the unfiltered list, which includes the one-day dataset identity committed in `identities.json`; its customer ID is covered by a grey bar.

| File | Viewport / theme | Kind | Content |
|---|---|---|---|
| `scenario-normal-es.png` | 1280×800 light | UI flow | Complete receipt, ES |
| `scenario-normal-pt.png` | 1280×800 light | UI flow | Complete receipt, PT |
| `scenario-normal-es-320.png` | 320×640 light | UI flow | Complete receipt, ES, phone |
| `scenario-ambiguous-es.png` | 1280×800 light | UI flow | Two candidates, refusal without a choice, ES |
| `scenario-ambiguous-pt.png` | 1280×800 light | UI flow | Same, PT |
| `scenario-handoff-es.png` | 1280×800 light | UI flow | Incomplete handoff receipt, ES |
| `scenario-handoff-pt.png` | 1280×800 light | UI flow | Incomplete handoff receipt, PT |
| `scenario-handoff-es-320.png` | 320×640 light | UI flow | Incomplete handoff receipt, phone |
| `scenario-agent-handoff-es.png` | 1280×1000 light | UI flow | Agent detail of an incomplete handoff, history and open questions |
| `scenario-unsupported-en.png` | 1280×800 light | UI flow | EN interface asking for the ES/PT report language |
| `scenario-unauthorized-es.png` | 1280×800 light | Interception (request rewritten, real 404) | Another customer's charge not found |
| `scenario-expired-auto-es.png` | 1280×800 light | UI flow (cookies cleared) | Automatic renewal then receipt |
| `scenario-expired-manual-es.png` | 1280×800 light | Interception (401, 401) | Expired-session text, pending panel, Renew |
| `scenario-toolfail-es.png` | 1280×800 light | Interception (503) | Frozen retry and pending panel, ES |
| `scenario-toolfail-pt.png` | 1280×800 light | Interception (503) | Same, PT |
| `scenario-mixed-es-pt.png` | 1280×800 light | UI flow | PT statement in an ES session, accepted |
| `scenario-mixed-en-pt.png` | 1280×800 light | UI flow | EN interface, PT chosen, accepted |
| `scenario-agent-mixed-pt.png` | 1280×1000 light | UI flow | Agent detail with `language: pt`, `lang="pt"` |
| `fix-a-before-login-1280-light.png` | 1280×720 light | Before | Promise text over the disc |
| `fix-a-after-login-1280-light.png` | 1280×720 light | After | Promise text clear of the disc |
| `fix-a-before-login-1440-dark.png` | 1440×900 dark | Before | Line 1 over the disc |
| `fix-a-after-login-1440-dark.png` | 1440×900 dark | After | Clear |
| `fix-f-before-intro-30s.png` | 1440×900 dark | Before | Still cycling at 30 s (infinite loop) |
| `fix-f-after-intro-14s.png` | 1440×900 dark | After | Current word static after the single pass |
| `fix-2411-before-focus-hidden-1024.png` | 1024×768 dark | Before | Focus on "Reportar un cargo", fully behind the chat panel |

## Direct client (2026-10-02)

The client changed after this audit was written (plan `Docs/superpowers/plans/2026-10-01-factored-feedback-response.md`, Tasks 1–3): the intro step, its word animation, the travelling disc and both timers were removed, so the first render is the sign-in screen; the home shows the greeting, the charges table with one Report button per row and the report panel, which opens only from a row and carries its own close button at every width. The findings above are kept as the record of the earlier client. What they mean now:

- Finding 2 (2.2.2), finding 16 and the intro notes in finding 12 are moot: nothing animates and no control is hidden for a time.
- Finding 5 (2.4.11): the inert behaviour at 1180 px and below is unchanged. The "toggle" it mentions no longer exists; the panel's own close button closes it at every width, and closing returns focus to the row button that opened the panel, or to the page heading when nothing did.
- Advisories: the sign-in screen has one `h1` (the greeting) and "¿Quién eres?" is an `h2`; the 6.8 s timer that had to match the stylesheet is gone. The missing `main` landmarks on sign-in and `/agent` remain open.

### Contrast, 2026-10-02

Measured from the tokens in `front-end/src/styles.css` with `Docs/Evidence/contrast_ratios.py` (re-run it after any token change). The hero card, the explainer card and its chips were removed in Task 2, which also removed the one layering failure the feedback described: `es` / `demo-ana` / `2 cargos` chips sat on the navy explainer card at 1.32:1. No text is de-emphasised by opacity any more (`.products` used `opacity: .85`; it now uses `--ink-muted`, 5.54:1 light and 7.40:1 dark on the page).

### Text on background

| Pair | Light | Dark | Needs | Result |
|---|---|---|---|---|
| body text on page (`--ink` on `--surface`) | 16.90 | 16.76 | 4.5 | pass |
| body text on raised box (`--ink` on `--surface-raised`) | 17.98 | 15.48 | 4.5 | pass |
| muted text on page (`--ink-muted` on `--surface`) | 5.54 | 7.40 | 4.5 | pass |
| muted text on raised box (`--ink-muted` on `--surface-raised`) | 5.90 | 6.83 | 4.5 | pass |
| muted chip text on sunken chip (`--ink-muted` on `--surface-sunken`) | 5.20 | 7.59 | 4.5 | pass |
| link / accent text on page (`--accent` on `--surface`) | 5.71 | 7.85 | 4.5 | pass |
| link / accent text on raised box (`--accent` on `--surface-raised`) | 6.08 | 7.25 | 4.5 | pass |
| ok chip text (`--ok` on `--ok-soft`) | 4.58 | 6.98 | 4.5 | pass |
| warn chip text (`--warn` on `--warn-soft`) | 5.06 | 7.81 | 4.5 | pass |
| text on accent-soft (selected row, chat bubble) (`--ink` on `--accent-soft`) | 15.33 | 13.03 | 4.5 | pass |
| muted text on accent-soft (`--ink-muted` on `--accent-soft`) | 5.03 | 5.75 | 4.5 | pass |
| button label on accent button (`--surface` on `--accent`) | 5.71 | 7.85 | 4.5 | pass |

### Adjacent surfaces (non-text)

| Pair | Light | Dark | Needs | Result |
|---|---|---|---|---|
| raised box on page (`--surface-raised` on `--surface`) | 1.06 | 1.08 | 3.0 | FAIL |
| sunken chip on raised box (`--surface-sunken` on `--surface-raised`) | 1.13 | 1.11 | 3.0 | FAIL |
| hairline on page (`--line` on `--surface`) | 1.16 | 1.34 | 3.0 | FAIL |
| strong line (inputs) on page (`--line-strong` on `--surface`) | 3.17 | 4.03 | 3.0 | pass |

Reading the surface rows: card and chip edges against the page do not reach 3:1 in either theme. WCAG 1.4.11 asks that of boundaries needed to identify a control or its state, not of decorative container edges whose content identifies them, so they are recorded, not treated as failures. The input boundary, which does matter, passes in both themes (`--line-strong`, 3.17 light and 4.03 dark).

Screenshots, fictitious seed, 1280×900: `screenshots/direct-client-home-light.png`, `screenshots/direct-client-home-dark.png`.

## Tests run

- `npm --prefix front-end test -- --watch=false --browsers=ChromeHeadless`: 68 of 68 pass. That includes the 3 new specs. The 2 focus specs were checked to fail with their fix removed.
- `npm --prefix front-end run build`, then `node back-end/scripts/prepare-assets.mjs`: build succeeds.
- `npm --prefix back-end test`: all three runs pass (84, 30 and 4 tests), covering the unit tests and the local-D1 integration tests.

## Review follow-ups

Made after the review, in the same PR, with specs written first (each failed before its fix, and failed again when the fix was reverted):

- **Chat panel at wide widths (2.4.11).** It no longer grows over the topbar; see finding 5.
- **Chat as a dialog at narrow widths (4.1.2).** At 1180 px and below, the page behind is inert, so the panel now has `role="dialog"` and `aria-modal="true"` there. At wider widths it stays a plain region. Escape closes it at any width and returns focus to the toggle. Because a modal dialog hides the toggle outside it from assistive technology, the dialog also has its own close button at those widths, for touch and screen-reader users who have no Escape key.
- **Choose step announced (#46 review).** When the choose step takes focus, its fieldset is described by the guide's latest line (`aria-describedby="chat-prompt"`), so a screen-reader user hears that the step changed. A spec also covers reopening the panel on the choose step, where the heading takes focus.
- **Picker count (#41 review).** The visible count still updates on every keystroke. The live region (`role="status"`) now repeats it only once typing has paused for 500 ms, so a screen reader isn't interrupted per key.
- **Agent detail (#38 review).** Each detail request is numbered, and only the latest may change the panel, even for the same protocol. A double click whose first request fails no longer hides the second request's detail, and a failed latest request clears the panel.
- **Code hygiene.** Process labels (`W3`, `W4`, `W5`, `ponytail:`) were replaced with descriptive comments.

`npm --prefix front-end test -- --watch=false --browsers=ChromeHeadless`: 74 of 74 pass. `ng build` succeeds.

