"""Aggregate-report fixtures use invented cases only; no model or withheld files are read."""
import hashlib
import json

import pytest

from evals.intake.report_cuts import report_cuts
from evals.intake.test_frozen_report import row


def sample():
    blob = json.dumps({"cases": [{"case_id": "a", "segment": "Basic"}, {"case_id": "b"}]}).encode()
    a = dict(row("a", "checklist", True), family="normal")
    b = dict(row("b", "checklist", False, language="pt"), family="handoff")
    model = dict(a, baseline="extractor-test", repetition="majority", correct=False)
    return {"cases": [a, b, dict(model, repetition=1)], "majority": [model],
            "provenance": {"corpus_sha256": hashlib.sha256(blob).hexdigest()}}, blob


def test_counts_primary_cases_only_and_preserves_denominators_and_missing_segments():
    result, blob = sample()
    report = report_cuts(result, blob)
    cuts = {(r["baseline"], r["dimension"], r["value"]): r for r in report["summary"]}
    all_cases = cuts["checklist", "all", None]
    assert (all_cases["correct"], all_cases["cases"], all_cases["missing_segment_cases"]) == (1, 2, 1)
    assert cuts["checklist", "session_language", "pt"]["cases"] == 1
    assert cuts["checklist", "family", "normal"]["cases"] == 1
    assert cuts["checklist", "authored_segment", None]["cases"] == 1
    assert cuts["checklist", "authored_segment", "Basic"]["sparse"] is True
    assert cuts["extractor-test", "all", None]["cases"] == 1  # Not the repetition plus majority.
    assert "case_id" not in json.dumps(report)


def test_refuses_metadata_from_a_different_corpus():
    result, blob = sample()
    with pytest.raises(ValueError, match="SHA-256"):
        report_cuts(result, blob + b" ")


def test_refuses_unknown_or_duplicate_primary_rows_without_echoing_case_ids():
    result, blob = sample()
    result["cases"].append(dict(result["cases"][0], case_id="private-id"))
    with pytest.raises(ValueError, match="lack corpus metadata") as exc:
        report_cuts(result, blob)
    assert "private-id" not in str(exc.value)
    result["cases"][-1] = result["cases"][0]
    with pytest.raises(ValueError, match="duplicate primary"):
        report_cuts(result, blob)


def test_empty_scored_population_has_no_invented_rates():
    result, blob = sample()
    result.update(cases=[], majority=[])
    assert report_cuts(result, blob)["summary"] == []


def test_reports_both_exposure_populations_and_their_rate_difference():
    result, blob = sample()
    report = report_cuts(result, blob, exposed={"a"})
    retained = [r for r in report["summary"] if r["analysis_population"] == "unexposed"]
    assert all(r["baseline"] == "checklist" for r in retained)
    comparison = next(r for r in report["population_comparison"] if r["baseline"] == "checklist")
    assert (comparison["all_correct"], comparison["all_cases"], comparison["unexposed_correct"], comparison["unexposed_cases"]) == (1, 2, 0, 1)
    assert comparison["correct_rate_difference_unexposed_minus_all"] == -0.5
    model = next(r for r in report["population_comparison"] if r["baseline"] == "extractor-test")
    assert model["unexposed_cases"] == 0
    assert model["correct_rate_difference_unexposed_minus_all"] is None
    with pytest.raises(ValueError, match="scored population"):
        report_cuts(result, blob, exposed={"private-id"})
