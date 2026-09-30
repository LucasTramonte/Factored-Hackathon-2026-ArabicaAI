"""A blind checkout must contain no withheld file, present or tracked."""
import subprocess
import tempfile
import unittest
from pathlib import Path

from evals.intake.preregistration.make_clean_checkout import assert_blind, withheld_paths


class BlindCheckoutTests(unittest.TestCase):
    def test_every_committed_file_is_on_the_withheld_list(self):
        paths = {str(p) for p in withheld_paths(Path(__file__).resolve().parents[3])}
        for name in ('draft.json', 'verifier_input.jsonl', 'queues.json', 'reviews/lucas.jsonl', 'reviews/lucas_es.jsonl'):
            self.assertIn(f'evals/intake/frozen_es_pt_v1/{name}', paths)

    def test_inherited_git_location_variables_cannot_redirect_the_check(self):
        import os
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as decoy:
            repo = Path(tmp)
            subprocess.run(['git', '-C', tmp, 'init', '-q'], check=True)
            subprocess.run(['git', '-C', decoy, 'init', '-q'], check=True)
            secret = Path('evals/intake/frozen_es_pt_v1/draft.json')
            (repo / secret).parent.mkdir(parents=True)
            (repo / secret).write_text('{}')
            subprocess.run(['git', '-C', tmp, 'add', str(secret)], check=True)
            (repo / secret).unlink()  # tracked in the target, absent on disk: only git ls-files can catch it
            old = os.environ.get('GIT_DIR')
            os.environ['GIT_DIR'] = str(Path(decoy) / '.git')
            try:
                with self.assertRaises(SystemExit):
                    assert_blind(repo, [secret])
            finally:
                if old is None:
                    os.environ.pop('GIT_DIR')
                else:
                    os.environ['GIT_DIR'] = old

    def test_present_or_tracked_withheld_files_are_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(['git', '-C', tmp, 'init', '-q'], check=True)
            secret = Path('evals/intake/frozen_es_pt_v1/draft.json')
            assert_blind(repo, [secret])
            (repo / secret).parent.mkdir(parents=True)
            (repo / secret).write_text('{}')
            with self.assertRaises(SystemExit):
                assert_blind(repo, [secret])


if __name__ == '__main__':
    unittest.main()
