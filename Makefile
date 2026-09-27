PYTHON ?= python
DATA_BUCKET ?= s3://factored-datathon-2026-s3-157725502942-us-east-2-an/data/
AWS_PROFILE ?= factored-datathon

.PHONY: test compile smoke baseline aws-sync docker-test

test:
	$(PYTHON) -m unittest discover -s data_foundation/tests -v

compile:
	$(PYTHON) -m compileall -q data_foundation

smoke:
	$(PYTHON) -m data_foundation.scripts.run_baseline --table customers --table products --table branches --table service_agents --table marketing_campaigns --output-root data_foundation/runs/data-quality-baseline

baseline:
	$(PYTHON) -m data_foundation.scripts.run_baseline --output-root data_foundation/runs/data-quality-baseline

aws-sync:
	aws s3 sync $(DATA_BUCKET) ./data/ --profile $(AWS_PROFILE)

docker-test:
	docker build --tag latam-bank-analysis:test .
	docker run --rm latam-bank-analysis:test
