"""The first-response analysis counts every filter it applies and keeps quarters apart."""
import json

import duckdb
import pytest

from data_foundation.scripts import run_first_response as fr


@pytest.fixture
def con():
    """Seven complaints: two valid pairs in different quarters, one response before assignment, one response
    without assignment, two with no response (Open, Escalated), and one of another subcategory."""
    c = duckdb.connect(":memory:")
    c.execute("CREATE SCHEMA silver")
    c.execute("""CREATE TABLE silver.fact_complaints AS SELECT * FROM (VALUES
      ('Cargo no reconocido', 'Resolved',  TIMESTAMP '2024-01-10 08:00', TIMESTAMP '2024-01-10 09:00', TIMESTAMP '2024-01-11 09:00'),
      ('Cargo no reconocido', 'Resolved',  TIMESTAMP '2024-04-10 08:00', TIMESTAMP '2024-04-10 09:00', TIMESTAMP '2024-04-11 21:00'),
      ('Cargo no reconocido', 'Closed',    TIMESTAMP '2024-04-11 08:00', TIMESTAMP '2024-04-12 09:00', TIMESTAMP '2024-04-11 09:00'),
      ('Cargo no reconocido', 'Resolved',  TIMESTAMP '2024-04-12 08:00', NULL,                         TIMESTAMP '2024-04-13 09:00'),
      ('Cargo no reconocido', 'Open',      TIMESTAMP '2024-04-13 08:00', NULL,                         NULL),
      ('Cargo no reconocido', 'Escalated', TIMESTAMP '2024-04-14 08:00', TIMESTAMP '2024-04-14 09:00', NULL),
      ('Cobro indebido',      'Resolved',  TIMESTAMP '2024-04-15 08:00', TIMESTAMP '2024-04-15 09:00', TIMESTAMP '2024-04-15 10:00'))
      t(subcategory, status, creation_date, assignment_date, first_response_date)""")
    yield c
    c.close()


def test_filters_are_counted_and_quarters_stay_apart(con):
    data = fr.aggregates(con)
    assert (data["complaints"], data["with_first_response"], data["no_first_response"]) == (6, 4, 2)
    assert data["no_first_response_share"] == round(2 / 6, 4)
    assert data["no_first_response_by_status"] == {"Open": 1, "Escalated": 1}
    assert (data["excluded_no_assignment"], data["excluded_before_assignment"], data["charted"]) == (1, 1, 2)
    by_q = {(q["year"], q["quarter"]): q for q in data["quarters"]}
    assert by_q[(2024, 1)]["n"] == 1 and by_q[(2024, 1)]["median_hours"] == 24.0
    assert by_q[(2024, 2)]["n"] == 1 and by_q[(2024, 2)]["median_hours"] == 36.0


def test_intervals_hold_their_point_and_are_reproducible(con):
    for q in fr.aggregates(con)["quarters"]:
        assert q["median_ci95"][0] <= q["median_hours"] <= q["median_ci95"][1]
        assert q["p90_ci95"][0] <= q["p90_hours"] <= q["p90_ci95"][1]
    assert fr.quantile([1, 2, 3, 4], .9) == pytest.approx(3.7) and fr.quantile([5], .5) == 5  # as quantile_cont
    x = list(range(200))
    low, high = fr.bootstrap_ci(x, .5)
    assert low < 99.5 < high and (low, high) == fr.bootstrap_ci(x, .5)


def test_chart_draws_from_the_aggregates_alone(con, tmp_path):
    pytest.importorskip("matplotlib")  # chart dependencies come from requirements-charts.txt, not the CI install
    data =json.loads(json.dumps(fr.aggregates(con), default=str))
    out = tmp_path / "chart.png"
    fr.chart(data, out)
    assert out.stat().st_size > 10_000


def test_partial_quarters_are_detected():
    assert fr._partial({"quarter": 2, "first_day": "2023-06-17", "last_day": "2023-06-30"})
    assert fr._partial({"quarter": 2, "first_day": "2026-04-01", "last_day": "2026-06-18"})
    assert not fr._partial({"quarter": 3, "first_day": "2024-07-01", "last_day": "2024-09-30"})
