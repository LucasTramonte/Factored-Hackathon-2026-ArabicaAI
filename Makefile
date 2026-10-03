PYTHON ?= .venv/bin/python
S3_BUCKET ?= factored-datathon-2026-s3-157725502942-us-east-2-an
AWS_REGION ?= us-east-2
AWS_PROFILE ?= default
DATA_DIR ?= $(CURDIR)/data
SOURCE_DIR ?= $(CURDIR)/data
DUCKDB_PATH ?= $(DATA_DIR)/latam_bank.duckdb
GOLD_PATH ?= $(DATA_DIR)/latam_bank_gold.duckdb
QUALITY_REPORT ?=
REPORT_RUN ?= $(CURDIR)/data_foundation/runs/$(shell date -u +%Y%m%dT%H%M%SZ)

export S3_BUCKET AWS_REGION AWS_PROFILE DATA_DIR

.PHONY: setup test test-evaluation compile bronze bronze-full bronze-local-full silver quality findings gold pipeline pipeline-local pipeline-gold docker-build docker-test docker-pipeline report product-report

setup:
	python3 -m venv .venv
	.venv/bin/python -m pip install -r data_pipelines/bronze/requirements.txt

test:
	$(PYTHON) -m pytest data_pipelines data_foundation/tests data_profiles/findings evals/intake intake_agent -q

test-evaluation:
	$(PYTHON) -m pytest data_foundation/tests evals/intake/test_baseline.py -q

compile:
	$(PYTHON) -m compileall -q data_pipelines data_foundation data_profiles/findings evals intake_agent

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

findings:
	$(PYTHON) -m data_profiles.findings.run_findings --db "$(DUCKDB_PATH)"

# Gold serving tables in their own DuckDB; Silver is attached read-only and its newest quality run gates the build.
gold:
	$(PYTHON) -m data_pipelines.gold.run_gold --silver-db "$(DUCKDB_PATH)" --gold-db "$(GOLD_PATH)"

pipeline:
	$(MAKE) bronze
	$(MAKE) silver
	$(MAKE) quality

pipeline-local:
	$(MAKE) bronze-local-full
	$(MAKE) silver
	$(MAKE) quality

# The pipeline, then the Gold tables gated on the quality run it just wrote.
pipeline-gold:
	$(MAKE) pipeline
	$(MAKE) gold

report:
	@test -n "$(QUALITY_REPORT)" || (echo "Set QUALITY_REPORT to a full quality_results.json" && exit 1)
	$(PYTHON) -m data_foundation.scripts.run_marketing_product --db "$(DUCKDB_PATH)" --quality "$(QUALITY_REPORT)" --output "$(REPORT_RUN)"

# The unrecognized-charge baseline (KPIs, the "before" picture, the segment cut). Add PUBLISH=data_foundation/reports after review.
product-report:
	@test -n "$(QUALITY_REPORT)" || (echo "Set QUALITY_REPORT to a full quality_results.json" && exit 1)
	$(PYTHON) -m data_foundation.scripts.run_product_report --db "$(DUCKDB_PATH)" --quality "$(QUALITY_REPORT)" --output "$(REPORT_RUN)" $(if $(PUBLISH),--publish "$(PUBLISH)")

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

.PHONY: intake-setup intake-test intake-ui-build intake-sample-bronze intake-sample-silver intake-sample-quality intake-sample-slice intake-seed-local intake-cohort-slice intake-cohort-seed-local
# One-day intake sample: a separate ignored DuckDB so the full analytical database is never replaced.
INTAKE_DATA_DIR ?= $(CURDIR)/data/demo_s3
INTAKE_DATE ?= 2026-02-26
INTAKE_QUALITY_RUN ?= intake-$(subst -,,$(INTAKE_DATE))
INTAKE_SEED ?= $(INTAKE_DATA_DIR)/intake_slice_seed.sql

intake-setup:
	npm --prefix front-end ci
	npm --prefix back-end ci

intake-test:
	$(PYTHON) -m pytest data_pipelines/gold -q
	npm --prefix front-end test -- --watch=false --browsers=ChromeHeadless
	$(MAKE) intake-ui-build
	npm --prefix back-end test

intake-ui-build:
	npm --prefix front-end run build
	npm --prefix back-end run prepare-assets

intake-sample-bronze:
	DATA_DIR="$(INTAKE_DATA_DIR)" DUCKDB_PATH="$(INTAKE_DATA_DIR)/latam_bank.duckdb" \
	$(PYTHON) data_pipelines/bronze/run_ingestion.py --tables customers,products,daily_exchange_rates,transactions --partition-date $(INTAKE_DATE)

intake-sample-silver:
	DATA_DIR="$(INTAKE_DATA_DIR)" DUCKDB_PATH="$(INTAKE_DATA_DIR)/latam_bank.duckdb" \
	$(PYTHON) data_pipelines/silver/run_silver.py --tables customers,products,transactions

intake-sample-quality:
	DATA_DIR="$(INTAKE_DATA_DIR)" DUCKDB_PATH="$(INTAKE_DATA_DIR)/latam_bank.duckdb" \
	$(PYTHON) -m data_pipelines.quality.run_quality --tables customers,products,transactions,daily_exchange_rates --run-id $(INTAKE_QUALITY_RUN)

intake-sample-slice:
	$(PYTHON) -m data_pipelines.gold.run_intake_slice --db "$(INTAKE_DATA_DIR)/latam_bank.duckdb" \
	--quality-report "$(INTAKE_DATA_DIR)/quality_runs/$(INTAKE_QUALITY_RUN)/quality_results.json" \
	--business-date $(INTAKE_DATE) --seed-out "$(INTAKE_SEED)" --manifest-out "$(INTAKE_DATA_DIR)/intake_slice_manifest.json"

# The cohort reads only Gold, so this target builds Gold first from the Silver file and its quality run
# (empty COHORT_QUALITY: the latest run for COHORT_DB, chosen by timestamp), then selects from it.
COHORT_DB ?= $(DUCKDB_PATH)
COHORT_GOLD ?= $(GOLD_PATH)
COHORT_QUALITY ?=
COHORT_AS_OF ?= 2026-06-17
COHORT_OUT ?= data/gold_cohort/$(COHORT_AS_OF)

intake-cohort-slice:
	$(PYTHON) -m data_pipelines.gold.run_gold --silver-db "$(COHORT_DB)" --gold-db "$(COHORT_GOLD)" \
	$(if $(COHORT_QUALITY),--quality-report "$(COHORT_QUALITY)")
	$(PYTHON) -m data_pipelines.gold.run_cohort build --gold-db "$(COHORT_GOLD)" --as-of $(COHORT_AS_OF) --out "$(COHORT_OUT)"

# Local only. The remote load is a reviewed, manual step: run_cohort load --target remote, one part per UTC day.
intake-cohort-seed-local:
	cd back-end && npx wrangler d1 migrations apply arabica-intake-demo --local
	for part in "$(COHORT_OUT)"/part-*.sql; do n=$$(basename "$$part" .sql | sed 's/part-0*//'); \
	$(PYTHON) -m data_pipelines.gold.run_cohort load --out "$(COHORT_OUT)" --part $$n --target local || exit 1; done

intake-seed-local:
	cd back-end && npx wrangler d1 migrations apply arabica-intake-demo --local
	cd back-end && npx wrangler d1 execute arabica-intake-demo --local --file seeds/seed_fictitious.sql
	cd back-end && npx wrangler d1 execute arabica-intake-demo --local --file "$(INTAKE_SEED)"
