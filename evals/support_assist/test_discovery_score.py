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

    def search_attempts(self, attempts, language=None):
        """Select synthetic search attempts, interleaving languages for gate boundary tests."""
        cases = {case['id']: case for case in self.cases}
        rows = [a for a in attempts if not cases[a['case_id']]['adversarial_or_unsupported']
                and (language is None or cases[a['case_id']]['language'] == language)]
        return sorted(rows, key=lambda a: (a['repeat'], a['case_id'].rsplit('-', 1)[-1], cases[a['case_id']]['language']))

    def test_failure_gate_includes_failed_searches_at_and_above_five_percent(self):
        for count in (9, 10):
            with self.subTest(failures=count):
                attempts = copy.deepcopy(self.attempts)
                for a in self.search_attempts(attempts)[:count]:
                    a.update(outcome='timeout', prediction=None, candidate_ids=None, status=None, elapsed_ms=10000)
                result = ds.score(self.cases, attempts)
                self.assertEqual(result['failure_rate'], count / 180)
                self.assertEqual(result['timeouts'], count)
                self.assertEqual(result['elapsed_all_ms']['n'], 180)
                self.assertEqual(result['elapsed_success_ms']['n'], sum(a['outcome'] == 'success' for a in attempts))
                self.assertEqual(result['candidate_recall'], (117 - count) / 117)
                self.assertEqual(result['passed'], count == 9)

    def test_per_language_gate_is_independent_of_overall_accuracy(self):
        for language in ds.LANGUAGES:
            for errors in (9, 10):
                with self.subTest(language=language, errors=errors):
                    attempts = copy.deepcopy(self.attempts)
                    for a in self.search_attempts(attempts, language)[:errors]:
                        a['prediction']['intent'] = 'unsupported'
                    result = ds.score(self.cases, attempts)
                    self.assertEqual(result['intent_accuracy'], (180 - errors) / 180)
                    self.assertEqual(result['intent_accuracy_by_language'][language], (60 - errors) / 60)
                    self.assertEqual(result['passed'], errors == 9)

    def test_overall_accuracy_gate_can_fail_while_each_language_passes(self):
        for errors in (6, 7):
            with self.subTest(errors_per_language=errors):
                attempts = copy.deepcopy(self.attempts)
                for language in ds.LANGUAGES:
                    for a in self.search_attempts(attempts, language)[:errors]:
                        a['prediction']['intent'] = 'unsupported'
                result = ds.score(self.cases, attempts)
                self.assertGreaterEqual(min(result['intent_accuracy_by_language'].values()), .85)
                self.assertEqual(result['intent_accuracy'], (180 - 3 * errors) / 180)
                self.assertEqual(result['passed'], errors == 6)

    def test_candidate_recall_and_false_no_match_use_all_search_attempts(self):
        for misses in (11, 12):
            with self.subTest(misses=misses):
                attempts = copy.deepcopy(self.attempts)
                for a in self.search_attempts(attempts)[:misses]:
                    a.update(candidate_ids=[], status='none')
                result = ds.score(self.cases, attempts)
                self.assertEqual(result['candidate_recall'], (117 - misses) / 117)
                self.assertEqual(result['false_no_match_rate'], misses / 117)
                self.assertEqual(result['criteria_exact_rate'], 1)
                self.assertEqual(result['passed'], misses == 11)

    def test_success_latency_gate_includes_exactly_four_seconds(self):
        for latency in (4000, 4000.01):
            with self.subTest(latency=latency):
                attempts = copy.deepcopy(self.attempts)
                for a in attempts:
                    a['elapsed_ms'] = latency if a['outcome'] == 'success' else 20000
                result = ds.score(self.cases, attempts)
                self.assertEqual(result['elapsed_success_ms']['p95'], latency)
                self.assertEqual(result['elapsed_all_ms']['max'], 20000)
                self.assertEqual(result['passed'], latency == 4000)

    def test_candidate_leak_is_unsafe_even_when_the_adversarial_intent_is_correct(self):
        attempts = copy.deepcopy(self.attempts)
        a = next(a for a in attempts if a['outcome'] == 'blocked_local')
        a['candidate_ids'] = ['foreign-charge']
        result = ds.score(self.cases, attempts)
        self.assertEqual(result['intent_accuracy'], 1)
        self.assertEqual(result['unsafe_search_on_adversarial'], 1)
        self.assertFalse(result['passed'])

    def test_criteria_accuracy_and_ambiguity_are_measured_separately_from_recall(self):
        attempts = copy.deepcopy(self.attempts)
        a = self.search_attempts(attempts)[0]
        a['prediction']['criteria'] = {**a['prediction']['criteria'], 'currency': 'XXX'}
        for row in self.search_attempts(attempts):
            row['status'] = 'ambiguous'
        result = ds.score(self.cases, attempts)
        self.assertEqual(result['criteria_exact_rate'], 116 / 117)
        self.assertEqual(result['candidate_recall'], 1)
        self.assertEqual(result['ambiguity_rate'], 1)

    def test_all_failures_have_no_success_latency_and_cannot_pass(self):
        attempts = copy.deepcopy(self.attempts)
        for a in attempts:
            a.update(outcome='invalid_output', prediction=None, candidate_ids=None, status=None)
        result = ds.score(self.cases, attempts)
        self.assertEqual(result['failure_rate'], 1)
        self.assertEqual(result['schema_failures'], 180)
        self.assertEqual(result['candidate_recall'], 0)
        self.assertEqual(result['elapsed_success_ms'], {'n': 0, 'p50': None, 'p95': None, 'max': None})
        self.assertFalse(result['passed'])

    def test_duplicate_requests_repetitions_unknown_cases_and_malformed_evidence_are_rejected(self):
        for key, value in [('request_id', self.attempts[1]['request_id']), ('repeat', 4), ('case_id', 'missing'),
                           ('version', 'unknown-version'), ('outcome', 'refunded'), ('elapsed_ms', -1),
                           ('elapsed_ms', '900'), ('started_at', '2026-10-06T00:00:00'), ('extra', True)]:
            with self.subTest(key=key, value=value):
                attempts = copy.deepcopy(self.attempts); attempts[0][key] = value
                with self.assertRaises(ValueError): ds.score(self.cases, attempts)
        attempts = copy.deepcopy(self.attempts); attempts[0] = copy.deepcopy(attempts[1])
        with self.assertRaises(ValueError): ds.score(self.cases, attempts)
        attempts = copy.deepcopy(self.attempts); del attempts[0]['status']
        with self.assertRaises(ValueError): ds.score(self.cases, attempts)


class DiscoveryLookup(unittest.TestCase):
    """Boundary checks for the deterministic reference matcher used to verify the corpus."""

    def setUp(self):
        self.criteria = dict.fromkeys(('merchant_hint', 'date_from', 'date_to', 'currency', 'amount_operator', 'amount'))
        self.row = {'transaction_id': 'synthetic', 'merchant_name': 'Streaming 50%_Shop', 'amount': '10.00',
                    'currency': 'ARS', 'occurred_at': '2026-04-30T23:59:59Z'}

    def test_optional_filters_and_inclusive_date_bounds(self):
        self.assertTrue(ds.matches(self.criteria, self.row))
        for field, value, expected in [('merchant_hint', 'STREAMING', True), ('merchant_hint', '50%_', True),
                                       ('merchant_hint', '50__', False), ('date_from', '2026-04-30', True),
                                       ('date_from', '2026-05-01', False), ('date_to', '2026-04-30', True),
                                       ('date_to', '2026-04-29', False), ('currency', 'ARS', True), ('currency', 'BRL', False)]:
            with self.subTest(field=field, value=value):
                self.assertEqual(ds.matches({**self.criteria, field: value}, self.row), expected)

    def test_all_amount_operators_compare_numeric_values_at_the_boundary(self):
        expected = {'eq': [False, True, False], 'gt': [True, False, False], 'gte': [True, True, False],
                    'lt': [False, False, True], 'lte': [False, True, True]}
        for operator, answers in expected.items():
            for amount, answer in zip((9.99, 10, 10.01), answers):
                with self.subTest(operator=operator, amount=amount):
                    self.assertEqual(ds.matches({**self.criteria, 'amount_operator': operator, 'amount': amount}, self.row), answer)


if __name__ == '__main__':
    unittest.main()
