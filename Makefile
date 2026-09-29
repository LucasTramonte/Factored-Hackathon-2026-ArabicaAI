PYTHON ?= .venv/bin/python
S3_BUCKET ?= factored-datathon-2026-s3-157725502942-us-east-2-an
AWS_REGION ?= us-east-2
AWS_PROFILE ?= default
DATA_DIR ?= $(CURDIR)/data
SOURCE_DIR ?= $(CURDIR)/data
DUCKDB_PATH ?= $(DATA_DIR)/latam_bank.duckdb
QUALITY_REPORT ?=
REPORT_RUN ?= $(CURDIR)/data_foundation/runs/$(shell date -u +%Y%m%dT%H%M%SZ)

export S3_BUCKET AWS_REGION AWS_PROFILE DATA_DIR

.PHONY: setup test test-evaluation compile bronze bronze-full bronze-local-full silver quality pipeline pipeline-local docker-build docker-test docker-pipeline report

setup:
	python3 -m venv .venv
	.venv/bin/python -m pip install -r data_pipelines/bronze/requirements.txt

test:
	$(PYTHON) -m pytest data_pipelines data_foundation/tests -q

test-evaluation:
	$(PYTHON) -m pytest data_foundation/tests evals/intake/test_baseline.py -q

compile:
	$(PYTHON) -m compileall -q data_pipelines data_foundation

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

report:
	@test -n "$(QUALITY_REPORT)" || (echo "Set QUALITY_REPORT to a full quality_results.json" && exit 1)
	$(PYTHON) -m data_foundation.scripts.run_marketing_product --db "$(DUCKDB_PATH)" --quality "$(QUALITY_REPORT)" --output "$(REPORT_RUN)"

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

.PHONY: demo-setup demo-migrate demo-seed demo-test demo-ui-build demo-docker-build demo-load-docker-build demo-sample-bronze demo-sample-silver demo-sample-quality demo-sample-load
DEMO_DATA_DIR ?= $(CURDIR)/data/demo_s3
DEMO_DATE ?= 2026-02-26
DEMO_CUSTOMER_ID ?= CLI-U53R5AZVLET0
DEMO_QUALITY_RUN ?= demo-$(subst -,,$(DEMO_DATE))

demo-setup:
	$(PYTHON) -m pip install -r demo_pg/web-requirements.txt
	npm --prefix demo-ui ci

demo-migrate:
	$(PYTHON) -m demo_pg.db.migrate

demo-seed:
	$(PYTHON) -m demo_pg.db.seed_fictitious

demo-test:
	$(PYTHON) -m pytest data_pipelines/bronze/test_ingestion.py demo_pg/db/tests -q

demo-ui-build:
	npm --prefix demo-ui run build

demo-docker-build:
	docker build -f demo_pg/web.Dockerfile -t arabica-intake-demo:local .

demo-sample-bronze:
	DATA_DIR="$(DEMO_DATA_DIR)" DUCKDB_PATH="$(DEMO_DATA_DIR)/latam_bank.duckdb" \
	$(PYTHON) data_pipelines/bronze/run_ingestion.py --tables customers,products,daily_exchange_rates,transactions --partition-date $(DEMO_DATE)

demo-sample-silver:
	DATA_DIR="$(DEMO_DATA_DIR)" DUCKDB_PATH="$(DEMO_DATA_DIR)/latam_bank.duckdb" \
	$(PYTHON) data_pipelines/silver/run_silver.py --tables customers,products,transactions

demo-sample-quality:
	DATA_DIR="$(DEMO_DATA_DIR)" DUCKDB_PATH="$(DEMO_DATA_DIR)/latam_bank.duckdb" \
	$(PYTHON) -m data_pipelines.quality.run_quality --tables customers,products,transactions,daily_exchange_rates --run-id $(DEMO_QUALITY_RUN)

demo-sample-load:
	$(PYTHON) -m demo_pg.db.load_sample --db "$(DEMO_DATA_DIR)/latam_bank.duckdb" \
	--quality-report "$(DEMO_DATA_DIR)/quality_runs/$(DEMO_QUALITY_RUN)/quality_results.json" \
	--business-date $(DEMO_DATE) --customer-id $(DEMO_CUSTOMER_ID) \
	--manifest "$(DEMO_DATA_DIR)/load_manifest.json"

demo-load-docker-build:
	docker build -f demo_pg/loader.Dockerfile -t arabica-intake-load:local .
