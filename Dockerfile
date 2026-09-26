FROM python:3.10-slim-bookworm

WORKDIR /workspace

ENV PYTHONDONTWRITEBYTECODE=1 \
	PYTHONUNBUFFERED=1

RUN useradd --create-home --uid 10001 appuser

COPY --chown=appuser:appuser analysis ./analysis

USER appuser

CMD ["python", "-m", "unittest", "discover", "-s", "analysis/tests", "-v"]
