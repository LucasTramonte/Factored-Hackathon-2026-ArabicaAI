# Customer clarity and lifecycle: local rehearsal, 2026-10-04

Scope: combined customer lifecycle tree at `32c2f5dd81fa596ebc3646a418483500de4c056a`, branch `codex/customer-explained-closure` (merged as #124). This is aggregate-only authored regression evidence. It changes no model, policy, frozen labels or deployment switch. Frozen v1 evidence is unchanged; none of these cases is a new held-out evaluation of v1 or v2. A handoff or finished review establishes no bank investigation, financial remediation or resolution.

## Environment and actions

The existing `back-end/test/run-local.mjs` applied all additive migrations and fictitious/sample/cohort seeds to a newly created disposable local D1, without resetting shared demo activity. The online runtime was the real Worker. Cognito-shaped test tokens used a throwaway local signing key; missing-charge extraction used the existing Google mock with forced local arm B. SES was unconfigured. These seams do not establish live OTP, real model accuracy, deployed D1 access or email delivery. Facts/fixtures are bounded; no production facts or credentials were loaded.

A temporary authored integration suite reused that harness for Spanish and Portuguese and an English smoke run. Each language exercised four initial paths: identified charge, missing-charge match/confirmation, no clear match and provider failure. Every saved report then received a separate reviewer response, `received → in_review → closed` with an explanation, and was recovered by a fresh owner session after logout. An omitted closing note returned 422; closed messages refused new posts; a linked follow-up produced a new report while its source remained closed. Foreign-customer reads returned 404. The suite is retained only in the ignored local SDD task directory; committed integration suites listed below cover the same behaviors.

| Authored API checkpoints | ES | PT | EN smoke |
|---|---|---|---|
| Initial paths completed | 4 | 4 | 4 |
| Saved reports recovered after new sign-in | 4 | 4 | 4 |
| Reviewer response and explained closure verified | 4 | 4 | 4 |
| Linked follow-up saved; source stays closed | 1 | 1 | 1 |
| Status update request accepted as queued | 1 | 1 | 1 |

Counts describe these authored paths only, not users, completion rates, response-time targets or general model performance. No-match and provider failure remained human handoffs; confirmed suggestions remained unverified by the bank.

## Actual local browser observations

A temporary long-lived copy of the same harness hosted the Worker and isolated D1. Development Angular assets were built into a separate temporary directory and copied only to this disposable server, enabling the existing synthetic identity picker. Chrome held the owner session; the Codex in-app browser held a separately signed-in reviewer and another customer session. No production assets, accounts or shared data were changed.

- Spanish: found and explicitly confirmed an owned charge; the acknowledged report appeared in the saved list. A reviewer in the other browser opened detail, sent a response, started review and finished with an explanation. Customer manual refresh displayed both real status changes, latest response and read-only closed messages. The explanation included markup characters, which displayed literally as plain text. Reload preserved the reference, progress and explanation.
- Portuguese: chose “Ainda preciso de ajuda” from the closed report; saved a linked missing-charge follow-up with a different reference. The existing mocked provider suggested an owned charge; the customer confirmed it. Reviewer detail distinguished the customer’s choice from bank-verified evidence. The reviewer sent a Portuguese response, started and finished review with a Portuguese explanation.
- Passive refresh: customer `document.visibilityState` was `visible`. After the Portuguese reviewer actions, no customer manual refresh/reload was performed: report checks advanced from displayed 18:54:48 to 18:55:18 and the open thread check to 18:55:17 (America/Bogota). The customer showed the real finished-review notice, stored explanation, new-team-response notice and latest reply with a read-only thread. This is one local cadence observation, not a latency distribution.
- Isolation/recovery: another customer in the in-app browser saw only their one own charge and zero reports; the owner in Chrome retained two reports. The reviewer session stayed separate. Signing the owner out and back in through the local picker recovered both reports/progress/explanations. English smoke showed translated status, explanation heading, message and linked-help controls; stored reviewer content retained its original language.
- Tour: the Spanish native modal opened after login, Tab cycled within its enabled controls, Escape closed it and returned focus to the home heading. The skip preference survived reload/new sign-in; the second browser received its own Portuguese tour offer. No tour action submitted a report. Full screen-reader, zoom/responsive, backward-Tab and deployed-browser coverage are not claimed by these manual observations; automated tour/component checks cover additional mechanics.

No-match/failure and technical-handoff recovery were exercised through the real local-D1 HTTP/store harness, not manually through every browser path. The operator was an agent acting on synthetic records; this is not a fresh human tester session. A future demonstration uses a human teammate as reviewer, with no automatic fake reviewer or timed closure.

## Checks and the runner limitation

Commands used the declared Python runtime from the primary checkout; the worktree has no `.venv`.

| Command/check | Exact result |
|---|---|
| `make intake-test PYTHON=/Users/robertozuniga/Desktop/code/Factored-Hackathon-2026-ArabicaAI/.venv/bin/python` | Gold 202 passed / 1 skipped; Chrome Headless 335 specs reported `TOTAL: 335 SUCCESS`; Angular runner did not exit. After more than 120 seconds of unchanged completion output, its owned `ng test` process was terminated with SIGTERM; make exited 2 (`Terminated: 15`). **The combined command did not pass.** |
| Gold skip | `data_pipelines/gold/test_cohort.py` local-manifest check skips with `no local cohort manifest`; no S3 run implied |
| `make intake-ui-build` (remaining stage, once) | Production build and prepared Worker assets passed; 515.41 kB initial bundle, existing 500 kB warning exceeded by 15.41 kB; 1 MB hard limit passed |
| `npm --prefix back-end test` (remaining stages, once) | Exit 0: 244 unit tests, 127 local-D1 integration tests and 8 D1 budget tests passed; 0 failures/skips/cancellations |
| Temporary authored `ONLY=task6-rehearsal.test.js npm --prefix back-end run test:integration` | Exit 0: 3 language tests passed, 0 failed/skipped/cancelled |
| `python3 scripts/check_doc_links.py` | Exit 0: all relative Markdown links resolve |

The Angular completion/exit discrepancy is an unresolved runner limitation, not a clean frontend gate. The idle `ng test` process had pipes/kqueue and three Unix sockets but no remaining browser child or Karma TCP listener; no individual failed spec or product regression was demonstrated. It was reported to the coordinator; no product change or repeated broad suite was made. Worker unit output also carries Node’s `ExperimentalWarning: SQLite is an experimental feature and might change at any time`.

Committed regression sources: `live-flow.test.js` (complete/incomplete/technical persistence, new sessions, retention beyond recent 20, concurrent retry); `suggestions.test.js` (owned match/confirm/reject and provider/no-match fallbacks); `messages.test.js`; `handoff-status.test.js` (required immutable note, atomic rollback/races and legacy nullable closure); `report-again.test.js`; `notify.test.js` (queue and cooldown/recipient ownership); customer refresh/email/tour and guided-tour Chrome specs. API responses pass committed contracts and budget ceilings. Generic email-template unit assertions check reference/status/language and exclude statement/closing note and session tokens from the app link; no received-email link was opened in this rehearsal.

Local logs remain outside the repository under `/tmp/task6-*.log`; raw browser content, references, notes, tokens and emails are not published here. To repeat the browser rehearsal, use the [runbook protocol](../Plans/intake-demo.md#human-operated-demonstration-protocol) with isolated synthetic records. An authorized person performs deployed checks.

## Pending evidence and human protocol

| Checkpoint | Result / missing evidence |
|---|---|
| Fresh formative testers | **0 observed; study not run.** At least 3 fresh people must find a charge, create a report and locate the latest response without coaching. Record completion, wrong turns, help needed and next-actor understanding as aggregate counts with observed denominators. No population rate is defined. |
| Live queue/outbox | Pending external: current Cloudflare account cannot access demo D1; no remote query or deployed email request was made |
| SES provider acceptance | Pending external at this rehearsal; local sends are skipped because SES is unconfigured. Mocked/fixture `sent` is not live acceptance. Confirmed in production on 2026-10-04 at 20:16 UTC ([observability runbook](../Plans/observability-runbook.md)) |
| Inbox receipt | Pending external at this rehearsal; no real email was sent or mailbox inspected. Confirmed in production on 2026-10-04 at 20:16 UTC ([observability runbook](../Plans/observability-runbook.md)) |
| Received-email app link | Generic token-free template checks passed; signed-out received-link → sign-in → current owned-report recovery remains pending external |
| Live OTP/deployed behavior | Untested; local picker and throwaway token issuer do not establish Cognito delivery/sign-in or deployed migration/client pairing |

A human organizer recruits the fresh testers and a teammate performs the reviewer actions. A person with authorized demo access requests one status email only to the user’s test inbox, records the 202/outbox queue, SES message id and inbox receipt separately, then checks the app link without a session token and owner-only recovery. Retain generic reference/status/language metadata only; email contains no statement or closing explanation. Use the existing five-minute queued/accepted and ten-second failed/skipped retry policy. This rehearsal adds no secret, permission, external contact, deploy, remote migration or bank action.
