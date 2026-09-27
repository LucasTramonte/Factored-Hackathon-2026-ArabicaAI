"""
DuckDB connection management.

Uses a temporary DuckDB S3 secret backed by the AWS credential chain. Profiles,
environment credentials and roles are resolved by DuckDB without interpolating raw keys into SQL.

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
        temp_dir = settings.data_dir / "duckdb_tmp"
        temp_dir.mkdir(parents=True, exist_ok=True)
        con.execute("SET memory_limit=?", [os.environ.get("DUCKDB_MEMORY_LIMIT", "2GB")])
        con.execute("SET temp_directory=?", [str(temp_dir)])
        con.execute("SET threads=?", [int(os.environ.get("DUCKDB_THREADS", "4"))])
        extension_dir = settings.data_dir / "duckdb_extensions"
        extension_dir.mkdir(parents=True, exist_ok=True)
        con.execute("SET extension_directory=?", [str(extension_dir)])
        con.execute("INSTALL httpfs; LOAD httpfs; INSTALL aws; LOAD aws;")
        # The AWS SDK resolves AWS_PROFILE or its normal credential chain. A temporary
        # secret keeps credentials out of repository files and SQL logs.
        con.execute(
            f"CREATE OR REPLACE SECRET {_SECRET_NAME} ("
            f"TYPE s3, PROVIDER credential_chain, REGION '{_quote(settings.region)}', "
            f"SCOPE 's3://{_quote(settings.bucket)}/')"
        )

        con.execute("CREATE SCHEMA IF NOT EXISTS bronze;")
        logger.info("connected to %s (bucket=%s)", settings.duckdb_path, settings.bucket)
        yield con
    finally:
        con.close()
        logger.info("connection closed")
