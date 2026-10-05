"""Offline contract checks for the discovery scorer; fabricated attempts exercise gates, never model quality."""
import copy
import unittest
from evals.support_assist import discovery_score as ds, score

class DiscoveryScorer(unittest.TestCase):
    def setUp(self):
        self.cases = score.load_jsonl(ds.ROOT / 'discovery-acceptance.jsonl')
        self.attempts = []
        for i, (case, repeat) in enumerate((c, n) for c in self.cases for n in (1, 2, 3)):
            e = case['expected']; local = e['blocked_locally']
            self.attempts.append({'case_id': case['id'], 'repeat': repeat, 'request_id': f'00000000-0000-4000-8000-{i:012d}', 'version': ds.VERSION,
                                  'started_at': '2026-10-06T00:00:00Z', 'elapsed_ms': 900, 'outcome': 'blocked_local' if local else 'success',
                                  'prediction': None if local else {'intent': e['intent'], 'criteria': e['criteria']},
                                  'candidate_ids': case['expected_candidate_ids'] if e['criteria'] else None,
                                  'status': (('ambiguous' if len(case['expected_candidate_ids']) > 3 else 'candidates') if e['criteria'] else None)})

    def test_frozen_corpus_is_consistent(self):
        ds.check_discovery_fixtures()

    def test_perfect_run_passes_but_never_approves_activation(self):
        result = ds.score(self.cases, self.attempts)
        self.assertTrue(result['passed']); self.assertFalse(result['activation_approved'])
        self.assertEqual(result['attempts'], 180); self.assertEqual(result['candidate_recall'], 1.0); self.assertEqual(result['false_no_match_rate'], 0.0)

    def test_one_search_on_an_adversarial_case_blocks(self):
        attempts = copy.deepcopy(self.attempts)
        a = next(x for x in attempts if next(c for c in self.cases if c['id'] == x['case_id'])['adversarial_or_unsupported'] and x['outcome'] == 'success')
        a['prediction'] = {'intent': 'transaction_search', 'criteria': None}; a['candidate_ids'] = ['t1']
        self.assertFalse(ds.score(self.cases, attempts)['passed'])

    def test_slow_successes_and_missing_attempts_fail(self):
        slow = copy.deepcopy(self.attempts)
        for a in slow[:12]: a['elapsed_ms'] = 9000
        self.assertFalse(ds.score(self.cases, slow)['passed'])
        with self.assertRaises(ValueError): ds.score(self.cases, self.attempts[:-1])

if __name__ == '__main__':
    unittest.main()
