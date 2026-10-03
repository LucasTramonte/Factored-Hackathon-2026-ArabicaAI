"""Log latency denominators include failed calls and missing timing without exposing request data."""
import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('worker_latency', Path(__file__).with_name('summarize_worker_latency.py'))
latency = importlib.util.module_from_spec(spec)
spec.loader.exec_module(latency)
VERSION = '12345678-1234-4234-8234-123456789abc'


def row(duration=100, status=201, version=VERSION):
    return {'eventTimestamp': 1000, 'scriptVersion': {'id': version}, 'wallTime': duration, 'outcome': 'ok',
            'event': {'request': {'url': 'https://example.test/intake/confirm?customer_id=secret', 'method': 'POST',
                                 'headers': {'Cookie': 'secret'}}, 'response': {'status': status}}}


def test_failures_missingness_versions_and_sensitive_data():
    report = latency.summarize([row(), row(3000, 503), row(None), row(42, version='other')])
    cut = next(r for r in report['by_route_and_version'] if r['worker_version'] == VERSION)
    assert (cut['requests'], cut['timed_requests'], cut['missing_duration'], cut['failed_requests']) == (3, 2, 1, 1)
    assert cut['p95_ms'] == 3000 and cut['sample_upper_bound_below_target'] is None
    assert len(report['by_route_and_version']) == 2
    assert 'secret' not in json.dumps(report) and 'Cookie' not in json.dumps(report)


def test_dashboard_array_and_pretty_tail_stream(tmp_path):
    p = tmp_path / 'logs.json'; p.write_text(json.dumps([row()]))
    assert len(list(latency.read_export(p))) == 1
    p.write_text(json.dumps(row(), indent=2) + '\n' + json.dumps(row(200), indent=2))
    assert len(list(latency.read_export(p))) == 2


def test_window_dedup_nonreport_and_small_sample():
    r = row(); r['$metadata'] = {'requestId': 'opaque'}
    other = row(); other['event']['request']['url'] = 'https://example.test/cases'
    report = latency.summarize([r, r, other, row()], since=1000, until=1001)
    assert report['counts']['duplicates'] == 1 and report['counts']['excluded_non_report'] == 1
    assert report['counts']['selected_requests'] == 2
    assert report['by_route_and_version'][0]['p95_interval_95_ms'][1] is None
    assert latency.summarize([r], until=1000)['by_route_and_version'] == []


def test_enough_observations_supply_interval_without_claiming_export_coverage():
    cut = latency.summarize([row(i) for i in range(160)])['by_route_and_version'][0]
    assert cut['p95_interval_95_ms'][1] is not None
    assert cut['sample_upper_bound_below_target'] is True
    missing = latency.summarize([row(float('nan')), row(True)])['by_route_and_version'][0]
    assert missing['missing_duration'] == 2 and missing['p95_ms'] is None


def test_partial_and_complete_dashboard_records_coalesce_in_either_order_before_windowing():
    partial = {'timestamp': None, '$metadata': {'requestId': 'opaque'}, '$workers': row(None, status=None, version=None)}
    partial['$workers']['scriptVersion'] = None
    complete = {'timestamp': 1500, '$metadata': {'requestId': 'opaque'}, '$workers': row(3000, 503)}
    expected = latency.summarize([partial, complete], since=1000, until=1200)
    assert latency.summarize([complete, partial], since=1000, until=1200) == expected
    cut = expected['by_route_and_version'][0]
    assert expected['counts']['duplicates'] == 1 and expected['counts']['selected_requests'] == 1
    assert (cut['requests'], cut['timed_requests'], cut['missing_duration'], cut['failed_requests']) == (1, 1, 0, 1)
    assert cut['worker_version'] == VERSION and cut['status_counts'] == {'503': 1} and cut['p95_ms'] == 3000
    assert cut['first_timestamp_ms'] == 1000


def test_contradictory_dashboard_records_preserve_failures_and_conservative_timing():
    versions = [VERSION, 'abcdefab-1234-4234-8234-123456789abc', VERSION]
    records = [{'$metadata': {'requestId': 'opaque'}, '$workers': row(duration, status, version)}
               for duration, status, version in zip([100, 3000, 200], [503, 201, 200], versions)]
    expected = latency.summarize(records)
    assert latency.summarize(list(reversed(records))) == expected
    cut = expected['by_route_and_version'][0]
    assert cut['worker_version'] == 'unknown' and cut['failed_requests'] == 1
    assert cut['status_counts'] == {'503': 1} and cut['p95_ms'] == 3000
    records[1]['$workers']['event']['request']['url'] = 'https://example.test/intake/start'
    with pytest.raises(ValueError, match='conflicting routes'):
        latency.summarize(records)
