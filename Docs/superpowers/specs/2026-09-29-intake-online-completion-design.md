# Worker intake completion, handoffs and gated AI integration

Status: approved by Roberto; fresh agent review completed and three findings resolved. Implementation (2026-09-30): backend plan Tasks 1–5 are implemented and verified locally, Task 5 and the whole branch were independently reviewed with their fix waves ([Task 5 completion note](../handoffs/2026-09-30-task-5-completion.md)), Task 6 is gated, the frontend is deferred, and nothing has been applied remotely or deployed.
Author: Roberto, with Codex. Local date: 2026-09-29.
Baseline: main `dbeebaf`, after the ordered merges #27, #28 and #26.

## Purpose and evidence

Implement the backend responsibilities in Lucas’s one-page `2026-09-30-ArabicaAI-intake-brief.pdf`: complete Worker intake workflow and gated online extraction. Roberto explicitly deferred the frontend to his own work tomorrow; this PR proposes no Angular redesign or component changes. The brief is team direction, not an organizer amendment. Its reported development result is 16/18 correct, zero unsafe, 48/48 schema-valid, and 3.25 s all-call p95; this design neither independently verifies those measurements nor turns the latency trigger into a pass.

The official problem statement requires grounded clarification, escalation with context, evaluated learned behavior and a normal resolution demonstration. Unrecognized-charge intake ends in human review. A separate recent-transactions path supplies the read-only automated-resolution demonstration. Source context: `Docs/sources/README.md`, problem statement pp. 3–6, kickoff p. 6, ADR-002 through ADR-006, and `Docs/intake/customer-and-measurement-contract.md`.

Success means an authenticated customer can report a charge in ES/PT, clarify or explicitly confirm an owned candidate, receive a reference only after durable read-back, and see the next step. An agent can inspect complete or incomplete evidence and the service’s actual actions. Failures and unfinished episodes remain visible in measurement.

## Recommended approach and alternatives

Keep the existing Angular application and guided form unchanged. Extend the Worker/D1 API with explicit outcome states and a feature-gated extraction adapter: AI extracts, deterministic policy decides. This is option B in the brief.

A form-only delivery is the rollback and first independently shippable increment; it can demonstrate workflow safety while the learned component is evaluated offline. An AI-led conversation would add response generation and another behavioral surface, so it is deferred. No new service, agent framework, queue, scorer or model SDK is needed for this design.

## Ownership and dependencies

- Roberto owns Worker orchestration, API contracts, migrations, events and verification described here. Frontend redesign is deferred to Roberto’s separate work tomorrow.
- Manoella owns the reviewed Gold cohort and its manifest, plus unexposed extractor-behavior and development-gate decisions. Approximately 1,000 customers is a question in the brief, not an approved import size.
- Lucas owns integration, corpus custody, exact registration/tag, frozen evaluation, deployment and submission.
- The blind builder owns extractor prompt, parsing, thresholds and model revisions. Neither Roberto nor Lucas tunes them after frozen exposure. A Worker-compatible implementation of extraction validation/parsing must be supplied through that boundary and reviewed by Manoella for behavioral equivalence. Roberto may implement the transport and orchestration interfaces without inventing replacement parsing rules.

No freeze, model activation, remote migration, data import or deployment is part of this design PR. All-decider ADR status and the country/latency/development-gold/escalation decisions remain unresolved until recorded by their owners.

## Frontend boundary and API outcomes

No Angular templates, styles, components, translations or frontend behavior are changed in this work. Existing guided submissions remain compatible. Contract schema updates are shared API work, and are documented so Roberto can integrate the frontend separately.

Use stable response codes for describing, clarification required, multiple candidates, confirmation required, submitting/acceptance unknown, complete handoff, technical/incomplete handoff, and out-of-scope routing. Each response includes its declared evidence coverage and relevant opaque references, without promising refunds, card blocks or fraud verdicts. A pending submission preserves its payload and key; renewed authentication must use the same customer identity.

Accept an explicit ES/PT conversation language and bind it to the episode. Locale hints do not determine identity or silently override the chosen language. Preserve source currency/amount and timezone-free timestamps in API evidence. Expose recent-transactions as a separate read-only resolution path, with coverage and `has_more`; its eventual display remains frontend work.

## Worker orchestration and contracts

Extend `back-end/src/modules/customer/routes.js`, `back-end/src/router.js`, and the existing shared contract, adding only the endpoints required for intake start/turn/confirmation and read-only agent detail. Keep existing `/cases` behavior compatible during transition. Every new API prefix must be gated and must never fall through to Angular assets.

Validate method/path, session role, language, length, shape and idempotency before work. Identity and confirmation history come from server state. Requests, extraction and conversation context cannot override customer identity, ownership, lookup health or previously confirmed evidence.

Use a server-minted episode ID distinct from the eventual case reference. Bind it to the customer session and persist turn keys so concurrent replay yields the same response and no repeated event chain. Re-read owned evidence and session validity when confirming; an old candidate ID is not authorization.

Classification distinguishes one candidate, several, none, incomplete coverage and lookup failure. The existing transaction schema lacks some card/category/country fields required by matching; coordinate an additive Gold-serving contract with Manoella before implementing those filters. Missing serving fields must remain missing rather than be fabricated from context cards. Keep source amount/currency/time semantics.

Allow at most one retry of a transient D1 read within its bounded operation deadline and measured query budget. Do not add an orchestration-level provider retry: the reviewed extractor implementation immediately fails on transport/provider errors and retries only invalid output. The blind-builder-approved compatible adapter owns that single attempt policy; wrapping it must not multiply attempts or change evaluated behavior. Never retry permission rejection, configuration errors, invalid ownership or conflicting idempotency. Case writes replay the existing key and must be read back before acknowledgment. If case storage/read-back is down, return acceptance unknown without a reference; a technical handoff cannot be promised until storage is available.

## Handoffs, case detail and history

Existing `cases` requires a non-null owned transaction and confirmed=true. Preserve that table and its constraints for existing complete cases. Add a separate intake episode/handoff representation for technical and incomplete evidence, rather than weakening the confirmed-case foreign key or inventing a transaction. Complete intake links to the existing confirmed case; incomplete handoffs explicitly carry no confirmed transaction.

Store original statements and verified evidence only in access-controlled case/handoff storage. Persist server-derived `actions_taken`, `unresolved_questions`, handoff kind, tool status, receiving destination, priority and read-back acknowledgment. Actions describe actual retrieval/confirmation/storage, never an assumed refund or fraud verdict. The durable D1 case store is the receiving service for this demo; acknowledgment after verified persistence is not human resolution.

Agent queue/detail APIs must include incomplete/technical handoffs, so replace inner-join-only assumptions where appropriate without exposing unrelated transactions. API history shows recorded service transitions, not invented agent work. Rendering belongs to the deferred frontend. Keep agent access read-only; status-changing agent endpoints are outside this scope.

All SQL remains in `back-end/src/store/d1.js`. Reserve the next migration number with Lucas: current main ends at 0003. Apply additive migrations to local D1 before any remote action. New indexes enforce owner/turn-key uniqueness and bounded queue queries. Operational rows remain through October 31 under ADR-004; session expiry still applies.

## AI boundary, deadlines and fallback

The Worker may use its AI binding only after the exact extractor is registered, frozen results are available, agreed release gates pass and the named decisions are recorded. Default the switch off. No live model calls are required to build or test the orchestration.

When enabled, authenticate first. Send only message, chosen session language, trusted `as_of` and the approved closed vocabulary; never send transactions, identifiers, statements from other turns/customers or context-card personal fields. Use the registered prompt/model/parameters unchanged. The unexposed builder supplies parsing and validation; trusted session and lookup state are added afterward. Customer replies use deterministic translated templates.

Keep ADR-006’s 10 s total extraction timeout and at most one invalid-output retry; both calls share the total deadline. The measured p95 qualification threshold remains 3 s, separately from the hard timeout. Provider failure/timeout is recorded as failure and a technical outcome; it cannot be disguised as a successful model extraction.

The safe fallback is the existing guided selection/confirmation flow with its own explicit mode. A durable technical or incomplete handoff is terminal for that episode: emit at most one handoff chain and one end event, then replay its receipt on retries. A later customer-selected guided report starts a new episode with a new submission key; it never converts the failed episode to accepted or replaces its usage. Technical handoffs end with `technical_failure`; incomplete handoffs routed to human review end with `routed`, never `accepted`. Record the original failure and measured/unknown usage in the original episode. A failed model attempt may offer the new guided flow to the customer; it does not silently claim the checklist understood the same message. If persistence/read-back failed, keep acceptance unknown and retry the original key rather than start another episode while its acceptance is unresolved. Any proposal for automatic checklist interpretation of free text must use a reviewed equivalent policy adapter and declare fallback provenance separately.

## Events and measurement

Implement the existing `Docs/intake/intake-events.md` vocabulary and ordering; reuse `evals/intake/episodes.py`. Persist ordered events atomically with relevant state transitions. Export allowlisted opaque references, never customer IDs, messages, names, evidence or model output.

Eligible episodes start only after authenticated supported-language intake classification; pending, failed, withdrawn and abandoned episodes stay in the started denominator. Maintain separate all-attempt routing/authentication safety counts; do not manufacture episode starts for unsupported traffic to make them scoreable.

Complete safe acceptance requires the scorer’s confirmation → complete handoff → durable acknowledgment → end chain. Technical/incomplete handoffs do not emit that safe chain. Production safety remains `not_assessed` unless the documented check actually ran. Propose abandonment after ten minutes idle or session expiry, whichever comes first; use a defined housekeeping/export cutoff and stable deduplicated end event.

Record actual monotonic elapsed time, calls and provider usage, including failed attempts. The current event contract requires integer token totals, while #26 supports unknown usage. Before runtime instrumentation, revise the event schema and scorer compatibly to represent unavailable usage explicitly; never substitute zero or omit an ended episode to conceal missing usage. Keep pending usage, decision-point metrics, episode metrics and inquiry resolution denominators separate.

ADR-002 requires a separate ADR for the recent-transactions resolution path. Record its scope, coverage, eligibility, numerator/denominator and acknowledgment semantics before implementing resolution measurement. Existing bounded retrieval and backend failure instrumentation may ship first, but an HTTP success cannot establish successful display. The resolution numerator remains unavailable until the separately owned frontend implements the agreed display acknowledgment; do not infer zero resolutions or count retrieval responses as resolutions. Any acknowledgment remains session-bound and idempotent, and supports a declared demo-display metric rather than proof of bank resolution.

## Delivery sequence and verification

1. Roberto approved this written design and the fresh reviewer confirmed its corrections. Next produce the detailed implementation plan and choose inline or delegated execution under Superpowers.
2. Preserve the existing frontend and guided API; document ES/PT language and outcome contracts for tomorrow’s frontend work.
3. Implement additive episode/handoff persistence, explicit states and read-only detail/history with contract changes and adversarial tests.
4. Add deterministic orchestration and privacy-safe event export, including the unknown-usage contract correction. Record the separate recent-transactions ADR before resolution work; backend retrieval/failure instrumentation is independent, while display acknowledgment and the resolution numerator wait for the deferred frontend.
5. Build the gated transport/interface after the unexposed compatible extraction/policy boundary is supplied. Test with stubs; activation remains an integration decision after frozen evidence.

Run Worker unit and real local-D1 integration suites, shared contract validation and episode tests; run existing Angular checks only for API compatibility, without implementing frontend changes. Cover the gate/method/path matrix, session swaps/forgery/expiry, cross-customer isolation, hostile input, concurrent idempotency, failed read-back, stale confirmation, incomplete coverage, bounded retry/timeout, exact provider attempt counts, terminal technical/incomplete handoff followed by a distinct guided episode, replay while acceptance is unknown, fallback provenance, event deduplication and unknown usage. Frontend accessibility and visual verification are deferred with the frontend implementation. No raw source/private evaluation data is needed.

Re-measure D1 rows/queries/round trips and justify any increase in ADR-004 before accepting a new budget. Do not preserve the old per-episode capacity claim after adding writes. Frozen evaluation, model/corpus tags, remote deployment and the reviewed Gold import remain with their owners.

## Approval decisions

Approve the recommended backend option B design, including the staged increments, read-only agent history API, incomplete handoff storage, explicit guided fallback, and safe unknown-usage representation. Frontend implementation is excluded. This proposal does not decide the model rung, change parsing/prompt, waive latency, alter frozen labels or approve the Gold cohort size. Those decisions remain explicit dependencies, not placeholders filled by this PR.

## Fresh review disposition

An independent agent reviewed `fa76fcd` against the source brief, current Worker/store/schema, ADRs and episode scorer. Three bounded design issues were confirmed and corrected: terminal technical/incomplete handoffs with distinct guided recovery episodes; one registered provider attempt policy without an extra orchestration retry; and a separate recent-transactions ADR with display acknowledgment deferred to the frontend. No extractor prompt/parsing/model revision or frontend implementation follows from these corrections.

The same fresh reviewer rechecked the corrected design and reported no remaining design blockers. Implementation and activation dependencies above remain in force.
