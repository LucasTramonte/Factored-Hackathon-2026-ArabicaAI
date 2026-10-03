"""Aggregate already-scored authored cases by language, scenario family and authored segment.

No system is called and no prediction, label or extraction is changed. Optional segment metadata
comes only from the exact corpus hash recorded by the runner, never from a source-customer join.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from .frozen_report import _rows
from .run import _summary


def report_cuts(result: dict, metadata_blob: bytes, exposed: set[str] | None = None) -> dict:
    """Return primary per-case counts and intervals, with explicit absent and sparse metadata.

    Uses reference executions and external-system majority rows. Their latency is a per-case
    descriptive value; the pooled execution summary remains the latency-gate evidence.
    """
    digest = hashlib.sha256(metadata_blob).hexdigest()
    if result.get("provenance", {}).get("corpus_sha256") != digest:
        raise ValueError("metadata corpus does not match the scored corpus SHA-256")
    cases = json.loads(metadata_blob)["cases"]
    metadata = {c["case_id"]: c.get("segment") for c in cases}
    if len(metadata) != len(cases):
        raise ValueError("duplicate metadata case ids")
    if any(v is not None and (not isinstance(v, str) or not v.strip()) for v in metadata.values()):
        raise ValueError("authored segment metadata must be a nonempty string or null")
    rows = _rows(result)
    if len({(r["case_id"], r["baseline"]) for r in rows}) != len(rows):
        raise ValueError("duplicate primary case/system rows")
    unknown = {r["case_id"] for r in rows} - metadata.keys()
    if unknown:
        raise ValueError(f"{len(unknown)} scored cases lack corpus metadata")
    if exposed is not None and exposed - {r["case_id"] for r in rows}:
        raise ValueError("exposed ids must belong to the scored population")
    populations = {"all": rows}
    if exposed is not None:
        populations["unexposed"] = [r for r in rows if r["case_id"] not in exposed]
    summaries = []
    for population_name, eligible in populations.items():
        for split, system in sorted({(r["split"], r["baseline"]) for r in eligible}):
            population = [r for r in eligible if (r["split"], r["baseline"]) == (split, system)]
            for dimension in ("all", "session_language", "family", "authored_segment"):
                value = lambda r: (None if dimension == "all" else metadata[r["case_id"]]
                                   if dimension == "authored_segment" else r[dimension])
                values = sorted({value(r) for r in population}, key=lambda v: (v is not None, v or ""))
                for label in values:
                    group = [r for r in population if value(r) == label]
                    summary = _summary(split, system, label if dimension == "session_language" else "all",
                                       group[0]["repetition"], group)
                    summaries.append({**summary, "analysis_population": population_name,
                                      "dimension": dimension, "value": label,
                                      "missing_segment_cases": sum(metadata[r["case_id"]] is None for r in group),
                                      "sparse": len(group) < 5})
    comparisons = []
    if exposed is not None:
        for original in (s for s in summaries if s["analysis_population"] == "all" and s["dimension"] == "all"):
            retained = next((s for s in summaries if s["analysis_population"] == "unexposed" and s["dimension"] == "all"
                             and (s["split"], s["baseline"]) == (original["split"], original["baseline"])), {})
            rate = retained.get("correct_rate")
            comparisons.append({"split": original["split"], "baseline": original["baseline"],
                                "all_cases": original["cases"], "all_correct": original["correct"],
                                "unexposed_cases": retained.get("cases", 0), "unexposed_correct": retained.get("correct", 0),
                                "correct_rate_difference_unexposed_minus_all": None if rate is None else rate - original["correct_rate"]})
    return {"metadata_sha256": digest, "population": "authored coverage mix, not prevalence",
            "segment_scope": "authored case metadata; source-customer and live segments not assessed",
            "latency_scope": "primary per-case values; use pooled executions for the latency gate",
            "sparse_rule": "fewer than 5 cases; descriptive counts and intervals only, no ranking or pass/fail",
            "exposed_cases": len(exposed) if exposed is not None else None,
            "population_comparison": comparisons, "summary": summaries}


def main() -> None:
    """Read a scored result and its committed-hash corpus; print aggregates without case content."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("result", type=Path)
    parser.add_argument("metadata", type=Path, help="the exact corpus used by the runner")
    parser.add_argument("--exposed", type=Path, help="authorized JSON list of exposed case ids; report both populations")
    args = parser.parse_args()
    result_blob = args.result.read_bytes()
    exposed = set(json.loads(args.exposed.read_bytes())) if args.exposed else None
    report = report_cuts(json.loads(result_blob), args.metadata.read_bytes(), exposed)
    report["result_sha256"] = hashlib.sha256(result_blob).hexdigest()
    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
