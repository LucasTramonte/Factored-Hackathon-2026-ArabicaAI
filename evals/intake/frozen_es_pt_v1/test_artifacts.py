"""Check frozen draft contracts and blind-export integrity without external data."""
from collections import Counter
from datetime import datetime, timedelta
from decimal import Decimal
import json
from pathlib import Path
import re
import unittest
from label_rules import evaluate, ambiguous_reading

ROOT = Path(__file__).resolve().parent
WITHHELD = 'draft.json and verifier_input.jsonl are withheld until extractor v1 is frozen (see COMMITMENT.json)'


@unittest.skipUnless((ROOT / 'draft.json').exists() and (ROOT / 'verifier_input.jsonl').exists(), WITHHELD)
class ArtifactTests(unittest.TestCase):
    """Validate bounded synthetic fixture and all sixty construction labels."""

    @classmethod
    def setUpClass(cls):
        """Load only artifacts under this evaluation directory."""
        cls.draft = json.loads((ROOT / 'draft.json').read_text(encoding='utf-8'))
        cls.blind = [json.loads(line) for line in (ROOT / 'verifier_input.jsonl').read_text(encoding='utf-8').splitlines()]

    def test_fixture_contract(self):
        """Require exactly 32 unique purchases, valid cards and design-window ranges."""
        fixture = self.draft['fixture']
        customers = {c['customer_id']: c for c in fixture['customers']}
        txs = fixture['transactions']
        self.assertEqual([t['transaction_id'] for t in txs], [f'FRZ-T{i:02d}' for i in range(1, 33)])
        self.assertEqual(Counter(t['customer_id'] for t in txs), {cid: 8 for cid in customers})
        expected_keys = set('transaction_id customer_id transaction_date amount currency merchant_name merchant_category product_type last4 transaction_country'.split())
        abroad = 0
        signatures = set()
        ranges = {'USD': ('5.00', '500.00'), 'ARS': ('1750.05', '174999.31'), 'COP': ('20006.90', '1999997.03')}
        for t in txs:
            self.assertEqual(set(t), expected_keys)
            self.assertRegex(t['amount'], r'^\d+\.\d{2}$')
            self.assertRegex(t['last4'], r'^\d{4}$')
            c = customers[t['customer_id']]
            self.assertIn({k: t[k] for k in ('product_type', 'last4', 'currency')}, c['cards'])
            lo, hi = map(Decimal, ranges[t['currency']])
            self.assertTrue(lo <= Decimal(t['amount']) <= hi)
            abroad += t['transaction_country'] != c['country']
            signature = tuple(t[k] for k in sorted(expected_keys - {'transaction_id'}))
            self.assertNotIn(signature, signatures)
            signatures.add(signature)
        self.assertIn(abroad, (2, 3))
        self.assertGreaterEqual(sum(t['merchant_name'] is None for t in txs), 2)
        for cid, customer in customers.items():
            self.assertTrue(any(c['product_type'] == 'Tarjeta Débito' for c in customer['cards']))
            if cid in ('FRZ-C1', 'FRZ-C3'):
                self.assertEqual(sum(c['product_type'] == 'Tarjeta Crédito' for c in customer['cards']), 2)
            if customer['country'] == 'Mexico':
                self.assertEqual({c['currency'] for c in customer['cards']}, {'USD'})

    def test_coverage_and_lookback(self):
        """Require requested families, paired sessions and all purchases within 45 days."""
        specs, cases = self.draft['specs'], self.draft['cases']
        self.assertEqual(len(specs), 30)
        self.assertEqual(len(cases), 60)
        paired = 'single_clear_match multiple_plausible no_match missing_detail invalid_detail confirms_own confirms_after_ambiguity confirms_foreign not_authenticated expired_session_confirmation tool_failure report_with_demand injection_with_report out_of_scope'.split()
        expected = {f: 2 for f in paired}
        expected.update(unsupported_language=1, mixed_language=1)
        self.assertEqual(Counter(s['family'] for s in specs), expected)
        self.assertEqual(Counter(c['session_language'] for c in cases), {'es': 30, 'pt': 30})
        self.assertEqual([c['case_id'] for c in cases], [f'frz-{i:03d}' for i in range(1, 61)])
        self.assertEqual(len({c['message'] for c in cases}), 60)
        for s in specs:
            when = datetime.fromisoformat(s['as_of'])
            self.assertTrue(datetime(2026, 3, 2) <= when < datetime(2026, 6, 16))
            for t in self.draft['fixture']['transactions']:
                if t['customer_id'] == s['customer_id']:
                    self.assertTrue(when - timedelta(days=45) <= datetime.fromisoformat(t['transaction_date']) < when)
            pair = [c for c in cases if c['situation_id'] == s['situation_id']]
            self.assertEqual({c['session_language'] for c in pair}, {'es', 'pt'})
            self.assertEqual(len(pair), 2)

    def test_gold_and_export(self):
        """Blind export contains no family, spec, gold, review or ambiguity annotation."""
        specs = {s['situation_id']: s for s in self.draft['specs']}
        expected_keys = set('case_id session_language authenticated lookup confirmed_id as_of message purchases'.split())
        self.assertEqual(len(self.blind), 60)
        for c, b in zip(self.draft['cases'], self.blind):
            s = specs[c['situation_id']]
            self.assertEqual(c['construction_gold'], evaluate(s, self.draft['fixture']))
            self.assertEqual(c['ambiguous_reading'], ambiguous_reading(s))
            self.assertEqual(set(b), expected_keys)
            self.assertEqual(b['case_id'], c['case_id'])
            self.assertEqual(b['message'], c['message'])
            self.assertEqual(b['session_language'], c['session_language'])
            self.assertEqual(b['as_of'], s['as_of'])
            self.assertEqual(b['authenticated'], s['authenticated'])
            self.assertEqual(b['confirmed_id'], s['confirmed_id'])
            self.assertEqual(b['lookup'], 'down' if s['tool_failure'] else 'ok')
            self.assertEqual(b['purchases'], [t for t in self.draft['fixture']['transactions'] if t['customer_id'] == s['customer_id']])

    def test_expected_situation_outcomes(self):
        """Cross-check hand-derived outcomes separately from the builder's calls."""
        expected = [
            ('F', [1]), ('F', [12]), ('C', [2, 3, 4]), ('C', [19, 20]), ('C', []), ('C', []),
            ('C', []), ('C', []), ('C', []), ('C', []), ('H', [6]), ('H', [11]), ('H', [3]), ('H', [18]),
            ('C', []), ('C', []), ('A', []), ('A', []), ('A', []), ('A', []), ('T', []), ('T', []),
            ('F', [18]), ('F', [30]), ('C', []), ('F', [6]), ('R', []), ('R', []), ('R', []), ('C', [27, 28]),
        ]
        for s, (action, ids) in zip(self.draft['specs'], expected):
            with self.subTest(situation=s['situation_id']):
                self.assertEqual(evaluate(s, self.draft['fixture']),
                                 {'action': action, 'candidate_ids': [f'FRZ-T{i:02d}' for i in ids], 'completion_ready': action == 'H'})


if __name__ == '__main__':
    unittest.main()
