FROM python:3.10-slim-bookworm

WORKDIR /workspace

ENV PYTHONDONTWRITEBYTECODE=1 \
	PYTHONUNBUFFERED=1

RUN useradd --create-home --uid 10001 appuser

COPY --chown=appuser:appuser data_foundation ./data_foundation

USER appuser

CMD ["python", "-m", "unittest", "discover", "-s", "data_foundation/tests", "-v"]
