# Factored Feedback Response Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the demo direct enough that a judge understands it without a pitch, remove the slowness and redundancy Factored saw, say plainly where the intelligence lives, and prove the whole pipeline works on new data.

**Architecture:** Delete before adding. The customer client becomes two screens (who you are, your charges) with one way to report a charge; nothing animates and nothing waits on a timer. The Worker, D1 and contracts don't change except where PR #49 already extends the receipt. The pitch and the "new data tomorrow" rehearsal are team work with named owners.

**Tech Stack:** Angular 20 (standalone, signals), the existing `.ar-*` design system in `front-end/src/styles.css`, Cloudflare Worker + D1, Python/DuckDB pipeline, Make. No new dependency.

**Source of the feedback:** Diego (Factored), Slack, 2026-10-01 01:14. Lucas notes he tested the version deployed before migrations 0006/0007 were applied, when deploys from `main` were blocked. The feedback stands regardless.

---

## The feedback, point by point

| # | Diego said | What we observed | Response in this plan |
|---|---|---|---|
| A1 | "I don't really understand the intent." | Three screens before a charge is visible (intro → sign-in → home). The home shows a hero card, an explainer card, two stat tiles, a currency box, a floating toggle and the charges table. Reporting has four entry points. | Tasks 1, 2, 5: two screens, one entry point, purpose stated on the first screen. |
| A2 | "The intelligence is in the backend more than in the demo, it's totally fine. But make sure you highlight it in your pitch." | True: identity, ownership, confirmation and the reference are deterministic in the Worker; the learned extractor runs offline against the checklist baseline (ADR-005/006, both Proposed) and online only behind a switch that is off (#48). | Task 7: one slide and one paragraph that say exactly this. Task 2 keeps "what we checked" (#49) visible on every receipt. |
| A3 | "The app felt a little slow and it got stuck at some points." | The first screen waits on timers: the boot animation runs 2.4 s and the Start button appears at 4.4 s (`styles.css:210`, `customer.page.ts:151-154`). Nothing loads during that time. The deploy he used was also the pre-#33 build. Lucas measured the live API at 0.2–0.5 s per step and about 1.3 s on confirm. | Task 1 removes every timer. Task 4 measures time-to-interactive and records it. |
| A4 | "Some words' color overlap with some other colors, hard to read." | Text-on-background token pairs all pass 4.5:1 in both themes (lowest 4.58, light "aceptada" chip). The failures are layering: the `es` / `demo-ana` / `2 cargos` chips sit on the navy explainer card at 1.32:1, `.products` text runs at 85% opacity, and three coloured cards compete on one screen. | Task 2 removes the layered cards. Task 3 fixes the remaining pairs and records measured ratios for both themes. |
| A5 | "The design of the app could be a little more direct." | As A1. | Tasks 1, 2, 5. |
| B | "Go deep in one or two. Don't try to kill every possible outcome." | We are in one vertical (ADR-002, Accepted). The recent-transactions view and "I recognize it now" are steps of the same journey, not new workflows. | Task 8 says so in the reply. No new vertical is added anywhere in this plan. |
| C | "Can you give me an example for this?" (reply to our question 3: a direct link for a customer who already found the charge) | The per-row **Reportar** button in PR #49 is that example: one click on the charge, confirm, reference; the description step is skipped. | Task 8 answers with the screenshot. |
| D | "If we give you some data tomorrow, what would work? That's the main question to get right." | The path exists (`make pipeline` → Gold cohort → D1 load → deploy guard) but has never been rehearsed end to end as one run, and the cohort load is still gated on Manoella's review. | Task 9: a timed rehearsal from a clean checkout, recorded with counts, plus the list of what would break. |

## Decisions taken (Roberto, 2026-10-01)

- First screen: one screen, no timers. The intro step and its animation are deleted.
- Home: charges only. The hero card, explainer card, stat tiles, "Por moneda" box and floating toggle are removed. One Report button per charge is the single entry point.
- Theme: both themes stay; both get measured.
- Scope: one plan for the whole team, with owners. Roberto executes the front-end tasks.
- Deferred, not built: a "Tus reportes" list under the table. The receipt stays in the panel until "new report" and the sidebar badge shows the count; the PR body says it is deferred.
- The explanation of what the tool is for lives on the first screen, above the identity picker, in three lines. No scroll-to-explain section: it would be one more step between a judge and the tool. If the first screen still reads thin after Task 1, a short scroll section can be added on top without undoing anything here.

## Global constraints

- One online runtime (ADR-003, Proposed); no Worker, D1 or contract change in this plan beyond what #49 already carries. Route handlers never build SQL.
- Identity from the session only; a reference only after read-back; no model call in the live demo (ADR-002). Nothing here touches the extractor, the frozen set or ADR status lines.
- Evidence (amounts, IDs, timestamps) is never translated; source currency and timezone-free source time stay as they are.
- Every string exists in `es`, `pt` and `en` (`lang.service.ts`; the `Strings` type enforces it).
- Accessibility basics are kept or improved: focus moves to the new screen's heading, every control has a name, 320px works, reduced motion is respected (easier now: nothing animates).
- No new dependency. Screenshots use the fictitious seed only; no dataset customer ID in any committed image (a customer ID slipped into #47's screenshots and had to be redacted in `65e8850`).
- Nothing remote, no deploy, no remote migration or data load from this plan's front-end tasks. Lucas owns deploys; the cohort load waits for Manoella's review.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; PR bodies state the tests run.

## Owners and dates

| Date | Owner | Deliverable | Gate |
|---|---|---|---|
| Oct 1 | Lucas | Approve and merge #49 (purpose line, Report button, "what we checked") | Tasks 1–2 stack on it |
| Oct 1–2 | Roberto | Tasks 1–6 in one PR: two-screen client, charges-only home, contrast pass, timing evidence, agent view without the legacy list, docs | Angular, Worker unit, local-D1 and budget suites green; browser check ES and PT at 1280 and 320; screenshots from the fictitious seed |
| Oct 2 | Lucas (Roberto reviews) | Task 7: "where the intelligence lives" slide and SYSTEM_DESIGN paragraph | Says deterministic vs learned vs offline in one breath; claims nothing unmeasured |
| Oct 2 | Lucas | Task 8: reply to Diego on B and C with the screenshot | Posted in the Slack channel |
| Oct 2–3 | Manoella (pipeline), Lucas (D1 and deploy) | Task 9: "new data tomorrow" rehearsal from a clean checkout, recorded | `Docs/Evidence/new-data-rehearsal.md` has the counts, timings and the breakpoints list |
| Oct 3 | Roberto | Task 10: final browser check on the deployed build, screenshots refreshed | ES and PT, three paths, 320px |
| Oct 4 | All | Slides and video on the new client | Oct 5 is buffer only; the brief gives no cutoff time or timezone |

---

## Task 1: One entry screen, no timers

**Branch:** `feat/direct-client`, created from `feat/purpose-report-checks` (PR #49) while #49 is open, or from `main` once it merges. This task deletes the intro that #49 touched, so stacking avoids a conflict.

Line numbers in this plan are from `main` at `ebfb6fd`; on #49's branch everything from the intro down shifts by about two lines. Locate blocks by their `@case` or class name.

**Files:**
- Modify: `front-end/src/app/features/customer/customer.page.html:7-53` (the `intro` and `login` cases)
- Modify: `front-end/src/app/features/customer/customer.page.ts` (`Step`, `booted`, `introDone`, `bootTimer`, `introTimer`, `discClass`, `start`, `skipIntro`, `ngOnInit`, `ngOnDestroy`, `resume`)
- Modify: `front-end/src/styles.css:193-227` (`.stage`, `.disc*`, `.step`, `.intro*`, `@keyframes ar-rise/ar-show/ar-word`, reduced-motion block), `:228-236` (`.login*`)
- Modify: `front-end/src/app/shared/i18n/lang.service.ts` (remove `start`, `skipIntro`, `hello`, `promise`, `promise1-3`, `onlyYours`; keep `greeting`, it is the `<h1>`; add `explain1`, `explain2`, `explain3`)
- Test: `front-end/src/app/features/customer/customer.page.spec.ts`, `customer.page.focus.spec.ts`

**Design of the screen.** `Step` becomes `'login' | 'home'`. The login screen is the first render: a static `<h1>` with the big word (Hola / Olá / Hello, 128px, the existing `.intro-word` type scale, no animation), the one-line purpose (`tagline`), three short lines, then the identity picker and Continue. The three lines, in Spanish (pt and en follow):

- `explain1`: "Eliges el cargo que no reconoces y cuentas qué pasó."
- `explain2`: "Una persona del banco revisa cada reporte."
- `explain3`: "Nada se reembolsa, bloquea ni se decide aquí."

The disc stays only as the sidebar mark on the home screen (`disc--home`); every other disc state and transition goes.

- [ ] **Step 1: Write the failing spec**

Replace the first spec in `customer.page.spec.ts` (`'starts on the intro, moves to sign-in on start, and to the home once charges are loaded'`) with:

```ts
it('opens on sign-in with the purpose and the three explanation lines, then goes home once charges are loaded', async () => {
  const fixture = TestBed.createComponent(CustomerPage);
  const p = fixture.componentInstance;
  await p.ngOnInit();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  expect(p.step()).toBe('login');
  expect(el.querySelector('h1')?.textContent?.trim()).toBe(p.t().greeting);
  expect(el.querySelector('.purpose')?.textContent?.trim()).toBe(p.t().tagline);
  expect([...el.querySelectorAll('.explain li')].map(li => li.textContent?.trim()))
    .toEqual([p.t().explain1, p.t().explain2, p.t().explain3]);
  expect(el.querySelector('.intro')).toBeNull();
  p.identity = 'demo-ana';
  await p.login();
  expect(p.step()).toBe('home');
});
```

Delete the specs `'states the purpose on the first screen and lets the intro be skipped'` (from #49) and any spec that calls `page.start()`; replace `page.start()` calls elsewhere with nothing (the page already starts on login).

- [ ] **Step 2: Run the spec to verify it fails**

Run: `npm --prefix front-end test -- --watch=false --browsers=ChromeHeadless`
Expected: FAIL. `step()` is `'intro'`, `.purpose` and `.explain` are missing.

- [ ] **Step 3: Implement**

In `customer.page.ts`: `export type Step = 'login' | 'home';` `readonly step = signal<Step>('login');` Delete `booted`, `introDone`, `bootTimer`, `introTimer`, `discClass`, `start()`, `skipIntro()`, the two `setTimeout` lines and the two `clearTimeout` lines. In `resume()` drop `this.booted.set(true)`. Keep `focusStepHeading`: it already moves focus to `.step h1` on a step change.

In `customer.page.html`, delete the `@case ('intro')` block and the `<div [class]="discClass()">` at the top. Replace the `login` case's `login-promise` block (`:29-32`) with:

```html
<header class="welcome">
  <h1 tabindex="-1" [attr.lang]="lang.lang()">{{ t().greeting }}</h1>
  <p class="purpose">{{ t().tagline }}</p>
  <ul class="explain">
    <li>{{ t().explain1 }}</li><li>{{ t().explain2 }}</li><li>{{ t().explain3 }}</li>
  </ul>
</header>
```

`whoAreYou` is currently `<h1 class="headline">` (`html:39`); make it an `<h2>` so the screen has one `<h1>` (the greeting), which is what `focusStepHeading` targets.

Put the sidebar mark where `disc--home` was: a plain `<app-mark>` inside the sidebar brand slot (the component already exists: `shared/mark`).

In `styles.css`: delete `.stage`'s `overflow: clip`, all `.disc*` rules, `.step`'s animation, `.intro*`, `@keyframes ar-rise`, `ar-show`, `ar-word`, the reduced-motion intro rules and `.login-promise*`. The same classes recur inside the `@media` blocks at `:288-314` (for example `:293`, `:303`, `:307-314`): `grep -n "disc\|intro\|login-promise" front-end/src/styles.css` and delete every hit, not only the first block. Add:

```css
.welcome { display: flex; flex-direction: column; gap: 12px; padding: 40px 64px 0; }
.welcome h1 { margin: 0; font: 600 96px/104px var(--font-sans); letter-spacing: -0.035em; }
.purpose { margin: 0; font: 500 20px/28px var(--font-sans); }
.explain { margin: 0; padding-left: 20px; font: 400 16px/24px var(--font-sans); color: var(--ink-muted); }
@media (max-width: 720px) { .welcome { padding: 24px 20px 0; } .welcome h1 { font-size: 56px; line-height: 60px; } }
```

In `lang.service.ts`, add `explain1-3` to all three languages and remove the keys the template no longer uses (`start`, `skipIntro`, `hello`, `promise`, `promise1`, `promise2`, `promise3`, `onlyYours`). `greeting` stays (it is the `<h1>`). The `Strings` type will fail compilation on any key left in only one language.

- [ ] **Step 4: Run the whole Angular suite**

Run: `npm --prefix front-end test -- --watch=false --browsers=ChromeHeadless`
Expected: SUCCESS. If `customer.page.focus.spec.ts` refers to the intro, update it: focus lands on the `h1` of the login screen on first render is not required (first render never moves focus); on the login → home change it lands on the home `h1`.

- [ ] **Step 5: Check it in a browser**

Run `make intake-ui-build`, start `npx wrangler dev --local` in `back-end/` with a throwaway `.dev.vars` (`DEMO_ACCESS_USERNAME` / `DEMO_ACCESS_PASSWORD` placeholders) and the fictitious seed, and load `/`. Confirm: no wait, no animation, the picker is usable immediately, the page scrolls at 320px.

- [ ] **Step 6: Commit**

```bash
git add front-end/src
git commit -m "feat: one entry screen, no timers: purpose and three lines above the identity picker"
```

## Task 2: Home shows the charges and nothing else

**Files:**
- Modify: `front-end/src/app/features/customer/customer.page.html:56-175` (sidebar, `home-top`, `stats`, `home-grid` second box, `chat-toggle`)
- Modify: `front-end/src/app/features/customer/customer.page.ts` (`totals`, `formatAmount`, `lastReceipt`, `chatOpen` toggle handling)
- Modify: `front-end/src/styles.css:237-266` (`.home-top`, `.stats`, `.stat*`, `.agent-panel`, second `.box` rules), `customer.page.css` (`.chat-toggle` if defined there)
- Modify: `front-end/src/app/shared/i18n/lang.service.ts` (remove `demoAccount`, `loadedCharges`, `currencies`, `guideBlurb`, `report`, `byCurrency`, `total`, `chatOpen`, `home`, `loaded`. Keep `guideTitle` (panel heading, `html:180`), `chatClose` (narrow close button, `:182`) and `charges` (choose-step legend, `:206`); `openCases` goes in Task 5, where its last use is.)
- Test: `customer.page.spec.ts`

**What stays:** the sidebar (brand mark, "Vista de agente" link with its pending-request guard, the identity block, the sandbox note), the greeting `<h1>` with the context-card first name, the charges table with one **Reportar** button per row (#49), the coverage caption, the `has_more` note, and the report panel (`#intake-chat`), which now opens only from a row. Everything else on the home goes: hero card, "Reporte guiado" card and its chips, both stat tiles, "Por moneda", the floating toggle, and the "Inicio" / "Cargos" nav entries (there is one section now).

- [ ] **Step 1: Write the failing specs**

```ts
it('shows only the greeting, the charges and the report panel; no hero, stats, currency box or floating toggle', async () => {
  const { el } = await home();
  expect(el.querySelector('h1')).not.toBeNull();
  expect(el.querySelector('#cargos')).not.toBeNull();
  for (const gone of ['.ar-card', '.agent-panel', '.stats', '.chat-toggle', '.home-top']) expect(el.querySelector(gone)).withContext(gone).toBeNull(); // the hero is .ar-card (html:85); there is no .hero class
  expect(el.querySelectorAll('.box').length).toBe(1);
  expect(el.querySelectorAll('.report-btn').length).toBe(1);
});

```

Delete the specs that assert the stat tile (`'.ar-count'`, `'.stat .ar-chip-ok'` in `'while a request is pending the agent link is disabled...'`: keep the link assertions and the sidebar badge check, drop the stat assertions), `'formats totals with thin-space grouping...'` and anything that clicks `.chat-toggle` (open the panel through a `.report-btn` click instead).

- [ ] **Step 2: Run to verify they fail**

Expected: FAIL on `.ar-card`/`.stats` present and `.box` count 2.

- [ ] **Step 3: Implement**

Template: delete the `loaded` subtitle under the greeting (`{{ transactions().length }} {{ t().loaded }}`, `html:77`), the `home-top` block (`84-129` on main; about `86-130` on #49), the second `<section class="box">` (`164-171` / `166-173`), the `chat-toggle` button (`175` / `177`), and the `Inicio` / `Cargos` anchors in `.ar-nav`. Locate by class name, not by line.

Component: delete `totals`, `formatAmount` and its export, `lastReceipt`, `initials` if only the hero used it (the sidebar identity block may still use it; check `initialsOf` callers first). `openChat(transactionId)` stays; the panel still closes with Escape through `closeChat()`, which now returns focus to the row's Report button: change `chatToggle` to the button that opened the panel (store `document.activeElement` in `openChat`).

Styles: delete `.home-top`, `.stats`, `.stat`, `.stat-value`, `.agent-panel*`, the hero rules, `.chat-toggle`, including their copies in the `@media` blocks at `styles.css:288-314` (`grep -n "home-top\|\.stats\|\.stat\b\|agent-panel\|chat-toggle" front-end/src/styles.css` and delete every hit). `.home-grid` becomes a single column: `grid-template-columns: minmax(0, 1fr)`.

i18n: remove the unused keys listed above.

- [ ] **Step 4: Run the Angular suite and the build**

Run: `npm --prefix front-end test -- --watch=false --browsers=ChromeHeadless && npm --prefix front-end run build`
Expected: SUCCESS; the initial bundle shrinks (was 402 kB).

- [ ] **Step 5: Browser check at 1280 and 320**

The table is the first thing below the greeting. One Report button per row. The panel opens from a row, Escape returns focus to that row's button. The receipt stays in the panel until "new report"; the sidebar badge shows the count.

- [ ] **Step 6: Commit**

```bash
git add front-end/src
git commit -m "feat: home shows the charges only; one Report button per row"
```

## Task 3: Contrast and layering pass, measured

**Files:**
- Modify: `front-end/src/app/features/customer/customer.page.css:18` (`.products` opacity)
- Modify: `front-end/src/styles.css` (only where a measured pair fails)
- Modify: `Docs/Evidence/accessibility-audit.md` (new section "Contrast, 2026-10-02")

- [ ] **Step 1: Remove opacity-based de-emphasis**

`.products { opacity: .85 }` → delete the opacity; use `color: var(--ink-muted)` (5.54:1 light, 7.4:1 dark). Grep for any other `opacity: .` on text: `grep -n "opacity: \?0\?\.[0-9]" front-end/src/styles.css front-end/src/app/**/*.css`. The only other hit should be `.disc--login`, which Task 1 deleted.

- [ ] **Step 2: Measure every text/background pair on both themes**

Compute WCAG ratios from the tokens in `styles.css:1-66` with a 15-line Python script (relative luminance per WCAG 2.x, `(L1+0.05)/(L2+0.05)`); commit it as `Docs/Evidence/contrast_ratios.py` so the table can be regenerated. Record the table in the audit under "Contrast, 2026-10-02": pair, light ratio, dark ratio, pass/fail at 4.5:1 (3:1 for ≥24px text). Include the adjacent-surface pairs (`.ar-chip` on `.box`, `.ar-chip-ok` on `.ar-panel-ok`) at the 3:1 non-text threshold.

- [ ] **Step 3: Fix any failure in the token, not per element**

If a pair fails, adjust the token in `:root` or the dark block so both themes pass, and re-run the measurement. Don't add per-element colour overrides.

- [ ] **Step 4: Two screenshots**

Capture the home at 1280 in light and in dark (`Emulation.setEmulatedMedia` with `prefers-color-scheme`), fictitious seed, into `Docs/Evidence/screenshots/direct-client-home-{light,dark}.png`. Task 10 covers 320px and the other screens. Look at both images for a dataset customer ID before committing.

- [ ] **Step 5: Commit**

```bash
git add front-end/src Docs/Evidence
git commit -m "fix: contrast pass on both themes; text no longer de-emphasized by opacity"
```

## Task 4: Nothing waits, nothing looks stuck

**Files:**
- Modify: `front-end/src/app/features/customer/customer.page.html` (loading line while identities load)

- [ ] **Step 1: Failing spec: the picker shows a loading state until identities arrive**

Add `Identity` to the spec's import from `../../shared/models/intake.model`.

```ts
it('shows a loading line until the identities arrive, then the picker', async () => {
  let resolve!: (v: Identity[]) => void;
  service.identities.and.returnValue(new Promise(r => { resolve = r; }));
  const fixture = TestBed.createComponent(CustomerPage);
  const init = fixture.componentInstance.ngOnInit();
  fixture.detectChanges();
  expect((fixture.nativeElement as HTMLElement).querySelector('[role="status"]')?.textContent).toContain(fixture.componentInstance.t().working);
  resolve([{ customer_id: 'demo-ana', display_name: 'Ana (demo)' }]);
  await init; fixture.detectChanges();
  expect((fixture.nativeElement as HTMLElement).querySelector('[role="status"]')).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**, then implement: an `identitiesLoading` signal set around `service.identities()` in `ngOnInit`, and `@if (identitiesLoading()) { <p class="status-line" role="status">{{ t().working }}</p> }` above the picker. The `busy()` "Procesando…" line already covers every later call.

- [ ] **Step 3: Measure once, record in the PR body**

In the browser check, read `performance.getEntriesByType('navigation')[0].domInteractive` and the time from load to the picker being enabled, three runs on local `wrangler dev`. Put the three numbers in the PR body with the commit hash and "local". Target: picker usable under 1 s; `grep -n setTimeout front-end/src/app` returns nothing but focus helpers. No separate timing document.

- [ ] **Step 4: Commit**

```bash
git add front-end/src
git commit -m "feat: loading state while identities load"
```

## Task 5: Agent view without the legacy list

**Files:**
- Modify: `front-end/src/app/features/agent/agent.page.html:107-128` (remove the "Casos abiertos" section), `:12` (`agentIntro` wording)
- Modify: `front-end/src/app/features/agent/agent.page.ts`, `agent.service.ts` (remove `cases()` and the `/agent/cases` call)
- Modify: `front-end/src/app/shared/i18n/lang.service.ts` (`agentIntro`; remove `openCases`, `noCases` and `acceptedAt`. Keep `customer`: it is the link back to the customer view at `agent.page.html:5`.)
- Test: `agent.page.spec.ts`

The intake queue (`/agent/intakes`) is the authoritative list; the legacy `/agent/cases` list shows the same complete cases a second time and can show unacknowledged ones (back-end README). The Worker route stays untouched (Lucas's area; it is still exercised by back-end tests).

- [ ] **Step 1: Failing spec**

```ts
it('shows the intake queue only before a detail is opened; no legacy case list', async () => {
  await load();
  expect(el().querySelectorAll('section.box').length).toBe(1);
});
```

(Use the spec file's existing load helper. Remove `'cases'` from the `createSpyObj` method list in the same step; a `toBeUndefined()` check on `service.cases` would not compile once the property is gone from `AgentService`.)

- [ ] **Step 2: Run to verify it fails**, then remove the section, the `cases` signal and service method, and the spy entry in the spec's `createSpyObj` list. Update `agentIntro` to describe the one list ("Acceso de agente simulado y separado. Muestra los 50 reportes guiados más recientes.").

- [ ] **Step 3: Run the Angular suite**, then commit:

```bash
git add front-end/src
git commit -m "feat: agent view shows the intake queue only; legacy case list removed"
```

## Task 6: Docs follow the client

**Files:**
- Modify: `front-end/README.md` (screens and flow)
- Modify: `README.md` (demo walkthrough, if it describes the intro or the cards)
- Modify: `Docs/Plans/intake-roadmap.md` (the "English UI" / client rows, already corrected once in #40; update the screen list)
- Modify: `Docs/Evidence/accessibility-audit.md` (findings that referred to the intro loop (2.2.2) and the chat launcher are now moot; say so rather than deleting them)

- [ ] **Step 1:** Fix only actual hits; don't rewrite sections. Grep for the words that no longer exist: `grep -rn -E "intro|Comenzar|Reporte guiado|Por moneda|chat-toggle|Casos abiertos" README.md front-end/README.md Docs/Plans Docs/Evidence/accessibility-audit.md` and fix each hit.
- [ ] **Step 2:** `git diff --check`, then commit: `docs: client docs follow the two-screen client`.
- [ ] **Step 3: Open the PR** from `feat/direct-client` (base: #49's branch if still open, else `main`). Body: the table above (feedback → change), tests run with counts, screenshot links, and "Not in this PR: the merchant column still wraps long names mid-word on the home table; separate fix." Lucas approves (PRs from Roberto's account can't be self-approved).

## Task 7: The pitch says where the intelligence lives (Lucas, Roberto reviews)

**Files:**
- Modify: `SYSTEM_DESIGN.md` "What we built" (`:44`) and "How it works" (`:69`)
- Create: one slide in the deck (Oct 4 deliverable), working title "Where the intelligence lives"

- [ ] **Step 1:** Add one paragraph to "What we built" that a judge can repeat after reading once. Draft:

> The demo you click is deliberately deterministic. The Worker decides who you are (session), which charges you may see (ownership), when a report exists (your confirmation) and when you get a reference (after the row is read back). The learned part is a narrow extractor that turns a customer's message into facts; it is evaluated offline against the rules-only checklist on a frozen Spanish/Portuguese set, and its result is published whether it wins or loses. Online it sits behind a switch that is off until the frozen comparison and ADR-006 say otherwise. So the intelligence is in the backend: in what the system refuses to guess.

- [ ] **Step 2:** The slide carries the same message in five lines, plus the measured numbers that exist (checklist 22/24 on the evaluation split, 0 unsafe; extractor dev 16/18; p95 3.58 s all-180, trigger fired). No number without a source line.
- [ ] **Step 3:** Roberto reviews for claims vs evidence; nothing about production gains, nothing about the frozen set before it has run.

## Task 8: Reply to Diego on B and C (Lucas)

- [ ] **Step 1 (C):** After #49 merges and the deploy is green, take one screenshot of the home with the per-row **Reportar** button and one of the receipt with "Lo que verificamos", fictitious seed, light theme. Reply in the channel: "Example for question 3: when a customer already knows the charge, they press Reportar on that row, confirm it, and get the reference. The description step is skipped. The receipt shows what was checked." Attach both.
- [ ] **Step 2 (B):** In the same message: "We stay in one vertical: unrecognized-charge intake. The recent-transactions view and the 'I recognize it now' close are steps inside that journey, not new workflows." Link ADR-002.
- [ ] **Step 3 (A, briefly):** "You tested the build from before our cohort migrations; the first screen also waited on an animation. Both are fixed in the deploy of <date>: two screens, no timers, one Report button per charge." Only once Task 6's PR is deployed.

## Task 9: "New data tomorrow" rehearsal (Manoella pipeline, Lucas D1 and deploy)

**Files:**
- Create: `Docs/Plans/new-data-rehearsal.md` (the runbook: exact commands, in order, with the expected output of each)
- Create: `Docs/Evidence/new-data-rehearsal.md` (what happened: counts, timings, breakpoints)

The question is Diego's D. The answer is a recorded run, not a description.

- [ ] **Step 1: Clean checkout.** `git clone` into a fresh directory, `make setup`, `make intake-setup`. Record the time.
- [ ] **Step 2: Simulate "tomorrow".** Pick a business date not yet in local Bronze (or re-run the last partition date with `make bronze` incremental; the watermark table decides). Run `make pipeline` (Bronze incremental → Silver full rebuild → Quality). Expected: the printed `quality_results.json` has `"ready": true` and `"errors": 0` in its metadata; record the warnings and the run's path for Step 3. Time each stage (the Makefile prints per-table progress; note wall-clock).
- [ ] **Step 3: Gold cohort as of the new date.** The Makefile default `COHORT_QUALITY` points at an old run (`Makefile:127`, `data/full_local/quality_runs/pr23-check/...`); a new-data rehearsal must pass the run from Step 2: `make intake-cohort-slice COHORT_AS_OF=<date> COHORT_DB=<path to the DuckDB used in Step 2> COHORT_QUALITY=<Step 2's quality_results.json>`. Expected: parts and manifest written atomically; record customers per country, purchases and expected writes, and whether it fits one free-plan day (the current cohort is one part of 20,620 expected writes, per PR #33's description).
- [ ] **Step 4: Local load and UI check.** `make intake-cohort-seed-local` (migrations, then `run_cohort load --target local` per part). Expected: a part whose version is already in `seed_loads` is skipped. Start `wrangler dev --local`; the picker lists the new cohort with countries; sign in as one, see purchases, report one, get a reference. Record the counts shown.
- [ ] **Step 5: Remote (Lucas, after Manoella's cohort review).** `npx wrangler d1 migrations apply arabica-intake-demo --remote` (no-op if none new); `run_cohort load --target remote` per part; `predeploy` green; Workers Build deploys `main`. Record `rows_written` vs estimate.
- [ ] **Step 6: Write the breakpoints list** in the evidence file, honestly:
  - Quality blocks on any Bronze primary-key duplicate (by design; #43 note). New data with re-delivered rows stops the run until adjudicated.
  - DF-004: the partition rolls over at 06:00 stored time, so "tomorrow's" partition carries today's late events; business-date filters, not `process_date`, select the day.
  - Free-plan D1 write quota bounds one cohort load per day; a bigger cohort needs parts across days or Workers Paid.
  - The cohort load waits for a human review of the manifest; this is a gate, not a bug.
  - The frozen evaluation set is independent of new data and is not re-run.
  - Anything that actually failed during the rehearsal, with the fix or the open item.
- [ ] **Step 7: Commit both files** in a docs PR: `docs: new-data rehearsal runbook and recorded run`.

## Task 10: Final check on the deployed build (Roberto)

- [ ] **Step 1:** On the deployed URL, in ES and PT, at 1280 and 320: sign in, report a charge (complete), report without finding the charge (incomplete), and open the agent view detail. Confirm the reference appears only after confirm, "Lo que verificamos" is present, and nothing waits.
- [ ] **Step 2:** Refresh the scenario screenshots that changed (`Docs/Evidence/screenshots/scenario-*.png`) from the fictitious identities only; check every image for a dataset ID before committing.
- [ ] **Step 3:** Commit: `docs: refresh scenario screenshots on the direct client`.

---

## Completion checklist

- [ ] #49 merged; `feat/direct-client` PR merged and deployed; Lucas approved both.
- [ ] A visitor sees the purpose and the picker with no wait; two screens total; one Report button per charge; no hero, explainer, stats, currency box or floating toggle; agent view has one list.
- [ ] Measured contrast table for both themes in the audit; no text de-emphasized by opacity.
- [ ] Local time-to-usable-picker in the PR body; no `setTimeout` outside focus helpers.
- [ ] SYSTEM_DESIGN paragraph and slide say deterministic / learned / offline in one breath, with sourced numbers only.
- [ ] Diego has the example (C), the one-vertical answer (B) and the "fixed in deploy of <date>" note (A).
- [ ] `Docs/Evidence/new-data-rehearsal.md` records a full run with counts, timings and the breakpoints list.
- [ ] Scenario screenshots refreshed, fictitious data only.
