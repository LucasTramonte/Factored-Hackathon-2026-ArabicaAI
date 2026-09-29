#!/usr/bin/env python3
"""
Personalization signal profiler -- answers "which columns can gold.customer_personalization_profile
actually rely on?" against the real Silver tables, before any Gold DDL gets written.

This does not build anything. It only measures, for each candidate personalization signal proposed
in the team's design discussion:

  - Coverage: what fraction of customers actually have the signal at all (many customers have zero
    interactions, zero transcripts, zero complaints -- "cold" customers change what the agent can
    personalize on day one). Numerators count only customers present in silver.dim_customers;
    orphan fact IDs are reported separately.
  - Consistency: where the same fact (e.g. accent) is recorded in two places (dim_customers vs.
    fact_call_center_interactions vs. fact_call_transcripts), do they agree often enough to trust
    one over the other, or do they disagree enough to need a documented precedence rule?
  - Cardinality/domain: the actual distinct values behind each categorical signal (segment, channel,
    accent, language) -- verified, not assumed from the data dictionary, which this project has
    already found wrong multiple times.
  - Language reality check: the hackathon requires Spanish AND Portuguese; this checks what
    detected_language actually contains before any Portuguese-specific personalization is designed.

Queries and readings live in personalization_metrics.py, shared with the HTML report and the
notebook, so the three outputs always agree. Reads only silver.* tables (read-only connection).

Usage:
    python profile_personalization.py                  # full report to personalization_profile.md
    python profile_personalization.py --output foo.md
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import List

import personalization_metrics as pm


def section(title: str) -> str:
    return f"\n## {title}\n"


def table_md(headers: List[str], rows: List[tuple]) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    for row in rows:
        out.append("| " + " | ".join("" if v is None else str(v) for v in row) + " |")
    return "\n".join(out) + "\n"


def render(m: dict, source: str) -> str:
    """Markdown report from ``personalization_metrics.measure`` output."""
    r = pm.readings(m)
    total = m["total_customers"]
    lines: List[str] = [
        "# Personalization signal profile",
        "",
        f"Source: `{source}` (Silver tables, read-only).",
        "Generated to decide what `gold.customer_personalization_profile` can safely contain.",
        f"\nTotal customers in `silver.dim_customers`: **{total:,}**",
    ]

    lines.append(section("1. Signal coverage per customer (cold-start exposure)"))
    lines.append(table_md(
        ["Source", "Distinct dimension customers", "% of all customers", "Orphan fact IDs"],
        [(c["source"], f"{c['customers']:,}", f"{c['pct']}%", f"{c['orphan_ids']:,}") for c in m["coverage"]]))
    lines.append(r["coverage"])

    lines.append(section("2. Accent signal: domain and cross-source agreement"))
    lines.append("`dim_customers.detected_accent` domain:\n")
    lines.append(table_md(["detected_accent", "customers"], m["accent_dim"]))
    lines.append("`fact_call_center_interactions.customer_detected_accent` domain:\n")
    lines.append(table_md(["customer_detected_accent", "interactions"], m["accent_interactions"]))
    lines.append("`fact_call_transcripts.detected_accent` domain:\n")
    lines.append(table_md(["detected_accent", "transcripts"], m["accent_transcripts"]))
    lines.append(r["accent"])

    lines.append(section("3. Language domain (Spanish/Portuguese requirement check)"))
    lines.append(table_md(["detected_language", "transcripts"], m["languages"]))
    lines.append(r["language"])

    lines.append(section("4. Segment, country, and digital-channel domains"))
    lines.append("`dim_customers.segment`:\n")
    lines.append(table_md(["segment", "customers"], m["segments"]))
    lines.append("`dim_customers.country`:\n")
    lines.append(table_md(["country", "customers"], m["countries"]))
    lines.append("`fact_digital_events.channel` (for preferred-channel personalization):\n")
    lines.append(table_md(["channel", "events"], m["channels"]))
    lines.append(r["segment"] + " " + r["country_channel"])

    lines.append(section("5. Repeat-contact and complaint signal strength"))
    lines.append("`fact_call_center_interactions.reason_category` volume:\n")
    lines.append(table_md(["reason_category", "interactions", "distinct_customers"], m["reasons"]))
    lines.append(r["repeat"])

    lines.append(section("6. Sentiment and CSAT coverage"))
    lines.append("`fact_satisfaction_surveys` by type (main_score is on a different scale per type):\n")
    lines.append(table_md(["survey_type", "surveys", "avg_main_score", "min", "max"], m["surveys"]))
    lines.append(r["sentiment"])

    lines.append(section("7. Consent gate for proactive personalization"))
    lines.append(table_md(["accepts_marketing", "customers"], m["consent"]))
    lines.append(r["consent"])

    lines.append(section("8. Recommended variables for gold.customer_personalization_profile"))
    lines.append(table_md(["Variable", "Source", "Evidence", "Decision"], pm.recommended(m)))
    return "\n".join(lines)


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(pm.SCRIPT_DIR / "personalization_profile.md"))
    parser.add_argument("--memory-limit", default="3GB")
    args = parser.parse_args(argv if argv is not None else sys.argv[1:])

    db_path = pm.resolve_duckdb_path()
    if not db_path.is_file():
        print(f"No DuckDB file at {db_path}", file=sys.stderr)
        return 1

    t0 = time.monotonic()
    with pm.connect(db_path, args.memory_limit) as con:
        m = pm.measure(con)
    elapsed = time.monotonic() - t0
    text = render(m, pm.display_path(db_path)) + f"\n---\nProfiled in {elapsed:.1f}s.\n"
    Path(args.output).write_text(text, encoding="utf-8")
    print(f"Wrote {args.output} in {elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
