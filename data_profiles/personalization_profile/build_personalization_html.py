"""
Builds a single, self-contained, offline HTML report justifying the personalization signals for
`gold.customer_personalization_profile`.

Deliberately plain: one page, a handful of charts (base64 PNG, no JS chart library, no external
CDN calls -- opens correctly with no network access), the same numbers as
personalization_profile.md and personalization_analysis.ipynb, and the recommended-variables table
at the end. This is meant to be skimmed by a teammate or judge in a couple of minutes, not explored.

Measurements and every conclusion shown come from personalization_metrics.py (shared with the
markdown profile and the notebook), so this script alone regenerates the report from a fresh Silver
build and its text cannot contradict its own numbers.

Usage:
    python build_personalization_html.py                       # writes personalization_report.html
    python build_personalization_html.py --output report.html
"""
from __future__ import annotations

import argparse
import base64
import html as html_lib
import io
import sys
import time
from pathlib import Path
from typing import List

import matplotlib

matplotlib.use("Agg")  # headless -- this script never opens a display window
import matplotlib.pyplot as plt
import pandas as pd

import personalization_metrics as pm


def fig_to_base64(fig) -> str:
    """Embed a Matplotlib figure directly in the HTML as a portable image."""
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight")
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def df_to_html_table(df: pd.DataFrame) -> str:
    return df.to_html(index=False, border=0, classes="data-table", na_rep="(null)")


def bar_chart(labels, values, size, color="#2b6cb0", horizontal=False, xlabel=None, ylabel=None, title=None,
              value_suffix=None):
    """One bar chart as base64 PNG; labels are stringified so NULL categories stay visible."""
    labels = ["(null)" if v is None else str(v) for v in labels]
    fig, ax = plt.subplots(figsize=size)
    (ax.barh if horizontal else ax.bar)(labels, values, color=color)
    if horizontal:
        ax.set_xlim(0, 100)
        for y, v in enumerate(values):
            ax.text(v + 1, y, f"{v}{value_suffix or ''}", va="center", fontsize=9)
    else:
        ax.tick_params(axis="x", rotation=20)
    if xlabel:
        ax.set_xlabel(xlabel)
    if ylabel:
        ax.set_ylabel(ylabel)
    if title:
        ax.set_title(title)
    fig.tight_layout()
    return fig_to_base64(fig)


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(pm.SCRIPT_DIR / "personalization_report.html"))
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
    r = {key: pm.reading_html(value) for key, value in pm.readings(m).items()}
    total_customers = m["total_customers"]
    agree = m["accent_agreement"]

    coverage = pd.DataFrame(m["coverage"]).rename(columns={
        "customers": "customers_with_signal", "pct": "% of customers", "orphan_ids": "orphan fact IDs"})
    coverage = coverage.sort_values("% of customers")
    coverage_img = bar_chart(coverage["source"], coverage["% of customers"], (6.5, 3.5), horizontal=True,
                             xlabel="% of all customers with >=1 record", value_suffix="%")
    accent_img = bar_chart([a for a, _ in m["accent_dim"]], [n for _, n in m["accent_dim"]], (5.5, 3.5),
                           ylabel="customers")
    lang = pd.DataFrame(m["languages"], columns=["detected_language", "transcripts"])

    fig, axes = plt.subplots(1, 2, figsize=(9, 3.5))
    for ax, rows, title, color in ((axes[0], m["segments"], "Customers by segment", "#2b6cb0"),
                                   (axes[1], m["channels"], "Digital events by channel", "#b7791f")):
        ax.bar(["(null)" if k is None else str(k) for k, _ in rows], [n for _, n in rows], color=color)
        ax.set_title(title)
        ax.tick_params(axis="x", rotation=20)
    fig.tight_layout()
    segment_channel_img = fig_to_base64(fig)

    reason_img = bar_chart([k for k, *_ in m["reasons"]], [n for _, n, _ in m["reasons"]], (6.5, 3.5),
                           ylabel="interactions")
    surveys = pd.DataFrame(m["surveys"], columns=["survey_type", "surveys", "avg_main_score", "min", "max"])
    consent = pd.DataFrame(m["consent"], columns=["accepts_marketing", "customers"])
    recommended = pd.DataFrame(pm.recommended(m), columns=["Variable", "Source", "Evidence", "Decision"])
    sentiment = m["sentiment"]

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Personalization - variable justification</title>
<style>
  body {{ font-family: -apple-system, Segoe UI, Arial, sans-serif; max-width: 920px; margin: 40px auto;
         padding: 0 20px; color: #1a202c; line-height: 1.55; }}
  h1 {{ font-size: 1.6em; border-bottom: 3px solid #2b6cb0; padding-bottom: 8px; }}
  h2 {{ font-size: 1.2em; margin-top: 2.2em; color: #2b6cb0; }}
  p.note {{ background: #ebf8ff; border-left: 4px solid #2b6cb0; padding: 10px 14px; font-size: 0.95em; }}
  img {{ max-width: 100%; border: 1px solid #e2e8f0; border-radius: 6px; margin: 12px 0; }}
  table.data-table {{ border-collapse: collapse; width: 100%; font-size: 0.92em; margin: 10px 0 20px; }}
  table.data-table th, table.data-table td {{ border: 1px solid #e2e8f0; padding: 6px 10px; text-align: left; }}
  table.data-table th {{ background: #f7fafc; }}
  .metric {{ display: inline-block; background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 6px;
            padding: 10px 16px; margin: 6px 8px 6px 0; }}
  .metric b {{ font-size: 1.15em; color: #2b6cb0; }}
  footer {{ margin-top: 3em; font-size: 0.85em; color: #718096; border-top: 1px solid #e2e8f0; padding-top: 10px; }}
</style>
</head>
<body>

<h1>Response personalization: recommended variables</h1>
<p>Analysis of <code>silver.*</code> data ({total_customers:,} customers) to determine which
signals support <code>gold.customer_personalization_profile</code> before building it.</p>

<h2>1. Signal coverage by customer</h2>
<p class="note">{r["coverage"]}</p>
<img src="data:image/png;base64,{coverage_img}" alt="Signal coverage by customer">
{df_to_html_table(coverage[["source", "customers_with_signal", "% of customers", "orphan fact IDs"]])}

<h2>2. Accent: domain and cross-source consistency</h2>
<div class="metric">Comparable customers: <b>{agree["compared"]:,}</b></div>
<div class="metric">Profile vs. interaction agreement: <b>{agree["pct"]}%</b></div>
<div class="metric">Customers with a blank accent: <b>{m["blank_accent"]:,} ({pm.pct(m["blank_accent"], total_customers)}%)</b></div>
<img src="data:image/png;base64,{accent_img}" alt="Accent distribution">
<p class="note">{r["accent"]}</p>

<h2>3. Language: Spanish/Portuguese requirement check</h2>
{df_to_html_table(lang)}
<div class="metric">Portuguese transcripts: <b>{m["pt_transcripts"]:,}</b></div>
<p class="note">{r["language"]}</p>

<h2>4. Segment, country, and digital channel</h2>
<img src="data:image/png;base64,{segment_channel_img}" alt="Segment and digital channel distributions">
<p class="note">{r["segment"]} {r["country_channel"]}</p>

<h2>5. Repeat contact and open complaints</h2>
<img src="data:image/png;base64,{reason_img}" alt="Contact reasons">
<div class="metric">Customers with >=2 contacts for the same reason: <b>{m["repeat_contact"]:,} ({pm.pct(m["repeat_contact"], total_customers)}%)</b></div>
<div class="metric">Customers with an open complaint now: <b>{m["open_complaints"]:,} ({pm.pct(m["open_complaints"], total_customers)}%)</b></div>
<p class="note">{r["repeat"]}</p>

<h2>6. Sentiment, satisfaction, and consent</h2>
<div class="metric">Missing sentiment_score values: <b>{sentiment["null"]:,}/{sentiment["interactions"]:,} ({sentiment["null_pct"]}%)</b></div>
{df_to_html_table(surveys)}
<p class="note">{r["sentiment"]}</p>
{df_to_html_table(consent)}
<p class="note">{r["consent"]}</p>

<h2>7. Recommended variables for gold.customer_personalization_profile</h2>
{df_to_html_table(recommended)}

<footer>
Generated from <code>{html_lib.escape(pm.display_path(db_path))}</code> (<code>silver.*</code>, read-only). Database contains
{total_customers:,} customers. Queries completed in {elapsed:.1f}s. The dataset is synthetic; these counts
describe the hackathon sample and not real customer behavior.
</footer>

</body>
</html>
"""

    Path(args.output).write_text(html, encoding="utf-8")
    print(f"Wrote {args.output} ({len(html):,} chars) in {elapsed:.1f}s query time")
    return 0


if __name__ == "__main__":
    sys.exit(main())
