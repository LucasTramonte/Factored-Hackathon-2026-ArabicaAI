"""The CI scope runs every suite a change could affect, and runs everything for anything it doesn't recognize."""
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).with_name('ci_scope.sh')
ALL = {'python': True, 'angular': True, 'worker': True}


def scope(*paths):
    out = subprocess.run(['bash', str(SCRIPT)], input='\n'.join(paths), capture_output=True, text=True, check=True).stdout
    return {k: v == 'true' for k, v in (line.split('=') for line in out.split())}


@pytest.mark.parametrize('paths, expected', [
    (('Docs/deliverables/EVALUATION.md', 'README.md', '.github/skills/release/SKILL.md'),
     {'python': False, 'angular': False, 'worker': False}),
    (('front-end/src/app/customer/customer.page.ts',), {'python': False, 'angular': True, 'worker': True}),
    (('back-end/src/store/d1.js',), {'python': True, 'angular': False, 'worker': True}),
    (('data_pipelines/gold/cohort.py',), {'python': True, 'angular': False, 'worker': False}),
    (('intake_agent/extractor/vertex.py',), {'python': True, 'angular': False, 'worker': True}),
])
def test_each_area_runs_the_suites_that_read_it(paths, expected):
    assert scope(*paths) == expected


@pytest.mark.parametrize('path', ['intake_agent/extractor/prompt.md', 'evals/intake/preregistration/README.md',
                                  'back-end/README.md'])
def test_markdown_that_code_reads_is_not_treated_as_documentation(path):
    assert scope(path)['python'] and scope(path)['worker']


@pytest.mark.parametrize('paths', [(), ('.github/workflows/quality.yml',), ('Makefile',), ('new-folder/x.py',),
                                   ('Docs/x.md', 'package.json')])
def test_unknown_or_empty_changes_run_everything(paths):
    assert scope(*paths) == ALL
