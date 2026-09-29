"""Check semantic comparison and fixed blinded review queues."""
import json
from pathlib import Path
import unittest
from prepare_review import normalized_facts, demands

ROOT = Path(__file__).resolve().parent


class ReviewTests(unittest.TestCase):
    """Guard sampling integrity, preserved disagreements and neutral options."""

    def test_semantic_normalization(self):
        """Equivalent dates normalize but missing demand content remains visible."""
        self.assertEqual(normalized_facts({'date': {'expression': 'ontem', 'from': '2026-03-31', 'to': '2026-03-31'}}),
                         normalized_facts({'date': {'expression': 'ayer', 'from': '2026-03-31', 'to': '2026-03-31'}}))
        self.assertEqual(demands('refund'), ['refund'])
        self.assertNotEqual(demands('refund'), demands(['refund', 'card_block']))

    @unittest.skipUnless((ROOT / 'queues.json').exists() and (ROOT / 'draft.json').exists(),
                         'queues.json and draft.json are withheld until extractor v1 is frozen (see COMMITMENT.json)')
    def test_queues_and_options(self):
        """Every flagged case is reviewed, audit is disjoint, answers are concealed."""
        q = json.loads((ROOT / 'queues.json').read_text(encoding='utf-8'))
        draft = json.loads((ROOT / 'draft.json').read_text(encoding='utf-8'))
        cases = {c['case_id']: c for c in draft['cases']}
        verdicts = {x['case_id']: x for x in q['comparison']}
        for lang, size in [('pt', 12), ('es', 6)]:
            queue = q[lang]
            self.assertEqual(len({x['case_id'] for x in queue}), len(queue))
            flagged = {x['case_id'] for x in q['comparison'] if x['session_language'] == lang and x['flagged']}
            self.assertEqual({x['case_id'] for x in queue if x['queue'] == 'flagged'}, flagged)
            self.assertEqual(sum(x['queue'] == 'audit' for x in queue), size)
            for item in queue:
                self.assertEqual(cases[item['case_id']]['session_language'], lang)
                self.assertEqual(verdicts[item['case_id']]['flagged'], item['queue'] == 'flagged')
                opts = item['options']
                self.assertEqual([o['number'] for o in opts], [1, 2, 3, 4, 5])
                self.assertEqual(opts[-1]['action'], 'UNKNOWN')
                self.assertEqual(len({(o['action'], tuple(o['candidate_ids'])) for o in opts}), 5)
                for o in opts:
                    self.assertEqual(set(o), {'number', 'action', 'candidate_ids'})
                gold = cases[item['case_id']]['construction_gold']
                self.assertTrue(any(o['action'] == gold['action'] and o['candidate_ids'] == gold['candidate_ids'] for o in opts))
        self.assertEqual({x['case_id'] for x in q['comparison'] if not x['facts_agree']}, {'frz-019', 'frz-024'})
