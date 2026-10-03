"""The registration check must catch a changed prompt, a missing tag and a moved tag."""
import subprocess
import tempfile
import unittest
from pathlib import Path

from evals.intake.preregistration.prereg import check, fill, read


def git(repo, *args):
    subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True)


class PreregTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        git(self.repo, 'init', '-q')
        git(self.repo, 'config', 'user.email', 't@example.com')
        git(self.repo, 'config', 'user.name', 'Test')
        (self.repo / 'prompt.md').write_text('Extract the stated facts.\n')
        (self.repo / 'ext.py').write_text('def extract(*a):\n    return {}\n')
        (self.repo / 'shared.py').write_text('VERSION = 1\n')
        (self.repo / 'reg.md').write_text('# Pre-registration: x-v1\n')
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-qm', 'prompt')
        fill(self.repo / 'reg.md', 'x-v1', Path('prompt.md'), '@cf/openai/gpt-oss-20b', {'temperature': '0'}, repo=self.repo,
             target='ext:extract', implementation=Path('ext.py'))
        git(self.repo, 'tag', 'x-v1')

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_faithful_registration_passes_and_is_machine_readable(self):
        data = check(self.repo / 'reg.md', repo=self.repo)
        self.assertEqual(data['model'], '@cf/openai/gpt-oss-20b')
        self.assertEqual(read(self.repo / 'reg.md')['params'], {'temperature': '0'})

    def test_the_scored_target_and_its_code_must_match_the_registration(self):
        check(self.repo / 'reg.md', repo=self.repo, target='ext:extract')
        with self.assertRaisesRegex(ValueError, 'registered target'):
            check(self.repo / 'reg.md', repo=self.repo, target='other:extract')
        (self.repo / 'ext.py').write_text('def extract(*a):\n    return {"tuned": True}\n')
        with self.assertRaisesRegex(ValueError, 'implementation changed'):
            check(self.repo / 'reg.md', repo=self.repo, target='ext:extract')
        with self.assertRaisesRegex(ValueError, 'implementation changed'):
            check(self.repo / 'reg.md', repo=self.repo)  # The standalone check binds code too.

    def test_a_later_publication_commit_does_not_invalidate_the_registration(self):
        (self.repo / 'frozen.json').write_text('{}')
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-qm', 'publish the test set')
        check(self.repo / 'reg.md', repo=self.repo, target='ext:extract')

    def test_a_file_missing_at_the_registered_commit_is_a_clear_refusal(self):
        (self.repo / 'late.py').write_text('def extract(*a):\n    return {}\n')  # never committed
        fill(self.repo / 'reg.md', 'x-v1', Path('prompt.md'), 'm', {}, repo=self.repo,
             target='late:extract', implementation=Path('late.py'))
        with self.assertRaisesRegex(ValueError, 'not in the registered commit'):
            check(self.repo / 'reg.md', repo=self.repo, target='late:extract')

    def test_a_changed_prompt_is_refused(self):
        (self.repo / 'prompt.md').write_text('Extract the stated facts. Also handle "uns 40 mil".\n')
        with self.assertRaisesRegex(ValueError, 'prompt file changed'):
            check(self.repo / 'reg.md', repo=self.repo)

    def test_a_missing_or_moved_tag_is_refused(self):
        git(self.repo, 'tag', '-d', 'x-v1')
        with self.assertRaisesRegex(ValueError, 'does not exist'):
            check(self.repo / 'reg.md', repo=self.repo)
        (self.repo / 'other.txt').write_text('later work\n')
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-qm', 'later')
        git(self.repo, 'tag', 'x-v1')
        with self.assertRaisesRegex(ValueError, 'points to'):
            check(self.repo / 'reg.md', repo=self.repo)

    def test_fill_replaces_the_block_instead_of_appending_a_second_one(self):
        fill(self.repo / 'reg.md', 'x-v1', Path('prompt.md'), 'm2', {}, repo=self.repo)
        self.assertEqual((self.repo / 'reg.md').read_text().count('```json prereg'), 1)
        self.assertEqual(read(self.repo / 'reg.md')['model'], 'm2')

    def test_shared_code_is_bound_now_and_at_the_registered_commit(self):
        data = fill(self.repo / 'reg.md', 'x-v1', Path('prompt.md'), 'm', {}, repo=self.repo,
                    target='ext:extract', implementation=Path('ext.py'), dependencies=[Path('shared.py')])
        self.assertIn('shared.py', data['dependency_sha256'])
        check(self.repo / 'reg.md', repo=self.repo, target='ext:extract')
        (self.repo / 'shared.py').write_text('VERSION = 2\n')
        with self.assertRaisesRegex(ValueError, 'dependency changed'):
            check(self.repo / 'reg.md', repo=self.repo, target='ext:extract')
        (self.repo / 'shared.py').unlink()
        with self.assertRaisesRegex(ValueError, 'dependency changed'):
            check(self.repo / 'reg.md', repo=self.repo)

    def test_dependency_absent_at_registered_commit_is_refused(self):
        (self.repo / 'late.py').write_text('VERSION = 1\n')
        fill(self.repo / 'reg.md', 'x-v1', Path('prompt.md'), 'm', {}, repo=self.repo,
             target='ext:extract', implementation=Path('ext.py'), dependencies=[Path('late.py')])
        with self.assertRaisesRegex(ValueError, 'not in the registered commit'):
            check(self.repo / 'reg.md', repo=self.repo, target='ext:extract')


if __name__ == '__main__':
    unittest.main()
