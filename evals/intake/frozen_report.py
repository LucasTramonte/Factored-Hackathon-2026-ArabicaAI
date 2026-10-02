"""Frozen-set results without the exposed cases (ADR-006 amendment 5), reusing the runner's own summary."""
import argparse, json
from pathlib import Path
from evals.intake.run import _summary
from evals.intake.stats import mcnemar_exact


def _rows(result):
    """References come from ``cases`` (one execution each); a registered system from ``majority`` (one row per case)."""
    return [r for r in result['cases'] if r['repetition'] is None] + result['majority']


def unexposed(result, exposed):
    """``run._summary`` rows (Wilson interval included) per baseline and language over the cases not in ``exposed``.

    The result must cover one split; empty baseline/language groups are omitted.
    """
    rows = [r for r in _rows(result) if r['case_id'] not in exposed]
    splits = {r['split'] for r in rows}
    if len(splits) > 1: raise ValueError(f'pass a single-split result, got {sorted(splits)}')
    summaries = []
    for name in sorted({r['baseline'] for r in rows}):
        for language in ('all', 'es', 'pt'):
            group = [r for r in rows if r['baseline'] == name and language in ('all', r['session_language'])]
            if group: summaries.append(_summary(group[0]['split'], name, language, group[0]['repetition'], group))
    return summaries


def paired(result, system, exposed):
    """Discordant pairs (checklist right and system wrong, system right and checklist wrong) for McNemar."""
    by = {(r['case_id'], r['baseline']): r['correct'] for r in _rows(result) if r['case_id'] not in exposed}
    ids = {c for c, b in by if b == system}
    if not ids: raise ValueError(f'no rows for system {system!r}')
    return (sum(by[c, 'checklist'] and not by[c, system] for c in ids),
            sum(by[c, system] and not by[c, 'checklist'] for c in ids))


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('result'); p.add_argument('--system', required=True)
    p.add_argument('--exposed', required=True)
    a = p.parse_args()
    result = json.loads(Path(a.result).read_text(encoding='utf-8'))
    exposed = set(json.loads(Path(a.exposed).read_text(encoding='utf-8')))
    unknown = exposed - {r['case_id'] for r in result['cases']}
    if unknown: raise SystemExit(f'unknown exposed ids: {len(unknown)} not in the result')
    b, c = paired(result, a.system, exposed)
    print(json.dumps({'unexposed': unexposed(result, exposed), 'mcnemar': {'b': b, 'c': c, 'p': mcnemar_exact(b, c)},
                      'mcnemar_all': dict(zip('bc', paired(result, a.system, set())))}, indent=2))
