"""UPDATE-CORRECTNESS FIXTURE (synthetic, team-generated; not organizer data).

The supplied dataset is a static snapshot, so the brief asks to "demonstrate update correctness with
a clearly labeled test fixture". These tests drive the real Bronze ingestion and Silver build over
local CSV partitions shaped like the S3 layout, through the deliveries a production feed sends:

1. a first full load;
2. a new day (the normal incremental case);
3. a late-arriving old day that was never delivered before (gap fill);
4. a row re-delivered in a later partition with changed content (the latest copy wins in Silver);
5. a corrected old partition, which an incremental run deliberately does not revisit and a full
   refresh does (DATA_ENGINEERING.md, update policy).
"""
from __future__ import annotations

import shutil
from datetime import date
from pathlib import Path

import duckdb
import pytest

from data_pipelines.bronze.ingestion import get_last_loaded_date, ingest_fact
from data_pipelines.silver.silver import build_silver_table
from data_pipelines.silver.table_specs import call_transcripts_spec

HEADER = ("transcript_id,interaction_id,process_date,customer_id,agent_id,full_text,customer_text,agent_text,"
          "detected_language,detected_accent,accent_confidence,detected_keywords,mentioned_entities,"
          "detected_intents,main_topics,transcription_model,audio_quality,duration_seconds\n")


def row(tid: str, day: date, text: str = "Hola.") -> str:
    return (f"{tid},INT-{tid},{day},C1,AGT1,{text},{text},Buenas.,es,mexican,0.9,k,e,i,t,m,High,10.0\n")


def deliver(base: Path, day: date, *rows: str, name: str = "part.csv") -> None:
    path = base / f"call_transcripts/year={day:%Y}/month={day:%m}/day={day:%d}/{name}"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(HEADER + "".join(rows))


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # Bronze writes Parquet under ./data
    con = duckdb.connect(":memory:")
    con.execute("CREATE SCHEMA bronze; CREATE SCHEMA silver;")
    yield con, tmp_path / "source"
    con.close()


def silver(con) -> dict[str, str]:
    build_silver_table(con, call_transcripts_spec)
    return dict(con.execute("SELECT transcript_id, customer_text FROM silver.fact_call_transcripts").fetchall())


def test_a_new_day_is_appended_and_the_watermark_advances(env):
    con, base = env
    deliver(base, date(2024, 1, 1), row("T1", date(2024, 1, 1)))
    deliver(base, date(2024, 1, 2), row("T2", date(2024, 1, 2)))
    ingest_fact(con, str(base), "call_transcripts")
    deliver(base, date(2024, 1, 3), row("T3", date(2024, 1, 3)))
    result = ingest_fact(con, str(base), "call_transcripts")
    assert result.partitions_added == 1 and result.late_partitions == 0
    assert get_last_loaded_date(con, "call_transcripts") == date(2024, 1, 3)
    assert set(silver(con)) == {"T1", "T2", "T3"}


def test_a_late_old_day_is_loaded_and_counted_without_moving_the_watermark_back(env):
    con, base = env
    deliver(base, date(2024, 1, 1), row("T1", date(2024, 1, 1)))
    deliver(base, date(2024, 2, 5), row("T5", date(2024, 2, 5)))
    ingest_fact(con, str(base), "call_transcripts")
    # 2024-01-20 arrives after 2024-02-05 was loaded: older than the watermark, never seen before.
    deliver(base, date(2024, 1, 20), row("T20", date(2024, 1, 20)))
    result = ingest_fact(con, str(base), "call_transcripts")
    assert result.partitions_added == 1 and result.late_partitions == 1
    assert get_last_loaded_date(con, "call_transcripts") == date(2024, 2, 5)
    assert set(silver(con)) == {"T1", "T5", "T20"}
    # A rerun finds nothing new, late or otherwise.
    again = ingest_fact(con, str(base), "call_transcripts")
    assert again.partitions_added == 0 and again.late_partitions == 0


def test_a_row_redelivered_later_with_new_content_replaces_the_old_copy_in_silver(env):
    con, base = env
    deliver(base, date(2024, 1, 1), row("T1", date(2024, 1, 1), text="old"))
    ingest_fact(con, str(base), "call_transcripts")
    deliver(base, date(2024, 1, 2), row("T1", date(2024, 1, 2), text="new"), row("T2", date(2024, 1, 2)))
    ingest_fact(con, str(base), "call_transcripts")
    assert con.execute("SELECT count(*) FROM bronze.call_transcripts WHERE transcript_id='T1'").fetchone()[0] == 2
    assert silver(con) == {"T1": "new", "T2": "Hola."}


def test_a_corrected_old_partition_needs_a_full_refresh(env):
    con, base = env
    deliver(base, date(2024, 1, 1), row("T1", date(2024, 1, 1), text="wrong"))
    deliver(base, date(2024, 1, 2), row("T2", date(2024, 1, 2)))
    ingest_fact(con, str(base), "call_transcripts")
    shutil.rmtree(base / "call_transcripts/year=2024/month=01/day=01")
    deliver(base, date(2024, 1, 1), row("T1", date(2024, 1, 1), text="fixed"))
    incremental = ingest_fact(con, str(base), "call_transcripts")
    assert incremental.partitions_added == 0 and silver(con)["T1"] == "wrong"  # documented: not revisited
    ingest_fact(con, str(base), "call_transcripts", full_refresh=True)
    assert silver(con)["T1"] == "fixed"


def test_a_late_day_never_rereads_the_days_already_held_in_its_month(env):
    con, base = env
    deliver(base, date(2024, 1, 1), row("T1", date(2024, 1, 1), text="held"))
    deliver(base, date(2024, 2, 5), row("T5", date(2024, 2, 5)))
    ingest_fact(con, str(base), "call_transcripts")
    # In the same month: a correction to a held day, and a late day that was never delivered.
    shutil.rmtree(base / "call_transcripts/year=2024/month=01/day=01")
    deliver(base, date(2024, 1, 1), row("T1", date(2024, 1, 1), text="unreviewed correction"))
    deliver(base, date(2024, 1, 20), row("T20", date(2024, 1, 20)))
    result = ingest_fact(con, str(base), "call_transcripts")
    assert result.partitions_added == 1 and result.late_partitions == 1
    assert silver(con) == {"T1": "held", "T5": "Hola.", "T20": "Hola."}, "the correction waits for a full refresh"


def test_a_new_day_never_rereads_earlier_days_of_the_current_month(env):
    con, base = env
    deliver(base, date(2024, 3, 1), row("T1", date(2024, 3, 1), text="held"))
    ingest_fact(con, str(base), "call_transcripts")
    shutil.rmtree(base / "call_transcripts/year=2024/month=03/day=01")
    deliver(base, date(2024, 3, 1), row("T1", date(2024, 3, 1), text="unreviewed correction"))
    deliver(base, date(2024, 3, 2), row("T2", date(2024, 3, 2)))
    ingest_fact(con, str(base), "call_transcripts")
    assert silver(con) == {"T1": "held", "T2": "Hola."}
