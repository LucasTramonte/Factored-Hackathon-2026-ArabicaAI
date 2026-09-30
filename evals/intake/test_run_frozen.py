"""The runner accepts the frozen ES/PT schema (v0.3) without reading the withheld set."""
import json
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from evals.intake.run import SPLITS, evaluate

RECORDS = [dict(transaction_id='X-T1', customer_id='X-C1', transaction_date='2026-02-26T13:21:51', amount='29763.49',
                currency='ARS', merchant_name='Uber', merchant_category='Transport', product_type='Tarjeta Crédito',
                last4='4821', transaction_country='Argentina')]
BASE = dict(customer_id='X-C1', authenticated=True, confirmed_id=None, tool_failure=False, split='frozen_es_pt_v1',
            as_of='2026-02-27T10:00:00', situation_id='s1')


def corpus():
    return dict(version='frozen-es-pt-v1', transactions=RECORDS, cases=[
        dict(BASE, case_id='x-1', family='single_clear_match', language='es', session_language='es',
             message='No reconozco un cargo de 29763.49 ARS del 2026-02-26',
             gold=dict(action='confirm', candidate_ids=['X-T1'], completion_ready=False)),
        dict(BASE, case_id='x-2', family='unsupported_language', language='other', session_language='pt',
             message="Je ne reconnais pas un achat de 29763.49 ARS", situation_id='s2',
             gold=dict(action='route', candidate_ids=[], completion_ready=False))])


class FrozenRunnerTests(unittest.TestCase):
    def test_frozen_split_and_other_language_are_accepted(self):
        self.assertIn('frozen_es_pt_v1', SPLITS)
        result = evaluate(corpus())
        rows = [s for s in result['summary'] if s['split'] == 'frozen_es_pt_v1' and s['baseline'] == 'checklist']
        overall = next(s for s in rows if s['language'] == 'all')
        self.assertEqual(overall['cases'], 2)
        low, high = overall['correct_rate_ci95']
        self.assertTrue(0 <= low <= overall['correct_rate'] <= high <= 1)

    def test_language_breakdowns_use_the_session_language_and_add_up(self):
        rows = {(s['baseline'], s['language']): s['cases'] for s in evaluate(corpus())['summary'] if s['split'] == 'frozen_es_pt_v1'}
        for baseline in ('handoff', 'checklist'):
            self.assertEqual(rows[(baseline, 'es')], 1)
            self.assertEqual(rows[(baseline, 'pt')], 1)  # the French message arrived in a Portuguese session
            self.assertEqual(rows[(baseline, 'es')] + rows[(baseline, 'pt')], rows[(baseline, 'all')])

    def test_other_language_is_only_allowed_for_the_unsupported_family(self):
        c = corpus()
        c['cases'][1]['family'] = 'no_match'
        with self.assertRaisesRegex(ValueError, 'Unsupported split/language'):
            evaluate(c)

    def test_empty_groups_keep_an_undefined_interval(self):
        rows = [s for s in evaluate(corpus())['summary'] if s['split'] == 'safety']
        self.assertTrue(all(s['cases'] == 0 and s['correct_rate_ci95'] == [None, None] for s in rows))

    def test_cli_runs_a_given_cases_file_and_records_its_hash(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / 'frozen.json'
            path.write_text(json.dumps(corpus()), encoding='utf-8')
            out = Path(tmp) / 'results.json'
            subprocess.run([sys.executable, '-m', 'evals.intake.run', '--cases', str(path), '--output', str(out)],
                           check=True, capture_output=True, cwd=Path(__file__).resolve().parents[2])
            result = json.loads(out.read_text(encoding='utf-8'))
            self.assertEqual(result['provenance']['corpus_path'], str(path))
            self.assertEqual(len(result['provenance']['corpus_sha256']), 64)


if __name__ == '__main__':
    unittest.main()
