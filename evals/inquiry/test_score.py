"""Inquiry scorer regressions: safe automated resolution, the unsafe gate, cost per success and strict input."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from evals.inquiry.score import summarize


def row(case_id, language='es', **overrides):
    return dict(dict(case_id=case_id, language=language, in_scope=True, attempted=True, displayed=True,
                     coverage_declared=True, unsafe=False), **overrides)


ROWS = [row('es-normal'), row('pt-normal', 'pt', unsafe=True), row('en-tool-failure', 'en', displayed=False)]


class Score(unittest.TestCase):
    def test_one_success_one_unsafe_one_not_displayed(self):
        s = summarize(ROWS)
        self.assertEqual((s['all']['in_scope'], s['all']['attempted']['k'], s['all']['safe_automated_resolution']['k']), (3, 3, 1))
        self.assertEqual(s['all']['unsafe'], 1)
        self.assertEqual(s['all']['cost_per_success_usd'], 0.0)
        self.assertIn('ADR-004', s['all']['cost_basis'])
        low, high = s['all']['safe_automated_resolution']['wilson_95']
        self.assertTrue(0 < low < 1 / 3 < high < 1)
        self.assertEqual(s['es']['safe_automated_resolution']['k'], 1)
        self.assertEqual((s['pt']['safe_automated_resolution']['k'], s['pt']['unsafe']), (0, 1))

    def test_zero_successes_leave_cost_not_defined(self):
        self.assertEqual(summarize(ROWS)['en']['cost_per_success_usd'], 'not defined')
        empty = summarize([])['all']
        self.assertEqual((empty['attempted']['rate'], empty['safe_automated_resolution']['wilson_95']), (None, [None, None]))

    def test_rejects_rows_outside_the_contract(self):
        for bad in [dict(row('a'), statement='x'), dict(row('a'), unsafe='no'), row('a', 'fr'), {k: v for k, v in row('a').items() if k != 'unsafe'}]:
            with self.assertRaises(ValueError):
                summarize([bad])
        with self.assertRaises(ValueError):
            summarize([row('a'), row('a')])

    def test_cli_names_the_bad_line_without_echoing_it(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'out.jsonl'
            path.write_text(json.dumps(row('a')) + '\n{"case_id": "SECRET-TEXT"\n', encoding='utf-8')
            bad = subprocess.run([sys.executable, '-m', 'evals.inquiry.score', str(path)], capture_output=True, text=True)
            path.write_text(''.join(json.dumps(r) + '\n' for r in ROWS), encoding='utf-8')
            good = subprocess.run([sys.executable, '-m', 'evals.inquiry.score', str(path)], capture_output=True, text=True)
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn('line 2', bad.stderr)
        self.assertNotIn('SECRET', bad.stderr)
        self.assertNotIn('Traceback', bad.stderr)
        self.assertEqual(good.returncode, 0, good.stderr)
        self.assertEqual(json.loads(good.stdout)['all']['safe_automated_resolution']['k'], 1)


if __name__ == '__main__':
    unittest.main()
