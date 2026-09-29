FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    DATA_DIR=/tmp/arabica-demo-data DUCKDB_MEMORY_LIMIT=3GB DUCKDB_THREADS=2
WORKDIR /app
COPY demo-load-requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && useradd --create-home --uid 10001 demo
COPY data_pipelines ./data_pipelines
COPY demo_db/__init__.py demo_db/migrate.py demo_db/load_sample.py demo_db/run_sample.py ./demo_db/
USER demo
CMD ["python", "-m", "demo_db.run_sample"]
