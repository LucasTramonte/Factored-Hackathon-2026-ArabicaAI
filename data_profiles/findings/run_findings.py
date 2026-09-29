"""Run the data findings register queries against a read-only Silver DuckDB.

Each query in ``queries/`` declares an id, title, scope and memory model in its header.
``design`` queries are always bounded to business timestamps before ``DESIGN_END`` (ADR-005);
the command line deliberately offers no way to move that bound, so a design fact can't be
recomputed on the holdout window by accident. ``full`` queries describe structural properties
(schema, links, domains) over all rows. Only aggregates are written, to ignored ``data/``.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
import json
from pathlib import Path
import re
import time

import duckdb

DESIGN_END = "2026-01-01"
QUERY_DIR = Path(__file__).with_name("queries")
HEADER = re.compile(r"^-- (id|title|scope|memory): (.+)$", re.MULTILINE)


@dataclass(frozen=True)
class Query:
    """One finding query and its declared metadata."""

    id: str
    title: str
    scope: str
    memory: str
    sql: str
    path: Path


def _parse(path: Path) -> Query:
    text = path.read_text(encoding="utf-8")
    meta = dict(HEADER.findall(text))
    missing = {"id", "title", "scope", "memory"} - meta.keys()
    if missing:
        raise ValueError(f"{path.name} is missing header fields {sorted(missing)}")
    if meta["scope"] not in {"design", "full"}:
        raise ValueError(f"{path.name} has scope {meta['scope']!r}; use design or full")
    return Query(meta["id"], meta["title"], meta["scope"], meta["memory"], text, path)


def load_queries() -> list[Query]:
    """All finding queries, ordered by file name (and so by id)."""
    return [_parse(p) for p in sorted(QUERY_DIR.glob("DF-*.sql"))]


def load_query(finding_id: str) -> Query:
    """The query for one finding id."""
    for q in load_queries():
        if q.id == finding_id:
            return q
    raise ValueError(f"Unknown finding {finding_id}")


def _json_safe(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def run(db_path: Path, only: tuple[str, ...] = ()) -> dict:
    """Execute the queries read-only and return aggregate results with provenance."""
    queries = load_queries()
    if only:
        unknown = set(only) - {q.id for q in queries}
        if unknown:
            raise ValueError(f"Unknown finding {sorted(unknown)[0]}")
        queries = [q for q in queries if q.id in only]
    db_path = Path(db_path)
    results = []
    with duckdb.connect(str(db_path), read_only=True) as con:
        con.execute("SET memory_limit='3GB'")
        con.execute("SET threads=4")
        con.execute("SET temp_directory=?", [str(db_path.parent / "duckdb_tmp")])
        for q in queries:
            started = time.monotonic()
            params = {"design_end": datetime.fromisoformat(DESIGN_END)} if q.scope == "design" else {}
            cursor = con.execute(q.sql, params)
            columns = [c[0] for c in cursor.description]
            rows = [[_json_safe(v) for v in row] for row in cursor.fetchall()]
            results.append({"id": q.id, "title": q.title, "scope": q.scope, "query": str(q.path.relative_to(QUERY_DIR.parent.parent.parent)),
                            "columns": columns, "rows": rows, "seconds": round(time.monotonic() - started, 2)})
            print(f"{q.id} ({q.scope}) done in {results[-1]['seconds']}s", flush=True)
    stat = db_path.stat()
    return {"metadata": {"generated_at_utc": datetime.now(timezone.utc).isoformat(), "database": str(db_path.resolve()),
                         "database_mtime_utc": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                         "design_end": DESIGN_END, "queries": len(results)},
            "results": results}


def write(result: dict, out_dir: Path) -> Path:
    """Write ``results.json`` under ``out_dir`` and return its path."""
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "results.json"
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def parser() -> argparse.ArgumentParser:
    """Command-line options; there is intentionally no option to change the design window."""
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--db", type=Path, default=Path("data/latam_bank.duckdb"))
    p.add_argument("--out", type=Path, default=None, help="default: data/findings_runs/<UTC timestamp>/")
    p.add_argument("--only", nargs="*", default=(), help="finding ids, e.g. DF-001 DF-008")
    return p


def main() -> None:
    args = parser().parse_args()
    out = args.out or Path("data/findings_runs") / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    print(f"Wrote {write(run(args.db, tuple(args.only)), out)}")


if __name__ == "__main__":
    main()
