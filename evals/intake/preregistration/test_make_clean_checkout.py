"""A blind checkout must contain no withheld file, present or tracked."""
import subprocess
import tempfile
import unittest
from pathlib import Path

from evals.intake.preregistration.make_clean_checkout import assert_blind, export_snapshot, withheld_paths


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


def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), '-c', 'user.email=t@example.com', '-c', 'user.name=T', *args],
                          check=True, capture_output=True, text=True).stdout


class SnapshotTests(unittest.TestCase):
    """The blind checkout is a history-free snapshot: nothing earlier than the chosen commit is reachable."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.src = Path(self.tmp.name) / 'src'
        self.src.mkdir()
        git(self.src, 'init', '-q')
        (self.src / 'status.md').write_text('FAKE-CASE SECRET-MESSAGE-TEXT gold clarify\n')
        (self.src / 'code.py').write_text('x = 1\n')
        git(self.src, 'add', '.')
        git(self.src, 'commit', '-qm', 'leaky status page')
        (self.src / 'status.md').write_text('rules only\n')
        git(self.src, 'commit', '-qam', 'redact')
        secret = self.src / 'evals/intake/frozen_es_pt_v1/draft.json'
        secret.parent.mkdir(parents=True)
        secret.write_text('{"withheld": true}')  # untracked, like the real withheld files

    def tearDown(self):
        self.tmp.cleanup()

    def test_earlier_commits_are_unreachable_from_the_snapshot(self):
        dest = Path(self.tmp.name) / 'blind'
        export_snapshot(self.src, 'HEAD', dest)
        self.assertEqual(git(dest, 'rev-list', '--all', '--count').strip(), '1')
        everything = git(dest, 'log', '--all', '-p') + git(dest, 'reflog', '--all')
        self.assertNotIn('SECRET-MESSAGE-TEXT', everything)
        self.assertEqual((dest / 'status.md').read_text(), 'rules only\n')
        self.assertEqual(git(dest, 'remote').strip(), '')
        self.assertFalse((dest / '.git' / 'objects' / 'info' / 'alternates').exists())
        self.assertFalse((dest / '.git' / 'commondir').exists())  # not a worktree of the source

    def test_untracked_withheld_files_never_reach_the_snapshot(self):
        dest = Path(self.tmp.name) / 'blind'
        export_snapshot(self.src, 'HEAD', dest)
        self.assertFalse((dest / 'evals/intake/frozen_es_pt_v1/draft.json').exists())

    def test_an_existing_destination_is_refused(self):
        dest = Path(self.tmp.name) / 'blind'
        dest.mkdir()
        (dest / 'keep.txt').write_text('mine')
        with self.assertRaises(SystemExit):
            export_snapshot(self.src, 'HEAD', dest)
        self.assertEqual((dest / 'keep.txt').read_text(), 'mine')

if __name__ == '__main__':
    unittest.main()
