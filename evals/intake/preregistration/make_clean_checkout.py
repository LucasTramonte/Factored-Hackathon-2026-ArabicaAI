"""Create a checkout in which the withheld frozen files physically do not exist, for a blind builder.

The withheld files are untracked, so an export of a commit never contains them. The checkout is a
history-free snapshot: ``git archive`` of the chosen commit, extracted into a new directory with a
fresh one-commit repository. A ``git worktree`` would share the source's history, and earlier commits
of tracked files could then be read. The script proves the result: every path in ``COMMITMENT.json``
(and every other known withheld path) must be absent and untracked, and only one commit may be
reachable. It refuses to hand over a checkout otherwise.

Usage:  python -m evals.intake.preregistration.make_clean_checkout --dest ../arabica-blind-build [--ref HEAD]
        (the destination must not exist or must be empty)
"""
from __future__ import annotations

import argparse
import io
import json
import subprocess
import tarfile
from pathlib import Path

from evals.intake.preregistration.prereg import clean_git_env

FROZEN = Path("evals/intake/frozen_es_pt_v1")
ALSO_WITHHELD = [FROZEN / "reviews", FROZEN / "review_state.json", FROZEN / "review_state_es.json",
                 FROZEN / "session_record.json", Path("evals/intake/frozen_es_pt_v1.candidate.json"),
                 Path("evals/intake/frozen_es_pt_v1.manifest.draft.json"), Path("evals/intake/frozen_es_pt_v1.json")]


def withheld_paths(repo: Path) -> list[Path]:
    """Repository-relative paths that must never reach a blind builder."""
    commitment = json.loads((repo / FROZEN / "COMMITMENT.json").read_text(encoding="utf-8"))
    return sorted({FROZEN / name for name in commitment["files"]} | set(ALSO_WITHHELD))


def assert_blind(checkout: Path, paths: list[Path]) -> None:
    """Raise unless none of ``paths`` exists in, or is tracked by, ``checkout``."""
    present = [str(p) for p in paths if (checkout / p).exists()]
    tracked = subprocess.run(["git", "-C", str(checkout), "ls-files", "--", *map(str, paths)],
                             check=True, capture_output=True, text=True, env=clean_git_env()).stdout.split()
    if present or tracked:
        raise SystemExit(f"Not blind: present={present} tracked={tracked}")


def export_snapshot(repo: Path, ref: str, dest: Path) -> str:
    """Write ``ref``'s tracked files to a new ``dest`` as a one-commit repository; return the source commit."""
    if dest.exists() and any(dest.iterdir()):
        raise SystemExit(f"Refusing to write into a non-empty directory: {dest}")
    env = clean_git_env()
    source = subprocess.run(["git", "-C", str(repo), "rev-parse", f"{ref}^{{commit}}"], check=True,
                            capture_output=True, text=True, env=env).stdout.strip()
    archive = subprocess.run(["git", "-C", str(repo), "archive", "--format=tar", source], check=True,
                             capture_output=True, env=env).stdout
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(dest, filter="data")
    identity = ["-c", "user.name=blind-snapshot", "-c", "user.email=blind-snapshot@localhost"]
    for args in (["init", "-q"], ["add", "-A"], [*identity, "commit", "-qm", f"Blind snapshot of {source}"]):
        subprocess.run(["git", "-C", str(dest), *args], check=True, capture_output=True, env=env)
    count = subprocess.run(["git", "-C", str(dest), "rev-list", "--all", "--count"], check=True,
                           capture_output=True, text=True, env=env).stdout.strip()
    if count != "1":
        raise SystemExit(f"Not history-free: {count} commits reachable in {dest}")
    return source


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--dest", type=Path, required=True)
    p.add_argument("--ref", default="HEAD")
    args = p.parse_args()
    repo = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True,
                               env=clean_git_env()).stdout.strip())
    paths = withheld_paths(repo)
    source = export_snapshot(repo, args.ref, args.dest.resolve())
    assert_blind(args.dest.resolve(), paths)
    print(f"Blind snapshot of {source[:7]} ready at {args.dest.resolve()} "
          f"({len(paths)} withheld paths verified absent, 1 commit reachable).")
    print("Give the builder only this checkout and evals/intake/preregistration/extractor-v1-builder-instructions.md.")


if __name__ == "__main__":
    main()
