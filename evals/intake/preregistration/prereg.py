"""Pre-registration helper: record a system's prompt hash and commit, and check it before a frozen run.

A registration file (``<system>-v<N>.md``) ends with a fenced block tagged ``json prereg`` that holds
the machine-readable fields. ``fill`` writes that block; ``check`` refuses unless the prompt file still
has the recorded SHA-256, the tag resolves to the recorded commit, and the prompt at that commit has the
same hash. The runner calls ``check`` before scoring a pre-registered system on ``frozen_es_pt_v1``.

Usage:  python -m evals.intake.preregistration.prereg fill --file F --system extractor-v1 --prompt P --model M [--param k=v ...]
        python -m evals.intake.preregistration.prereg check --file F
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

BLOCK = re.compile(r"```json prereg\n(.*?)\n```", re.S)


GIT_LOCATION_VARS = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
                     "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE")


def clean_git_env() -> dict:
    """The environment without variables that could point git at another repository or index."""
    return {k: v for k, v in os.environ.items() if k not in GIT_LOCATION_VARS}


def _git(repo: Path, *args: str, text: bool = True):
    out = subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=text, env=clean_git_env()).stdout
    return out.strip() if text else out


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read(path: Path) -> dict:
    """The registration's machine-readable block."""
    match = BLOCK.search(path.read_text(encoding="utf-8"))
    if not match:
        raise ValueError(f"{path.name} has no ```json prereg block")
    return json.loads(match.group(1))


def fill(path: Path, system: str, prompt: Path, model: str, params: dict, repo: Path = Path("."),
         target: str | None = None, implementation: Path | None = None) -> dict:
    """Write (or replace) the block: prompt and implementation hashes, target and current commit. The tag comes next."""
    data = {"system": system, "tag": system, "commit": _git(repo, "rev-parse", "HEAD"),
            "prompt_file": str(prompt), "prompt_sha256": sha256_bytes((repo / prompt).read_bytes()),
            "target": target, "implementation_file": str(implementation) if implementation else None,
            "implementation_sha256": sha256_bytes((repo / implementation).read_bytes()) if implementation else None,
            "model": model, "params": params, "registered_utc": datetime.now(timezone.utc).isoformat()}
    block = "```json prereg\n" + json.dumps(data, indent=2, sort_keys=True) + "\n```"
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    text = BLOCK.sub(lambda _: block, text) if BLOCK.search(text) else text.rstrip() + "\n\n" + block + "\n"
    path.write_text(text, encoding="utf-8")
    return data


def _same_at_commit(repo: Path, commit: str, file: str, digest: str) -> bool:
    """Whether ``file`` at ``commit`` has ``digest``; a file absent from that commit is a refusal, not a crash."""
    try:
        blob = _git(repo, "show", f"{commit}:{file}", text=False)
    except subprocess.CalledProcessError as exc:
        raise ValueError(f"{file} is not in the registered commit {commit[:7]}") from exc
    return sha256_bytes(blob) == digest


def check(path: Path, repo: Path = Path("."), target: str | None = None) -> dict:
    """Raise ``ValueError`` unless the registration still describes exactly what will run.

    ``target`` is the ``module:callable`` about to be scored: it must equal the registered target, and
    the registered implementation file must be byte-identical now and at the registered commit. Later
    commits that only add files (for example publishing the test set) don't invalidate a registration.
    """
    data = read(path)
    if target is not None:
        if data.get("target") != target:
            raise ValueError(f"{target} is not the registered target ({data.get('target')})")
        impl = data.get("implementation_file")
        if not impl or sha256_bytes((repo / impl).read_bytes()) != data.get("implementation_sha256"):
            raise ValueError("implementation changed since registration (or none was registered)")
    current = sha256_bytes((repo / data["prompt_file"]).read_bytes())
    if current != data["prompt_sha256"]:
        raise ValueError("prompt file changed since registration")
    try:
        tagged = _git(repo, "rev-parse", f"{data['tag']}^{{commit}}")
    except subprocess.CalledProcessError as exc:
        raise ValueError(f"tag {data['tag']} does not exist") from exc
    if tagged != data["commit"]:
        raise ValueError(f"tag {data['tag']} points to {tagged[:7]}, not the registered {data['commit'][:7]}")
    if not _same_at_commit(repo, data["commit"], data["prompt_file"], data["prompt_sha256"]):
        raise ValueError("prompt at the registered commit differs from the recorded hash")
    if target is not None and not _same_at_commit(repo, data["commit"], data["implementation_file"], data["implementation_sha256"]):
        raise ValueError("implementation at the registered commit differs from the recorded hash")
    return data


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fill")
    f.add_argument("--file", type=Path, required=True)
    f.add_argument("--system", required=True)
    f.add_argument("--prompt", type=Path, required=True)
    f.add_argument("--model", required=True)
    f.add_argument("--target", required=True, help="module:callable the runner will score")
    f.add_argument("--implementation", type=Path, required=True, help="the file that defines the target")
    f.add_argument("--param", action="append", default=[], help="key=value, e.g. temperature=0")
    c = sub.add_parser("check")
    c.add_argument("--file", type=Path, required=True)
    args = p.parse_args()
    if args.cmd == "fill":
        params = dict(kv.split("=", 1) for kv in args.param)
        print(json.dumps(fill(args.file, args.system, args.prompt, args.model, params,
                              target=args.target, implementation=args.implementation), indent=2))
        print(f"Now commit, then: git tag {args.system} && git push origin {args.system}")
    else:
        print(json.dumps(check(args.file), indent=2))
        print("Registration OK")


if __name__ == "__main__":
    main()
