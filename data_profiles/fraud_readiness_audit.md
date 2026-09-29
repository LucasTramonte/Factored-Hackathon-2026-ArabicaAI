# Fraud-modeling readiness audit

Source: `data/latam_bank.duckdb` (Silver + Bronze), synthetic data.

## Country values after Silver canonicalization (transactions)

| value | rows |
|---|---|
| México | 2,146,309 |
| Colombia | 1,289,503 |
| Argentina | 867,561 |
| USA | 40,621 |
| Spain | 40,542 |
| Brazil | 40,472 |

## Country values after Silver canonicalization (digital_events.ip_country)

| value | rows |
|---|---|
| México | 7,281,067 |
| Colombia | 4,806,882 |
| Argentina | 3,533,045 |

## Transaction currency by country

| transaction_country | currency | rows |
|---|---|---|
| México | USD | 2,126,409 |
| Colombia | COP | 1,134,801 |
| Argentina | ARS | 752,794 |
| Colombia | USD | 146,719 |
| Argentina | USD | 102,708 |
| Spain | USD | 20,829 |
| Brazil | USD | 20,726 |
| USA | USD | 20,588 |
| Argentina | COP | 12,059 |
| USA | COP | 12,002 |
| México | COP | 11,905 |
| Brazil | COP | 11,887 |
| Spain | COP | 11,790 |
| USA | ARS | 8,031 |
| México | ARS | 7,995 |
| Colombia | ARS | 7,983 |
| Spain | ARS | 7,923 |
| Brazil | ARS | 7,859 |

## USD amount coverage by currency

| currency | rows | source_usd | native_usd | fx_estimated | still_missing |
|---|---|---|---|---|---|
| USD | 2,437,979 | 0 | 2,437,979 | 0 | 0 |
| COP | 1,194,444 | 1,135,008 | 0 | 59,421 | 15 |
| ARS | 792,585 | 752,544 | 0 | 40,021 | 20 |

## Daily FX rate vs source amount_usd (rows where both exist)

| currency | comparable | off_by_over_1pct | median_ratio | amount_weighted_ratio |
|---|---|---|---|---|
| COP | 1,134,663 | 593,669 | 1.0 | 1.0005 |
| ARS | 752,317 | 361,501 | 0.9994 | 0.9995 |

## fraud_score distribution by label

| is_fraud | rows | scored | min | p05 | p50 | p95 | max |
|---|---|---|---|---|---|---|---|
| 0 | 4,420,692 | 3,536,426 | 0.0 | 1.5 | 15.0 | 28.5 | 30.0 |
| 1 | 4,316 | 3,425 | 0.01 | 4.72 | 48.93 | 95.23 | 99.99 |

## Rows scoring above the highest non-fraud score

| is_fraud | scored | above_nonfraud_max |
|---|---|---|
| 0 | 3,536,426 | 0 |
| 1 | 3,425 | 2,373 |

## Label/score separation (AUC: chance a fraud row outscores a non-fraud row)

| pos | neg | auc |
|---|---|---|
| 3,425 | 3,536,426 | 0.8469 |

## Processing lag (process_date - transaction_date, days) by label

| is_fraud | rows | min_days | p50_days | max_days |
|---|---|---|---|---|
| 0 | 4,420,692 | -1 | 0.0 | 0 |
| 1 | 4,316 | -1 | 0.0 | 0 |

## Rows with process_date before the transaction's calendar date

| earlier | rows |
|---|---|
| 1,106,307 | 4,425,008 |

