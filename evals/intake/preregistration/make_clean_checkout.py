"""Create a checkout in which the withheld frozen files physically do not exist, for a blind builder.

The withheld files are untracked, so a fresh ``git worktree`` never contains them. This script
creates one and then proves it: every path in ``COMMITMENT.json`` (and every other known withheld
path) must be absent, and none may be tracked by git. It refuses to hand over a checkout otherwise.

Usage:  python -m evals.intake.preregistration.make_clean_checkout --dest ../arabica-blind-build [--ref HEAD]
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

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
                             check=True, capture_output=True, text=True).stdout.split()
    if present or tracked:
        raise SystemExit(f"Not blind: present={present} tracked={tracked}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--dest", type=Path, required=True)
    p.add_argument("--ref", default="HEAD")
    args = p.parse_args()
    repo = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True).stdout.strip())
    paths = withheld_paths(repo)
    subprocess.run(["git", "-C", str(repo), "worktree", "add", "--detach", str(args.dest.resolve()), args.ref], check=True)
    assert_blind(args.dest.resolve(), paths)
    print(f"Blind checkout ready at {args.dest.resolve()} ({len(paths)} withheld paths verified absent).")
    print("Give the builder only this checkout and evals/intake/preregistration/extractor-v1-builder-instructions.md.")


if __name__ == "__main__":
    main()
