PYTHON ?= .venv/bin/python
S3_BUCKET ?= factored-datathon-2026-s3-157725502942-us-east-2-an
AWS_REGION ?= us-east-2
AWS_PROFILE ?= default
DATA_DIR ?= $(CURDIR)/data

export S3_BUCKET AWS_REGION AWS_PROFILE DATA_DIR

.PHONY: setup test compile bronze bronze-full silver quality pipeline docker-build docker-test docker-pipeline

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

silver:
	$(PYTHON) data_pipelines/silver/run_silver.py

quality:
	$(PYTHON) -m data_pipelines.quality.run_quality

pipeline:
	$(MAKE) bronze
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
