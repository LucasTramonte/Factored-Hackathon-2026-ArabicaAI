"""Publish the reviewed complaint-timing baseline (``gold.complaint_timing``) to D1 through a committed seed.

Two steps, like the fictitious seed:

1. ``python -m data_pipelines.gold.service_timing --gold-db <file>`` reads the latest Gold build of
   ``gold.complaint_timing`` and writes the reviewed aggregate to ``back-end/seeds/service_timing.json``: per metric,
   p50, p90, ``n``, the population and its exclusions, with the window, source, query and Gold build that produced it.
   It holds no customer or complaint row, only counts and quantiles, so it is committed once reviewed.
2. ``render_seed()`` turns that JSON into the ``INSERT`` statements of migration ``0027_service_timing.sql``; a test
   fails if the migration and the JSON disagree. ``INSERT`` of new rows is additive, so the deploy applies it.

A later refresh is a new ``version`` row set in a new migration; the Worker serves the newest ``published_on``. The
customer is shown first response only: creation to resolution covers resolved complaints only (a survivor statistic).
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import duckdb

from .intake_slice import REPO_ROOT, quote

DATA = REPO_ROOT / "back-end/seeds/service_timing.json"
MIGRATION = REPO_ROOT / "back-end/migrations/0027_service_timing.sql"
QUERY = "data_foundation/queries/product/PR-04_before.sql"
FIELDS = ("metric", "unit", "p50", "p90", "n", "missing", "negative", "population")


def export(gold_db: Path, published_on: str) -> dict:
    """The reviewed aggregate from ``gold_db``'s current ``complaint_timing``; ``version`` hashes its content."""
    with duckdb.connect(str(gold_db), read_only=True) as con:
        rows = con.execute(f"SELECT {', '.join(FIELDS)}, subcategory, CAST(window_start AS VARCHAR),"
                           " CAST(window_end_exclusive AS VARCHAR), source FROM gold.complaint_timing ORDER BY metric").fetchall()
        build = con.execute("SELECT t.build_id, b.quality_generated_at_utc, b.silver_database FROM gold.table_builds t"
                            " JOIN gold.builds b USING (build_id) WHERE t.table_name = 'complaint_timing'").fetchone()
    if not rows or build is None:
        raise ValueError("No complaint_timing build in this Gold file")
    metrics = [dict(zip(FIELDS, r[:len(FIELDS)])) for r in rows]
    subcategory, start, end, source = rows[0][len(FIELDS):]
    data = {"population": {"subcategory": subcategory, "window_start": start, "window_end_exclusive": end,
                           "timestamp": "creation_date", "source": source, "query": QUERY},
            "gold_build": build[0], "quality_generated_at_utc": str(build[1]), "published_on": published_on,
            "metrics": metrics}
    data["version"] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:16]
    return data


def _number(value) -> str:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"not a number: {value!r}")
    return repr(value)


def render_seed(data: dict) -> str:
    """One ``INSERT`` per metric, in metric order; values are checked so a hand-edited JSON can't inject SQL."""
    pop = data["population"]
    lines = []
    for m in sorted(data["metrics"], key=lambda m: m["metric"]):
        if not (0 <= m["p50"] <= m["p90"]) or m["n"] + m["missing"] + m["negative"] != m["population"]:
            raise ValueError(f"{m['metric']}: inconsistent aggregate")
        values = [quote(data["version"]), quote(data["published_on"]), quote(m["metric"]), quote(m["unit"]),
                  *(_number(m[k]) for k in ("p50", "p90", "n", "missing", "negative", "population")),
                  quote(pop["subcategory"]), quote(pop["window_start"]), quote(pop["window_end_exclusive"]),
                  quote(pop["source"]), quote(pop["query"]), quote(data["gold_build"])]
        lines.append("INSERT INTO service_timing (version, published_on, metric, unit, p50, p90, n, missing, negative, "
                     "population, subcategory, window_start, window_end_exclusive, source, query, gold_build) VALUES ("
                     + ", ".join(values) + ");")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--gold-db", type=Path, required=True)
    parser.add_argument("--published-on", required=True, help="review date, YYYY-MM-DD")
    args = parser.parse_args()
    data = export(args.gold_db, args.published_on)
    DATA.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {DATA.relative_to(REPO_ROOT)} (version {data['version']}). Its INSERTs for a migration:\n")
    print(render_seed(data), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
