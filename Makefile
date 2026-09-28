PYTHON ?= .venv/bin/python
S3_BUCKET ?= factored-datathon-2026-s3-157725502942-us-east-2-an
AWS_REGION ?= us-east-2
AWS_PROFILE ?= default
DATA_DIR ?= $(CURDIR)/data
SOURCE_DIR ?= $(CURDIR)/data

export S3_BUCKET AWS_REGION AWS_PROFILE DATA_DIR

.PHONY: setup test compile bronze bronze-full bronze-local-full silver quality pipeline pipeline-local docker-build docker-test docker-pipeline

setup:
	python3 -m venv .venv
	.venv/bin/python -m pip install -r data_pipelines/bronze/requirements.txt

test:
	$(PYTHON) -m pytest data_pipelines -q

compile:
	$(PYTHON) -m compileall -q data_pipelines

bronze:
	$(PYTHON) data_pipelines/bronze/run_ingestion.py

bronze-full:
	$(PYTHON) data_pipelines/bronze/run_ingestion.py --full-refresh

bronze-local-full:
	$(PYTHON) data_pipelines/bronze/run_ingestion.py --local-source "$(SOURCE_DIR)" --full-refresh

silver:
	$(PYTHON) data_pipelines/silver/run_silver.py

quality:
	$(PYTHON) -m data_pipelines.quality.run_quality

pipeline:
	$(MAKE) bronze
	$(MAKE) silver
	$(MAKE) quality

pipeline-local:
	$(MAKE) bronze-local-full
	$(MAKE) silver
	$(MAKE) quality

docker-build:
	docker build --tag latam-bank-pipeline:test .

docker-test: docker-build
	docker run --rm latam-bank-pipeline:test

docker-pipeline: docker-build
	mkdir -p "$(DATA_DIR)"
	docker run --rm --user "$$(id -u):$$(id -g)" \
		-v "$(DATA_DIR):/workspace/data" \
		-v "$(HOME)/.aws:/run/aws:ro" \
		-e AWS_CONFIG_FILE=/run/aws/config \
		-e AWS_SHARED_CREDENTIALS_FILE=/run/aws/credentials \
		-e AWS_PROFILE=$(AWS_PROFILE) -e AWS_REGION=$(AWS_REGION) -e S3_BUCKET=$(S3_BUCKET) \
		latam-bank-pipeline:test sh -c 'python data_pipelines/bronze/run_ingestion.py && python data_pipelines/silver/run_silver.py && python -m data_pipelines.quality.run_quality'

# Explicit opt-in: imports authorized local caches, never calls Jev.
JEV_FIRST_CACHE ?= data_foundation/runs/jev-label-audit/audit.sqlite
JEV_SECOND_CACHE ?= data_foundation/runs/jev-second-pass/second-pass.sqlite
.PHONY: transcript-labels pipeline-with-labels
transcript-labels:
	$(PYTHON) -m data_pipelines.quality.run_quality --db "$(DATA_DIR)/latam_bank.duckdb" --tables call_center_interactions,call_transcripts
	$(PYTHON) -m data_pipelines.transcript_labels --db "$(DATA_DIR)/latam_bank.duckdb" --first "$(JEV_FIRST_CACHE)" --second "$(JEV_SECOND_CACHE)"

pipeline-with-labels:
	$(MAKE) pipeline
	$(MAKE) transcript-labels
