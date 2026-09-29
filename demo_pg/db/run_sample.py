"""Run the existing Bronze/Silver/quality commands for one isolated day, then load PG."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from uuid import uuid4

from .load_sample import load


def main() -> None:
    """Execute a bounded one-day import outside web request traffic."""
    selected = date.fromisoformat(os.environ.get("DEMO_DATE", "2026-02-26"))
    data_dir = Path(os.environ.get("DATA_DIR", "/tmp/arabica-demo-data")).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    db = data_dir / "latam_bank.duckdb"
    run_id = ("demo-" + selected.strftime("%Y%m%d") + "-"
              + datetime.now(timezone.utc).strftime("%H%M%S") + "-" + uuid4().hex[:8])
    customer = os.environ.get("DEMO_CUSTOMER_ID", "CLI-U53R5AZVLET0")
    env = {**os.environ, "DATA_DIR": str(data_dir), "DUCKDB_PATH": str(db)}
    base = [sys.executable]
    bronze = base + ["data_pipelines/bronze/run_ingestion.py", "--tables",
                     "customers,products,daily_exchange_rates,transactions", "--partition-date", str(selected)]
    if os.environ.get("DEMO_LOCAL_SOURCE"):
        bronze += ["--local-source", os.environ["DEMO_LOCAL_SOURCE"]]
    subprocess.run(bronze, check=True, env=env)
    subprocess.run(base + ["data_pipelines/silver/run_silver.py", "--tables",
                           "customers,products,transactions"], check=True, env=env)
    subprocess.run(base + ["-m", "data_pipelines.quality.run_quality", "--tables",
                           "customers,products,transactions,daily_exchange_rates", "--run-id", run_id],
                   check=True, env=env)
    report = data_dir / "quality_runs" / run_id / "quality_results.json"
    result = load(db, report, selected, (customer,))
    (data_dir / "load_manifest.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"Sample load complete: selected={result['selected']} inserted={result['inserted']} unchanged={result['unchanged']}")


if __name__ == "__main__":
    main()
