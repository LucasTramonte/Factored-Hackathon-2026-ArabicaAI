"""Publication rehearsal helpers on synthetic files: hash commitment and review agreement."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from rehearse_publication import review_summary, verify_commitment


class RehearsalTests(unittest.TestCase):
    def test_a_changed_file_breaks_the_commitment(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'a.json').write_text('{"x": 1}')
            digest = hashlib.sha256(b'{"x": 1}').hexdigest()
            (root / 'COMMITMENT.json').write_text(json.dumps({'files': {'a.json': {'sha256': digest}}}))
            self.assertEqual(verify_commitment(root), {'a.json': 'OK'})
            (root / 'a.json').write_text('{"x": 2}')
            with self.assertRaisesRegex(ValueError, 'changed after the commitment'):
                verify_commitment(root)

    def test_review_agreement_is_split_by_queue_and_compares_candidates(self):
        gold = {'c1': ('F', ['T1']), 'c2': ('C', []), 'c3': ('R', [])}
        rows = [dict(case_id='c1', queue='flagged', chosen_code='F', candidate_ids=['T1']),
                dict(case_id='c2', queue='audit', chosen_code='C', candidate_ids=['T9']),
                dict(case_id='c3', queue='audit', chosen_code='R', candidate_ids=[])]
        self.assertEqual(review_summary(rows, gold), {'flagged': {'n': 1, 'agree_exact': 1}, 'audit': {'n': 2, 'agree_exact': 1}})


if __name__ == '__main__':
    unittest.main()
