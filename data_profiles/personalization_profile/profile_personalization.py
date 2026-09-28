#!/usr/bin/env python3
"""
Personalization signal profiler -- answers "which columns can gold.customer_personalization_profile
actually rely on?" against the real Silver tables, before any Gold DDL gets written.

This does not build anything. It only measures, for each candidate personalization signal proposed
in the team's design discussion:

  - Coverage: what fraction of customers actually have the signal at all (many customers have zero
    interactions, zero transcripts, zero complaints -- "cold" customers change what the agent can
    personalize on day one).
  - Consistency: where the same fact (e.g. accent) is recorded in two places (dim_customers vs.
    fact_call_center_interactions vs. fact_call_transcripts), do they agree often enough to trust
    one over the other, or do they disagree enough to need a documented precedence rule?
  - Cardinality/domain: the actual distinct values behind each categorical signal (segment, channel,
    accent, language) -- verified, not assumed from the data dictionary, which this project has
    already found wrong multiple times.
  - Language reality check: the hackathon requires Spanish AND Portuguese; this checks what
    detected_language actually contains before any Portuguese-specific personalization is designed.

Reads only silver.* tables (read-only connection), so it never risks writing to the shared
.duckdb file. Mirrors data_profiles/bronze_data_profile/profile_bronze.py's path resolution
convention (PROJECT_ROOT/DATA_DIR/DUCKDB_PATH env var overrides) so it finds the same database
without any project-specific setup.

Usage:
    python profile_personalization.py                  # full report to personalization_profile.md
    python profile_personalization.py --output foo.md
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path
from typing import List

import duckdb

SCRIPT_DIR = Path(__file__).resolve().parent


def resolve_duckdb_path() -> Path:
    default_root = SCRIPT_DIR.parent.parent
    project_root = Path(os.environ.get("PROJECT_ROOT", default_root)).resolve()
    data_dir = Path(os.environ.get("DATA_DIR", project_root / "data")).resolve()
    return Path(os.environ.get("DUCKDB_PATH", data_dir / "latam_bank.duckdb"))


def section(title: str) -> str:
    return f"\n## {title}\n"


def table_md(headers: List[str], rows: List[tuple]) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    for row in rows:
        out.append("| " + " | ".join("" if v is None else str(v) for v in row) + " |")
    return "\n".join(out) + "\n"


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(SCRIPT_DIR / "personalization_profile.md"))
    parser.add_argument("--memory-limit", default="3GB")
    args = parser.parse_args(argv if argv is not None else sys.argv[1:])

    db_path = resolve_duckdb_path()
    if not db_path.is_file():
        print(f"No DuckDB file at {db_path}", file=sys.stderr)
        return 1

    lines: List[str] = [
        "# Personalization signal profile",
        "",
        f"Source: `{db_path}` (Silver tables, read-only).",
        "Generated to decide what `gold.customer_personalization_profile` can safely contain.",
    ]

    t0 = time.monotonic()
    with duckdb.connect(str(db_path), read_only=True) as con:
        temp_dir = db_path.parent / "duckdb_tmp"
        temp_dir.mkdir(parents=True, exist_ok=True)
        con.execute("SET memory_limit=?", [args.memory_limit])
        con.execute("SET temp_directory=?", [str(temp_dir)])
        con.execute("SET threads=?", [int(os.environ.get("DUCKDB_THREADS", "2"))])

        total_customers = con.execute("SELECT count(*) FROM silver.dim_customers").fetchone()[0]
        lines.append(f"\nTotal customers in `silver.dim_customers`: **{total_customers:,}**")

        # ------------------------------------------------------------------------------
        # 1. Coverage: how many customers actually have each history source at all
        # ------------------------------------------------------------------------------
        lines.append(section("1. Signal coverage per customer (cold-start exposure)"))
        coverage_queries = {
            "fact_call_center_interactions (any interaction ever)": "SELECT count(DISTINCT customer_id) FROM silver.fact_call_center_interactions",
            "fact_call_transcripts (any transcript ever)": "SELECT count(DISTINCT customer_id) FROM silver.fact_call_transcripts",
            "fact_complaints (any complaint ever)": "SELECT count(DISTINCT customer_id) FROM silver.fact_complaints",
            "fact_satisfaction_surveys (any survey ever)": "SELECT count(DISTINCT customer_id) FROM silver.fact_satisfaction_surveys",
            "fact_digital_events (any digital session ever)": "SELECT count(DISTINCT customer_id) FROM silver.fact_digital_events",
            "fact_transactions (any transaction ever)": "SELECT count(DISTINCT customer_id) FROM silver.fact_transactions",
        }
        rows = []
        for label, q in coverage_queries.items():
            n = con.execute(q).fetchone()[0]
            rows.append((label, f"{n:,}", f"{100*n/total_customers:.1f}%"))
        lines.append(table_md(["Source", "Distinct customers", "% of all customers"], rows))

        # Customers with ZERO service-relevant history at all -- the true "cold start" population
        cold = con.execute(
            """
            SELECT count(*) FROM silver.dim_customers c
            WHERE NOT EXISTS (SELECT 1 FROM silver.fact_call_center_interactions i WHERE i.customer_id = c.customer_id)
              AND NOT EXISTS (SELECT 1 FROM silver.fact_complaints cp WHERE cp.customer_id = c.customer_id)
              AND NOT EXISTS (SELECT 1 FROM silver.fact_digital_events d WHERE d.customer_id = c.customer_id)
            """
        ).fetchone()[0]
        lines.append(f"\nCustomers with **zero** interactions, complaints, or digital events at all: "
                      f"**{cold:,}** ({100*cold/total_customers:.1f}% of {total_customers:,}). "
                      "These customers cannot get any behavior-based personalization on first contact; "
                      "the profile must fall back to `dim_customers` fields (segment, country, accent) only.")

        # ------------------------------------------------------------------------------
        # 2. Accent / language consistency across sources
        # ------------------------------------------------------------------------------
        lines.append(section("2. Accent signal: domain and cross-source agreement"))

        rows = con.execute(
            "SELECT detected_accent, count(*) FROM silver.dim_customers GROUP BY 1 ORDER BY 2 DESC"
        ).fetchall()
        lines.append("`dim_customers.detected_accent` domain:\n")
        lines.append(table_md(["detected_accent", "customers"], rows))

        rows = con.execute(
            "SELECT customer_detected_accent, count(*) FROM silver.fact_call_center_interactions GROUP BY 1 ORDER BY 2 DESC"
        ).fetchall()
        lines.append("`fact_call_center_interactions.customer_detected_accent` domain:\n")
        lines.append(table_md(["customer_detected_accent", "interactions"], rows))

        rows = con.execute(
            "SELECT detected_accent, count(*) FROM silver.fact_call_transcripts GROUP BY 1 ORDER BY 2 DESC"
        ).fetchall()
        lines.append("`fact_call_transcripts.detected_accent` domain:\n")
        lines.append(table_md(["detected_accent", "transcripts"], rows))

        # Agreement: for customers with BOTH a dim_customers accent and at least one interaction
        # accent, what fraction of their interactions match their profile accent?
        agree = con.execute(
            """
            WITH per_customer AS (
                SELECT i.customer_id,
                       c.detected_accent AS profile_accent,
                       mode(i.customer_detected_accent) AS interaction_mode_accent,
                       count(*) AS n_interactions
                FROM silver.fact_call_center_interactions i
                JOIN silver.dim_customers c USING (customer_id)
                WHERE i.customer_detected_accent IS NOT NULL AND c.detected_accent IS NOT NULL
                GROUP BY 1, 2
            )
            SELECT
                count(*) AS customers_compared,
                sum(CASE WHEN profile_accent = interaction_mode_accent THEN 1 ELSE 0 END) AS agree_n,
                round(100.0 * sum(CASE WHEN profile_accent = interaction_mode_accent THEN 1 ELSE 0 END) / count(*), 1) AS agree_pct
            FROM per_customer
            """
        ).fetchone()
        lines.append(
            f"\nCustomers with both a `dim_customers.detected_accent` and >=1 interaction accent: "
            f"**{agree[0]:,}**. Their most-common interaction accent matches the profile accent for "
            f"**{agree[1]:,} ({agree[2]}%)**. This is the evidence for whether `dim_customers.detected_accent` "
            "can be trusted as the single source of truth, or whether a per-interaction mode is more reliable."
        )

        # ------------------------------------------------------------------------------
        # 3. Language reality check -- Spanish/Portuguese requirement
        # ------------------------------------------------------------------------------
        lines.append(section("3. Language domain (Spanish/Portuguese requirement check)"))
        rows = con.execute(
            "SELECT detected_language, count(*) FROM silver.fact_call_transcripts GROUP BY 1 ORDER BY 2 DESC"
        ).fetchall()
        lines.append(table_md(["detected_language", "transcripts"], rows))
        pt_count = con.execute(
            "SELECT count(*) FROM silver.fact_call_transcripts WHERE lower(detected_language) LIKE 'pt%'"
        ).fetchone()[0]
        lines.append(f"\nTranscripts with a Portuguese `detected_language`: **{pt_count:,}**. "
                      "If this is zero, Portuguese personalization cannot be derived from this dataset "
                      "and must be reported as a data limitation, not silently skipped.")

        # ------------------------------------------------------------------------------
        # 4. Segment / country / channel domains (for personalization tone rules)
        # ------------------------------------------------------------------------------
        lines.append(section("4. Segment, country, and digital-channel domains"))
        rows = con.execute("SELECT segment, count(*) FROM silver.dim_customers GROUP BY 1 ORDER BY 2 DESC").fetchall()
        lines.append("`dim_customers.segment`:\n")
        lines.append(table_md(["segment", "customers"], rows))

        rows = con.execute("SELECT country, count(*) FROM silver.dim_customers GROUP BY 1 ORDER BY 2 DESC").fetchall()
        lines.append("`dim_customers.country`:\n")
        lines.append(table_md(["country", "customers"], rows))

        rows = con.execute(
            "SELECT channel, count(*) FROM silver.fact_digital_events GROUP BY 1 ORDER BY 2 DESC"
        ).fetchall()
        lines.append("`fact_digital_events.channel` (for preferred-channel personalization):\n")
        lines.append(table_md(["channel", "events"], rows))

        # ------------------------------------------------------------------------------
        # 5. Repeat contact / complaint overlap (for the "repeat complainer" signal)
        # ------------------------------------------------------------------------------
        lines.append(section("5. Repeat-contact and complaint signal strength"))
        rows = con.execute(
            """
            SELECT reason_category, count(*) AS interactions, count(DISTINCT customer_id) AS customers
            FROM silver.fact_call_center_interactions GROUP BY 1 ORDER BY 2 DESC
            """
        ).fetchall()
        lines.append("`fact_call_center_interactions.reason_category` volume:\n")
        lines.append(table_md(["reason_category", "interactions", "distinct_customers"], rows))

        repeat = con.execute(
            """
            WITH per_cust AS (
                SELECT customer_id, reason_category, count(*) AS n
                FROM silver.fact_call_center_interactions
                GROUP BY 1, 2
            )
            SELECT count(DISTINCT customer_id) FROM per_cust WHERE n >= 2
            """
        ).fetchone()[0]
        lines.append(f"\nCustomers with >=2 interactions in the SAME `reason_category` (ever, not windowed): "
                      f"**{repeat:,}** ({100*repeat/total_customers:.1f}% of all customers). "
                      "This is the population for whom a 'you've contacted us about this before' "
                      "personalization would actually trigger.")

        open_complaints = con.execute(
            "SELECT count(DISTINCT customer_id) FROM silver.fact_complaints WHERE status IN ('Open','In Process','Escalated')"
        ).fetchone()[0]
        lines.append(f"\nCustomers with a currently open/in-process/escalated complaint: **{open_complaints:,}** "
                      f"({100*open_complaints/total_customers:.1f}% of all customers).")

        # ------------------------------------------------------------------------------
        # 6. Sentiment / CSAT coverage and null rates
        # ------------------------------------------------------------------------------
        lines.append(section("6. Sentiment and CSAT coverage"))
        row = con.execute(
            """
            SELECT
                count(*) AS interactions,
                sum(CASE WHEN sentiment_score IS NULL THEN 1 ELSE 0 END) AS null_sentiment,
                round(100.0 * sum(CASE WHEN sentiment_score IS NULL THEN 1 ELSE 0 END) / count(*), 1) AS null_pct
            FROM silver.fact_call_center_interactions
            """
        ).fetchone()
        lines.append(f"`sentiment_score` null rate in interactions: {row[1]:,}/{row[0]:,} ({row[2]}%).")

        row = con.execute(
            "SELECT survey_type, count(*), round(avg(main_score),2) FROM silver.fact_satisfaction_surveys GROUP BY 1 ORDER BY 2 DESC"
        ).fetchall()
        lines.append("\n`fact_satisfaction_surveys` by type (main_score is on a different scale per type):\n")
        lines.append(table_md(["survey_type", "surveys", "avg_main_score"], row))

        # ------------------------------------------------------------------------------
        # 7. accepts_marketing gate coverage
        # ------------------------------------------------------------------------------
        lines.append(section("7. Consent gate for proactive personalization"))
        row = con.execute(
            "SELECT accepts_marketing, count(*) FROM silver.dim_customers GROUP BY 1 ORDER BY 2 DESC"
        ).fetchall()
        lines.append(table_md(["accepts_marketing", "customers"], row))

    elapsed = time.monotonic() - t0
    lines.append(f"\n---\nProfiled in {elapsed:.1f}s.\n")

    Path(args.output).write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {args.output} in {elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
