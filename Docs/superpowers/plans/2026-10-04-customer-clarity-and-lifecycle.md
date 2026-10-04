# Customer clarity, guided tour and report lifecycle implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. If executed by agents, follow AGENTS.md: one coder per task, sequentially, then spec and code-quality QA.

**Status:** Execution approved by Roberto on 2026-10-04; in progress. Task 0 persistence gate is being verified on current main before the remaining tasks. Deployment remains a separate human-authorized action.

**Goal:** A customer can identify/report a charge, understand who acts next, and follow a report through a human response and explained closure, with an optional guided introduction.

**Architecture:** Reuse Angular's customer/agent pages and the single Worker/D1 service. Add a small guided-tour component, explicit suggestion feedback, bounded report refresh, and a stored closing explanation. Keep model extraction, deterministic matching and human review separate.

**Tech stack:** Angular 20, TypeScript, CSS, Worker JavaScript, D1; Node 22+. No new product dependency, model, runtime, push service or tour library.

**Spec:** The product design in this document. Evidence: current checkout `5f72b11`; ADR-002, ADR-004, ADR-012 amendment 1, ADR-015, and the customer/agent code listed below. Recheck these files against main before implementation.

## Global constraints

- Session-derived identity and customer isolation remain mandatory. SQL belongs in `back-end/src/store/d1.js`.
- A reference appears only after durable read-back. A finished review is not a refund, fraud decision or proof that the problem was resolved.
- Every customer-facing change ships in Spanish, Portuguese and English. ES/PT demonstrate all required challenge paths.
- No model prompt, matching policy, evaluation label or AI deployment switch changes in this plan. V1 results do not establish V2 accuracy.
- Customer statements, messages and closing explanations never enter logs or event payloads.
- Additive migrations only; apply locally for tests. The existing deploy applies them remotely after human approval. No agent deploy, merge, tag or remote migration.
- Preserve unrelated working files, including `Docs/Plans/video-scaletta.md`.
- No automatic fake reviewer, timed auto-closure or fabricated success banner. The demo uses real app actions on synthetic records.

## Product design

### Promise and navigation

Use one vocabulary: **cargo** for the transaction, **reporte** for the customer's request, **revisión** for the person's work. Do not label every problem as an unrecognized purchase: duplicate amounts, cancelled purchases and subscriptions already have separate reasons.

Proposed Spanish opening:

> **¿Hay un problema con uno de tus cargos?**
> Te ayudamos a identificarlo, reportarlo y seguir su revisión.
> **Revisar mis cargos**

Login support copy: “Encuentra el cargo. Cuéntanos el problema. Sigue la revisión desde aquí.” Replace “¿Quién eres?” with “Entra para revisar tus cargos”. Keep a short visible disclosure: “Demostración con datos sintéticos. No realiza reembolsos ni bloquea tarjetas.” Remove “Tranquilo, nos encargamos” and “Nadie mueve tu dinero”.

Home has clearly named **Tus cargos**, **Tus reportes**, and **Ayuda** entry points. Show the reports section even when empty: “Aquí verás el estado y los mensajes de tus reportes.” Help must not silently create a report: expose “Cómo usar ArabicaAI”, “Tengo un problema con un cargo” and the existing FAQs as explicit choices.

Audit active strings in the opening, sign-in, reason selection, receipt, reports, messages, agent actions and emails. Remove customer-facing implementation language such as idempotency keys, source provenance and Cognito. Retain detailed evidence in operator views/docs. Keep urgent lost-card advice at the point it is needed.

### Guided tour with a dimmed/blurred background

After the first successful sign-in and initial data load, show a small welcome dialog: “Conoce ArabicaAI en cuatro pasos”, with **Mostrarme cómo** and **Ahora no**. Do not delay sign-in or obscure an urgent bank alert: if an alert is present, offer the tour through Help instead.

Once started, dim and lightly blur everything except the highlighted section. A readable instruction card identifies the section and its purpose. Four steps:

| Step | Target | Spanish instruction |
|---|---|---|
| 1 | Tus cargos | “Revisa el comercio, la fecha y el monto de tus cargos.” |
| 2 | Reportar entry | “Si hay un problema, selecciona Reportar. Te pediremos los detalles y tu confirmación antes de enviarlo.” |
| 3 | Tus reportes | “Consulta el estado de cada reporte y abre sus mensajes para leer la respuesta del equipo.” |
| 4 | Ayuda | “Si no encuentras un cargo o necesitas orientación, empieza aquí. También puedes repetir este recorrido.” |

Each card has **Anterior**, **Siguiente**, **Omitir recorrido**, and “Paso X de 4”; last step uses **Listo**. Finishing returns focus to the highlighted primary action; skipping restores the launch control when it still exists. The tour never submits, marks an alert answered, or changes a report.

Use a native dialog for the instruction card and CSS for the backdrop/spotlight. Background controls remain inert; instructions are usable by keyboard and screen reader without interacting with the highlighted element. Escape exits. Prefer reduced motion, support 320px width and 200% zoom, maintain text contrast without depending on blur. Recompute target bounds on scroll/resize; close safely on identity change or page destruction. No raised interactive background element above the modal.

Store only `arabica.customer-tour.v1 = dismissed|complete` in localStorage, scoped to this browser, with no email/customer ID. Storage errors must not block entry; suppress repeated offers for the current page session. Replay is always available from Help. Do not reset the preference on sign-out or administrator act-as.

When no charges exist, replace step 2 with the Help entry and explain “No encuentro el cargo”; never highlight a missing row. The reports empty state gives step 3 a stable target. Contextual advice for suggestions and messages belongs in those real states, not extra tour steps filled with fake data.

### Missing-charge assistance

The receipt remains immediate. After it, show a truthful state:

- Pending: “Tu reporte ya está guardado. Estamos buscando posibles coincidencias.”
- Candidates: “Estos cargos podrían coincidir. Confirma uno solo si es el que quieres reportar.”
- No clear match: “No encontramos una coincidencia clara. El equipo continuará la revisión con lo que nos contaste.”
- Unavailable/request failure: “No pudimos completar la búsqueda automática. Tu reporte sigue guardado para revisión.”
- Still pending when the bounded wait ends: “La búsqueda sigue pendiente. Puedes volver a consultar este reporte.” Do not claim completion or cancel the stored run.
- Reviewer already started: “El equipo ya está revisando tu reporte. Puedes enviarle más detalles en Mensajes.”

Keep the existing 15-second, 1.5-second polling window. Opening an incomplete report later retrieves its stored suggestion state again. A customer confirmation stays explicitly separate from bank verification.

The current API collapses failures, disabled runs and no-match outcomes into `status: none`; the UI cannot infer why. Add optional `reason` to `suggestionList`, preserving existing status values: `no_clear_match`, `unavailable`, or `review_started`. Map `no_match`/`ambiguous` to the first, operational/off outcomes to the second, and unanswerable/unanswered suggestions to the third. Return no provider error detail. Legacy responses with no reason use a neutral handoff message, never an invented no-match claim.

### Visible report progress

The receipt's primary next action is **Ver mi reporte**, which closes the intake panel and focuses the saved report. Keep reference, current status and next action together. Requesting an email means “Enviarme este estado por correo”; it does not advance the report or imply that a person has replied.

**Persistent progress banner:** every report card and its open detail show **Recibido → En revisión → Revisión terminada**, with the saved current step highlighted, its reference and the next action. This stays visible after a reload and does not depend on a temporary change notification. Reuse the existing report-progress markup. Use text and accessible current-step semantics, not color alone; no percentage, countdown or estimated completion invented from these three states. On a refresh failure, keep the last confirmed state visibly marked as potentially out of date. Keep each banner attached to its own report when several exist.

While authenticated and visible, refresh the report list every 30 seconds, without overlapping requests. Refresh on return to the tab and via **Actualizar**, coalescing these triggers. Pause while hidden/offline and after 401; clean up on logout, identity change and destruction. Ignore late responses from an old customer. Back off after failures; keep the last successful data with “No pudimos actualizar” and the time last checked. Poll only the currently open message thread, at the same cadence; do not fetch every thread.

Compare successful snapshots for the same customer. A real status change shows “Tu reporte [referencia] pasó a revisión” or “La revisión de tu reporte [referencia] terminó”, with **Ver actualización**. A new agent message in the open thread shows “Tienes una respuesta del equipo”. Do not announce initial data as a new event, repeat unchanged notices, or steal focus. Newly opened threads show stored messages without claiming cross-device unread tracking.

An explanation that can change the customer's next action is more useful than a generic success banner. No model is needed to report a stored status.

### Saved reports and a working email button

**Explicit acceptance requirement from Roberto:** submitted reports must be durably saved, the email button must work, and customers must see their report's progress.

Validate storage before treating UI work as complete. An acknowledged complete, incomplete or technical handoff must remain in D1 and be retrievable by its owner after reload, logout/sign-in and a new browser session. The same retry key must return the original reference without creating a duplicate. A failed write or read-back must never display “guardado”. Browser state is not proof of persistence. Preserve statement, reason, confirmed charge when present, messages and status; no fixture reset may erase another user's activity. The existing list is bounded: a report falling outside the recent list is not deleted. Verify retention through a scoped store read and expose the existing “more reports” notice honestly; do not promise unlimited history navigation in this phase.

Keep **Enviarme este estado por correo** on each saved report, with its reference in the accessible label. Show **Solicitando correo…** during the request and prevent duplicate clicks. HTTP 202 means queued: show “Solicitamos un correo con el estado de este reporte”, not “Correo entregado”. The email must contain the requested report reference, its status at request time, the report language, and a valid app link. It must never include another report's details or the customer's statement.

Preserve the existing recipient policy: a normal customer receives their own update; an administrator acting as another customer receives the requested update at the administrator's address. Explain that distinction in the admin view. Keep the existing server-side five-minute cooldown for queued/SES-accepted updates and ten-second retry eligibility for failed/skipped sends. Honor `Retry-After` in the UI, distinguish missing email from service/network failure, and keep the report readable when email fails. Queueing, SES acceptance and inbox delivery are separate evidence checkpoints; a passing mock test establishes none of the latter two.

During an authorized deployed rehearsal, request a status email only to the user's own test inbox, verify the outbox result and SES acceptance, then obtain inbox receipt evidence from the user or an authorized inbox read. Do not claim delivery if only provider acceptance can be verified. If production access is unavailable, record that specific blocker and leave live delivery verification pending.

### Explained closure and complete demonstration

Keep `received → in_review → closed`. Require a closing explanation on new closures; do not introduce a “resolved” state. In the reviewer UI, label the field “Explica qué se revisó y qué debe hacer el cliente”, and the action **Enviar explicación y terminar revisión**.

Proposal for the API: `POST /agent/intake-status` keeps `{protocol,status}` for `in_review`; for `closed`, require `closing_note` of 1–2000 Unicode code points after trimming. Store it in a nullable `intake_handoffs.closing_note` column through the next unused additive migration. A new close writes note, status, history and existing notification outbox atomically. Replaying the same close/note returns the stored result; a different note after closure conflicts. Never store a note when the transition loses a concurrent race. Existing closed reports remain valid with null: “Esta revisión anterior no tiene una explicación registrada.”

Expose the stored note in owned report responses and the approved agent detail; render as plain text, never HTML. Show **Todavía necesito ayuda** using the existing linked follow-up flow. Existing closed messages remain read-only. Keep the closing email generic, pointing to the app for the explanation; do not send report text through email or introduce a new template type.

Demonstrate with a customer browser session and a separate authorized reviewer session: submit, receive suggestions when eligible, confirm/reject, open reviewer detail, send a response, advance to review, close with an explanation, return to customer view and observe the actual update. Explain that a teammate operates the reviewer role. No claim of bank investigation or financial remediation.

## Delivery tasks

### Task 0 — Prove report persistence

**Files:** `back-end/test/integration/live-flow.test.js`, relevant existing adversarial/failure tests, customer page/service specs; modify intake routes/store only if a failing check exposes a persistence defect.

**Interfaces:** Existing start, confirm, handoff and owned report reads. Preserve receipts, idempotency keys, ownership and failure semantics.

- [ ] Add or reuse local-D1 checks for complete, incomplete and technical handoffs, a fresh session reading the original reference, concurrent retries yielding one report, and write/read-back failures yielding no success receipt.
- [ ] Cover UI reload and same-owner sign-out/sign-in, with report details and progress restored from the API. A different owner sees none of the report.
- [ ] Check report-list truncation separately from storage loss; inspect only the scoped test records. Do not add a second persistence system or store statements in localStorage.
- [ ] Run the existing integration suite and affected Angular tests; document results before proceeding. Fix only demonstrated defects, with the required API adversarial/contract/budget coverage.

### Task 1 — Copy and clear entry points

**Files:** `front-end/src/app/shared/i18n/lang.service.ts`; customer page `.ts`, `.html`, `.css`; customer page/focus specs; `back-end/src/notify/templates.js` and `back-end/test/unit/notify.test.js` for aligned email wording.

**Interfaces:** Reuse current routes and receipt/report fields. Give stable section IDs to charges, report entry, reports and Help for Task 2. Help choices launch existing functions explicitly; no backend change.

- [ ] Apply the product copy above in ES/PT/EN; inventory active strings rather than translating unused keys blindly.
- [ ] Add the reports empty state, explicit Help choices and receipt-to-report navigation; preserve focus and pending-request guards.
- [ ] Extend existing navigation/focus checks for receipt navigation and Help without automatic report creation. Run Angular specs and notification unit tests.
- [ ] Review the customer flow in all three languages and commit only this task's changes, stating checks run.

### Task 2 — Optional guided tour

**Files:** create `front-end/src/app/shared/guided-tour/guided-tour.component.ts`, `.html`, `.css`, `.spec.ts`; modify customer page and language dictionary/specs.

**Interfaces:** Component consumes ordered `{targetId,title,body}` steps and emits `finished` or `skipped`; the customer page owns eligibility and the browser preference. No customer data enters storage.

- [ ] Write checks for first eligible sign-in, skip, replay, completion persistence, unavailable storage and no automatic repeat after act-as.
- [ ] Implement the four-step tour with native dialog, stable targets, no transaction mutations and no external dependency.
- [ ] Verify missing charges, missing targets, urgent alert deferral, Escape, Tab containment, focus restoration, language changes, resize and reduced motion.
- [ ] Run Angular specs/build; manually inspect desktop, 320px and 200% zoom; commit with checks.

### Task 3 — Explicit suggestion outcomes and revisiting

**Files:** customer page/service/model and specs; `front-end/contracts/intake-api.schema.json`; `back-end/src/modules/intake/routes.js`; `back-end/src/store/d1.js` only if the existing read lacks required state; `back-end/test/integration/suggestions.test.js` and contract/budget coverage.

**Interfaces:** Add the optional `SuggestionList.reason` enum defined above. Preserve model/matcher behavior and the existing suggestion choice contract.

- [ ] Add failing cases for no match versus provider failure/off, pending beyond the UI deadline, review already started and reopening stored suggestions.
- [ ] Map recorded outcomes to the public reason; display the specified states and reuse the suggestion panel when reopening a report.
- [ ] Preserve first-answer semantics and late-response identity guards; test a reviewer opening the report during customer confirmation.
- [ ] Run relevant Angular/Worker tests and the full API adversarial/contract/budget checks before review; commit with results.

### Task 4 — Refresh and evidence-based update banners

**Files:** customer page `.ts`, `.html`, `.css`, service if needed, existing page/service/focus specs; `Docs/ADRs/ADR-004-intake-capacity-and-cost.md` only for the measured request-rate analysis.

**Interfaces:** Existing reports and message endpoints. Keep one timer and one outstanding request per resource, customer generation guards and in-memory snapshot comparison. No push infrastructure or new database state.

- [ ] Add fake-timer checks for the 30-second cadence, focus/manual-trigger coalescing, hidden/offline tabs, 401, cleanup and stale responses after sign-out/act-as.
- [ ] Implement refresh, last-checked/error state, the persistent per-report progress banner, status-change notices and polling of only the open message thread.
- [ ] Verify all three saved states render correctly on initial load and reload, several reports retain independent states, and the banner stays visible after a transient notice is dismissed.
- [ ] Test no initial-load or repeated announcements, preservation of typed messages and focus, and fallback manual refresh after failure. Backoff doubles to at most 120 seconds and resets on success.
- [ ] Measure D1 cost and request rate with suggestions and multiple tabs. Two periodic resources imply up to four requests/minute per active tab, before actions; compare against the shared 60/minute IP limit. Do not raise limits by default.
- [ ] Run Angular specs, existing endpoint budget tests and build; commit with checks.

### Task 4a — Verify and finish the report email action

**Files:** customer page/service/model and specs; `front-end/src/app/core/http/api.service.ts` and its specs for bounded `Retry-After` handling; language dictionary; `back-end/test/integration/notify.test.js`, `back-end/test/unit/notify.test.js`; intake routes, notification dispatch/templates and D1 store only where tests identify a defect.

**Interfaces:** Preserve `POST /reports/update {protocol}` returning `202 {queued:true}`. Extend `ApiError` with optional validated `retryAfterSeconds` for numeric `Retry-After`; never expose arbitrary response headers or internal error text. Refresh button state from the server response rather than guessing that an email arrived.

- [ ] Cover the button's loading, queued, missing-email, cooldown and network/service-error states; retain focus and allow retry when eligible. Malformed or absent `Retry-After` must not create a permanent lock.
- [ ] Verify repeated/concurrent clicks enqueue one update, the wrong customer's reference is refused, and act-as sends only to the admin's notification target. Scope pending UI state to the customer generation so a late response cannot affect another signed-in identity.
- [ ] Check correct reference, request-time status, language and app link for each report status; verify failed/skipped dispatch remains auditable and retryable under the existing policy. Missing SES settings must not be treated as delivered.
- [ ] Run Angular specs plus Worker notification/integration/contract/budget checks. Record live email verification separately in Task 6; commit with exact checks.

### Task 5 — Closing explanation

**Files:** next unused migration under `back-end/migrations/`; `back-end/src/store/d1.js`; `back-end/src/modules/agent/routes.js`; customer report serializer if needed; `front-end/contracts/intake-api.schema.json`; shared model; agent page/service and specs; customer page and language dictionary; integration agent/messages/budget tests; ADR-015 and API docs.

**Interfaces:** Add `closing_note: string|null` to report/detail responses; close request requires `closing_note`, review-start request remains unchanged. The note is immutable once closed.

- [ ] Record the agreed closure contract in ADR-015 before code. Add local-D1 tests for note validation, atomic write/read-back, same-note replay, different-note conflict and two reviewers racing.
- [ ] Add the nullable column, implement transition and serializers, and keep all SQL in the store. Preserve legacy closed records and protect customer ownership.
- [ ] Add reviewer input and customer explanation display; keep linked follow-up and existing notification behavior.
- [ ] Verify expired/forged/swapped sessions, hostile text, Unicode limits, no statement leakage in logs, API contracts and D1 ceilings. Run the complete intake suite before review.
- [ ] Commit with tests; document old reviewer clients' missing-note validation response and deploy the client/API together through the existing pipeline.

### Task 6 — Rehearsal and evidence

**Files:** `Docs/Plans/intake-demo.md`, `Docs/deliverables/EVALUATION.md`, and dated aggregate-only evidence under `Docs/Evidence/`.

- [ ] Rehearse an identified-charge report, missing-charge match, no-match/failure fallback, reviewer response, explained closure and “Todavía necesito ayuda” in ES/PT; smoke-check English.
- [ ] Ask at least three fresh testers to find a charge, create a report and find the latest response without coaching. Record task completion, wrong turns, help needed and whether they can explain who acts next. Treat this as formative usability evidence, not a population rate or causal result.
- [ ] Check customer isolation, tour accessibility and tab-refresh behavior with two separate signed-in browser sessions; do not reset shared demo activity for rehearsal.
- [ ] Reload and sign back in to recover each saved test report and its progress banner. Request one authorized status email to the user's test inbox; record queued, provider-accepted and inbox-received evidence separately, or the exact unavailable checkpoint. Verify the app link returns to sign-in/current owned reports without leaking a session token.
- [ ] Run `make intake-test` and `python3 scripts/check_doc_links.py`; record exact results and any untested deployed behavior.
- [ ] Update the demo runbook to identify the human reviewer role, recorded state changes, AI boundaries and remaining limitations. Do not reuse authored rehearsal cases as new held-out evaluation.

## Review focus

1. Shared browser and administrator act-as: no report/banner from a previous identity and no repeated forced tour (Tasks 2, 4).
2. Empty data and mobile layout: every tour step has a visible target and a usable exit (Tasks 1, 2).
3. Provider failure versus no match: distinct truthful feedback, saved report remains accessible (Task 3).
4. Multiple tabs and poor connectivity: bounded reads, no polling storm, no loss of drafts/focus (Task 4).
5. Concurrent reviewers and legacy closure: one immutable explanation, idempotent notification, honest missing-note state (Task 5).

## Sequence and human review

Execute Task 0 first, then Tasks 1–2, then 3–4 and 4a, then 5–6. Persistence and the report/email checks are completion gates, not optional polish. Keep phases independently reviewable; create phase branches from current main at execution time, following repository PR metadata requirements. Do not execute this proposal from the existing branded-email branch.

**Human steps before merge:** review/approve the product proposal and closing API contract; review ES/PT wording; PR review. No new secrets or dashboard configuration are expected. If new external requirements are discovered, list their exact human steps in the relevant phase PR. Deployment remains a separate authorized action.

**Deferred:** autonomous dispute decisions, automatic fake resolution, AI-written status narration, a tour library, push notifications, durable cross-device unread tracking, financial actions and a new model evaluation. None is required to make this flow understandable.
