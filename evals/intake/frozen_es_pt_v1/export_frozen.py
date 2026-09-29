"""Export the withheld draft into the runner's corpus schema (`python -m evals.intake.run --cases`).

Construction gold uses one-letter codes; the runner and its scorer use action names, so every
code is mapped here and an unknown code fails loudly. Message languages outside es/pt are
normalised for the runner (mixed ES–PT → the session language; any other language → "other")
and the original value is kept in `message_language`. The output stays local until the freeze.
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).parent
ACTION_NAMES = {"A": "authenticate", "T": "technical_handoff", "R": "route", "H": "complete_handoff",
                "F": "confirm", "C": "clarify"}


def to_runner_gold(construction: dict) -> dict:
    """Map a construction answer (letter code) to the runner's gold schema."""
    code = construction["action"]
    if code not in ACTION_NAMES:
        raise ValueError(f"Unknown construction action {code!r}")
    return {"action": ACTION_NAMES[code], "candidate_ids": sorted(construction["candidate_ids"]),
            "completion_ready": code == "H"}


def runner_language(message_language: str, session_language: str, family: str) -> str:
    """The language value the runner accepts for this case."""
    if message_language in ("es", "pt"):
        return message_language
    if family == "unsupported_language":
        return "en" if message_language == "en" else "other"
    if "-" in message_language:  # code-switching between the two supported languages
        return session_language
    raise ValueError(f"Language {message_language!r} is only allowed for unsupported_language cases")


def build_corpus(draft: dict) -> dict:
    """Runner corpus from the draft: fixture transactions plus one case per message."""
    specs = {s["situation_id"]: s for s in draft["specs"]}
    cases = []
    for c in draft["cases"]:
        s = specs[c["situation_id"]]
        cases.append({
            "case_id": c["case_id"], "situation_id": c["situation_id"], "family": s["family"], "split": "frozen_es_pt_v1",
            "language": runner_language(c["language"], c["session_language"], s["family"]),
            "message_language": c["language"], "session_language": c["session_language"],
            "customer_id": s["customer_id"], "authenticated": s["authenticated"], "confirmed_id": s["confirmed_id"],
            "tool_failure": s["tool_failure"], "as_of": s["as_of"], "message": c["message"],
            "gold": to_runner_gold(c["construction_gold"]),
        })
    return {"version": "frozen-es-pt-v1", "transactions": draft["fixture"]["transactions"], "cases": cases}


def main() -> None:
    draft = json.loads((HERE / "draft.json").read_text(encoding="utf-8"))
    out = HERE.parent / "frozen_es_pt_v1.candidate.json"
    out.write_text(json.dumps(build_corpus(draft), ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
