"""Frozen-set results without the exposed cases (ADR-006 amendment 5), reusing the runner's own summary."""
import argparse, json
from evals.intake.run import _summary
from evals.intake.stats import mcnemar_exact


def _rows(result):
    """References come from ``cases`` (one execution each); a registered system from ``majority`` (one row per case)."""
    return [r for r in result['cases'] if r['repetition'] is None] + result['majority']


def unexposed(result, exposed):
    """``run._summary`` rows (Wilson interval included) per baseline and language over the cases not in ``exposed``."""
    rows = [r for r in _rows(result) if r['case_id'] not in exposed]
    return [_summary(r0['split'], name, language, r0['repetition'], group)
            for name in sorted({r['baseline'] for r in rows})
            for language in ('all', 'es', 'pt')
            for group in [[r for r in rows if r['baseline'] == name and language in ('all', r['session_language'])]]
            if group for r0 in [group[0]]]


def paired(result, system, exposed):
    """Discordant pairs (checklist right and system wrong, system right and checklist wrong) for McNemar."""
    by = {(r['case_id'], r['baseline']): r['correct'] for r in _rows(result) if r['case_id'] not in exposed}
    ids = {c for c, b in by if b == system}
    return (sum(by[c, 'checklist'] and not by[c, system] for c in ids),
            sum(by[c, system] and not by[c, 'checklist'] for c in ids))


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('result'); p.add_argument('--system', required=True)
    p.add_argument('--exposed', required=True)
    a = p.parse_args()
    result, exposed = json.load(open(a.result)), set(json.load(open(a.exposed)))
    b, c = paired(result, a.system, exposed)
    print(json.dumps({'unexposed': unexposed(result, exposed), 'mcnemar': {'b': b, 'c': c, 'p': mcnemar_exact(b, c)},
                      'mcnemar_all': dict(zip('bc', paired(result, a.system, set())))}, indent=2))
