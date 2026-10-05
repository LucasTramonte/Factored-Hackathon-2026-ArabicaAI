"""Offline contract checks; fabricated records here exercise scoring, never model quality."""
import copy
import datetime as dt
import json
from pathlib import Path
import unittest
from evals.support_assist import score

ROOT = Path(__file__).parent

class EvaluationContract(unittest.TestCase):
    """Reject evidence that could hide failures or falsely approve activation."""
    def setUp(self):
        self.cases = score.load_jsonl(ROOT / 'acceptance.jsonl')
        self.manifest = {'version': score.VERSION, 'acceptance_sha256': score.digest(ROOT / 'acceptance.jsonl'),
                         'evidence_kind': 'local_mock', 'location': 'us', 'input_price_per_million': .33,
                         'output_price_per_million': 2.75, 'scope_approval_ref': None,
                         'spend_approval_ref': None, 'provider_access_ref': None,
                         'deadline_check_ref': None, 'human_pilot_ref': None, 'live_evidence': None}
        self.attempts, self.ledger = [], []
        for case in self.cases:
            for repeat in range(1, 4):
                i = len(self.attempts)
                stamp = (dt.datetime.fromisoformat(json.loads((ROOT / 'COMMITMENT.json').read_text())['frozen_at'].replace('Z', '+00:00')) + dt.timedelta(days=1) + dt.timedelta(days=i // 200, seconds=(i % 200) * 13)).isoformat().replace('+00:00', 'Z')
                request_id = f'00000000-0000-4000-8000-{i:012d}'
                review = {'reviewer': 'unit-test-only', 'reviewed_at': (dt.datetime.fromisoformat(stamp.replace('Z', '+00:00')) + dt.timedelta(days=1)).isoformat().replace('+00:00', 'Z'),
                          'leak': False, 'unauthorized_write': False, 'fabricated_fact': False,
                          'financial_promise': False, 'status_matches_source': True if case['feature'] == 'customer' and case['expected']['intent'] == 'status' else None,
                          'fallback_safe': True, 'usable': True if case['feature'] == 'reviewer' else None,
                          'acceptance': 'unchanged' if case['feature'] == 'reviewer' else None,
                          'factual_correction': False if case['feature'] == 'reviewer' else None}
                self.attempts.append({'case_id': case['id'], 'repeat': repeat, 'request_id': request_id,
                                      'version': score.VERSION, 'started_at': stamp, 'elapsed_ms': 100,
                                      'outcome': 'success', 'usage': {'input_tokens': 10, 'output_tokens': 2},
                                      'prediction': case['expected'] if case['feature'] == 'customer' else None, 'review': review})
                self.ledger.append({'request_id': request_id, 'feature': case['feature'], 'session_hash': 'a' * 64,
                                    'reserved_at': stamp, 'purpose': 'acceptance'})

    def run_score(self):
        return score.score(self.cases, self.attempts, self.manifest, self.ledger)

    def test_mock_never_passes_live_gate(self):
        result = self.run_score()
        self.assertEqual(result['status'], 'pending_external')
        self.assertEqual(result['features']['customer']['attempts'], 180)
        self.assertTrue(result['features']['customer']['quality_gates_met'])

    def test_missing_duplicate_and_version_rejected(self):
        for mutation in ('missing', 'duplicate', 'version'):
            with self.subTest(mutation=mutation):
                old = copy.deepcopy(self.attempts)
                if mutation == 'missing': self.attempts.pop()
                if mutation == 'duplicate': self.attempts.append(self.attempts[0])
                if mutation == 'version': self.attempts[0]['version'] = 'changed'
                with self.assertRaises(ValueError): self.run_score()
                self.attempts = old

    def test_invalid_unreviewed_and_fabricated_pass_fields_rejected(self):
        for field, value in [('elapsed_ms', float('nan')), ('elapsed_ms', -1), ('elapsed_ms', True), ('repeat', True), ('passed', True)]:
            with self.subTest(field=field, value=value):
                old = copy.deepcopy(self.attempts)
                self.attempts[0][field] = value
                with self.assertRaises(ValueError): self.run_score()
                self.attempts = old
        self.attempts[0]['review']['reviewer'] = ''
        with self.assertRaises(ValueError): self.run_score()

    def test_unknown_usage_not_free_and_failed_attempt_stays_in_denominator(self):
        row = self.attempts[0]
        row.update(outcome='timeout', prediction=None, elapsed_ms=10000, usage={'input_tokens': None, 'output_tokens': None})
        row['review'].update(usable=False, acceptance='rejected', factual_correction=False)
        result = self.run_score()['features']['reviewer']
        self.assertEqual(result['attempts'], 180)
        self.assertEqual(result['failures'], 1)
        self.assertEqual(result['usage_unknown_attempts'], 1)
        self.assertIsNone(result['total_cost_usd'])
        self.assertEqual(result['all_attempt_elapsed_ms']['max'], 10000)
        self.assertEqual(result['successful_generation_ms']['max'], 100)

    def test_any_safety_or_status_failure_blocks(self):
        self.attempts[0]['review']['fabricated_fact'] = True
        self.assertEqual(self.run_score()['status'], 'blocked')
        self.attempts[0]['review']['fabricated_fact'] = False
        status = next(x for x in self.attempts if x['review']['status_matches_source'] is True)
        status['review']['status_matches_source'] = False
        self.assertEqual(self.run_score()['status'], 'blocked')

    def test_correct_classifications_use_all_supported_attempts_and_language_gates(self):
        rows = [x for x in self.attempts if x['case_id'].startswith('acceptance-customer-en') and x['prediction']['intent'] != 'unsupported']
        for row in rows[:7]:
            row['prediction'] = {'intent': 'unsupported', 'field': None}
            row['review']['status_matches_source'] = None
        metrics = self.run_score()['features']['customer']
        self.assertEqual(metrics['supported_by_language']['en']['denominator'], 39)
        self.assertFalse(metrics['quality_gates_met'])

    def test_cap_includes_other_reserved_slots_and_rolling_minute(self):
        extra = {'request_id': 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'feature': 'reviewer',
                 'session_hash': 'b' * 64, 'reserved_at': self.ledger[0]['reserved_at'], 'purpose': 'development'}
        self.ledger.append(extra)
        with self.assertRaises(ValueError): self.run_score()  # first day already has 200 slots
        self.ledger.pop()
        for row in self.ledger[:6]: row['reserved_at'] = self.ledger[0]['reserved_at']
        with self.assertRaises(ValueError): self.run_score()

    def test_complete_live_attestations_required_and_fixture_hash_verified(self):
        self.manifest['evidence_kind'] = 'live'
        self.assertEqual(self.run_score()['status'], 'pending_external')
        for key in ('scope_approval_ref','spend_approval_ref','provider_access_ref','deadline_check_ref','human_pilot_ref'):
            self.manifest[key] = 'test-only-attestation'
        self.assertEqual(self.run_score()['status'], 'pending_external')
        self.manifest['live_evidence'] = {}
        with self.assertRaises(ValueError): self.run_score()
        self.manifest['live_evidence'] = None
        self.manifest['acceptance_sha256'] = '0' * 64
        with self.assertRaises(ValueError): self.run_score()

    def test_invalid_usage_and_unsafe_fallback_rejected_or_blocked(self):
        for tokens in (-1, True, 2.5, float('inf')):
            with self.subTest(tokens=tokens):
                self.attempts[0]['usage']['input_tokens'] = tokens
                with self.assertRaises(ValueError): self.run_score()
        self.attempts[0]['usage']['input_tokens'] = None
        self.attempts[0]['usage']['output_tokens'] = 2
        result = self.run_score()['features']['reviewer']
        self.assertEqual(result['known_output_tokens'], 360)
        self.assertEqual(result['usage_unknown_attempts'], 1)
        self.attempts[0].update(outcome='invalid_output', prediction=None)
        self.attempts[0]['review'].update(usable=False, acceptance='rejected', fallback_safe=False)
        self.assertEqual(self.run_score()['status'], 'blocked')

    def test_a_single_late_success_blocks_even_when_p95_passes(self):
        self.attempts[0]['elapsed_ms'] = 10001
        result = self.run_score()
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['features']['reviewer']['successful_deadline_violations'], 1)
        self.assertEqual(result['features']['reviewer']['successful_generation_ms']['p95'], 100)

    def test_unreserved_gate_failure_is_not_dropped_or_faked_as_provider_usage(self):
        row = self.attempts[0]
        self.ledger.pop(0)
        row.update(outcome='limited', prediction=None, usage={'input_tokens':0,'output_tokens':0})
        row['review'].update(usable=False, acceptance='rejected')
        result = self.run_score()['features']['reviewer']
        self.assertEqual(result['attempts'],180)
        self.assertEqual(result['failures'],1)
        self.assertEqual(result['unreserved_requests'],1)
        row['outcome'] = 'success'
        with self.assertRaises(ValueError): self.run_score()

    def test_actual_unsupported_unsafe_fallback_blocks_despite_high_accuracy(self):
        row = next(row for row in self.attempts if row['case_id'] == 'acceptance-customer-en-01')
        row['prediction'] = {'intent':'unsupported','field':None}
        row['review'].update(status_matches_source=None, fallback_safe=False)
        result = self.run_score()
        metrics = result['features']['customer']
        self.assertEqual(metrics['supported_overall'], {'numerator':116,'denominator':117})
        self.assertEqual(metrics['unsafe_fallbacks'],1)
        self.assertFalse(metrics['quality_gates_met'])
        self.assertEqual(result['status'],'blocked')

    def test_failed_reviewer_cannot_claim_unchanged_or_edited_acceptance(self):
        row = self.attempts[0]
        row.update(outcome='timeout', elapsed_ms=10000, prediction=None)
        row['review']['usable'] = False
        for acceptance in ('unchanged','edited'):
            with self.subTest(acceptance=acceptance):
                row['review']['acceptance'] = acceptance
                with self.assertRaises(ValueError): self.run_score()

    def test_fixture_counts_variety_and_freeze(self):
        score.check_fixtures(ROOT)

if __name__ == '__main__':
    unittest.main()
