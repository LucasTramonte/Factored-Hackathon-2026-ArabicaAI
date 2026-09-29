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
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

BLOCK = re.compile(r"```json prereg\n(.*?)\n```", re.S)


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read(path: Path) -> dict:
    """The registration's machine-readable block."""
    match = BLOCK.search(path.read_text(encoding="utf-8"))
    if not match:
        raise ValueError(f"{path.name} has no ```json prereg block")
    return json.loads(match.group(1))


def fill(path: Path, system: str, prompt: Path, model: str, params: dict, repo: Path = Path(".")) -> dict:
    """Write (or replace) the block with the prompt hash and the current commit. The tag comes next."""
    data = {"system": system, "tag": system, "commit": _git(repo, "rev-parse", "HEAD"),
            "prompt_file": str(prompt), "prompt_sha256": sha256_bytes((repo / prompt).read_bytes()),
            "model": model, "params": params, "registered_utc": datetime.now(timezone.utc).isoformat()}
    block = "```json prereg\n" + json.dumps(data, indent=2, sort_keys=True) + "\n```"
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    text = BLOCK.sub(lambda _: block, text) if BLOCK.search(text) else text.rstrip() + "\n\n" + block + "\n"
    path.write_text(text, encoding="utf-8")
    return data


def check(path: Path, repo: Path = Path(".")) -> dict:
    """Raise ``ValueError`` unless the registration still describes exactly what will run."""
    data = read(path)
    current = sha256_bytes((repo / data["prompt_file"]).read_bytes())
    if current != data["prompt_sha256"]:
        raise ValueError("prompt file changed since registration")
    try:
        tagged = _git(repo, "rev-parse", f"{data['tag']}^{{commit}}")
    except subprocess.CalledProcessError as exc:
        raise ValueError(f"tag {data['tag']} does not exist") from exc
    if tagged != data["commit"]:
        raise ValueError(f"tag {data['tag']} points to {tagged[:7]}, not the registered {data['commit'][:7]}")
    at_commit = subprocess.run(["git", "-C", str(repo), "show", f"{data['commit']}:{data['prompt_file']}"],
                               check=True, capture_output=True).stdout
    if sha256_bytes(at_commit) != data["prompt_sha256"]:
        raise ValueError("prompt at the registered commit differs from the recorded hash")
    return data


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fill")
    f.add_argument("--file", type=Path, required=True)
    f.add_argument("--system", required=True)
    f.add_argument("--prompt", type=Path, required=True)
    f.add_argument("--model", required=True)
    f.add_argument("--param", action="append", default=[], help="key=value, e.g. temperature=0")
    c = sub.add_parser("check")
    c.add_argument("--file", type=Path, required=True)
    args = p.parse_args()
    if args.cmd == "fill":
        params = dict(kv.split("=", 1) for kv in args.param)
        print(json.dumps(fill(args.file, args.system, args.prompt, args.model, params), indent=2))
        print(f"Now commit, then: git tag {args.system} && git push origin {args.system}")
    else:
        print(json.dumps(check(args.file), indent=2))
        print("Registration OK")


if __name__ == "__main__":
    main()
