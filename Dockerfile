FROM python:3.10-slim-bookworm

WORKDIR /workspace
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN useradd --create-home --uid 10001 appuser
COPY data_pipelines/bronze/requirements.txt /tmp/pipeline-requirements.txt
RUN python -m pip install --no-cache-dir -r /tmp/pipeline-requirements.txt
COPY --chown=appuser:appuser data_pipelines ./data_pipelines
COPY --chown=appuser:appuser data_foundation ./data_foundation
# The Gold slice tests import intake_agent and read the Worker's identities, migrations and seeds.
COPY --chown=appuser:appuser data_profiles/__init__.py ./data_profiles/__init__.py
COPY --chown=appuser:appuser data_profiles/findings ./data_profiles/findings
COPY --chown=appuser:appuser evals ./evals
COPY --chown=appuser:appuser intake_agent ./intake_agent
COPY --chown=appuser:appuser back-end/src/config ./back-end/src/config
COPY --chown=appuser:appuser back-end/migrations ./back-end/migrations
COPY --chown=appuser:appuser back-end/seeds ./back-end/seeds

USER appuser
# Same test set as CI. The transcript audit test records `git rev-parse HEAD`, and the image has no .git.
CMD ["python", "-m", "pytest", "-p", "no:cacheprovider", "data_pipelines", "data_foundation/tests", "data_profiles/findings", "evals/intake", "intake_agent", "-q", \
     "--deselect", "data_foundation/tests/test_silver_transcript_audit.py::test_complete_audit_on_controlled_snapshot"]
