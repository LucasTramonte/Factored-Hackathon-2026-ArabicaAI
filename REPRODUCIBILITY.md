# Reproducibility Guide

This repository separates reproducible code from participant-controlled access to the synthetic dataset.

## What another developer needs

- Git.
- Python 3.10 or a compatible newer Python version.
- Optional: Docker for an isolated test environment.
- Optional: GNU Make for the shortcuts in `Makefile`.
- AWS CLI only when downloading the organizer-provided S3 dataset.
- Read-only dataset credentials supplied through the official Datathon channel.

The repository does not contain credentials, AWS profiles, raw data, generated reports, or local absolute paths.

## Local setup

From the repository root:

```powershell
python -m unittest discover -s data_foundation/tests -v
python -m compileall -q data_foundation
```

The shared foundation uses relative defaults: `data/` for input and `data_foundation/runs/data-quality-baseline/` for generated audit runs. It does not depend on the developer's home directory, current AWS profile, or machine-specific path.

## Downloading the dataset

Dataset access is an external prerequisite. Confirm that the organizer has authorized the developer before configuring credentials.

Prefer an AWS profile or environment-managed credentials. Never commit, paste into source files, place in Docker layers, or add to shell history any access key or secret key.

Example using a named AWS profile:

```powershell
aws configure --profile factored-datathon
aws s3 ls s3://factored-datathon-2026-s3-157725502942-us-east-2-an/data/ --profile factored-datathon
aws s3 sync s3://factored-datathon-2026-s3-157725502942-us-east-2-an/data/ ./data/ --profile factored-datathon
```

The profile configuration is local to the developer and must not be committed. The repository's `Makefile` also supports:

```powershell
make aws-sync DATA_BUCKET=s3://factored-datathon-2026-s3-157725502942-us-east-2-an/data/
```

That target assumes the AWS CLI is already authenticated and uses the named profile
`factored-datathon` by default. Override it explicitly when needed:

```powershell
make aws-sync AWS_PROFILE=default
```

It does not configure credentials.

## Validation progression

Use the cheapest meaningful validation first:

```text
unit tests -> compile check -> dimension smoke scan -> controlled scan -> full baseline
```

Commands:

```powershell
make test
make compile
make smoke
make baseline
```

The full baseline can be expensive. Do not use it as the first debugging mechanism.

## Docker

Docker is useful here for validating the code and test environment, not for distributing the dataset or credentials:

```powershell
docker build --tag latam-bank-analysis:test .
docker run --rm latam-bank-analysis:test
```

The current image intentionally runs tests only as a non-root user. Raw data and generated reports are excluded by `.dockerignore`. A future data-processing image should receive an explicit mounted data directory or controlled object-store access; it should never bake credentials into the image.

The repository also defines a CI workflow that runs the same tests and builds this
code-only image. Docker is therefore an additional reproducibility check, not a
requirement for local development.

## Reproducibility boundaries

- Python behavior is pinned by the supported major/minor version, but no third-party dependency installation is currently required.
- Dataset contents depend on the organizer's S3 bucket and the participant's authorized read-only access.
- Raw data is local input and is never modified by the scanner.
- Audit runs are generated under `data_foundation/runs/data-quality-baseline/<run_id>/` and ignored by Git.
- Results should record the data source, scan command, timestamp, table selection, and relevant contract version.