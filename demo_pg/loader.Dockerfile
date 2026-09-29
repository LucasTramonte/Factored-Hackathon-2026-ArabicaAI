FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    DATA_DIR=/tmp/arabica-demo-data DUCKDB_MEMORY_LIMIT=3GB DUCKDB_THREADS=2
WORKDIR /app
COPY demo_pg/loader-requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && useradd --create-home --uid 10001 demo
COPY data_pipelines ./data_pipelines
COPY demo_pg/__init__.py ./demo_pg/
COPY demo_pg/db/__init__.py demo_pg/db/migrate.py demo_pg/db/load_sample.py demo_pg/db/run_sample.py ./demo_pg/db/
USER demo
CMD ["python", "-m", "demo_pg.db.run_sample"]
