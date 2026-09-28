"""
Configuration for the Silver build.

Silver never touches S3 or AWS credentials -- it only reads the local bronze.* tables and writes
local silver.* tables, both in the same .duckdb file the bronze pipeline already created. Path
resolution mirrors data_pipelines/bronze/config.py and data_pipelines/silver/profile_bronze.py
(same PROJECT_ROOT/DATA_DIR/DUCKDB_PATH env var overrides, anchored to this script's own location
rather than the launching shell's CWD), so all three packages agree on where the .duckdb file lives
without importing from one another.
"""
from __future__ import annotations

import os
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent


def resolve_duckdb_path() -> Path:
    # <project_root>/data_pipelines/silver/config.py -- two levels up lands on the project root,
    # same convention as the bronze package.
    default_root = SCRIPT_DIR.parent.parent
    project_root = Path(os.environ.get("PROJECT_ROOT", default_root)).resolve()
    data_dir = Path(os.environ.get("DATA_DIR", project_root / "data")).resolve()
    return Path(os.environ.get("DUCKDB_PATH", data_dir / "latam_bank.duckdb"))


# Case-insensitive, trim-matched strings that mean "missing" in the source data but aren't NULL or
# blank -- same list profile_bronze.py uses. Duplicated rather than imported so the two scripts
# stay independent (profile_bronze.py only ever reads; this one writes tables), but keep them in
# sync if you extend either one. Confirmed necessary by the Bronze profile: e.g. DuckDB's
# TRY_CAST('NaN' AS DOUBLE) succeeds (IEEE 754), so without this list a "NaN" placeholder column
# would silently cast to a real (garbage) number instead of NULL.
NULL_LIKE_SENTINELS = {
    "nan", "null", "none", "nil", "n/a", "na", "#n/a", "#na",
    "undefined", "unknown", "missing", "-", "--", "?",
    "inf", "infinity", "-inf", "-infinity",
}

# Canonical spelling for country values that turned out to be split across two spellings in the
# Bronze profile -- e.g. transactions.transaction_country has 'México' (2,105,794 rows) and
# 'Mexico' (40,515 rows) as two DISTINCT values that any GROUP BY / COUNT DISTINCT treats as
# different countries until this runs. Keyed by lowercased, trimmed source value.
COUNTRY_CANONICAL = {
    "méxico": "México",
    "mexico": "México",
    "colombia": "Colombia",
    "argentina": "Argentina",
    "usa": "USA",
    "united states": "USA",
    "spain": "Spain",
    "brazil": "Brazil",
    "brasil": "Brazil",
}
