"""The committed Vertex AI alert policies (scripts/gcp/monitoring) target extractor v2 and the thresholds the README states."""
from __future__ import annotations

import json
import re
from pathlib import Path

HERE = Path(__file__).parent / "gcp" / "monitoring"
MODEL = 'resource.labels.model_user_id = "gemini-3.5-flash-lite"'
RESOURCE = 'resource.type = "aiplatform.googleapis.com/PublisherModel"'


def policy(name: str) -> dict:
    return json.loads((HERE / f"vertex-suggestions-{name}.json").read_text(encoding="utf-8"))


def test_every_condition_watches_the_v2_model_with_native_metrics_and_no_channel_is_invented():
    for name in ("errors", "latency"):
        p = policy(name)
        assert p["enabled"] and "notificationChannels" not in p, name
        assert p["userLabels"] == {"app": "arabica-intake", "managed_by": "repo"}
        for c in p["conditions"]:
            f = c["conditionThreshold"]["filter"]
            assert RESOURCE in f and MODEL in f and "aiplatform.googleapis.com/publisher/online_serving/" in f, c["displayName"]
            assert c["conditionThreshold"]["aggregations"][0]["alignmentPeriod"] == "900s"


def test_errors_fire_on_three_429_or_5xx_responses_in_15_minutes():
    (c,) = policy("errors")["conditions"]
    t = c["conditionThreshold"]
    pattern = re.search(r'response_code = monitoring\.regex\.full_match\("([^"]+)"\)', t["filter"]).group(1)
    assert all(re.fullmatch(pattern, code) for code in ("429", "500", "503"))
    assert not any(re.fullmatch(pattern, code) for code in ("200", "400", "401", "403", "404"))
    assert (t["comparison"], t["thresholdValue"], t["aggregations"][0]["perSeriesAligner"]) == ("COMPARISON_GT", 2, "ALIGN_SUM")


def test_latency_needs_a_p95_over_5_seconds_and_at_least_three_calls():
    p = policy("latency")
    assert p["combiner"] == "AND"
    slow, volume = (c["conditionThreshold"] for c in p["conditions"])
    assert 'latency_type = "total"' in slow["filter"] and slow["aggregations"][0]["crossSeriesReducer"] == "REDUCE_PERCENTILE_95"
    assert (slow["comparison"], slow["thresholdValue"]) == ("COMPARISON_GT", 5000)
    assert "model_invocation_count" in volume["filter"] and (volume["comparison"], volume["thresholdValue"]) == ("COMPARISON_GT", 2)
