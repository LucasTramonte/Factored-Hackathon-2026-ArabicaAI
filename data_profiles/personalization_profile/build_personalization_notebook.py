#!/usr/bin/env python3
"""
Generates personalization_analysis.ipynb from code, rather than hand-authoring notebook JSON.

Keeping this generator in the repo (instead of only committing the .ipynb) means the notebook can
be regenerated if a query or chart changes, without editing raw notebook JSON by hand -- the same
"declarative, reproducible" preference the rest of data_pipelines/ and data_profiles/ already
follow. The notebook calls personalization_metrics.py for every number and every "Reading", so it
agrees with personalization_profile.md and personalization_report.html by construction.

It locates the repository from PROJECT_ROOT or by walking up from the kernel's working directory,
so it runs from the repo root or from this folder. Build and execute with:

    python build_personalization_notebook.py
    python -m jupyter execute --inplace personalization_analysis.ipynb

so the committed .ipynb already has outputs baked in and a teammate can open it and see charts
without needing to re-run anything (though they can re-run it against their own local .duckdb).
"""
from __future__ import annotations

from pathlib import Path

import nbformat as nbf

SCRIPT_DIR = Path(__file__).resolve().parent


def md(text: str) -> nbf.NotebookNode:
    return nbf.v4.new_markdown_cell(text)


def code(text: str) -> nbf.NotebookNode:
    return nbf.v4.new_code_cell(text)


def reading(key: str) -> nbf.NotebookNode:
    """A 'Reading' cell rendered from the measured values, never hand-typed numbers."""
    return code(f'Markdown("**Reading:** " + r["{key}"])')


SETUP = '''import os
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
from IPython.display import Markdown

plt.rcParams["figure.dpi"] = 110


def find_project_root(start: Path) -> Path:
    """Walk up from the kernel's working directory to the repository root."""
    for candidate in (start, *start.parents):
        if (candidate / "data_profiles" / "personalization_profile" / "personalization_metrics.py").is_file():
            return candidate
    raise FileNotFoundError("Run from inside the repository or set PROJECT_ROOT")


PROJECT_ROOT = Path(os.environ.get("PROJECT_ROOT") or find_project_root(Path.cwd().resolve())).resolve()
sys.path.insert(0, str(PROJECT_ROOT / "data_profiles" / "personalization_profile"))
import personalization_metrics as pm

DUCKDB_PATH = pm.resolve_duckdb_path()
print("Using DuckDB file:", pm.display_path(DUCKDB_PATH))
with pm.connect(DUCKDB_PATH) as con:
    m = pm.measure(con)
r = pm.readings(m)
total_customers = m["total_customers"]
print(f"Total customers: {total_customers:,}")


def frame(rows, columns):
    return pd.DataFrame(rows, columns=columns).fillna("(null)")


def bars(ax, rows, title, color="#2b6cb0"):
    ax.bar(["(null)" if k is None else str(k) for k, *_ in rows], [n for _, n, *_ in rows], color=color)
    ax.set_title(title)
    ax.tick_params(axis="x", rotation=25)'''


def build() -> nbf.NotebookNode:
    nb = nbf.v4.new_notebook()
    cells = [
        md("# Personalization signal analysis\n"
           "\n"
           "**Purpose:** decide, from Silver data, which customer-level signals justify a "
           "`gold.customer_personalization_profile` table -- before designing that table.\n"
           "\n"
           "This does not build the recommender or the Gold table. It measures, for every candidate "
           "personalization signal the team discussed:\n"
           "\n"
           "- **Coverage** -- what fraction of customers in `dim_customers` actually have the signal. "
           "Fact IDs missing from the dimension are reported as orphans and never counted.\n"
           "- **Consistency** -- when the same fact is recorded in more than one table (e.g. accent), "
           "do the sources agree?\n"
           "- **Domain** -- the real distinct values, not the ones assumed from the data dictionary.\n"
           "- **Language reality** -- the hackathon requires Spanish *and* Portuguese; this checks what "
           "the dataset actually contains before any Portuguese-specific personalization is designed.\n"
           "\n"
           "Risk-scoring signals (`credit_score`, `estimated_monthly_income`, `fraud_score`, "
           "`days_past_due`) are deliberately **out of scope** -- the team decided personalization should "
           "not run through those fields.\n"
           "\n"
           "All queries are in `personalization_metrics.measure` (read-only connection, no writes). "
           "Every *Reading* below is generated from the measured values."),
        code(SETUP),

        md("## 1. Signal coverage per customer (cold-start exposure)\n\n"
           "How many customers actually have each type of history at all? A signal with low coverage "
           "cannot personalize most customers' first contact."),
        code('coverage = pd.DataFrame(m["coverage"]).sort_values("pct")\ncoverage'),
        code('fig, ax = plt.subplots(figsize=(7, 4))\n'
             'ax.barh(coverage["source"], coverage["pct"], color="#2b6cb0")\n'
             'ax.set_xlabel("% of all customers with >=1 record")\n'
             'ax.set_title("Signal coverage per customer")\n'
             'ax.set_xlim(0, 100)\n'
             'for y, v in enumerate(coverage["pct"]):\n'
             '    ax.text(v + 1, y, f"{v}%", va="center")\n'
             'plt.tight_layout()\n'
             'plt.show()'),
        reading("coverage"),

        md("## 2. Accent signal: domain and cross-source agreement\n\n"
           "The dataset records accent in three places. Do they agree enough to trust one as the source of truth?"),
        code('accent_dim = frame(m["accent_dim"], ["detected_accent", "customers"])\n'
             'fig, ax = plt.subplots(figsize=(6, 4))\n'
             'bars(ax, m["accent_dim"], "dim_customers.detected_accent")\n'
             'plt.tight_layout()\n'
             'plt.show()\n'
             'accent_dim'),
        code('pd.DataFrame([m["accent_agreement"] | {"blank_profile_accent": m["blank_accent"]}])'),
        reading("accent"),

        md("## 3. Language domain: Spanish/Portuguese requirement check\n\n"
           "The hackathon requires demonstrating Spanish **and** Portuguese. This checks what language the "
           "transcripts actually contain."),
        code('frame(m["languages"], ["detected_language", "transcripts"])'),
        reading("language"),

        md("## 4. Segment, country, and digital-channel domains\n\n"
           "The real distinct values behind the categorical fields a tone/style rule would key off."),
        code('fig, axes = plt.subplots(1, 3, figsize=(14, 4))\n'
             'bars(axes[0], m["segments"], "segment")\n'
             'bars(axes[1], m["countries"], "country", "#2f855a")\n'
             'bars(axes[2], m["channels"], "digital channel", "#b7791f")\n'
             'plt.tight_layout()\n'
             'plt.show()\n'
             'frame(m["segments"], ["segment", "customers"])'),
        reading("segment"),
        reading("country_channel"),

        md("## 5. Repeat-contact and open-complaint signal strength\n\n"
           "How often would a 'you've contacted us about this before' or 'you have an open case' "
           "personalization actually trigger?"),
        code('reasons = frame(m["reasons"], ["reason_category", "interactions", "customers"])\n'
             'fig, ax = plt.subplots(figsize=(7, 4))\n'
             'bars(ax, m["reasons"], "Interactions by reason_category")\n'
             'plt.tight_layout()\n'
             'plt.show()\n'
             'reasons'),
        reading("repeat"),

        md("## 6. Sentiment and CSAT coverage\n\n"
           "Is sentiment/satisfaction data clean enough to summarize per customer?"),
        code('frame(m["surveys"], ["survey_type", "surveys", "avg_main_score", "min", "max"])'),
        reading("sentiment"),

        md("## 7. Consent gate for proactive personalization"),
        code('frame(m["consent"], ["accepts_marketing", "customers"])'),
        reading("consent"),

        md("## 8. Recommended variables for `gold.customer_personalization_profile`\n\n"
           "Evidence is filled from the measurements above. None of these signals requires joining fact "
           "tables to each other directly -- each is aggregated to `customer_id` grain independently "
           "before any join, per the project's join-safety rule."),
        code('pd.DataFrame(pm.recommended(m), columns=["Variable", "Source", "Evidence", "Decision"])'),
    ]
    nb["cells"] = cells
    nb["metadata"] = {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python", "version": "3"},
    }
    return nb


def main() -> int:
    nb = build()
    out_path = SCRIPT_DIR / "personalization_analysis.ipynb"
    nbf.write(nb, out_path)
    print(f"Wrote {out_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
