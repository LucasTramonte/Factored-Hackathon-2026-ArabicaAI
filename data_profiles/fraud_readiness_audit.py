"""Fraud-modeling readiness audit on Silver: country aliases, USD amount normalization and label timing.

Read-only, aggregate-only. Every query is grouped SQL in DuckDB; Python holds only result rows
(a few dozen). Prints Markdown to stdout. Run after `make pipeline`:

    .venv/bin/python data_profiles/fraud_readiness_audit.py > data_profiles/fraud_readiness_audit.md
"""
from __future__ import annotations

import sys
from pathlib import Path

import duckdb

DB = Path(sys.argv[1] if len(sys.argv) > 1 else "data/latam_bank.duckdb")

QUERIES = {
    "Country values after Silver canonicalization (transactions)": """
        SELECT transaction_country AS value, count(*) AS rows FROM silver.fact_transactions
        GROUP BY 1 ORDER BY 2 DESC""",
    "Country values after Silver canonicalization (digital_events.ip_country)": """
        SELECT ip_country AS value, count(*) AS rows FROM silver.fact_digital_events
        GROUP BY 1 ORDER BY 2 DESC""",
    "Transaction currency by country": """
        SELECT transaction_country, currency, count(*) AS rows FROM silver.fact_transactions
        GROUP BY 1, 2 ORDER BY 3 DESC""",
    "USD amount coverage by currency": """
        SELECT t.currency,
               count(*) AS rows,
               count(b.amount_usd) FILTER (WHERE trim(b.amount_usd) <> '') AS source_usd,
               count(*) FILTER (WHERE upper(t.currency) = 'USD') AS native_usd,
               count(*) FILTER (WHERE t.amount_usd_is_estimated) AS fx_estimated,
               count(*) FILTER (WHERE t.amount_usd IS NULL) AS still_missing
        FROM silver.fact_transactions t
        JOIN (SELECT DISTINCT ON (transaction_id) transaction_id, amount_usd
              FROM bronze.transactions ORDER BY transaction_id, _ingested_at DESC) b USING (transaction_id)
        GROUP BY 1 ORDER BY 2 DESC""",
    # The FX fill is only trustworthy if the daily rate reproduces amount_usd where the source supplies it.
    "Daily FX rate vs source amount_usd (rows where both exist)": """
        SELECT t.currency,
               count(*) AS comparable,
               count(*) FILTER (WHERE abs(t.amount_usd / (t.amount * fx.exchange_rate) - 1) > 0.01) AS off_by_over_1pct,
               round(median(t.amount_usd / (t.amount * fx.exchange_rate)), 4) AS median_ratio
        FROM silver.fact_transactions t
        JOIN silver.dim_fx_rates fx ON fx.source_currency = trim(t.currency) AND fx.target_currency = 'USD'
             AND fx.rate_date = CAST(t.transaction_date AS DATE)
        WHERE NOT t.amount_usd_is_estimated AND upper(t.currency) <> 'USD' AND t.amount <> 0
        GROUP BY 1 ORDER BY 2 DESC""",
    # If fraud_score separates the label almost perfectly, it was likely computed with hindsight.
    "fraud_score distribution by label": """
        SELECT is_fraud, count(*) AS rows, count(fraud_score) AS scored,
               min(fraud_score) AS min, round(quantile_cont(fraud_score, 0.05), 2) AS p05,
               median(fraud_score) AS p50, round(quantile_cont(fraud_score, 0.95), 2) AS p95, max(fraud_score) AS max
        FROM silver.fact_transactions GROUP BY 1 ORDER BY 1""",
    "Rows scoring above the highest non-fraud score": """
        SELECT is_fraud, count(fraud_score) AS scored,
               count(*) FILTER (WHERE fraud_score > (SELECT max(fraud_score) FROM silver.fact_transactions
                                                     WHERE NOT is_fraud)) AS above_nonfraud_max
        FROM silver.fact_transactions GROUP BY 1 ORDER BY 1""",
    "Label/score separation (AUC: chance a fraud row outscores a non-fraud row)": """
        WITH r AS (SELECT is_fraud, rank() OVER (ORDER BY fraud_score) AS rk
                   FROM silver.fact_transactions WHERE fraud_score IS NOT NULL AND is_fraud IS NOT NULL),
             n AS (SELECT count(*) FILTER (WHERE is_fraud) AS pos, count(*) FILTER (WHERE NOT is_fraud) AS neg FROM r)
        SELECT pos, neg, round((sum(rk) FILTER (WHERE is_fraud) - pos * (pos + 1) / 2.0) / (pos * neg), 4) AS auc
        FROM r, n GROUP BY pos, neg""",
    # No label timestamp exists; processing lag is the only timing signal the data carries.
    "Processing lag (process_date - transaction_date, days) by label": """
        SELECT is_fraud, count(*) AS rows,
               min(process_date - CAST(transaction_date AS DATE)) AS min_days,
               median(process_date - CAST(transaction_date AS DATE)) AS p50_days,
               max(process_date - CAST(transaction_date AS DATE)) AS max_days
        FROM silver.fact_transactions GROUP BY 1 ORDER BY 1""",
    "Rows with process_date before the transaction's calendar date": """
        SELECT count(*) FILTER (WHERE process_date < CAST(transaction_date AS DATE)) AS earlier, count(*) AS rows
        FROM silver.fact_transactions""",
}


def markdown(rows: list[tuple], cols: list[str]) -> str:
    """Renders query rows as a Markdown table."""
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    lines += ["| " + " | ".join(f"{v:,}" if isinstance(v, int) else str(v) for v in r) + " |" for r in rows]
    return "\n".join(lines)


def main() -> None:
    con = duckdb.connect(str(DB), read_only=True)
    con.execute("SET memory_limit = '4GB'")
    print(f"# Fraud-modeling readiness audit\n\nSource: `{DB}` (Silver + Bronze), synthetic data.\n")
    for title, sql in QUERIES.items():
        cur = con.execute(sql)
        print(f"## {title}\n\n{markdown(cur.fetchall(), [d[0] for d in cur.description])}\n")


if __name__ == "__main__":
    main()
