"""
Configuration for the Bronze ingestion pipeline.

Environment-specific bucket, region and local paths come from the environment; AWS
credentials resolve through the runtime AWS profile, not code or a credentials .env file -- the same code runs unchanged across dev/staging/prod, only the
environment differs. The table registry (which tables exist, and whether each is a flat snapshot
or a year/month/day-partitioned fact) lives here as the single source of truth.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import List, Literal

TableKind = Literal["dimension", "fact"]

# Directory this file lives in -- used to anchor default paths to the PACKAGE's location rather
# than to whatever directory `python run_ingestion.py` happens to be launched from. This is what
# lets the pipeline be run as `python data_pipelines/bronze/run_ingestion.py` from the project
# root, `python run_ingestion.py` from inside `data_pipelines/bronze/`, or via an absolute path
# from a scheduler -- all three land on the same data/ and .duckdb file.
PACKAGE_DIR = Path(__file__).resolve().parent


@dataclass(frozen=True)
class TableConfig:
    name: str
    kind: TableKind


# Flat, full-snapshot tables -- re-read and fully overwritten in Bronze on every run.
# `daily_exchange_rates` lives here (not with the other facts) because it turned out to be a flat
# export in the real bucket, despite the data dictionary marking it "Partition: daily".
DIMENSIONS: List[str] = [
    "customers",
    "products",
    "branches",
    "service_agents",
    "marketing_campaigns",
    "daily_exchange_rates",
]

# year=YYYY/month=MM/day=DD/ partitioned tables -- ingested incrementally (see ingestion.py):
# only partitions newer than the last recorded watermark are read and appended.
FACTS: List[str] = [
    "transactions",
    "call_center_interactions",
    "call_transcripts",
    "satisfaction_surveys",
    "digital_events",
    "complaints",
    "campaign_sends",
]

ALL_TABLES: List[TableConfig] = [TableConfig(name=n, kind="dimension") for n in DIMENSIONS] + [
    TableConfig(name=n, kind="fact") for n in FACTS
]


@dataclass(frozen=True)
class Settings:
    bucket: str
    region: str
    project_root: Path
    data_dir: Path        # where local Bronze Parquet files land: <data_dir>/bronze/<table>/...
    duckdb_path: str
    s3_data_prefix: str = "data"  # matches the bucket layout: s3://bucket/data/<table>

    @classmethod
    def from_env(cls) -> "Settings":
        required = ["S3_BUCKET", "AWS_REGION"]
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise RuntimeError(
                f"Missing required environment variable(s): {', '.join(missing)}. "
                "Set the bucket and region in the environment or use Makefile defaults."
            )

        # Project root defaults to two levels above this file, matching the recommended layout:
        #     <project_root>/data_pipelines/bronze/config.py  (this file)
        #     <project_root>/data/                             (local Bronze Parquet + .duckdb file)
        # Override with PROJECT_ROOT if the scripts live somewhere else -- e.g. flat at the repo
        # root instead of under data_pipelines/bronze/. Anchoring to PACKAGE_DIR (the script's own
        # location) rather than os.getcwd() is what makes the pipeline behave the same whether you
        # run it from the project root, from inside data_pipelines/bronze/, or via an absolute path
        # from a scheduler.
        default_root = PACKAGE_DIR.parent.parent
        project_root = Path(os.environ.get("PROJECT_ROOT", default_root)).resolve()

        # DATA_DIR / DUCKDB_PATH can each be overridden independently (e.g. to point the .duckdb
        # file at a different disk), but both default relative to project_root, not to CWD.
        data_dir = Path(os.environ.get("DATA_DIR", project_root / "data")).resolve()
        duckdb_path = os.environ.get("DUCKDB_PATH", str(data_dir / "latam_bank.duckdb"))

        return cls(
            bucket=os.environ["S3_BUCKET"],
            region=os.environ["AWS_REGION"],
            project_root=project_root,
            data_dir=data_dir,
            duckdb_path=duckdb_path,
        )

    def base_s3_path(self) -> str:
        return f"s3://{self.bucket}/{self.s3_data_prefix}"
