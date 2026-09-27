"""
DuckDB connection management for the Silver build.

Simpler than the bronze pipeline's db.py on purpose: Silver never touches S3, so there's no
CREATE SECRET, no httpfs, no AWS credentials at all -- just a local connection with the `silver`
schema ensured. Context-manager based for the same reason as bronze's: guarantees the connection
closes even on error, avoiding the "database file already in use" lock error a crashed or
forgotten interactive session leaves behind.
"""
from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Union

import duckdb

logger = logging.getLogger(__name__)


@contextmanager
def get_connection(duckdb_path: Union[str, Path]) -> Iterator[duckdb.DuckDBPyConnection]:
    duckdb_path = str(duckdb_path)
    os.makedirs(os.path.dirname(duckdb_path) or ".", exist_ok=True)
    con = duckdb.connect(duckdb_path)
    try:
        temp_dir = Path(duckdb_path).parent / "duckdb_tmp"
        temp_dir.mkdir(parents=True, exist_ok=True)
        con.execute("SET memory_limit=?", [os.environ.get("DUCKDB_MEMORY_LIMIT", "3GB")])
        con.execute("SET temp_directory=?", [str(temp_dir)])
        con.execute("SET threads=?", [int(os.environ.get("DUCKDB_THREADS", "2"))])
        con.execute("SET preserve_insertion_order=false")
        con.execute("CREATE SCHEMA IF NOT EXISTS silver;")
        logger.info("connected to %s", duckdb_path)
        yield con
    finally:
        con.close()
        logger.info("connection closed")
