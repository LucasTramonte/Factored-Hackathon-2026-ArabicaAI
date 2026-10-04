"""First response to unrecognized-charge complaints, by quarter: aggregates from a verified Silver DB, and the chart.

Runs data_foundation/queries/first_response/FR-*.sql read-only, writes the aggregates to
Docs/Evidence/business/first-response-by-quarter.json (no row-level data) and draws
Docs/Evidence/business/charts/first-response-by-quarter.png from that JSON alone, so the chart can be rebuilt
without the database (--chart-only). Full period: every available quarter, descriptive only, never used for design
(ADR-005). Requires data_foundation/requirements-charts.txt for the chart.

    python -m data_foundation.scripts.run_first_response --db data/latam_bank.duckdb \\
        --quality data/quality_runs/<run-id>/quality_results.json
    python -m data_foundation.scripts.run_first_response --chart-only
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
QUERIES = ROOT / "data_foundation" / "queries" / "first_response"
EVIDENCE = ROOT / "Docs" / "Evidence" / "business"
JSON_OUT = EVIDENCE / "first-response-by-quarter.json"
CHART_OUT = EVIDENCE / "charts" / "first-response-by-quarter.png"


def _rows(con, sql: str) -> list[dict]:
    cur = con.execute(sql)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


BOOT_DRAWS, BOOT_SEED = 10_000, 20261004


def bootstrap_ci(values, q: float, draws: int = BOOT_DRAWS, seed: int = BOOT_SEED) -> tuple[float, float]:
    """95% percentile-bootstrap interval for the q-quantile (linear interpolation, as DuckDB's quantile_cont).

    Resamples the quarter's durations with replacement `draws` times from a fixed seed, so a rerun on the same
    data gives the same bounds. Holds one draws x n matrix at a time (at most 10,000 x 649 floats)."""
    import numpy as np
    x = np.asarray(values, dtype=float)
    rng = np.random.default_rng(seed)
    stats = np.quantile(x[rng.integers(0, len(x), size=(draws, len(x)))], q, axis=1)
    low, high = np.quantile(stats, [0.025, 0.975])
    return round(float(low), 2), round(float(high), 2)


def aggregates(con) -> dict:
    """FR-01 per quarter with bootstrap intervals from FR-03, and FR-02 coverage; every count is read, none assumed."""
    import numpy as np
    durations: dict[tuple[int, int], list[float]] = {}
    for r in _rows(con, (QUERIES / "FR-03_durations.sql").read_text(encoding="utf-8")):
        durations.setdefault((r["year"], r["quarter"]), []).append(r["hours"])
    quarters = []
    for r in _rows(con, (QUERIES / "FR-01_by_quarter.sql").read_text(encoding="utf-8")):
        x = durations[(r["year"], r["quarter"])]
        if len(x) != r["n"] or abs(np.quantile(x, .5) - r["median_hours"]) > 1e-9 or abs(np.quantile(x, .9) - r["p90_hours"]) > 1e-9:
            raise ValueError(f"FR-03 does not reproduce FR-01 for {r['year']} Q{r['quarter']}")
        (m_lo, m_hi), (p_lo, p_hi) = bootstrap_ci(x, .5), bootstrap_ci(x, .9)
        quarters.append({**r, "first_day": str(r["first_day"]), "last_day": str(r["last_day"]),
                         "median_hours": round(r["median_hours"], 2), "median_ci95": [m_lo, m_hi],
                         "p90_hours": round(r["p90_hours"], 2), "p90_ci95": [p_lo, p_hi]})
    cov = _rows(con, (QUERIES / "FR-02_coverage.sql").read_text(encoding="utf-8"))
    one = {r["measure"]: r["n"] for r in cov if r["label"] is None}
    by_status = {r["label"]: r["n"] for r in cov if r["measure"] == "no_first_response_by_status"}
    missing = one["complaints"] - one["with_first_response"]
    if sum(q["n"] for q in quarters) != one["charted"] or sum(by_status.values()) != missing:
        raise ValueError("FR-01 and FR-02 disagree; the coverage counts do not reconcile")
    return {"population": "Cargo no reconocido complaints in silver.fact_complaints, full period",
            "complaints": one["complaints"], "with_first_response": one["with_first_response"],
            "no_first_response": missing, "no_first_response_share": round(missing / one["complaints"], 4),
            "no_first_response_by_status": dict(sorted(by_status.items(), key=lambda kv: -kv[1])),
            "excluded_no_assignment": one["first_response_without_assignment"],
            "excluded_before_assignment": one["first_response_before_assignment"],
            "charted": one["charted"], "quarters": quarters,
            "intervals": f"95% percentile bootstrap per quarter, {BOOT_DRAWS:,} resamples, seed {BOOT_SEED}"}


def chart(data: dict, out: Path = CHART_OUT) -> None:
    """Median and p90 hours by quarter, with each quarter's n and a callout for the missing first responses."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    blue, light, ink, muted, line = "#1f5fbf", "#86a9e0", "#1f1f1e", "#62615d", "#e3e2de"
    qs = data["quarters"]
    x = list(range(len(qs)))
    med, p90 = [q["median_hours"] for q in qs], [q["p90_hours"] for q in qs]
    partial = [i for i, q in enumerate(qs) if _partial(q)]
    fig, ax = plt.subplots(figsize=(11, 5.6), facecolor="white")
    bands = {"p90": [q["p90_ci95"] for q in qs], "Median": [q["median_ci95"] for q in qs]}
    for vals, colour, name in ((p90, light, "p90"), (med, blue, "Median")):
        ax.fill_between(x, [b[0] for b in bands[name]], [b[1] for b in bands[name]], color=colour, alpha=.22, lw=0, zorder=1)
        ax.plot(x, vals, color=colour, lw=2.4, zorder=2)
        full = [i for i in x if i not in partial]
        ax.scatter(full, [vals[i] for i in full], color=colour, s=34, zorder=3, edgecolor="white", linewidth=1.2)
        ax.scatter(partial, [vals[i] for i in partial], facecolor="white", edgecolor=colour, s=34, zorder=3, linewidth=1.6)
        ax.text(x[-1] + .25, vals[-1], f"{name}  {vals[-1]:.0f} h", color=ink, fontsize=10, va="center", fontweight="bold")
    ax.set_xticks(x, [f"{q['year']} Q{q['quarter']}\nn = {q['n']:,}" for q in qs], fontsize=8.5, color=muted)
    ax.set_xlim(-.5, x[-1] + 1.6)
    ax.set_ylim(0, 72)
    ax.set_yticks(range(0, 61, 12))
    ax.set_ylabel("Hours from assignment to first response", fontsize=9.5, color=muted)
    ax.tick_params(axis="y", colors=muted, labelsize=9)
    ax.tick_params(axis="x", length=0)
    ax.grid(axis="y", color=line, lw=.8)
    ax.set_axisbelow(True)
    for s in ("top", "right", "left"):
        ax.spines[s].set_visible(False)
    ax.spines["bottom"].set_color(line)

    st = data["no_first_response_by_status"]
    others = data["no_first_response"] - st.get("Open", 0) - st.get("Escalated", 0)
    ax.text(.985, .96, f"{100 * data['no_first_response_share']:.1f}%", transform=ax.transAxes, ha="right", va="top",
            fontsize=24, fontweight="bold", color="#9a5b00")
    ax.text(.985, .80, f"of all {data['complaints']:,} complaints have no recorded first response\n"
            f"({data['no_first_response']:,}: {st.get('Open', 0):,} Open, {st.get('Escalated', 0):,} Escalated, "
            f"{others:,} other statuses). They are not in the lines.",
            transform=ax.transAxes, ha="right", va="top", fontsize=9, color=ink, linespacing=1.4)

    fig.suptitle(f"Recorded first responses take about a day; "
                 f"{100 * data['no_first_response_share']:.1f}% of complaints have none recorded", x=.01, ha="left",
                 fontsize=13, fontweight="bold", color=ink)
    fig.text(.01, .925, f"Cargo no reconocido complaints with a recorded first response (n = {data['charted']:,}), by creation "
             "quarter: median and 90th percentile.\nShaded: 95% bootstrap interval; the bands overlap in every quarter, so the "
             "quarter-to-quarter moves are within sampling noise. Hollow points are partial quarters.",
             fontsize=9.5, color=muted, va="top", linespacing=1.4)
    fig.text(.01, .012, f"Excluded from the lines: {data['excluded_no_assignment']:,} complaints with a first response but no "
             "assignment date. These durations are recorded source timestamps, not a bank SLA or our product's latency.\n"
             "Synthetic LATAM Bank dataset, silver.fact_complaints; full period 2023-06-17 to 2026-06-18, including the 2026 "
             f"quarters (descriptive only).\nQueries FR-01 to FR-03. Intervals: {data['intervals']}.", fontsize=7.8, color=muted,
             linespacing=1.45)
    fig.tight_layout(rect=(0, .08, 1, .86))
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=150, facecolor="white")
    plt.close(fig)


def _partial(q: dict) -> bool:
    """A quarter is partial when the data starts after its first day or ends before its last day."""
    start = {1: "01-01", 2: "04-01", 3: "07-01", 4: "10-01"}[q["quarter"]]
    end = {1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31"}[q["quarter"]]
    return q["first_day"][5:] > start or q["last_day"][5:] < end


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path)
    parser.add_argument("--quality", type=Path, help="Full quality_results.json for this DB")
    parser.add_argument("--chart-only", action="store_true", help="Redraw the chart from the committed JSON")
    args = parser.parse_args(argv)
    if not args.chart_only:
        if not (args.db and args.quality):
            parser.error("--db and --quality are required unless --chart-only")
        import duckdb
        from data_foundation.scripts.run_marketing_product import published_manifest, validate_quality_identity
        report = json.loads(args.quality.read_text(encoding="utf-8"))
        try:
            validate_quality_identity(args.db, report["metadata"])
        except ValueError as exc:
            parser.error(str(exc))
        with duckdb.connect(str(args.db), read_only=True) as con:
            data = aggregates(con)
        data["manifest"] = published_manifest({"generated_at_utc": datetime.now(timezone.utc).isoformat(),
                                               "quality_generated_at_utc": report["metadata"]["generated_at_utc"],
                                               "quality_errors": report["metadata"]["errors"]}, args.db, args.quality)
        with open(JSON_OUT, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    chart(json.loads(JSON_OUT.read_text(encoding="utf-8")))
    print(f"wrote {JSON_OUT.relative_to(ROOT)} and {CHART_OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
