# ADR-012 — AI online only where the evidence shows the deterministic flow falls short: not yet

- **Status:** Proposed
- **Date:** 2026-10-04
- **Deciders:** Lucas, Roberto, Manoella

## Context

The product owner proposed putting an AI assistant online, but only where evidence shows the deterministic flow is insufficient, or where latency or complexity justifies it; not everywhere. The brief asks the team to "justify where AI is appropriate, where deterministic logic is preferable" (problem statement p. 2). ADR-002 keeps the MVP free of model calls, and adding one needs its own ADR. This is that ADR. It asks, path by path, whether the data and our own measurements justify a model online.

The deployed flow (ADR-002, ADR-009, ADR-010) is guided:
1. the customer signs in;
2. picks one tap of reason;
3. writes a short statement;
4. **picks the charge from their own list** and confirms it, or says "I can't find it" and adds what they remember (an incomplete handoff to a person).

No step needs the service to understand free text in order to act: the charge comes from a list, the reason from a closed set. The statement and the details travel to the agent as written.

**Evidence, per path:**

| Path | Where it could fall short | Measured | Source |
|---|---|---|---|
| Sign-in, reason, charge list, confirmation | Ambiguity or failure in choosing the charge | None measurable: the customer chooses from their own charges, and ownership is enforced in SQL | ADR-009; `back-end/test/integration/` |
| Reading free text (what a fully conversational flow would need) | The rule-based checklist misses currency words, non-ISO and relative dates, paraphrases | Checklist 15/25 on `v1_authored`, 16/18 on development, 22/24 on evaluation. The guided UI avoids this need: nothing is decided from the text | `EVALUATION.md` §3 |
| "I can't find the charge" (incomplete handoff with details) | The customer can't find the charge, so a person must match it by hand | 1 of 5 live episodes (Portuguese). Five episodes support no rate | `EVALUATION.md` §9 (remote export, 2026-10-02) |
| Latency of the guided requests | Slow steps | One timed confirm: 1,268 ms. The report-request target is p95 below 2,000 ms; evidence is still incomplete | `EVALUATION.md` §10 |
| The learned extractor itself | Whether a model reads better than the checklist | Development: 18/18 at the default reasoning level, but p95 interval upper bound 3,079 ms (latency trigger fires). At `low`: latency passes (about 2.34 s), instability ruling pending (#98). Frozen comparison **not run** | ADR-006 amendments 7–8; `DEV_LOG.md` |
| Proactive help | Customers wait to start every interaction | Handled deterministically by ADR-011 (a bank flag, no model) | ADR-011 |

**What the evidence says.** The one measured weakness of deterministic logic, reading free text, sits on a step the guided flow doesn't depend on. The one path where a model could plausibly help (matching an "I can't find it" description to the customer's own charges) has a single live occurrence. The model hasn't yet passed its own pre-registered gates or its held-out comparison. On top of that, it adds about 1.6 s at p50, and 2.3 to 2.6 s at p95 at the low reasoning level, to whatever step it joins, against a 2,000 ms report-request target.

## Decision

1. **No model online now. Every live path stays deterministic.** The extractor stays offline (evaluation, ADR-006) and behind the shadow switch, which is off (`INTAKE_AI_ENABLED`, `APPROVED_EXTRACTOR = null`).
2. **The one candidate path is named in advance:** "I can't find the charge" with details. If it qualifies, the model reads only the customer's details text and turns it into the fixed vocabulary (amount, date, currency, merchant). Deterministic code then **suggests** up to three of the customer's own charges that fit those facts. The customer confirms one or keeps the handoff. The model never sees transactions, never picks a charge, never writes to the store, and never decides an action.
3. **It goes online only when all of these hold**, measured and recorded before the switch is turned on:
   - the frozen comparison has run once (ADR-006), and the extractor is at least as correct as the checklist on held-out cases, with 0 unsafe;
   - every ADR-006 development trigger passes under the recorded rulings, including instability (#98);
   - over at least 30 live episodes, "I can't find it" is at least 15% of started reports. Below that, a person matching by hand costs less than operating a model path;
   - the path's added p95 latency (model call plus suggestion) keeps the request under the 2,000 ms report-request target, measured on that path only.
4. **When it does go online, the architecture optimizes for these properties:**
   - **Latency:** one call, only on that path, never on the main flow; 10 s hard deadline; the response is never blocked by an unrelated model call.
   - **Cost and tokens:** about 1,900 input and 250 output tokens per call (development smoke, 2026-10-03), billed per token (Vertex AI trial credits; ADR-006 amendment 7). At the expected volume it stays well under a cent a day.
   - **Reliability:** timeout, malformed output, schema failure or provider error all fall back to the current incomplete handoff, recorded as unknown usage and never as free.
   - **Security:** the model sees only the details text, the session language and the closed vocabulary; no customer id, transaction or history. Its output is validated against the schema before anything uses it, and ownership of suggested charges is enforced in SQL.
   - **Auditability:** events carry the producer version, call counts and token usage, never the text (`intake-events.md`). The suggestion, and the customer's choice, are recorded as references.
   - **Determinism:** the suggestion rule (facts → own charges) is deterministic and unit-tested. Only the reading is learned.
5. **Everything else stays deterministic by design,** because it is already adequate: sign-in, reason, charge list, confirmation, receipts, notifications, agent queue, proactive alert (ADR-011) and urgency.

## Consequences

- **+** No latency, cost or new failure mode on any live path today.
- **+** The decision is falsifiable: four measurable conditions turn the one AI path on, and the architecture for it is already fixed.
- **+** The learned component still meets the brief's requirement offline: a pre-registered comparison against the checklist on held-out cases.
- **−** The demo shows AI in the offline evaluation, not in the live conversation. That is a deliberate choice, and the reason is stated.
- **−** "I can't find it" stays a manual match for a person until the conditions hold.

## Alternatives considered

- **An AI assistant for the whole conversation.** It would add 1.6 to 2.6 s to every turn and a new failure mode to every step, to solve a reading problem the guided flow doesn't have. Rejected: no measured benefit on live paths. Reopen if a live path appears that must be decided from free text.
- **Turn the shadow extractor on online now.** Shadow mode costs tokens on every start and changes nothing for the customer, and the model hasn't passed its gates. Rejected. Reopen when decision 3's first two conditions hold, to collect live latency and usage before activation.
- **The model picks the charge directly from the customer's transactions.** It would send transaction data to the model and let a model output choose a record. Rejected: data minimization and ADR-002's boundary. Reopen never for picking; suggestions stay deterministic.
- **A trained urgency or routing classifier (SageMaker).** ADR-011 found no validated pre-outcome signal to learn from. Rejected. Reopen with a timestamped label or new pre-outcome fields.
