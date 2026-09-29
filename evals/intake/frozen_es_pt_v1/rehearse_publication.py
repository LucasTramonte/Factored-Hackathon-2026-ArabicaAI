"""Rehearse publication locally: verify the hash commitment, export, validate, and draft the manifest.

Nothing is scored and nothing is committed. The outputs (``../frozen_es_pt_v1.candidate.json`` and
``../frozen_es_pt_v1.manifest.draft.json``) are listed in ``.git/info/exclude`` until publication, when
the manifest is finalised and the set is tagged ``eval-es-pt-v1``.
"""
from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent


def verify_commitment(root: Path = HERE) -> dict:
    """Every committed file must still match its SHA-256; returns ``{path: 'OK'}`` or raises."""
    commitment = json.loads((root / "COMMITMENT.json").read_text(encoding="utf-8"))
    status = {}
    for name, entry in commitment["files"].items():
        digest = hashlib.sha256((root / name).read_bytes()).hexdigest()
        if digest != entry["sha256"]:
            raise ValueError(f"{name} changed after the commitment")
        status[name] = "OK"
    return status


def review_summary(reviews: list[dict], gold: dict) -> dict:
    """Agreement of one reviewer's answers with final gold, split into flagged and audit questions."""
    out = {}
    for queue in ("flagged", "audit"):
        rows = [r for r in reviews if r["queue"] == queue]
        agree = sum((r["chosen_code"], sorted(r["candidate_ids"])) == gold[r["case_id"]] for r in rows)
        out[queue] = {"n": len(rows), "agree_exact": agree}
    return out


def manifest(corpus: dict, queues: dict, reviews: dict, session: dict, label_errors: dict) -> dict:
    """Draft manifest from aggregates only (no message text)."""
    from evals.intake.stats import clopper_pearson_upper
    codes = {"authenticate": "A", "technical_handoff": "T", "route": "R", "complete_handoff": "H", "confirm": "F", "clarify": "C"}
    gold = {c["case_id"]: (codes[c["gold"]["action"]], sorted(c["gold"]["candidate_ids"])) for c in corpus["cases"]}
    counts = Counter((c["family"], c["session_language"], c["gold"]["action"]) for c in corpus["cases"])
    audits = {}
    for name, rows in reviews.items():
        n = sum(r["queue"] == "audit" for r in rows)
        k = label_errors.get(name, 0)
        audits[name] = {**review_summary(rows, gold), "label_errors": k, "n": n, "upper_95": clopper_pearson_upper(k, n)}
    total_n = sum(a["n"] for a in audits.values())
    total_k = sum(a["label_errors"] for a in audits.values())
    return {
        "version": corpus["version"], "drafted_utc": datetime.now(timezone.utc).isoformat(), "cases": len(corpus["cases"]),
        "counts_family_session_action": [{"family": f, "session_language": l, "action": a, "n": n} for (f, l, a), n in sorted(counts.items())],
        "verifier_agreement": queues.get("agreement"),
        "reviews": audits,
        "audit_total": {"label_errors": total_k, "n": total_n, "upper_95": clopper_pearson_upper(total_k, total_n)},
        "drafting_model": session.get("model"), "drafting_files_read": session.get("files_read"),
        "isolation_exception": session.get("isolation_exception"),
        "policy_decisions": "All five policy questions kept on 2026-09-29 (REVIEW_STATUS.md); no gold changed.",
        "assumptions": session.get("assumptions"),
        "errata": ["DF-013 wording in TASK.md/DATA_FACTS.md is conditional on holding the card type; no case changes."],
        "sha256": None,
    }


def main() -> None:
    from export_frozen import build_corpus
    from evals.intake.run import validate
    print("Commitment:", verify_commitment())
    corpus = build_corpus(json.loads((HERE / "draft.json").read_text(encoding="utf-8")))
    validate(corpus)
    blob = json.dumps(corpus, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    (HERE.parent / "frozen_es_pt_v1.candidate.json").write_text(blob, encoding="utf-8")
    reviews = {p.stem: [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines()]
               for p in sorted((HERE / "reviews").glob("*.jsonl"))}
    draft = manifest(corpus, json.loads((HERE / "queues.json").read_text(encoding="utf-8")), reviews,
                     json.loads((HERE / "session_record.json").read_text(encoding="utf-8")), label_errors={})
    draft["sha256"] = hashlib.sha256(blob.encode("utf-8")).hexdigest()
    (HERE.parent / "frozen_es_pt_v1.manifest.draft.json").write_text(json.dumps(draft, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Validated {len(corpus['cases'])} cases; audit {draft['audit_total']}; candidate sha256 {draft['sha256'][:12]}…")


if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(HERE.parents[2]))
    sys.path.insert(0, str(HERE))
    main()
