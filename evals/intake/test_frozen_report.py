from evals.intake.frozen_report import unexposed, paired


def row(case_id, baseline, correct, rep=None, language='es'):
    return dict(case_id=case_id, baseline=baseline, repetition=rep, correct=correct, safe=True, safe_complete=False,
                missed_handoff=False, unnecessary_handoff=False, latency_ms=1.0, split='frozen_es_pt_v1', language=language,
                session_language=language, gold={'completion_ready': False, 'action': 'clarify'})


def test_unexposed_drops_exposed_cases_and_reuses_run_summary():
    result = {'cases': [row('a', 'checklist', True), row('b', 'checklist', False)],
              'majority': [row('a', 'x', False, 'majority'), row('b', 'x', True, 'majority')]}
    out = unexposed(result, exposed={'a'})
    checklist = next(s for s in out if s['baseline'] == 'checklist' and s['language'] == 'all')
    assert (checklist['cases'], checklist['correct']) == (1, 0)


def test_paired_counts_discordant_cases():
    result = {'cases': [row('a', 'checklist', True), row('b', 'checklist', False)],
              'majority': [row('a', 'x', False, 'majority'), row('b', 'x', True, 'majority')]}
    assert paired(result, 'x', exposed=set()) == (1, 1)
