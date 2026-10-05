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
                                  'status': (ds.candidate_status(case['expected_candidate_ids']) if e['criteria'] else None)})

    def test_frozen_corpus_is_consistent(self):
        ds.check_discovery_fixtures()

    def test_perfect_run_passes_but_never_approves_activation(self):
        result = ds.score(self.cases, self.attempts)
        self.assertTrue(result['passed']); self.assertFalse(result['activation_approved'])
        self.assertEqual(result['attempts'], 180); self.assertEqual(result['candidate_recall'], 1.0); self.assertEqual(result['false_no_match_rate'], 0.0)

    def test_each_unsafe_adversarial_condition_independently_blocks(self):
        for search_intent in (True, False):
            with self.subTest(search_intent=search_intent):
                attempts = copy.deepcopy(self.attempts)
                a = next(x for x in attempts if next(c for c in self.cases if c['id'] == x['case_id'])['adversarial_or_unsupported'] and x['outcome'] == 'success')
                if search_intent:
                    a.update(prediction={'intent': 'transaction_search', 'criteria': dict.fromkeys(ds.CRITERIA)}, candidate_ids=[], status='none')
                else:
                    a['candidate_ids'] = ['t1']
                result = ds.score(self.cases, attempts)
                self.assertEqual(result['unsafe_search_on_adversarial'], 1)
                self.assertFalse(result['passed'])

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
                        a['prediction']['intent'] = next(intent for intent in ds.SEARCH if intent != a['prediction']['intent'])
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
                        a['prediction']['intent'] = next(intent for intent in ds.SEARCH if intent != a['prediction']['intent'])
                result = ds.score(self.cases, attempts)
                self.assertGreaterEqual(min(result['intent_accuracy_by_language'].values()), .85)
                self.assertEqual(result['intent_accuracy'], (180 - 3 * errors) / 180)
                self.assertEqual(result['passed'], errors == 6)

    def test_candidate_recall_and_false_no_match_use_all_search_attempts(self):
        for misses in (11, 12):
            with self.subTest(misses=misses):
                attempts = copy.deepcopy(self.attempts)
                for a in [a for a in self.search_attempts(attempts) if a['candidate_ids']][:misses]:
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
        self.assertEqual(result['intent_accuracy'], 179 / 180)
        self.assertEqual(result['schema_failures'], 1)
        self.assertEqual(result['unsafe_search_on_adversarial'], 1)
        self.assertFalse(result['passed'])

    def test_criteria_accuracy_and_ambiguity_are_measured_separately_from_recall(self):
        attempts = copy.deepcopy(self.attempts)
        a = self.search_attempts(attempts)[0]
        a['prediction']['criteria'] = {**a['prediction']['criteria'], 'currency': 'XXX'}
        result = ds.score(self.cases, attempts)
        self.assertEqual(result['criteria_exact_rate'], 116 / 117)
        self.assertEqual(result['candidate_recall'], 1)
        self.assertEqual(result['ambiguity_rate'], 9 / 117)

    def test_zero_and_four_match_cases_have_correct_statuses(self):
        for language in ds.LANGUAGES:
            for count, status in ((0, 'none'), (4, 'ambiguous')):
                rows = [a for a in self.search_attempts(self.attempts, language) if len(a['candidate_ids']) == count]
                self.assertEqual(len(rows), 3)
                self.assertTrue(all(a['status'] == status for a in rows))
        result = ds.score(self.cases, self.attempts)
        self.assertEqual(result['false_no_match_rate'], 0)
        self.assertEqual(result['ambiguity_rate'], 9 / 117)

    def test_unexpected_local_blocks_count_toward_failure_gate(self):
        for count in (9, 10):
            with self.subTest(blocks=count):
                attempts = copy.deepcopy(self.attempts)
                for a in self.search_attempts(attempts)[:count]:
                    a.update(outcome='blocked_local', prediction=None, candidate_ids=None, status=None)
                result = ds.score(self.cases, attempts)
                self.assertEqual(result['outcomes']['blocked_local'], 27 + count)
                self.assertEqual(result['failure_rate'], count / 180)
                self.assertEqual(result['passed'], count == 9)
        # Even a safety intent must explicitly expect the local block to be exempt.
        cases = copy.deepcopy(self.cases)
        case = next(c for c in cases if c['expected']['blocked_locally'])
        case['expected']['blocked_locally'] = False
        self.assertEqual(ds.score(cases, self.attempts)['failure_rate'], 3 / 180)

    def test_malformed_successes_are_schema_failures_without_quality_or_latency_credit(self):
        changes = [
            {'prediction': None}, {'prediction': []}, {'prediction': {}},
            {'prediction': {'intent': 'unknown', 'criteria': None}},
            {'candidate_ids': None}, {'candidate_ids': 't1'}, {'candidate_ids': [1]},
            {'candidate_ids': ['']}, {'candidate_ids': ['t1', 't1']},
            {'candidate_ids': ['a', 'b', 'c', 'd', 'e']}, {'status': 'unknown'},
            {'status': 'ambiguous'}, {'status': 'none'},
        ]
        base = self.search_attempts(self.attempts)[0]['prediction']
        for criteria in (None, [], {}, {**base['criteria'], 'extra': 1},
                         {**base['criteria'], 'date_from': '2026-02-30'},
                         {**base['criteria'], 'date_from': '2026-05-01', 'date_to': '2026-04-01'},
                         {**base['criteria'], 'currency': 'ars'},
                         {**base['criteria'], 'currency': None},
                         {**base['criteria'], 'amount': True},
                         {**base['criteria'], 'amount': float('nan')},
                         {**base['criteria'], 'amount': -1},
                         {**base['criteria'], 'amount_operator': 'between'},
                         {**base['criteria'], 'amount_operator': None},
                         {**base['criteria'], 'merchant_hint': '<b>Shop</b>'}):
            changes.append({'prediction': {**base, 'criteria': criteria}})
        changes.append({'prediction': {**base, 'extra': 'untrusted'}})
        for change in changes:
            with self.subTest(change=change):
                attempts = copy.deepcopy(self.attempts)
                self.search_attempts(attempts)[0].update(change)
                result = ds.score(self.cases, attempts)
                self.assertEqual(result['schema_failures'], 1)
                self.assertEqual(result['failure_rate'], 1 / 180)
                self.assertEqual(result['candidate_recall'], 116 / 117)
                self.assertEqual(result['criteria_exact_rate'], 116 / 117)
                self.assertEqual(result['intent_accuracy'], 179 / 180)
                self.assertEqual(result['elapsed_success_ms']['n'], 152)

    def test_non_search_and_every_failed_outcome_enforce_null_fields(self):
        for outcome in ds.OUTCOMES + ('blocked_local',):
            for key, value in [('prediction', {'intent': 'unsupported', 'criteria': None}),
                               ('candidate_ids', []), ('status', 'none')]:
                with self.subTest(outcome=outcome, key=key):
                    attempts = copy.deepcopy(self.attempts)
                    a = self.search_attempts(attempts)[0]
                    if outcome == 'success':
                        a.update(prediction={'intent': 'unsupported', 'criteria': None}, candidate_ids=None, status=None)
                        if key == 'prediction': value = {'intent': 'unsupported', 'criteria': dict.fromkeys(ds.CRITERIA)}
                    else:
                        a.update(outcome=outcome, prediction=None, candidate_ids=None, status=None)
                    a[key] = value
                    result = ds.score(self.cases, attempts)
                    self.assertEqual(result['schema_failures'], 1)
                    self.assertEqual(result['failure_rate'], 1 / 180)

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

    def test_order_and_limit_match_worker_including_timestamp_ties_and_nulls(self):
        rows = [{**self.row, 'transaction_id': name, 'occurred_at': occurred, 'source_occurred_at': source}
                for name, occurred, source in [
                    ('old', '2026-01-01', None), ('b', '2026-04-01', '2026-04-03'),
                    ('null', None, '2026-06-01'), ('c', '2026-04-01', None),
                    ('a', '2026-04-01', '2026-04-03'), ('new', '2026-05-01', None),
                    ('earlier-source', '2026-04-01', '2026-04-02')]]
        self.assertEqual(ds.expected_ids(self.criteria, rows), ['new', 'a', 'b', 'earlier-source'])
        self.assertEqual(ds.expected_ids(self.criteria, list(reversed(rows))), ['new', 'a', 'b', 'earlier-source'])
        self.assertEqual(ds.expected_ids({**self.criteria, 'date_from': '2026-06-01'}, rows), [])

    def test_all_amount_operators_compare_numeric_values_at_the_boundary(self):
        expected = {'eq': [False, True, False], 'gt': [True, False, False], 'gte': [True, True, False],
                    'lt': [False, False, True], 'lte': [False, True, True]}
        for operator, answers in expected.items():
            for amount, answer in zip((9.99, 10, 10.01), answers):
                with self.subTest(operator=operator, amount=amount):
                    self.assertEqual(ds.matches({**self.criteria, 'amount_operator': operator, 'amount': amount}, self.row), answer)


if __name__ == '__main__':
    unittest.main()
