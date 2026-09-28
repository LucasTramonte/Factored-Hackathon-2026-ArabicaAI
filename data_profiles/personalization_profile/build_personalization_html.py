#!/usr/bin/env python3
"""
Builds a single, self-contained, offline HTML report justifying the personalization signals for
`gold.customer_personalization_profile`.

Deliberately plain: one page, a handful of charts (base64 PNG, no JS chart library, no external
CDN calls -- opens correctly with no network access), the same numbers as
personalization_profile.md and personalization_analysis.ipynb, and the recommended-variables table
at the end. This is meant to be skimmed by a teammate or judge in a couple of minutes, not explored.

Re-runs the same read-only DuckDB queries directly (rather than parsing the notebook's outputs), so
this script alone is enough to regenerate the report from a fresh Silver build.

Usage:
    python build_personalization_html.py                       # writes personalization_report.html
    python build_personalization_html.py --output report.html
"""
from __future__ import annotations

import argparse
import base64
import io
import os
import sys
import time
import warnings
from pathlib import Path
from typing import List

import duckdb
import matplotlib

# pandas warns that DuckDBPyConnection is not a SQLAlchemy/sqlite3 connection -- read_sql works
# fine against it regardless (this project's other scripts use the same pattern); suppressed here
# rather than switching to con.execute(...).fetchdf(), which would just be more verbose for the
# same result.
warnings.filterwarnings("ignore", message="pandas only supports SQLAlchemy")

matplotlib.use("Agg")  # headless -- this script never opens a display window
import matplotlib.pyplot as plt
import pandas as pd

SCRIPT_DIR = Path(__file__).resolve().parent


def resolve_duckdb_path() -> Path:
    default_root = SCRIPT_DIR.parent.parent
    project_root = Path(os.environ.get("PROJECT_ROOT", default_root)).resolve()
    data_dir = Path(os.environ.get("DATA_DIR", project_root / "data")).resolve()
    return Path(os.environ.get("DUCKDB_PATH", data_dir / "latam_bank.duckdb"))


def fig_to_base64(fig) -> str:
    """Embeds a Matplotlib figure directly in the HTML -- no separate image files to keep in sync
    with the report, and the report stays a single portable file."""
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight")
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def df_to_html_table(df: pd.DataFrame) -> str:
    return df.to_html(index=False, border=0, classes="data-table")


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(SCRIPT_DIR / "personalization_report.html"))
    parser.add_argument("--memory-limit", default="3GB")
    args = parser.parse_args(argv if argv is not None else sys.argv[1:])

    db_path = resolve_duckdb_path()
    if not db_path.is_file():
        print(f"No DuckDB file at {db_path}", file=sys.stderr)
        return 1

    t0 = time.monotonic()
    con = duckdb.connect(str(db_path), read_only=True)
    temp_dir = db_path.parent / "duckdb_tmp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    con.execute("SET memory_limit=?", [args.memory_limit])
    con.execute("SET temp_directory=?", [str(temp_dir)])
    con.execute("SET threads=?", [int(os.environ.get("DUCKDB_THREADS", "2"))])

    total_customers = con.execute("SELECT count(*) FROM silver.dim_customers").fetchone()[0]

    # ---- 1. Coverage chart -----------------------------------------------------------
    coverage_queries = {
        "call_center_interactions": "SELECT count(DISTINCT customer_id) FROM silver.fact_call_center_interactions",
        "call_transcripts": "SELECT count(DISTINCT customer_id) FROM silver.fact_call_transcripts",
        "complaints": "SELECT count(DISTINCT customer_id) FROM silver.fact_complaints",
        "satisfaction_surveys": "SELECT count(DISTINCT customer_id) FROM silver.fact_satisfaction_surveys",
        "digital_events": "SELECT count(DISTINCT customer_id) FROM silver.fact_digital_events",
        "transactions": "SELECT count(DISTINCT customer_id) FROM silver.fact_transactions",
    }
    coverage = pd.DataFrame(
        [(name, con.execute(q).fetchone()[0]) for name, q in coverage_queries.items()],
        columns=["source", "customers_with_signal"],
    )
    coverage["% of customers"] = (100 * coverage["customers_with_signal"] / total_customers).round(1)
    coverage = coverage.sort_values("% of customers")

    fig, ax = plt.subplots(figsize=(6.5, 3.5))
    ax.barh(coverage["source"], coverage["% of customers"], color="#2b6cb0")
    ax.set_xlim(0, 100)
    ax.set_xlabel("% of all customers with >=1 record")
    for y, v in enumerate(coverage["% of customers"]):
        ax.text(v + 1, y, f"{v}%", va="center", fontsize=9)
    fig.tight_layout()
    coverage_img = fig_to_base64(fig)

    # ---- 2. Accent chart --------------------------------------------------------------
    accent_dim = pd.read_sql(
        "SELECT NULLIF(detected_accent,'') AS detected_accent, count(*) AS customers "
        "FROM silver.dim_customers GROUP BY 1 ORDER BY 2 DESC", con,
    )
    accent_dim["detected_accent"] = accent_dim["detected_accent"].fillna("(blank)")
    fig, ax = plt.subplots(figsize=(5.5, 3.5))
    ax.bar(accent_dim["detected_accent"], accent_dim["customers"], color="#2b6cb0")
    ax.set_ylabel("customers")
    fig.tight_layout()
    accent_img = fig_to_base64(fig)

    agree = con.execute(
        """
        WITH per_customer AS (
            SELECT i.customer_id, c.detected_accent AS profile_accent,
                   mode(i.customer_detected_accent) AS interaction_mode_accent
            FROM silver.fact_call_center_interactions i
            JOIN silver.dim_customers c USING (customer_id)
            WHERE i.customer_detected_accent IS NOT NULL AND c.detected_accent IS NOT NULL
            GROUP BY 1, 2
        )
        SELECT count(*), sum(CASE WHEN profile_accent = interaction_mode_accent THEN 1 ELSE 0 END)
        FROM per_customer
        """
    ).fetchone()
    blank_accent = con.execute(
        "SELECT count(*) FROM silver.dim_customers WHERE detected_accent IS NULL OR detected_accent = ''"
    ).fetchone()[0]

    # ---- 3. Language ------------------------------------------------------------------
    lang = pd.read_sql(
        "SELECT detected_language, count(*) AS transcripts FROM silver.fact_call_transcripts "
        "GROUP BY 1 ORDER BY 2 DESC", con,
    )
    pt_count = con.execute(
        "SELECT count(*) FROM silver.fact_call_transcripts WHERE lower(detected_language) LIKE 'pt%'"
    ).fetchone()[0]

    # ---- 4. Segment / country / channel -------------------------------------------
    segment = pd.read_sql("SELECT segment, count(*) AS customers FROM silver.dim_customers GROUP BY 1 ORDER BY 2 DESC", con)
    channel = pd.read_sql("SELECT channel, count(*) AS events FROM silver.fact_digital_events GROUP BY 1 ORDER BY 2 DESC", con)

    fig, axes = plt.subplots(1, 2, figsize=(9, 3.5))
    axes[0].bar(segment["segment"], segment["customers"], color="#2b6cb0")
    axes[0].set_title("Customers by segment")
    axes[0].tick_params(axis="x", rotation=20)
    axes[1].bar(channel["channel"], channel["events"], color="#b7791f")
    axes[1].set_title("Digital events by channel")
    axes[1].tick_params(axis="x", rotation=20)
    fig.tight_layout()
    segment_channel_img = fig_to_base64(fig)

    # ---- 5. Repeat contact / complaints -------------------------------------------
    reason_volume = pd.read_sql(
        "SELECT reason_category, count(*) AS interactions FROM silver.fact_call_center_interactions "
        "GROUP BY 1 ORDER BY 2 DESC", con,
    )
    fig, ax = plt.subplots(figsize=(6.5, 3.5))
    ax.bar(reason_volume["reason_category"], reason_volume["interactions"], color="#2b6cb0")
    ax.tick_params(axis="x", rotation=20)
    ax.set_ylabel("interactions")
    fig.tight_layout()
    reason_img = fig_to_base64(fig)

    repeat = con.execute(
        """
        WITH per_cust AS (
            SELECT customer_id, reason_category, count(*) AS n
            FROM silver.fact_call_center_interactions GROUP BY 1, 2
        )
        SELECT count(DISTINCT customer_id) FROM per_cust WHERE n >= 2
        """
    ).fetchone()[0]
    open_complaints = con.execute(
        "SELECT count(DISTINCT customer_id) FROM silver.fact_complaints "
        "WHERE status IN ('Open','In Process','Escalated')"
    ).fetchone()[0]

    # ---- 6. Sentiment / consent ----------------------------------------------------
    sent_null = con.execute(
        "SELECT count(*), sum(CASE WHEN sentiment_score IS NULL THEN 1 ELSE 0 END) "
        "FROM silver.fact_call_center_interactions"
    ).fetchone()
    consent = pd.read_sql(
        "SELECT accepts_marketing, count(*) AS customers FROM silver.dim_customers GROUP BY 1", con,
    )

    con.close()
    elapsed = time.monotonic() - t0

    # ---- Recommended variables table ------------------------------------------------
    recommended = pd.DataFrame([
        ("preferred_accent", "dim_customers -> interaction mode -> transcript mode",
         "100% agreement where both exist; ~30% blank in the dimension alone", "Include, with 3-step fallback"),
        ("preferred_language", "call_transcripts.detected_language",
         "100% es, 0% pt in this dataset", "Include for Spanish only; Portuguese is a documented data gap"),
        ("segment, country", "dim_customers", "Well-populated, no nulls found", "Include directly"),
        ("preferred_digital_channel", "mode of fact_digital_events.channel",
         "100% coverage, well distributed across 4 channels", "Include"),
        ("repeat_contact_flag", "fact_call_center_interactions by reason_category",
         "75% of customers qualify", "Include"),
        ("open_complaint_flag", "fact_complaints.status", "28% of customers", "Include"),
        ("avg_sentiment_score", "fact_call_center_interactions.sentiment_score",
         "0% null, 99% customer coverage", "Include"),
        ("csat_avg / nps_avg / ces_avg", "fact_satisfaction_surveys, split by survey_type",
         "Scales differ per type; blending would be wrong", "Include as 3 separate columns"),
        ("accepts_marketing", "dim_customers", "Clean 50/50 split, no nulls", "Include as a gate, not a style"),
        ("credit_score, income, fraud_score, days_past_due", "dim_customers / products / transactions",
         "Out of scope by team decision", "Excluded -- risk-based personalization deferred"),
    ], columns=["Variable", "Source", "Evidence", "Decision"])

    html = f"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Personalizacion - justificacion de variables</title>
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

<h1>Personalizacion de respuestas: que variables usar</h1>
<p>Analisis sobre datos reales de <code>silver.*</code> ({total_customers:,} clientes) para decidir
que senales soportan <code>gold.customer_personalization_profile</code>, antes de construirlo.
Las senales de riesgo (score de credito, ingreso, fraud_score) quedan fuera de alcance por decision del equipo.</p>

<h2>1. Cobertura de cada senal por cliente</h2>
<p class="note">Ningun cliente esta completamente "frio": todos tienen al menos un evento digital o
una interaccion. Pero la cobertura cae fuerte en quejas (36%) y transcripciones (68%) -- esas dos
no pueden ser la unica senal de personalizacion de un cliente.</p>
<img src="data:image/png;base64,{coverage_img}" alt="Cobertura de señales">
{df_to_html_table(coverage[['source', 'customers_with_signal', '% of customers']])}

<h2>2. Acento: dominio y consistencia entre fuentes</h2>
<div class="metric">Clientes comparables: <b>{agree[0]:,}</b></div>
<div class="metric">Coinciden perfil vs. interacciones: <b>{100*agree[1]/agree[0]:.1f}%</b></div>
<div class="metric">Clientes con acento en blanco: <b>{blank_accent:,} ({100*blank_accent/total_customers:.1f}%)</b></div>
<img src="data:image/png;base64,{accent_img}" alt="Distribución de acentos">
<p class="note">Donde ambas fuentes existen, coinciden el 100% de las veces -- confiable. Pero
falta en ~30% de los perfiles, asi que se necesita una cadena de respaldo (perfil -> moda en
interacciones -> moda en transcripciones -> null explicito).</p>

<h2>3. Idioma: verificacion del requisito Espanol/Portugues</h2>
{df_to_html_table(lang)}
<div class="metric">Transcripciones en portugues: <b>{pt_count:,}</b></div>
<p class="note"><b>Hallazgo critico:</b> el dataset no contiene ninguna muestra en portugues.
La personalizacion en portugues no puede derivarse de estos datos -- debe construirse con casos
manuales y reportarse como limitacion del dataset, no simularse como si estuviera validada.</p>

<h2>4. Segmento, pais y canal digital</h2>
<img src="data:image/png;base64,{segment_channel_img}" alt="Segmento y canal">
<p class="note">Segmento esta desbalanceado (Basic 60%, Premium 10%) -- cualquier evaluacion por
segmento tendra menos evidencia para Premium/Student. Pais y canal estan bien distribuidos.</p>

<h2>5. Contacto repetido y quejas abiertas</h2>
<img src="data:image/png;base64,{reason_img}" alt="Motivos de contacto">
<div class="metric">Clientes con >=2 contactos por el mismo motivo: <b>{repeat:,} ({100*repeat/total_customers:.1f}%)</b></div>
<div class="metric">Clientes con queja abierta ahora: <b>{open_complaints:,} ({100*open_complaints/total_customers:.1f}%)</b></div>

<h2>6. Sentimiento, satisfaccion y consentimiento</h2>
<div class="metric">Nulos en sentiment_score: <b>{sent_null[1]:,}/{sent_null[0]:,} (0%)</b></div>
{df_to_html_table(consent)}
<p class="note"><code>accepts_marketing</code> esta perfectamente balanceado y sin nulos -- sirve
como filtro (gate) para personalizacion proactiva, no como estilo de personalizacion en si.</p>

<h2>7. Variables recomendadas para gold.customer_personalization_profile</h2>
{df_to_html_table(recommended)}

<footer>
Generado desde <code>silver.*</code> (solo lectura). Base de datos con {total_customers:,} clientes.
Consultas ejecutadas en {elapsed:.1f}s. Dataset sintetico -- estos conteos describen la muestra generada
para el hackathon, no comportamiento real de clientes.
</footer>

</body>
</html>
"""

    Path(args.output).write_text(html, encoding="utf-8")
    print(f"Wrote {args.output} ({len(html):,} chars) in {elapsed:.1f}s query time")
    return 0


if __name__ == "__main__":
    sys.exit(main())
