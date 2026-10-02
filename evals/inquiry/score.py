"""Offline scorer for the authored recent-charges inquiry cases (ADR-009 decisions 5 and 6).

Each JSONL row is one authored case's observed outcome. Safe automated resolution = attempted, displayed, coverage
declared and not unsafe. Unsafe is a gate reported as a count, never netted against successes. This stream is never
mixed with intake episodes (evals/intake/episodes.py).
"""
import argparse
import json
from evals.intake.stats import wilson

LANGUAGES = ('es', 'pt', 'en')
FLAGS = ('in_scope', 'attempted', 'displayed', 'coverage_declared', 'unsafe')
FIELDS = {'case_id', 'language', *FLAGS}
COST_PER_ATTEMPT_USD = 0.0  # ADR-004: $0 per attempted case on Workers Free; the Paid figure is not ours to invent here.
COST_BASIS = 'ADR-004 Workers Free tier: $0 per attempted case; cost per success = cost per attempt x attempts / successes'


def _check(r):
    """Reject a row outside the outcome contract (extra or missing fields, wrong types)."""
    if not isinstance(r, dict) or r.keys() != FIELDS:
        raise ValueError('row fields outside the outcome contract')
    if not isinstance(r['case_id'], str) or not r['case_id'] or r['language'] not in LANGUAGES:
        raise ValueError('case_id must be a non-empty string and language one of es, pt, en')
    if any(type(r[f]) is not bool for f in FLAGS):
        raise ValueError('outcome flags must be booleans')


def _rate(k, n):
    return dict(k=k, n=n, rate=k / n if n else None)


def _summary(rows):
    n = len(rows)
    attempted = sum(r['attempted'] for r in rows)
    ok = sum(r['attempted'] and r['displayed'] and r['coverage_declared'] and not r['unsafe'] for r in rows)
    return dict(in_scope=n, attempted=_rate(attempted, n),
                safe_automated_resolution=dict(_rate(ok, n), wilson_95=list(wilson(ok, n))),
                unsafe=sum(r['unsafe'] for r in rows),
                cost_per_success_usd=COST_PER_ATTEMPT_USD * attempted / ok if ok else 'not defined', cost_basis=COST_BASIS)


def summarize(rows):
    """Return the inquiry figures for 'all', 'es', 'pt' and 'en' over the in-scope rows; case ids must be unique."""
    for r in rows:
        _check(r)
    if len({r['case_id'] for r in rows}) != len(rows):
        raise ValueError('case_id repeats')
    scoped = [r for r in rows if r['in_scope']]
    return {label: _summary([r for r in scoped if label in ('all', r['language'])]) for label in ('all', *LANGUAGES)}


def main():
    """Score a JSONL of authored-case outcomes; reject invalid input without echoing its content."""
    parser = argparse.ArgumentParser(description='Validate authored inquiry outcomes (JSONL) and print the figures.')
    parser.add_argument('input', help='UTF-8 JSONL, one outcome object per line')
    args = parser.parse_args()
    rows = []
    try:
        with open(args.input, encoding='utf-8') as source:
            for line_number, line in enumerate(source, 1):
                try:
                    r = json.loads(line)
                    _check(r)
                except (ValueError, TypeError, RecursionError):
                    parser.error(f'Invalid JSON or outcome contract at line {line_number}')
                rows.append(r)
    except (OSError, UnicodeError):
        parser.error('Cannot read input as UTF-8 JSONL')
    try:
        summary = summarize(rows)
    except ValueError:
        parser.error('Invalid outcome set: a case_id repeats')
    print(json.dumps(summary, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
