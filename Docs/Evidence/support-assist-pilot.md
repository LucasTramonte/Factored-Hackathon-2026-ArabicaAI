# Support-assist offline pilot evidence

**Decision: implementation is ready for its final review/checks; live pilot and activation remain pending.** Both production assistant switches stay absent/off. This record contains aggregate synthetic/local evidence, not observed model quality, human handling improvement or production verification. The final PR and final checks belong to the coordinator; no live model calls, spend approval, deploy, remote migration, merge, tag or permission change occurred in Task 6.

## Provenance and fixed populations

Task 6 implements the evaluation foundation originally assigned to Task 4, once. The only runtime under test is the existing Worker with fresh local D1; migrations and synthetic seeds use the existing `back-end/test/run-local.mjs`. Provider and session issuer are loopback/throwaway test seams. No S3/data-pipeline scan or bank customer text is used. The corpus/scorer is bounded in memory: 180 synthetic fixture rows, 360 acceptance observations and a finite reserved-slot ledger; no fact-key materialization or fact joins. The native follow-up check reads the one episode→one source handoff relationship through the existing store.

| Population | Reviewer | Customer |
|---|---:|---:|
| Synthetic development cases | 30, 10/language | 30, 10/language |
| Synthetic acceptance cases | 60, 20/language | 60, 20/language |
| Adversarial/unsupported acceptance cases | 21 | 21 |
| Registered repetitions / required attempts | 3 / 180 | 3 / 180 |
| Observed live acceptance attempts | **0** | **0** |
| Observed live reviewed safety/quality denominator | **0** | **0** |

The authored ES/PT/EN scenarios vary charge facts, missing/uncertain fields, corrections, human author order, bounded history, status, process and details questions, human requests and hostile financial/instruction/foreign-reference/HTML/URL content. Corresponding language scenarios are correlated. The agent authored these after reading implementation; they are held out from future model tuning/trials, not an independent blind benchmark or a native-speaker-validated population. Human label review remains pending. Reviewer gold is a grounding/checklist policy, not one expected prose string.

Frozen at **2026-10-05 04:16:28.879288 UTC** (2026-10-04 local), before any provider trial. [COMMITMENT.json](../../evals/support_assist/COMMITMENT.json) pins:

- Development: `b9ebd4f94a8697cdb3a66d6c88289e298bcb7d420bb334f68f7c03b48cd5ea50`.
- Acceptance: `263af24bba6708d584c7f9aacfbc2056126ad770b0e8a4efa589dc67ebb66a96`.
- Transport: `72858e826e9f187fcd3f1946d9768c56f06b798543252772c76599b4d3a7f7ad`.
- Prompts: `127ad29495d1ea30af12e96e6f445f1ce70eedd384c1650bd8ee84c37834f2d6`.

Bundle: `support-assist-v1@google/gemini-3.5-flash-lite`; no extractor modification or borrowed extractor timing/cost. A bundle change needs version increment and fresh acceptance corpus; do not tune against this set's outcomes.

## Focused checks and real local journeys

Commands run at repository root on `codex/report-support-assistants`, Task 6 base `bfa8219`; the final whole-branch review base is `origin/main` at `d5cd089`. Logs and private contract-check fixtures remain ignored and retained for the coordinator.

| Exact check | Exit / result | What it establishes |
|---|---|---|
| `python3 -m unittest evals.support_assist.test_score` | 0, **12/12** | Complete denominators; missing/duplicate/reused attempts; version/hash mismatch; malformed/unreviewed/invalid metrics; safety/status/fallback blocking; customer per-language accuracy; failures/partial unknown tokens; shared daily and rolling caps; absent/malformed live evidence; unreserved gate failures retained; one late success blocks even when p95 passes |
| `python3 -m evals.support_assist.score --check` | 0, all frozen bytes match | 30 development + 60 acceptance per feature, 10/20 per language, separate IDs/wording and ≥20 adversarial/unsupported per feature; unchanged transport/prompt freeze |
| `ONLY=support-assist-journeys.test.js npm --prefix back-end run test:integration` | 0, **10/10** | Real local Worker/D1 persistence and isolation with controlled provider/session seams |
| `python3 -m evals.support_assist.score --results .superpowers/sdd/2026-10-04-report-support-assistants/task-6-contract-results.jsonl --manifest .superpowers/sdd/2026-10-04-report-support-assistants/task-6-contract-manifest.json --ledger .superpowers/sdd/2026-10-04-report-support-assistants/task-6-contract-reservations.jsonl --require-pass` | **2**, `pending_external` | Artificial unit-test records exercise the CLI contract; mock-only evidence cannot pass the live gate. These rows are not observed model results and their numeric metrics are not published |
| `git diff --check` | 0 | No whitespace errors in scoped work |

The initial scorer RED command exited 1 because the scorer module did not exist, before implementation. The first native journey execution failed at the existing logout response (the test expected 200; the endpoint returns 204); correcting the expectation produced 10/10 without runtime changes. Intermediate scorer fixtures were corrected to place timestamps after the freeze and to make status review inapplicable after intentionally changing a predicted status to unsupported. These were test-contract corrections, not hidden model failures. No broad backend/frontend/build wave was repeated here.

**Ten scripted two-party journeys: ES 4, PT 3, EN 3.** Each actually creates a handoff, saves and rereads a customer message, asserts waiting from last persisted customer author, classifies status against owned stored state/count without creating a message, prepares an unsaved reviewer draft, explicitly sends different edited human text with its snapshot, rereads the human-author reply, replays Send once, and preserves manual status/messages on a provider outage. The changed message count rejects stale assisted sending. Logout during a delayed classifier call, a different customer session and foreign/missing equivalence verify identity isolation. A human-commanded explained closure makes the old thread read-only; linked follow-up creates a different report and keeps its source closed. Local claims are direct assertions about stored data, not asserted provider semantics.

Exactly **40 reserved loopback operations** across the ten journeys: 10 reviewer generations and 30 customer operations (10 status successes, 10 controlled provider failures, 10 delayed results rejected after logout). Distinct synthetic session scopes belong to separate journeys; they are not permission to rotate sessions in a live pilot to evade caps. Each journey uses only one reviewer and three customer reservations in a rolling minute. The harness leaves the shared 200/day and five/session/feature/minute caps unchanged.

The controlled provider's reviewer prose is fixed, and its intent output is marker-driven. It does not establish ES/PT/EN language quality, groundedness, classification accuracy, provider latency, actual usage or spend. Existing Task 1/4/5 native UI evidence separately covers transient/saved labels, explicit composer acceptance, language/report/session races, outage/closed state, keyboard and widths 320/390/1440. This final task does not duplicate those browser runs or claim new production UI checks.

| Timing/cost evidence | Observed denominator | Result / limit |
|---|---:|---|
| Scripted saved-customer-message→saved-reviewer-reply span | 10 | Min 20 ms, nearest-rank p50 23 ms, p95/max 43 ms; script scheduling only, **not human response, handling time or model latency** |
| Actual first human response | **0** | Unmeasured; automated answers excluded |
| Matched operator tasks with/without assist | **0** | Unmeasured; no improvement or causality claim |
| Live support model latency/tokens/cost | **0** | Unmeasured; unknown usage is not zero cost |

## Proposed live gates and pending human work

[The full scoring contract](../../evals/support_assist/README.md) fixes zero safety failures and exact stored-source status answers; unknown/invalid/unsupported results must fall back safely. Customer exact intent/field accuracy needs ≥90% of **117 supported attempts** overall, ≥85% of **39/language**, with failed calls incorrect (including unreserved gate refusals reported separately from provider calls) and 63 unsupported attempts retained in safety/performance/cost. Reviewer usable drafts without factual correction need ≥80% of **180 attempts**, with unchanged/edited/rejected/factual-correction counts separate. Success p95≤8 s and failure/timeout share≤5% use explicit denominators and all-attempt timing separately. One successful result at/after the 10 s deadline blocks, independently of p95; preserve the existing WIF/provider/read deadline proof and distinguish body/D1 platform waits. Phase-1 status <2 s remains a target, not a measured result of this rehearsal.

Unit prices verified by the coordinator in [ADR-016](../ADRs/ADR-016-report-support-assistants.md): global US$0.30/M input and US$2.50/M output; existing non-global endpoint US$0.33/M and US$2.75/M, including response plus reasoning output. Actual support model spend is unmeasured. The scorer reports known tokens/cost components and per-attempt known-cost distribution; a single partial/unknown usage makes total cost null. An approval budget must account for timed-out work that may still be billed.

Live scheduling must honor shared **200 reserved attempts per UTC day** and **five/session/feature/rolling minute**, including development, other calls and failed/abandoned slots. **360 acceptance alone needs at least two UTC days. 60 one-call development cases + 360 acceptance = 420, at least three days**, with `ceil((420 + other reserved attempts)/200)` controlling the actual minimum. Example allocation: day 1, 60 development + 140 acceptance; day 2, 200 acceptance; day 3, 20 acceptance, reduced for any other reservations. Pace each unchanged session/feature at least 13 seconds between calls or otherwise enforce the actual rolling window. Never raise caps, rotate sessions, delete failures or replace registered bad attempts with better retries. Reconcile the full ledger across all days.

Pending external work: multilingual label/ADR/evidence review; synthetic-only model-input and spending approval; configured-project availability/WIF/schema compatibility proof; all 360 live attempts and human output review; ≥10 actual operator/customer journeys and descriptive paired human-handling timing; PR approval and separate per-feature activation. Live readiness also needs named operator attestation, real deployment SHA, approval/access/deadline/human-pilot references and matching hashes of reviewed results, all reservations and preserved private raw evidence. Hashes prove integrity, not the truth of attestation; a person must inspect it. A derived `passed` score still returns `activation_approved:false` and cannot authorize switching on.

After authorized normal deployment/activation, a person verifies actual production SHA/assets, login/OTP/logo, locale-specific email requests, message persistence/waiting/status, reviewer edit/send, reply/closure/follow-up and each approved switch. Observe feature-specific safety/errors/latency/unknown usage/spend with exact UTC windows and denominators. Disable only the failing assistant switch if its gate is breached, confirm deployed configuration and recheck manual messages, factual status and existing extraction. These checks are **unperformed**, not silently accepted from local evidence. Additive migration 0030 is applied by normal deploy; no agent runs a remote migration. [The observability runbook](../Plans/observability-runbook.md) records the procedure.

## Exhaustive controller rulings and costs

These reproduce every `Ruling:` decision in the retained orchestration ledger, including the final efficiency ruling. They record why implementation differs from historical scheduling and what each choice costs; they confer no live/permission authority.

| Ruling | Basis | Cost / limitation |
|---|---|---|
| Six sequential scoped tasks, one final PR, superseding three phase merge stops | Latest explicit user authorization and parent instruction | A larger review diff if this choice is wrong |
| Live Vertex evaluation and activation remain external; implement offline harness, frozen fixtures and truthful local evidence | Approved design separates implementation and activation | Deferred live confidence/performance results |
| Maximum three correction rounds overrides skill's five-round default | Repository/task instruction | Earlier escalation if defects persist |
| Show `accepted_at` as received-at, last status-update unavailable and checked-at separately | Existing report contract lacks update timestamp; Task 1 mandates no API addition and forbids invented facts | Last-update history stays unavailable until a reviewed contract addition |
| UUID duplicate detection lasts seven-day metadata retention; each deliberate action uses a fresh UUID, no indefinite tombstones | Plan requires bounded seven-day storage and one attempt per retained UUID | Old UUID replay after cleanup may incur another billed attempt, still within daily/session caps; disclosed in ADR for final review |
| Persist immutable bundle version at reservation; migration version is non-null before any remote application | Accountability must survive Worker interruption; no existing production callers | Slightly expanded internal `reserveAssist` interface consumed by Task 3 |
| Preserve the exact persisted incomplete-handoff statement/details composite as `statement`, with empty `details` when provenance is absent; never guess newline delimiters | Stored truth and existing combined 2,000-code-point bound avoid extra intake/schema scope | Original/detail separate labels unavailable for historical records; ADR/report disclose it |
| Permit model input only for server-owned `customers.source='fictitious'`, before reservation/provider; dataset reports keep manual/status paths | Broader text needs its own approved ADR; source tag never reaches client/model | Assist unavailable for dataset cases until separately approved scope expansion |
| Move all Task 4 evaluation foundation to Task 6 and author once, preserving counts/hash/gates | Explicit user/coordinator efficiency authorization | Evaluation arrives after customer implementation rather than with reviewer UI |
| Ten-second deadline binds `runAssist` authentication/provider; retain route elapsed/abort/session/snapshot guards, retract speculative body/D1 timeout framework | Coordinator clarified scope; no actual transport deadline violation was shown | Endpoint latency remains subject to existing body/D1 platform waits; no late provider/result may be served |
| Retain ignored SDD ledger/packages/reviews/screenshots until root inspection and PR creation; durable aggregates/rulings committed here | Explicit handoff-evidence requirement overrides immediate skill scratch cleanup | Temporary ignored local artifacts remain until later cleanup |
| After separate Task 6 spec review, the fresh strongest whole-branch reviewer independently performs Task 6 quality, concurrently with coordinator's final full build/tests; reviewer inspects final outputs before ready verdict | Latest explicit user/coordinator efficiency instruction | One combined review seat instead of two overlapping quality passes |

Task 6 spec review, combined independent quality/whole-branch review, final complete stack/build checks and the final PR remain coordinator-owned at this record's creation. Private scratch is retained; this public record contains no run question, draft, customer record, credential or raw transcript.
