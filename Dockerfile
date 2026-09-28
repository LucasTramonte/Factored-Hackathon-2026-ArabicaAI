FROM python:3.10-slim-bookworm

WORKDIR /workspace
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN useradd --create-home --uid 10001 appuser
COPY data_pipelines/bronze/requirements.txt /tmp/pipeline-requirements.txt
RUN python -m pip install --no-cache-dir -r /tmp/pipeline-requirements.txt
COPY --chown=appuser:appuser data_pipelines ./data_pipelines

USER appuser
CMD ["python", "-m", "pytest", "-p", "no:cacheprovider", "data_pipelines", "-q"]
