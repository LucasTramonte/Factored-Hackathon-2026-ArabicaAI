"""Intake decision-KPI baselines from a verified Silver DB: aggregates and their statistics only.

Runs data_foundation/queries/intake_kpis/IK-*.sql read-only on one window. `design` (2023-06-17 to 2025-12-31) is
the only window that may inform design (ADR-005). `holdout` (2026-01-01 to 2026-06-17) is run once, after the
confirmation rule in BUSINESS_OUTCOMES.md was committed, to check that each baseline holds out of sample.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

import duckdb

from data_foundation.scripts.run_marketing_product import published_manifest, validate_quality_identity

QUERIES = Path(__file__).resolve().parents[1] / 'queries' / 'intake_kpis'
WINDOWS = {'design': ('2023-06-17', '2026-01-01'), 'holdout': ('2026-01-01', '2026-06-18')}
RATES = ('rejected', 'escalated', 'mistyped', 'digital', 'assigned')


def wilson(k: int, n: int, z: float = 1.96) -> list[float]:
    """Wilson score 95% interval for k successes in n trials."""
    if n == 0:
        return [math.nan, math.nan]
    p, d = k / n, 1 + z * z / n
    centre, half = (p + z * z / (2 * n)) / d, z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [max(0.0, centre - half), min(1.0, centre + half)]


def cochran_armitage(k: list[int], n: list[int]) -> dict:
    """Two-sided Cochran–Armitage test for a linear trend in proportions over ordered groups (scores 0..g-1)."""
    x = range(len(n))
    p, xbar = sum(k) / sum(n), sum(ni * xi for ni, xi in zip(n, x)) / sum(n)
    t = sum(ki * (xi - xbar) for ki, xi in zip(k, x))
    v = p * (1 - p) * sum(ni * (xi - xbar) ** 2 for ni, xi in zip(n, x))
    z = t / math.sqrt(v) if v else 0.0
    return {'z': z, 'p': math.erfc(abs(z) / math.sqrt(2))}


def poisson_gof(counts: dict[int, int], population: int) -> dict:
    """Chi-square goodness of fit of complaints per customer to a Poisson with the observed mean.

    Cells are 0, 1 and 2+ (pooled so expected counts stay large); one parameter is estimated, so df = 1 and
    p = erfc(sqrt(chi2 / 2)). `counts` holds customers with k >= 1; zero-complaint customers are the remainder.
    """
    total = sum(k * c for k, c in counts.items())
    lam = total / population
    observed = [population - sum(counts.values()), counts.get(1, 0), sum(c for k, c in counts.items() if k >= 2)]
    e0, e1 = population * math.exp(-lam), population * lam * math.exp(-lam)
    expected = [e0, e1, population - e0 - e1]
    chi2 = sum((o - e) ** 2 / e for o, e in zip(observed, expected))
    return {'lambda': lam, 'observed_0_1_2plus': observed, 'expected_0_1_2plus': [round(e, 1) for e in expected],
            'chi2': chi2, 'df': 1, 'p': math.erfc(math.sqrt(chi2 / 2))}


def relative_risk(a: int, n1: int, b: int, n0: int) -> dict:
    """Risk ratio (a/n1)/(b/n0) with a 95% log-normal interval."""
    rr = (a / n1) / (b / n0)
    se = math.sqrt(1 / a - 1 / n1 + 1 / b - 1 / n0)
    return {'rr': rr, 'ci95': [math.exp(math.log(rr) - 1.96 * se), math.exp(math.log(rr) + 1.96 * se)]}


def _rows(con, name: str, start: str, end: str) -> list[dict]:
    sql = (QUERIES / name).read_text(encoding='utf-8').format(start=start, end=end)
    cur = con.execute(sql)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def summarize(q: dict, customers: int, window: str) -> dict:
    """Turn the IK query rows into rates, intervals and tests; no row-level data leaves this function."""
    quarters = q['IK-01']
    if window == 'design':  # the first quarter holds only 2023-06-17..30; trends use full quarters only
        quarters = [r for r in quarters if str(r['quarter']) >= '2023-07-01']
    n = [r['complaints'] for r in quarters]
    rates = {}
    for name in RATES:
        k = [r[name] for r in quarters]
        rates[name] = {'numerator': sum(k), 'denominator': sum(n), 'rate': sum(k) / sum(n), 'ci95': wilson(sum(k), sum(n)),
                       'first_quarter': k[0] / n[0], 'last_quarter': k[-1] / n[-1],
                       'trend': cochran_armitage(k, n) if len(n) > 2 else None}
    repeat = {r['complaints_per_customer']: r['customers'] for r in q['IK-02']}
    fam = {}
    for r in q['IK-05']:
        f = fam.setdefault(r['familiarity'], [0, 0])
        f[0] += r['fraud']; f[1] += r['transactions']
    return {
        'window': window, 'quarters': len(quarters), 'complaints_in_trend_quarters': sum(n),
        'complaints_in_window': sum(r['complaints'] for r in q['IK-01']),
        'rates': rates,
        'repeat_reporters': {'customers_by_count': repeat, 'poisson': poisson_gof(repeat, customers),
                             'gap_and_flag': q['IK-03']},
        'claimed_value': q['IK-04'],
        'familiar_merchant': {'fraud_transactions': {k: {'fraud': v[0], 'transactions': v[1]} for k, v in fam.items()},
                              'first_time_vs_seen_before': relative_risk(fam['first_time'][0], fam['first_time'][1],
                                                                         fam['seen_before'][0], fam['seen_before'][1]),
                              'by_year': q['IK-05']},
    }


def main(argv: list[str] | None = None) -> int:
    """Check the quality run belongs to this DB, run the IK queries read-only on one window and write JSON."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('--quality', type=Path, required=True, help='Full quality_results.json for this DB')
    parser.add_argument('--window', choices=WINDOWS, required=True)
    parser.add_argument('--output', type=Path, required=True, help='Aggregate JSON to write')
    parser.add_argument('--memory-limit', default='2GB')
    args = parser.parse_args(argv)
    quality = json.loads(args.quality.read_text(encoding='utf-8'))
    try:
        validate_quality_identity(args.db, quality['metadata'])
    except ValueError as exc:
        parser.error(str(exc))
    start, end = WINDOWS[args.window]
    tmp = args.output.parent / f'.duckdb_tmp_{os.getpid()}'
    tmp.mkdir(parents=True)
    try:
        with duckdb.connect(str(args.db), read_only=True) as con:
            con.execute('SET memory_limit=?', [args.memory_limit])
            con.execute('SET threads=?', [int(os.environ.get('DUCKDB_THREADS', '2'))])
            con.execute('SET temp_directory=?', [str(tmp)])
            q = {p.name[:5]: _rows(con, p.name, start, end) for p in sorted(QUERIES.glob('IK-*.sql'))}
            customers = con.execute('SELECT count(*) FROM silver.dim_customers').fetchone()[0]
    finally:
        shutil.rmtree(tmp)
    result = summarize(q, customers, args.window)
    result['manifest'] = published_manifest({
        'generated_at_utc': datetime.now(timezone.utc).isoformat(), 'window': [start, end],
        'quality_generated_at_utc': quality['metadata']['generated_at_utc'], 'quality_checks': len(quality['checks']),
        'quality_errors': quality['metadata']['errors'], 'quality_warnings': quality['metadata']['warnings'],
        'memory_model': 'DuckDB projected scans, one window function, grouped SQL with disk spill; Python holds aggregates only',
    }, args.db, args.quality)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=1, default=str, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'{args.window}: complaints={result["complaints_in_window"]} -> {args.output}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
