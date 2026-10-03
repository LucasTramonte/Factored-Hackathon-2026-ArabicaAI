# ADR-011 — Proactive alert: the bank's fraud flag, not the charge amount

- **Status:** Proposed
- **Date:** 2026-10-04
- **Deciders:** Lucas, Roberto, Manoella

## Context

The product owner asked for a proactive experience, following an evaluator's feedback (André): when a case is urgent enough, the service should reach the customer first instead of waiting for them to start every interaction. The challenge documents don't require this. It is a product decision, kept inside ADR-002's scope (intake with human handoff; nothing refunds, blocks a card or decides fraud).

Roberto's plan (#100) designed the experience: one dismissible banner on the home, two taps, the guided chat prefilled, and "a person reviews every report". It proposed the amount tier of the urgency lane as the trigger. That tier is a stated policy, not a measured one (DF-024). This ADR asks what the data says should trigger the alert.

**Target and unit.** One transaction. The target is the dataset's label `is_fraud`, the closest observable stand-in for "a charge the customer will not recognize". Complaints can't be linked to transactions (DF-002, DF-003), so they can't serve as the target. Only signals that exist when the charge is recorded are candidates; outcomes recorded later (complaints, SLA, surveys) are not.

**Evidence** (Silver, design window 2023-06-17 to 2025-12-31, ADR-005; 3,738,506 transactions, 3,713 fraud, 0.099%; aggregates only; queries in [`PA-01_fraud_signal.sql`](../../data_foundation/queries/proactive/PA-01_fraud_signal.sql)):

1. **The amount does not separate fraud.** `amount_usd` for fraud against legitimate: median 450.82 against 466.78, p90 4,821 against 5,117, p99 9,456 against 9,510. A "high charge" alert would mostly reach legitimate charges.
2. **Nothing else observable at transaction time separates it either.** Fraud rates are all around 0.10% across transaction type, category, channel, status, merchant category and currency, and 0.110% against 0.099% for foreign against home-country charges.
3. **The bank's own `fraud_score` does, and the separation is stable over time.** Legitimate transactions never score above 30.0 in any of the 31 months. Temporal split: the cut is chosen on 2023-06-17 to 2024-12-31, then checked on the first and second halves of 2025 ([chart](../Evidence/proactive-alert-temporal-split.svg)):

   | `fraud_score > 30` | Days | Flagged | Alerts a day (whole bank) | Precision | Recall |
   |---|---|---|---|---|---|
   | Train (2023-06-17 to 2024-12-31) | 564 | 1,265 | 2.24 | 1.000 | 0.551 |
   | Validation (2025 H1) | 181 | 386 | 2.13 | 1.000 | 0.538 |
   | Test (2025 H2) | 184 | 375 | 2.04 | 1.000 | 0.537 |

   Lower cuts collapse: at `> 25`, test alerts rise to about 540 a day at 0.4% precision; at `> 20`, to about 1,076 a day at 0.2%. Higher cuts only lose recall (`> 50`: 0.37). So 30 is where the data puts the cut, not a number we chose.
4. **Coverage.** About 20% of transactions have no score, and so do about 20% of frauds (137 of 699 in the test half). With the frauds whose score falls in the legitimate range, about 46% of fraud is not flagged. Nothing in the data recovers them, because no other field separates fraud.
5. **Volume.** The test half flagged 375 charges for 373 customers in 184 days. Almost every flagged customer gets one alert, and the bank as a whole about two a day.

**Caveat.** Perfect precision is almost certainly an artifact of the synthetic generator: legitimate scores are capped at 30.0, which real scores would not be. It is reported as a property of this dataset, not a claim about production. A real deployment would set the cut from the bank's own score calibration and a measured false-positive cost.

## Decision

1. **The alert fires on the bank's fraud flag**, `fraud_score > 30`, computed offline in the Gold slice. Only a boolean `bank_flagged` reaches D1, on the customer's own transaction. The score itself never leaves Silver (data minimization). The cut lives in one reviewed constant with this ADR's evidence. A change to it is a data change, reviewed like any other Gold change.
2. **In-app first.** At sign-in, the home shows at most one banner, for the newest flagged charge the customer hasn't answered: "We noticed a charge that looks unusual: {merchant}, {amount} {currency}, {date}. Do you recognize it?"
   - "Yes, it's mine" records the answer.
   - "I don't recognize it" opens the guided chat on that charge, prefilled; it then follows the normal confirmation path.
   - The banner never says fraud, blocked or refunded, and it says that a person reviews every report (ADR-002).
3. **Email is designed, not built for the demo.** A proactive email needs something that runs without the customer signing in (a scheduled trigger), and SES production access. The demo data is a fixed seed, so no new charges arrive. When those two exist, the same flag sends **one** email per flagged charge, keyed by the transaction in the outbox (idempotent under retries), with reference-level content only and no amount or merchant in the subject.
4. **No repeated or unnecessary alerts.**
   - One alert per charge.
   - Once answered either way, it never shows again; the answer is stored server-side, keyed by customer and transaction.
   - An already reported charge never alerts.
   - Only flagged charges alert, never "high" ones.
   - At about two a day for the whole bank, alert fatigue is not a measured risk at this cut.
5. **Routing.** A report that starts from the alert, or any report on a bank-flagged charge, joins the urgent lane of the agent queue and is marked "from the bank's alert". This is the one routing change the evidence supports: at this cut the charges flagged are fraud in this data. The amount tier stays in the lane as the stated policy it is (DF-024), not as evidence.
6. **No trained model, no SageMaker, no new cloud service.**
   - A rule on an existing score already reaches precision 1.000 on held-out periods.
   - The remaining recall can't be learned from fields that don't separate fraud.
   - Infrastructure cost: one boolean column, one small table of answers in D1, and the existing Worker and outbox.
7. **Security.**
   - The alert is read from the session customer's own transactions only; there is no customer id in any request.
   - Answers are idempotent writes checked against the live session.
   - Events carry references only.
   - An admin acting as a customer (ADR-007, decision 10) sees that customer's alert, but its answer is recorded as the admin's, so it never silences the alert for the real customer.

## Consequences

- **+** The trigger is measured and held out in time, and the threshold comes from the data.
- **+** About two alerts a day bank-wide: proactive help without notification noise.
- **+** Customers whose charge the bank already doubts are reached before they have to find it.
- **+** Agents see those reports first.
- **+** Nothing new to run or pay for.
- **−** About half of fraud is never flagged, so the alert supplements the customer-initiated report and doesn't replace it.
- **−** Precision on this dataset is too clean to be a production estimate; the caveat travels with every figure.
- **−** Email waits for a scheduled trigger and SES production access.
- **−** The flag reaches D1 only through a Gold rebuild and a reviewed seed load (a person's step).

## Alternatives considered

- **The amount tier as trigger (#100's proposal).** Fraud and legitimate amounts have the same distribution, so it alerts on legitimate charges. Rejected: not supported by the data. Reopen if the bank supplies a loss-weighted target where amount is the cost.
- **Above the customer's own p95 (the lane's second rule).** By definition about 5% of any customer's charges sit above their own p95, so every customer with enough history would see banners. Rejected: unbounded notification volume with no evidence of urgency. Reopen with a target that shows it separates.
- **A trained classifier (logistic regression or gradient boosting, SageMaker).** No field other than the score separates fraud, so a model can't recover the missed half, and the score already gives held-out precision of 1.000. Rejected: no measurable gain for added cost and operations. Reopen if non-synthetic data adds signals (device, velocity, merchant history) with real separation.
- **Email only.** It can't run without a scheduled trigger and SES production access, and it reaches customers outside the session where they can act. Rejected for the demo. Reopen when both exist (decision 3).
- **No proactive alert.** It ignores a signal the bank already has and the product requirement. Rejected.
