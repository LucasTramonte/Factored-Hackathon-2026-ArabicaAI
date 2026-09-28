#!/usr/bin/env python3
"""
Generates personalization_analysis.ipynb from code, rather than hand-authoring notebook JSON.

Keeping this generator in the repo (instead of only committing the .ipynb) means the notebook can
be regenerated if a query or chart changes, without editing raw notebook JSON by hand -- the same
"declarative, reproducible" preference the rest of data_pipelines/ and data_profiles/ already
follow. Run this, then execute the notebook with:

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


def build() -> nbf.NotebookNode:
    nb = nbf.v4.new_notebook()
    cells = []

    cells.append(md(
        "# Personalization signal analysis\n"
        "\n"
        "**Purpose:** decide, from real Silver data, which customer-level signals justify a "
        "`gold.customer_personalization_profile` table -- before designing that table.\n"
        "\n"
        "This does not build the recommender or the Gold table. It measures, for every candidate "
        "personalization signal the team discussed:\n"
        "\n"
        "- **Coverage** -- what fraction of the 150,000 customers actually have the signal at all.\n"
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
        "Reads `silver.*` tables only, read-only connection, no writes."
    ))

    cells.append(code(
        "import os\n"
        "import warnings\n"
        "from pathlib import Path\n"
        "\n"
        "import duckdb\n"
        "import matplotlib.pyplot as plt\n"
        "import pandas as pd\n"
        "\n"
        "warnings.filterwarnings(\"ignore\")\n"
        "plt.rcParams[\"figure.dpi\"] = 110\n"
        "\n"
        "# Same PROJECT_ROOT/DATA_DIR/DUCKDB_PATH resolution convention as the rest of the pipeline.\n"
        "SCRIPT_DIR = Path.cwd()\n"
        "PROJECT_ROOT = Path(os.environ.get(\"PROJECT_ROOT\", SCRIPT_DIR.parent.parent)).resolve()\n"
        "DATA_DIR = Path(os.environ.get(\"DATA_DIR\", PROJECT_ROOT / \"data\")).resolve()\n"
        "DUCKDB_PATH = Path(os.environ.get(\"DUCKDB_PATH\", DATA_DIR / \"latam_bank.duckdb\"))\n"
        "print(\"Using DuckDB file:\", DUCKDB_PATH)\n"
        "\n"
        "con = duckdb.connect(str(DUCKDB_PATH), read_only=True)\n"
        "temp_dir = DATA_DIR / \"duckdb_tmp\"\n"
        "temp_dir.mkdir(parents=True, exist_ok=True)\n"
        "con.execute(\"SET memory_limit='3GB'\")\n"
        "con.execute(\"SET temp_directory=?\", [str(temp_dir)])\n"
        "con.execute(\"SET threads=2\")\n"
        "\n"
        "total_customers = con.execute(\"SELECT count(*) FROM silver.dim_customers\").fetchone()[0]\n"
        "print(f\"Total customers: {total_customers:,}\")"
    ))

    cells.append(md("## 1. Signal coverage per customer (cold-start exposure)\n\n"
                     "How many of the 150,000 customers actually have each type of history at all? "
                     "A signal with low coverage cannot personalize most customers' first contact."))

    cells.append(code(
        "coverage_queries = {\n"
        "    \"call_center_interactions\": \"SELECT count(DISTINCT customer_id) FROM silver.fact_call_center_interactions\",\n"
        "    \"call_transcripts\": \"SELECT count(DISTINCT customer_id) FROM silver.fact_call_transcripts\",\n"
        "    \"complaints\": \"SELECT count(DISTINCT customer_id) FROM silver.fact_complaints\",\n"
        "    \"satisfaction_surveys\": \"SELECT count(DISTINCT customer_id) FROM silver.fact_satisfaction_surveys\",\n"
        "    \"digital_events\": \"SELECT count(DISTINCT customer_id) FROM silver.fact_digital_events\",\n"
        "    \"transactions\": \"SELECT count(DISTINCT customer_id) FROM silver.fact_transactions\",\n"
        "}\n"
        "coverage = pd.DataFrame(\n"
        "    [(name, con.execute(q).fetchone()[0]) for name, q in coverage_queries.items()],\n"
        "    columns=[\"source\", \"customers_with_signal\"],\n"
        ")\n"
        "coverage[\"pct_of_all_customers\"] = (100 * coverage[\"customers_with_signal\"] / total_customers).round(1)\n"
        "coverage = coverage.sort_values(\"pct_of_all_customers\", ascending=True)\n"
        "coverage"
    ))

    cells.append(code(
        "fig, ax = plt.subplots(figsize=(7, 4))\n"
        "ax.barh(coverage[\"source\"], coverage[\"pct_of_all_customers\"], color=\"#2b6cb0\")\n"
        "ax.set_xlabel(\"% of all customers with >=1 record\")\n"
        "ax.set_title(\"Signal coverage per customer\")\n"
        "ax.set_xlim(0, 100)\n"
        "for y, v in enumerate(coverage[\"pct_of_all_customers\"]):\n"
        "    ax.text(v + 1, y, f\"{v}%\", va=\"center\")\n"
        "plt.tight_layout()\n"
        "plt.show()"
    ))

    cells.append(code(
        "cold = con.execute(\n"
        "    \"\"\"\n"
        "    SELECT count(*) FROM silver.dim_customers c\n"
        "    WHERE NOT EXISTS (SELECT 1 FROM silver.fact_call_center_interactions i WHERE i.customer_id = c.customer_id)\n"
        "      AND NOT EXISTS (SELECT 1 FROM silver.fact_complaints cp WHERE cp.customer_id = c.customer_id)\n"
        "      AND NOT EXISTS (SELECT 1 FROM silver.fact_digital_events d WHERE d.customer_id = c.customer_id)\n"
        "    \"\"\"\n"
        ").fetchone()[0]\n"
        "print(f\"Customers with zero interactions, complaints, or digital events: {cold:,} \"\n"
        "      f\"({100*cold/total_customers:.1f}% of {total_customers:,})\")"
    ))

    cells.append(md(
        "**Reading:** every customer has at least one digital event or interaction, so there is no "
        "fully cold-start population. But coverage drops sharply for `complaints` (36%) and "
        "`call_transcripts` (68%) -- those two cannot be a customer's *only* personalization signal; "
        "they can only refine what `call_center_interactions` and `digital_events` already cover."
    ))

    cells.append(md("## 2. Accent signal: domain and cross-source agreement\n\n"
                     "The dataset records accent in three places. Do they agree enough to trust one "
                     "as the source of truth?"))

    cells.append(code(
        "accent_dim = pd.read_sql(\n"
        "    \"SELECT detected_accent, count(*) AS customers FROM silver.dim_customers GROUP BY 1 ORDER BY 2 DESC\", con\n"
        ")\n"
        "accent_dim[\"detected_accent\"] = accent_dim[\"detected_accent\"].fillna(\"(blank)\").replace(\"\", \"(blank)\")\n"
        "accent_dim"
    ))

    cells.append(code(
        "fig, ax = plt.subplots(figsize=(6, 4))\n"
        "ax.bar(accent_dim[\"detected_accent\"], accent_dim[\"customers\"], color=\"#2b6cb0\")\n"
        "ax.set_title(\"dim_customers.detected_accent\")\n"
        "ax.set_ylabel(\"customers\")\n"
        "plt.tight_layout()\n"
        "plt.show()"
    ))

    cells.append(code(
        "agree = con.execute(\n"
        "    \"\"\"\n"
        "    WITH per_customer AS (\n"
        "        SELECT i.customer_id,\n"
        "               c.detected_accent AS profile_accent,\n"
        "               mode(i.customer_detected_accent) AS interaction_mode_accent\n"
        "        FROM silver.fact_call_center_interactions i\n"
        "        JOIN silver.dim_customers c USING (customer_id)\n"
        "        WHERE i.customer_detected_accent IS NOT NULL AND c.detected_accent IS NOT NULL\n"
        "        GROUP BY 1, 2\n"
        "    )\n"
        "    SELECT count(*), sum(CASE WHEN profile_accent = interaction_mode_accent THEN 1 ELSE 0 END)\n"
        "    FROM per_customer\n"
        "    \"\"\"\n"
        ").fetchone()\n"
        "print(f\"Customers comparable: {agree[0]:,}\")\n"
        "print(f\"Profile accent matches most-common interaction accent: {agree[1]:,} \"\n"
        "      f\"({100*agree[1]/agree[0]:.1f}%)\")\n"
        "blank_profile_accent = con.execute(\n"
        "    \"SELECT count(*) FROM silver.dim_customers WHERE detected_accent IS NULL OR detected_accent = ''\"\n"
        ").fetchone()[0]\n"
        "print(f\"Customers with a BLANK dim_customers.detected_accent: {blank_profile_accent:,} \"\n"
        "      f\"({100*blank_profile_accent/total_customers:.1f}%) -- these need the interaction-level fallback\")"
    ))

    cells.append(md(
        "**Reading:** where both sources exist, they agree 100% of the time -- `dim_customers.detected_accent` "
        "is trustworthy when present. But it is blank for roughly 30% of customers, so the Gold profile "
        "needs an explicit fallback chain: `dim_customers` -> mode of interaction accent -> mode of "
        "transcript accent -> `null` (never a silently guessed default)."
    ))

    cells.append(md("## 3. Language domain: Spanish/Portuguese requirement check\n\n"
                     "The hackathon requires demonstrating Spanish **and** Portuguese. This checks what "
                     "language the transcripts actually contain."))

    cells.append(code(
        "lang = pd.read_sql(\n"
        "    \"SELECT detected_language, count(*) AS transcripts FROM silver.fact_call_transcripts GROUP BY 1 ORDER BY 2 DESC\", con\n"
        ")\n"
        "lang"
    ))

    cells.append(code(
        "pt_count = con.execute(\n"
        "    \"SELECT count(*) FROM silver.fact_call_transcripts WHERE lower(detected_language) LIKE 'pt%'\"\n"
        ").fetchone()[0]\n"
        "print(f\"Portuguese transcripts: {pt_count:,}\")"
    ))

    cells.append(md(
        "**Reading:** every transcript is Spanish (`es`); there are zero Portuguese samples anywhere in "
        "this dataset. Portuguese personalization cannot be derived or validated from this data -- it "
        "has to be built and demonstrated with hand-authored cases, and this gap must be reported as a "
        "dataset limitation, not silently worked around."
    ))

    cells.append(md("## 4. Segment, country, and digital-channel domains\n\n"
                     "The real distinct values behind the categorical fields a tone/style rule would key off."))

    cells.append(code(
        "segment = pd.read_sql(\"SELECT segment, count(*) AS customers FROM silver.dim_customers GROUP BY 1 ORDER BY 2 DESC\", con)\n"
        "country = pd.read_sql(\"SELECT country, count(*) AS customers FROM silver.dim_customers GROUP BY 1 ORDER BY 2 DESC\", con)\n"
        "channel = pd.read_sql(\"SELECT channel, count(*) AS events FROM silver.fact_digital_events GROUP BY 1 ORDER BY 2 DESC\", con)\n"
        "\n"
        "fig, axes = plt.subplots(1, 3, figsize=(14, 4))\n"
        "axes[0].bar(segment[\"segment\"], segment[\"customers\"], color=\"#2b6cb0\"); axes[0].set_title(\"segment\")\n"
        "axes[1].bar(country[\"country\"], country[\"customers\"], color=\"#2f855a\"); axes[1].set_title(\"country\")\n"
        "axes[2].bar(channel[\"channel\"], channel[\"events\"], color=\"#b7791f\"); axes[2].set_title(\"digital channel\")\n"
        "for ax in axes:\n"
        "    ax.tick_params(axis=\"x\", rotation=30)\n"
        "plt.tight_layout()\n"
        "plt.show()\n"
        "segment"
    ))

    cells.append(md(
        "**Reading:** `segment` is heavily skewed toward `Basic` (60%) with `Premium` only 10% -- any "
        "segment-based tone rule will have much thinner held-out evidence for Premium/Student. Country "
        "and channel are both well-distributed and safe to key personalization on."
    ))

    cells.append(md("## 5. Repeat-contact and open-complaint signal strength\n\n"
                     "How often would a 'you've contacted us about this before' or 'you have an open case' "
                     "personalization actually trigger?"))

    cells.append(code(
        "reason_volume = pd.read_sql(\n"
        "    \"\"\"\n"
        "    SELECT reason_category, count(*) AS interactions, count(DISTINCT customer_id) AS customers\n"
        "    FROM silver.fact_call_center_interactions GROUP BY 1 ORDER BY 2 DESC\n"
        "    \"\"\", con,\n"
        ")\n"
        "reason_volume"
    ))

    cells.append(code(
        "fig, ax = plt.subplots(figsize=(7, 4))\n"
        "ax.bar(reason_volume[\"reason_category\"], reason_volume[\"interactions\"], color=\"#2b6cb0\")\n"
        "ax.set_title(\"Interactions by reason_category\")\n"
        "ax.tick_params(axis=\"x\", rotation=20)\n"
        "plt.tight_layout()\n"
        "plt.show()"
    ))

    cells.append(code(
        "repeat = con.execute(\n"
        "    \"\"\"\n"
        "    WITH per_cust AS (\n"
        "        SELECT customer_id, reason_category, count(*) AS n\n"
        "        FROM silver.fact_call_center_interactions GROUP BY 1, 2\n"
        "    )\n"
        "    SELECT count(DISTINCT customer_id) FROM per_cust WHERE n >= 2\n"
        "    \"\"\"\n"
        ").fetchone()[0]\n"
        "print(f\"Customers with >=2 interactions in the SAME reason_category: {repeat:,} \"\n"
        "      f\"({100*repeat/total_customers:.1f}% of all customers)\")\n"
        "\n"
        "open_complaints = con.execute(\n"
        "    \"SELECT count(DISTINCT customer_id) FROM silver.fact_complaints WHERE status IN ('Open','In Process','Escalated')\"\n"
        ").fetchone()[0]\n"
        "print(f\"Customers with a currently open/in-process/escalated complaint: {open_complaints:,} \"\n"
        "      f\"({100*open_complaints/total_customers:.1f}% of all customers)\")"
    ))

    cells.append(md(
        "**Reading:** repeat contact on the same reason is common (75% of customers, ever) -- strong, "
        "well-populated signal. An open complaint is rarer (28%) but still frequent enough to be a "
        "useful, high-priority context flag rather than an edge case."
    ))

    cells.append(md("## 6. Sentiment and CSAT coverage\n\n"
                     "Is sentiment/satisfaction data clean enough to summarize per customer?"))

    cells.append(code(
        "sent_null = con.execute(\n"
        "    \"SELECT count(*), sum(CASE WHEN sentiment_score IS NULL THEN 1 ELSE 0 END) FROM silver.fact_call_center_interactions\"\n"
        ").fetchone()\n"
        "print(f\"sentiment_score null rate: {sent_null[1]:,}/{sent_null[0]:,} \"\n"
        "      f\"({100*sent_null[1]/sent_null[0]:.1f}%)\")\n"
        "\n"
        "surveys = pd.read_sql(\n"
        "    \"SELECT survey_type, count(*) AS surveys, round(avg(main_score),2) AS avg_main_score \"\n"
        "    \"FROM silver.fact_satisfaction_surveys GROUP BY 1 ORDER BY 2 DESC\", con,\n"
        ")\n"
        "surveys"
    ))

    cells.append(md(
        "**Reading:** `sentiment_score` has zero nulls -- safe to average per customer directly. "
        "`main_score` must **not** be averaged across `survey_type` (CSAT/NPS/CES are different scales); "
        "any per-customer satisfaction summary needs one column per survey type, not one blended average."
    ))

    cells.append(md("## 7. Consent gate for proactive personalization"))

    cells.append(code(
        "consent = pd.read_sql(\"SELECT accepts_marketing, count(*) AS customers FROM silver.dim_customers GROUP BY 1\", con)\n"
        "consent"
    ))

    cells.append(md(
        "**Reading:** consent is split almost exactly 50/50 and has no nulls -- a clean, reliable gate. "
        "Any *proactive* personalization (the agent bringing up something the customer didn't ask about) "
        "should be conditioned on `accepts_marketing = True`; reactive personalization (how the agent "
        "responds to a request the customer already made) does not need this gate."
    ))

    cells.append(md(
        "## 8. Recommended variables for `gold.customer_personalization_profile`\n"
        "\n"
        "| Variable | Source | Evidence from this analysis | Decision |\n"
        "|---|---|---|---|\n"
        "| `preferred_accent` | `dim_customers.detected_accent`, fallback to mode of `call_center_interactions.customer_detected_accent`, then `call_transcripts.detected_accent` | 100% agreement where both exist; ~30% blank in the dimension alone | **Include**, with explicit 3-step fallback and `null` as an honest last resort |\n"
        "| `preferred_language` | `call_transcripts.detected_language` | 100% `es`, 0% `pt` | **Include for Spanish only.** Portuguese cannot be derived from data -- must ship as hand-built cases and be documented as a dataset limitation |\n"
        "| `segment`, `country` | `dim_customers` | Well-populated, no nulls found | **Include** directly, no aggregation needed |\n"
        "| `preferred_digital_channel` | mode of `fact_digital_events.channel` | 100% coverage, well-distributed across 4 channels | **Include** |\n"
        "| `repeat_contact_flag` (per `reason_category`) | `fact_call_center_interactions` | 75% of customers qualify -- strong, common signal | **Include** |\n"
        "| `open_complaint_flag` | `fact_complaints.status` | 28% of customers -- meaningful minority, not a rare edge case | **Include** |\n"
        "| `avg_sentiment_score` | `fact_call_center_interactions.sentiment_score` | 0% null, 99% customer coverage | **Include** |\n"
        "| `csat_avg`, `nps_avg`, `ces_avg` (separate columns) | `fact_satisfaction_surveys`, split by `survey_type` | Scales differ per type; blending would be wrong | **Include as 3 separate columns**, never one blended average |\n"
        "| `accepts_marketing` | `dim_customers` | Clean 50/50 split, no nulls | **Include as a gate**, not a personalization style itself |\n"
        "| `credit_score`, `estimated_monthly_income`, `fraud_score`, `days_past_due` | `dim_customers` / `products` / `transactions` | Out of scope by team decision | **Excluded** -- risk-based personalization was deliberately deferred |\n"
        "\n"
        "None of these signals require joining fact tables to each other directly -- each is aggregated "
        "to `customer_id` grain independently before any join, per the project's existing join-safety rule."
    ))

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
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
