"""Apply versioned, transactional demo migrations without deleting existing cases."""
from __future__ import annotations

import os
from pathlib import Path

import psycopg

MIGRATIONS = Path(__file__).with_name("migrations")
DEFAULT_DSN = "host=127.0.0.1 port=55432 dbname=arabica_demo user=arabica connect_timeout=5"


def migrate(dsn: str | None = None) -> list[str]:
    """Apply each pending SQL file once under an advisory lock."""
    applied = []
    with psycopg.connect(dsn or os.environ.get("DEMO_DATABASE_DSN", DEFAULT_DSN)) as conn:
        with conn.transaction():
            conn.execute("SELECT pg_advisory_xact_lock(73921, 1)")
            conn.execute("CREATE SCHEMA IF NOT EXISTS intake_demo")
            conn.execute("CREATE TABLE IF NOT EXISTS intake_demo.schema_migrations "
                         "(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
            for path in sorted(MIGRATIONS.glob("[0-9]*.sql")):
                if conn.execute("SELECT 1 FROM intake_demo.schema_migrations WHERE version=%s", (path.name,)).fetchone():
                    continue
                conn.execute(path.read_text())
                conn.execute("INSERT INTO intake_demo.schema_migrations(version) VALUES (%s)", (path.name,))
                applied.append(path.name)
    return applied


if __name__ == "__main__":
    print("Applied migrations:", ", ".join(migrate()) or "none")
