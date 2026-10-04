# ADR-011 — Proactive alert: the bank's own fraud flag as an input, never the charge amount

- **Status:** Proposed
- **Date:** 2026-10-04
- **Deciders:** Lucas, Roberto, Manoella

## Context

The product owner asked for a proactive experience, following an evaluator's feedback (André): when a case is urgent enough, the service should reach the customer first instead of waiting for them to start every interaction. The challenge documents don't require this. It is a product decision, kept inside ADR-002's scope (intake with human handoff; nothing refunds, blocks a card or decides fraud).

Roberto's plan (#100) designed the experience: one dismissible banner on the home, two taps, the guided chat prefilled, and "a person reviews every report". It proposed the amount tier of the urgency lane as the trigger. That tier is a stated policy, not a measured one (DF-024). The requirement for this ADR is that urgency be derived from the data, not stated.

**A constraint the team already recorded.** [`fraud_readiness_findings.md`](../../data_profiles/fraud_readiness_findings.md) (Roberto, 2026-09-28) found that `fraud_score` is deterministically tied to `is_fraud`: no legitimate row scores above 30.0. The snapshot can't show which was set first, and `is_fraud` has no availability timestamp. The team therefore keeps `fraud_score` out of every model and intake decision until the organizers confirm its provenance, and ADR-002 rejects fraud triage on the same grounds. This ADR keeps that rule.

**Target and unit.** One transaction. The only transaction-level outcome is the label `is_fraud`. Complaints can't be linked to transactions (DF-002, DF-003), so they can't serve as the target for a pre-complaint signal. Only fields that exist when the charge is recorded are candidates.

**Evidence** (Silver, design window 2023-06-17 to 2025-12-31, ADR-005; 3,738,506 transactions, 3,713 fraud, 0.099%; aggregates only; queries in [`PA-01_fraud_signal.sql`](../../data_foundation/queries/proactive/PA-01_fraud_signal.sql)). Each field is compared on its own, per period of a temporal split: train 2023-06-17 to 2024-12-31, validation 2025 H1, test 2025 H2.

1. **The amount does not separate fraud, in any period.** `amount_usd` p50, p90 and p99, fraud against legitimate:

   | Period | Fraud | Legitimate |
   |---|---|---|
   | Train | 452.5 / 4,824.8 / 9,344.8 | 466.9 / 5,124.1 / 9,510.7 |
   | Validation | 447.8 / 4,888.1 / 9,666.8 | 466.0 / 5,095.8 / 9,505.1 |
   | Test | 451.0 / 4,720.5 / 9,671.3 | 467.2 / 5,120.0 / 9,508.5 |

   A "high charge" trigger would reach legitimate and fraudulent charges alike. This is the finding that decides the trigger.
2. **No other field separates it on its own, in any period.** Across transaction type, channel, status, merchant category and currency (categories with at least 1,000 rows), the fraud rate stays within 0.05–0.13% in every period. Foreign against home-country charges goes 0.123% against 0.100% in train, 0.106% against 0.099% in validation, and 0.076% against 0.095% in test: no stable lift.
3. **`fraud_score` separates the label, but that is not evidence that it predicts fraud.** `fraud_score > 30` flags 2.24, 2.13 and 2.04 charges a day bank-wide in the three periods, at precision 1.000 and recall 0.551, 0.538 and 0.537 ([chart](../Evidence/proactive-alert-temporal-split.svg)). Legitimate scores never exceed 30.0 in any of the 31 months. Two readings fit: the score was derived from the label (leakage), or the label was set by a rule on the score (the score is then an upstream fraud-engine output). One snapshot can't tell them apart (the 2026-09-28 finding). Read as an operational volume (about two flags a day, almost one per customer), the figure is useful. Read as a performance estimate, it is not.

**What the data supports.** It does not support amount, or any other single transaction field, as an urgency trigger. It does not validate any field as a pre-outcome urgency signal: the one strong separator has unconfirmed provenance. A proactive alert can therefore only be triggered by an urgency signal the bank provides. In a real bank that is the fraud engine's flag at authorization.

## Decision

1. **The alert fires on a flag the bank provides, `bank_flagged`, on the customer's own charge.** This service neither computes nor judges fraud; it shows the bank's flag and asks the customer.
   - **In this prototype** the flag is set only on authored fictitious charges: three small ones (Diego, Elena, Marco). The demo shows the experience without relying on a field that may leak the label.
   - **The dataset cohort is not flagged from `fraud_score`.** That waits until the organizers confirm the score is assigned before, and independently of, the label. If they confirm it, the flag becomes `fraud_score > 30`, computed offline in Gold; only the boolean reaches D1, never the score. The measured volume of about two a day bank-wide then applies.
2. **In-app first.** At sign-in, the home shows at most one banner, for the newest flagged charge the customer hasn't answered: "We noticed an unusual charge on your account: {merchant}, {amount} {currency}, {date}. Do you recognize it?"
   - "Yes, it's mine" records the answer.
   - "I don't recognize it, report it" opens the guided chat on that charge; it then follows the normal confirmation path.
   - It never says fraud, blocked or refunded, and it says that a person reviews every report (ADR-002).
3. **Email is designed, not built for the demo.** It needs something that runs without the customer signing in (a scheduled trigger), and SES production access. When both exist, it sends **one** email per flagged charge, keyed by the transaction in the outbox (idempotent under retries), with reference-level content only.
4. **No repeated or unnecessary alerts.**
   - One alert per charge.
   - Once answered either way, it never shows again; the answer is stored server-side by customer and transaction.
   - A charge that already has a report never alerts.
   - Only flagged charges alert; the amount never triggers one.
5. **Routing.** A report on a flagged charge joins the urgent lane of the agent queue. The bank's own signal ranks it, not an inference of ours. The amount tier stays in the lane as the stated policy it is (DF-024); this ADR shows that the data doesn't support it as evidence of urgency.
6. **No trained model, no SageMaker, no new cloud service.**
   - There is no validated pre-outcome signal to learn from: `is_fraud` has no availability time, and the one strong separator may leak it.
   - The tested fields don't separate fraud one at a time. Joint models were not tested, and with a label of unknown timing their evaluation couldn't be trusted either.
   - Infrastructure cost: one boolean column, one small table of answers in D1, and the existing Worker.
7. **Security.**
   - The alert is read from the session customer's own transactions only; there is no customer id in any request.
   - Answers are idempotent writes checked against the live session.
   - An admin acting as a customer (ADR-007, decision 10) sees that customer's alert, but its answer is recorded as the admin's, so it never silences the alert for the real customer.

## Consequences

- **+** The trigger is not invented. The data rules out the amount and every other single field. What remains is the bank's own flag, used as an input and not as a claim of ours.
- **+** No field that may leak the label reaches the online service.
- **+** Customers whose charge the bank doubts are reached before they have to find it, and agents see those reports first.
- **+** Nothing new to run or pay for.
- **−** In this prototype the flags are authored. Until the organizers confirm `fraud_score`'s provenance, the alert demonstrates the experience, not a measured detection rate.
- **−** Even if the provenance is confirmed, about half of fraud would not be flagged (no score, or a score in the legitimate range). The alert supplements the customer-initiated report; it doesn't replace it.
- **−** Email waits for a scheduled trigger and SES production access.

## Alternatives considered

- **The amount tier as trigger (#100's proposal).** Fraud and legitimate amounts have the same distribution in every period, so it alerts on legitimate charges as often as on fraudulent ones. Rejected: contradicted by the data. Reopen if the bank supplies a loss-weighted target where amount is the cost.
- **Above the customer's own p95 (the lane's second rule).** By definition about 5% of any customer's charges sit above their own p95, so every customer with enough history would see banners. Rejected: unbounded volume with no evidence of urgency. Reopen with a target that shows it separates.
- **Derive the flag from `fraud_score > 30` now, for the dataset cohort.** The numbers look perfect, which is exactly why the team treats the score as possible leakage. Rejected for now: it would put a possibly leaky field in front of customers and evaluators. Reopen when the organizers confirm that the score is assigned before the label (decision 1).
- **A trained classifier (logistic regression or gradient boosting, SageMaker).** The label has no availability time, the tested fields don't separate it one at a time, and the strongest field may leak it. Rejected: nothing trustworthy to train or evaluate on. Reopen with a timestamped label or new pre-outcome fields (device, velocity, merchant history) that separate on held-out periods.
- **Email only.** It needs a scheduled trigger and SES production access, and it reaches customers outside the session where they can act. Rejected for the demo. Reopen when both exist (decision 3).
- **No proactive alert.** The product requirement stands, and the bank's own flag is a legitimate input even when this dataset can't validate it. Rejected: the experience can be built and demonstrated honestly with authored flags. Reopen if the bank has no fraud engine whose flag the service can receive.
