"""
DuckDB connection management.

Uses DuckDB's native secrets manager (`CREATE SECRET`, available since DuckDB 0.10) instead of the
older `SET s3_access_key_id=...` pattern -- it's the currently-recommended way to supply S3 credentials
and scopes them to a named, droppable object rather than loose session variables.

Honest caveat: `CREATE SECRET` is a DDL statement, and DuckDB does not support bound (`?`) parameters
in DDL -- confirmed by testing against this exact statement shape before shipping it, since assuming
otherwise would have silently produced the same "looked fine, wasn't" failure this project has hit
several times already. So credentials are still interpolated into SQL text here, same exposure as
`SET` would have. What this module actually does to limit that: never logs the statement itself (only
a bucket name and connection-success message), and isolates the interpolation to this one function so
there is exactly one place in the codebase to audit.

Context-manager based so the connection is always closed, even on error -- avoids the "database file
already in use" lock error that comes from a crashed or forgotten interactive kernel.
"""
from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from typing import Iterator

import duckdb

from config import Settings

logger = logging.getLogger(__name__)

_SECRET_NAME = "bronze_pipeline_s3"


def _quote(value: str) -> str:
    """Escapes single quotes for safe interpolation into a SQL string literal."""
    return value.replace("'", "''")


@contextmanager
def get_connection(settings: Settings) -> Iterator[duckdb.DuckDBPyConnection]:
    # duckdb.connect() does not create missing parent directories, and now that duckdb_path is
    # derived from project_root/data_dir (which may not exist yet on a fresh checkout), that has
    # to happen here rather than being assumed away.
    os.makedirs(os.path.dirname(settings.duckdb_path) or ".", exist_ok=True)
    con = duckdb.connect(settings.duckdb_path)
    try:
        con.execute("INSTALL httpfs; LOAD httpfs;")

        # CREATE SECRET can't take bound parameters (tested -- DDL statements raise
        # "This type of statement can't be prepared" in this DuckDB version), so credentials are
        # quote-escaped and interpolated directly. This statement is never logged.
        con.execute(
            f"""
            CREATE OR REPLACE SECRET {_SECRET_NAME} (
                TYPE s3,
                KEY_ID '{_quote(settings.aws_access_key_id)}',
                SECRET '{_quote(settings.aws_secret_access_key)}',
                REGION '{_quote(settings.region)}'
            )
            """
        )

        con.execute("CREATE SCHEMA IF NOT EXISTS bronze;")
        logger.info("connected to %s (bucket=%s)", settings.duckdb_path, settings.bucket)
        yield con
    finally:
        con.close()
        logger.info("connection closed")
