"""Shared measurements and readings for the personalization signal profile.

profile_personalization.py (markdown), build_personalization_html.py (HTML) and the generated
notebook all call ``measure`` and ``readings`` from here. Every conclusion printed in any of the
three outputs is derived from the measured values, so a regenerated report cannot contradict its
own tables.

Invariants:
- Read-only: callers open the DuckDB file with ``read_only=True``.
- Customer-level coverage numerators count only IDs present in ``silver.dim_customers``; fact IDs
  missing from the dimension are counted separately as orphans and never enter a percentage.
- Memory model: every metric is one grouped DuckDB query returning a handful of rows; no fact keys
  are pulled into Python. DuckDB runs under ``memory_limit`` with disk spill in ``duckdb_tmp``.
- Consent, segment and complaint status are current snapshots; readings say so rather than
  implying history.
"""
from __future__ import annotations

import os
from pathlib import Path

import duckdb
import html
import re


def reading_html(value: str) -> str:
    """Escape measured text, then render its Markdown code spans."""
    safe = html.escape(value)
    return re.sub(r"`([^`]+)`", lambda match: f"<code>{match.group(1)}</code>", safe)

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT_DEFAULT = SCRIPT_DIR.parent.parent

# Fact tables whose per-customer coverage is profiled, in report order.
COVERAGE_FACTS = (
    'fact_call_center_interactions', 'fact_call_transcripts', 'fact_complaints',
    'fact_satisfaction_surveys', 'fact_digital_events', 'fact_transactions',
)
OPEN_COMPLAINT_STATUSES = ('Open', 'In Process', 'Escalated')
# A source below this share of customers cannot be anyone's only personalization signal.
LOW_COVERAGE_PCT = 80.0


def resolve_duckdb_path() -> Path:
    """Same PROJECT_ROOT / DATA_DIR / DUCKDB_PATH convention as the rest of the pipeline."""
    project_root = Path(os.environ.get('PROJECT_ROOT', PROJECT_ROOT_DEFAULT)).resolve()
    data_dir = Path(os.environ.get('DATA_DIR', project_root / 'data')).resolve()
    return Path(os.environ.get('DUCKDB_PATH', data_dir / 'latam_bank.duckdb'))


def display_path(db_path: Path) -> str:
    """Path to print in committed outputs: repo-relative when possible, never a home directory."""
    try:
        return Path(db_path).resolve().relative_to(PROJECT_ROOT_DEFAULT).as_posix()
    except ValueError:
        return Path(db_path).name


def connect(db_path: Path, memory_limit: str = '3GB') -> duckdb.DuckDBPyConnection:
    """Open Silver read-only with bounded memory and disk spill next to the database."""
    con = duckdb.connect(str(db_path), read_only=True)
    temp_dir = Path(db_path).parent / 'duckdb_tmp'
    temp_dir.mkdir(parents=True, exist_ok=True)
    con.execute('SET memory_limit=?', [memory_limit])
    con.execute('SET temp_directory=?', [str(temp_dir)])
    con.execute('SET threads=?', [int(os.environ.get('DUCKDB_THREADS', '2'))])
    return con


def pct(n, d) -> float | None:
    """Percentage rounded to one decimal; undefined when the denominator is zero."""
    return round(100 * n / d, 1) if d else None


def _rows(con, sql, params=()):
    return con.execute(sql, list(params)).fetchall()


def _coverage(con, fact: str) -> tuple[int, int]:
    """Distinct dimension customers with >=1 fact row, and distinct fact IDs absent from the dimension.

    LEFT JOIN fact N:1 dim_customers on customer_id (the dimension key is unique in Silver).
    """
    return con.execute(
        f'SELECT count(DISTINCT f.customer_id) FILTER (WHERE d.customer_id IS NOT NULL), '
        f'count(DISTINCT f.customer_id) FILTER (WHERE d.customer_id IS NULL) '
        f'FROM silver.{fact} f LEFT JOIN silver.dim_customers d ON d.customer_id = f.customer_id '
        f'WHERE f.customer_id IS NOT NULL').fetchone()


def measure(con) -> dict:
    """Run every profile query once and return plain Python values."""
    total = con.execute('SELECT count(*) FROM silver.dim_customers').fetchone()[0]
    m: dict = {'total_customers': total, 'coverage': []}
    for fact in COVERAGE_FACTS:
        covered, orphans = _coverage(con, fact)
        m['coverage'].append({'source': fact, 'customers': covered, 'pct': pct(covered, total),
                              'orphan_ids': orphans})

    m['cold'] = con.execute(
        'SELECT count(*) FROM silver.dim_customers c '
        'WHERE NOT EXISTS (SELECT 1 FROM silver.fact_call_center_interactions i WHERE i.customer_id = c.customer_id) '
        'AND NOT EXISTS (SELECT 1 FROM silver.fact_complaints cp WHERE cp.customer_id = c.customer_id) '
        'AND NOT EXISTS (SELECT 1 FROM silver.fact_digital_events d WHERE d.customer_id = c.customer_id)'
    ).fetchone()[0]

    m['accent_dim'] = _rows(con, "SELECT NULLIF(detected_accent, '') AS a, count(*) FROM silver.dim_customers "
                                 'GROUP BY 1 ORDER BY 2 DESC, 1')
    m['accent_interactions'] = _rows(con, 'SELECT customer_detected_accent, count(*) '
                                          'FROM silver.fact_call_center_interactions GROUP BY 1 ORDER BY 2 DESC, 1')
    m['accent_transcripts'] = _rows(con, 'SELECT detected_accent, count(*) FROM silver.fact_call_transcripts '
                                         'GROUP BY 1 ORDER BY 2 DESC, 1')
    compared, agree = con.execute(
        'WITH per_customer AS ('
        '  SELECT i.customer_id, c.detected_accent AS profile_accent, '
        '         mode(i.customer_detected_accent) AS interaction_mode_accent '
        '  FROM silver.fact_call_center_interactions i '
        '  JOIN silver.dim_customers c USING (customer_id) '  # N:1
        "  WHERE i.customer_detected_accent IS NOT NULL AND NULLIF(c.detected_accent, '') IS NOT NULL "
        '  GROUP BY 1, 2) '
        'SELECT count(*), count(*) FILTER (WHERE profile_accent = interaction_mode_accent) FROM per_customer'
    ).fetchone()
    m['accent_agreement'] = {'compared': compared, 'agree': agree, 'pct': pct(agree, compared)}
    m['blank_accent'] = con.execute(
        "SELECT count(*) FROM silver.dim_customers WHERE NULLIF(detected_accent, '') IS NULL").fetchone()[0]

    m['languages'] = _rows(con, 'SELECT detected_language, count(*) FROM silver.fact_call_transcripts '
                                'GROUP BY 1 ORDER BY 2 DESC, 1')
    m['transcripts'] = sum(n for _, n in m['languages'])
    m['pt_transcripts'] = con.execute(
        "SELECT count(*) FROM silver.fact_call_transcripts WHERE lower(detected_language) LIKE 'pt%'").fetchone()[0]

    m['segments'] = _rows(con, 'SELECT segment, count(*) FROM silver.dim_customers GROUP BY 1 ORDER BY 2 DESC, 1')
    m['countries'] = _rows(con, 'SELECT country, count(*) FROM silver.dim_customers GROUP BY 1 ORDER BY 2 DESC, 1')
    m['channels'] = _rows(con, 'SELECT channel, count(*) FROM silver.fact_digital_events GROUP BY 1 ORDER BY 2 DESC, 1')

    m['reasons'] = _rows(con, 'SELECT reason_category, count(*), count(DISTINCT customer_id) '
                              'FROM silver.fact_call_center_interactions GROUP BY 1 ORDER BY 2 DESC, 1')
    m['repeat_contact'] = con.execute(
        'WITH per_cust AS (SELECT customer_id, reason_category, count(*) AS n '
        '  FROM silver.fact_call_center_interactions '
        '  WHERE customer_id IN (SELECT customer_id FROM silver.dim_customers) GROUP BY 1, 2) '
        'SELECT count(DISTINCT customer_id) FROM per_cust WHERE n >= 2').fetchone()[0]
    m['open_complaints'] = con.execute(
        'SELECT count(DISTINCT customer_id) FROM silver.fact_complaints '
        'WHERE status IN (?, ?, ?) AND customer_id IN (SELECT customer_id FROM silver.dim_customers)',
        list(OPEN_COMPLAINT_STATUSES)).fetchone()[0]

    interactions, null_sentiment, sentiment_customers = con.execute(
        'SELECT count(*), count(*) FILTER (WHERE sentiment_score IS NULL), '
        'count(DISTINCT customer_id) FILTER (WHERE sentiment_score IS NOT NULL '
        '  AND customer_id IN (SELECT customer_id FROM silver.dim_customers)) '
        'FROM silver.fact_call_center_interactions').fetchone()
    m['sentiment'] = {'interactions': interactions, 'null': null_sentiment,
                      'null_pct': pct(null_sentiment, interactions),
                      'customers': sentiment_customers, 'customer_pct': pct(sentiment_customers, total)}
    m['surveys'] = _rows(con, 'SELECT survey_type, count(*), round(avg(main_score), 2), min(main_score), max(main_score) '
                              'FROM silver.fact_satisfaction_surveys GROUP BY 1 ORDER BY 2 DESC, 1')
    m['consent'] = _rows(con, 'SELECT accepts_marketing, count(*) FROM silver.dim_customers GROUP BY 1 ORDER BY 2 DESC, 1')
    return m


def _share_list(rows, total, limit=None):
    items = [f'`{k}` {pct(n, total)}%' for k, n, *_ in rows[:limit]]
    return ', '.join(items)


def readings(m: dict) -> dict[str, str]:
    """Plain-language conclusions, each computed from ``measure`` output."""
    total = m['total_customers']
    out = {}

    low = [c for c in m['coverage'] if c['pct'] is not None and c['pct'] < LOW_COVERAGE_PCT]
    low_text = ', '.join(f"`{c['source']}` ({c['pct']}%)" for c in low)
    orphans = [c for c in m['coverage'] if c['orphan_ids']]
    cold_text = ('Every customer has at least one interaction, complaint or digital event, so there is no '
                 'fully cold-start population.' if m['cold'] == 0 else
                 f"{m['cold']:,} customers ({pct(m['cold'], total)}%) have no interaction, complaint or digital "
                 'event; for them only `dim_customers` fields are available on first contact.')
    out['coverage'] = cold_text + (
        f' Coverage is below {LOW_COVERAGE_PCT:.0f}% for {low_text}; those sources can refine a profile but '
        'cannot be any customer\'s only signal.' if low else
        f' Every profiled source covers at least {LOW_COVERAGE_PCT:.0f}% of customers.') + (
        ' Fact customer IDs missing from `dim_customers` are excluded from the percentages: '
        + ', '.join(f"`{c['source']}` {c['orphan_ids']:,}" for c in orphans) + '.' if orphans else
        ' No fact customer ID is missing from `dim_customers`.')

    a = m['accent_agreement']
    blank_pct = pct(m['blank_accent'], total)
    if a['compared'] == 0:
        agree_text = 'No customer has both a profile accent and an interaction accent, so agreement is unmeasured.'
    elif a['agree'] == a['compared']:
        agree_text = (f"Where both exist ({a['compared']:,} customers) the profile accent matches the most common "
                      'interaction accent every time, so `dim_customers.detected_accent` can be trusted when present.')
    else:
        agree_text = (f"Where both exist ({a['compared']:,} customers) they agree for {a['pct']}%; the "
                      f"{a['compared'] - a['agree']:,} disagreements need a documented precedence rule.")
    out['accent'] = (agree_text + f" The profile accent is blank for {m['blank_accent']:,} customers ({blank_pct}%), "
                     'so the profile needs a fallback chain: `dim_customers` -> mode of interaction accent -> '
                     'mode of transcript accent -> null (never a guessed default).')

    if m['pt_transcripts'] == 0:
        out['language'] = (f"None of the {m['transcripts']:,} transcripts has a Portuguese `detected_language`. "
                           'Portuguese personalization cannot be derived or validated from this dataset; it has to '
                           'be demonstrated with hand-authored cases and reported as a data limitation.')
    else:
        out['language'] = (f"{m['pt_transcripts']:,} of {m['transcripts']:,} transcripts "
                           f"({pct(m['pt_transcripts'], m['transcripts'])}%) have a Portuguese `detected_language`, "
                           'so Portuguese signals can be measured, with that sample size stated.')

    seg = m['segments']
    out['segment'] = (f'Segment shares: {_share_list(seg, total)}. The smallest segment (`{seg[-1][0]}`) has the '
                      'least evidence for any segment-based tone rule. Segment is a current snapshot, not the '
                      'segment at the time of past contacts.' if seg else 'No segment values found.')
    events = sum(n for _, n in m['channels'])
    out['country_channel'] = (f"Countries: {_share_list(m['countries'], total)}. "
                              f"Digital channels: {_share_list(m['channels'], events)} of {events:,} events.")

    out['repeat'] = (f"{m['repeat_contact']:,} customers ({pct(m['repeat_contact'], total)}%) have >=2 interactions "
                     'in the same `reason_category` (ever, not windowed). '
                     f"{m['open_complaints']:,} ({pct(m['open_complaints'], total)}%) currently have an open, "
                     'in-process or escalated complaint; complaint status is a snapshot.')

    s = m['sentiment']
    scales = '; '.join(f'`{t}` {lo}-{hi}' for t, _, _, lo, hi in m['surveys'])
    out['sentiment'] = (f"`sentiment_score` is null for {s['null']:,}/{s['interactions']:,} interactions "
                        f"({s['null_pct']}%) and present for {s['customers']:,} customers ({s['customer_pct']}%). "
                        f'`main_score` ranges per survey type: {scales}. It must not be averaged across types; '
                        'use one column per type.')

    consent = dict((k, n) for k, n in m['consent'])
    nulls = consent.get(None, 0)
    out['consent'] = (f"`accepts_marketing`: True {pct(consent.get(True, 0), total)}%, False "
                      f"{pct(consent.get(False, 0), total)}%, null {nulls:,}. It is the current consent snapshot, so it "
                      'can gate proactive personalization now but says nothing about consent at past contact dates. '
                      'Reactive personalization (answering what the customer asked) does not need this gate.')
    return out


def recommended(m: dict) -> list[tuple[str, str, str, str]]:
    """Recommended-variables table with evidence filled from the measurements."""
    total = m['total_customers']
    a = m['accent_agreement']
    cov = {c['source']: c['pct'] for c in m['coverage']}
    events = sum(n for _, n in m['channels'])
    consent = dict((k, n) for k, n in m['consent'])
    pt = m['pt_transcripts']
    return [
        ('preferred_accent', 'dim_customers -> interaction mode -> transcript mode',
         f"{a['pct']}% agreement over {a['compared']:,} comparable customers; {pct(m['blank_accent'], total)}% blank "
         'in the dimension', 'Include, with the 3-step fallback and null as last resort'),
        ('preferred_language', 'call_transcripts.detected_language',
         f"{pct(pt, m['transcripts'])}% Portuguese of {m['transcripts']:,} transcripts",
         'Include for Spanish only; Portuguese is a documented data gap' if pt == 0 else
         'Include; state the Portuguese sample size'),
        ('segment, country', 'dim_customers',
         f"{sum(n for k, n in m['segments'] if k is None):,} null segments, "
         f"{sum(n for k, n in m['countries'] if k is None):,} null countries; current snapshot",
         'Include directly as tone inputs, never for eligibility'),
        ('preferred_digital_channel', 'mode of fact_digital_events.channel',
         f"{cov['fact_digital_events']}% customer coverage; {len(m['channels'])} channels over {events:,} events",
         'Include'),
        ('repeat_contact_flag', 'fact_call_center_interactions by reason_category',
         f"{pct(m['repeat_contact'], total)}% of customers qualify", 'Include'),
        ('open_complaint_flag', 'fact_complaints.status (snapshot)',
         f"{pct(m['open_complaints'], total)}% of customers", 'Include'),
        ('avg_sentiment_score', 'fact_call_center_interactions.sentiment_score',
         f"{m['sentiment']['null_pct']}% null; {m['sentiment']['customer_pct']}% customer coverage", 'Include'),
        ('csat_avg / nps_avg / ces_avg', 'fact_satisfaction_surveys, split by survey_type',
         f"{len(m['surveys'])} survey types on different scales", 'Include as separate columns, never blended'),
        ('accepts_marketing', 'dim_customers (current snapshot)',
         f"True {pct(consent.get(True, 0), total)}%, null {consent.get(None, 0):,}",
         'Include as a gate for proactive offers, not a style'),
        ('credit_score, estimated_monthly_income, fraud_score, days_past_due', 'dim_customers / products / transactions',
         'Out of scope by team decision', 'Excluded'),
    ]
