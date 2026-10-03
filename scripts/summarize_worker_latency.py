"""Summarize bounded Worker log exports without emitting headers, bodies or customer data."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime
import json
from math import ceil, isfinite
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evals.intake.stats import quantile_interval

REPORT_METHODS = {"/intake/start": "POST", "/intake/confirm": "POST", "/intake/handoff": "POST",
                  "/reports": "GET", "/reports/feedback": "POST", "/reports/update": "POST"}
MAX_EXPORT_BYTES = 64 * 1024 * 1024
VERSION = re.compile(r"^[0-9a-f]{8}-[0-9a-f-]{27}$")


def read_export(path: Path):
    """Read at most 64 MiB of JSON array/object or whitespace-separated tail objects."""
    if path.stat().st_size > MAX_EXPORT_BYTES:
        raise ValueError("log export exceeds 64 MiB; split it into smaller files")
    content = path.read_text(encoding="utf-8")
    decoder, offset = json.JSONDecoder(), 0
    while offset < len(content):
        while offset < len(content) and content[offset].isspace():
            offset += 1
        if offset == len(content):
            break
        value, offset = decoder.raw_decode(content, offset)
        rows = value if isinstance(value, list) else [value]
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError("expected log objects")
            yield row


def _timestamp(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(value):
        return value
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo:
                return parsed.timestamp() * 1000
        except ValueError:
            pass
    return None


def summarize(rows, routes=None, since=None, until=None, target_ms=2000):
    """Coalesce request records before windowing; retain failures and the slowest known timing.

    Request-id contradictions use the earliest timestamp, highest status and unknown version;
    conflicting routes are rejected rather than silently assigned to one route. Memory is
    proportional to unique report requests, without retaining raw request data.
    """
    from urllib.parse import urlsplit
    routes = set(routes or REPORT_METHODS)
    if routes - REPORT_METHODS.keys():
        raise ValueError("unsupported report route")
    requests = {}
    counts = Counter()
    for row in rows:
        counts["records"] += 1
        worker = row.get("$workers", row)
        event = worker.get("event", {})
        request = event.get("request", {})
        path = event.get("path") or urlsplit(request.get("url", "")).path
        method = request.get("method")
        if path not in routes or method != REPORT_METHODS[path]:
            counts["excluded_non_report"] += 1
            continue
        ts = _timestamp(row.get("timestamp"))
        if ts is None:
            ts = _timestamp(worker.get("eventTimestamp"))
        request_id = row.get("$metadata", {}).get("requestId")
        key = request_id if isinstance(request_id, str) and request_id else ("record", counts["records"])
        raw_version = (worker.get("scriptVersion") or {}).get("id", "")
        version = raw_version if isinstance(raw_version, str) and VERSION.fullmatch(raw_version) else None
        duration = worker.get("wallTimeMs", worker.get("wallTime"))
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not isfinite(duration) or duration < 0:
            duration = None
        status = event.get("response", {}).get("status")
        if isinstance(status, bool) or not isinstance(status, int):
            status = None
        outcome = worker.get("outcome")
        sample = {"path": path, "method": method, "version": version, "duration": duration, "timestamp": ts,
                  "status": status, "failed": (status is not None and status >= 400) or outcome not in (None, "ok")}
        if key not in requests:
            requests[key] = sample
            continue
        counts["duplicates"] += 1
        previous = requests[key]
        if (previous["path"], previous["method"]) != (path, method):
            raise ValueError("conflicting routes for one request id")
        for field, choose in (("duration", max), ("timestamp", min), ("status", max)):
            if sample[field] is not None:
                previous[field] = sample[field] if previous[field] is None else choose(previous[field], sample[field])
        if version is not None:
            if previous["version"] is None:
                previous["version"] = version
            elif previous["version"] != version:
                previous["version"] = "unknown"
        previous["failed"] |= sample["failed"]
    groups = defaultdict(list)
    for sample in requests.values():
        ts = sample["timestamp"]
        if (since is not None or until is not None) and ts is None:
            counts["excluded_missing_timestamp"] += 1
            continue
        if ts is not None and ((since is not None and ts < since) or (until is not None and ts >= until)):
            counts["excluded_outside_window"] += 1
            continue
        groups[(sample["path"], sample["method"], sample["version"] or "unknown")].append(
            (sample["duration"], ts, sample["status"], sample["failed"]))
        counts["selected_requests"] += 1
    del requests
    cuts = []
    for (path, method, version), sample in sorted(groups.items()):
        values = sorted(x[0] for x in sample if x[0] is not None)
        interval = quantile_interval(values) if values else (None, None)
        timestamps = [x[1] for x in sample if x[1] is not None]
        missing = len(sample) - len(values)
        cuts.append({"route": path, "method": method, "worker_version": version, "requests": len(sample),
                     "timed_requests": len(values), "missing_duration": missing,
                     "failed_requests": sum(x[3] for x in sample),
                     "status_counts": dict(Counter(str(x[2]) if isinstance(x[2], int) else "unknown" for x in sample)),
                     "first_timestamp_ms": min(timestamps) if timestamps else None,
                     "last_timestamp_ms": max(timestamps) if timestamps else None,
                     "p50_ms": values[ceil(.5 * len(values)) - 1] if values else None,
                     "p95_ms": values[ceil(.95 * len(values)) - 1] if values else None,
                     "p95_interval_95_ms": list(interval),
                     "sample_upper_bound_below_target": interval[1] < target_ms if interval[1] is not None and not missing else None})
    return {"scope": "provided_log_export_only", "coverage": "export sampling and completeness not established",
            "target_ms": target_ms, "quantile": "nearest_rank", "counts": dict(counts), "by_route_and_version": cuts}


def main():
    """Print aggregate JSON only; parse errors never include raw log content."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("exports", nargs="+", type=Path)
    parser.add_argument("--route", action="append", choices=sorted(REPORT_METHODS))
    parser.add_argument("--since", help="inclusive UTC ISO timestamp")
    parser.add_argument("--until", help="exclusive UTC ISO timestamp")
    args = parser.parse_args()
    since, until = _timestamp(args.since), _timestamp(args.until)
    if args.since and since is None or args.until and until is None or since is not None and until is not None and since >= until:
        parser.error("invalid UTC timestamp window")
    try:
        result = summarize((row for path in args.exports for row in read_export(path)), args.route, since, until)
    except (ValueError, OSError, TypeError, AttributeError):
        parser.error("cannot parse log export; no raw content was emitted")
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
