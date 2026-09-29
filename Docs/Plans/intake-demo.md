# Charge-intake demo: reproducible handoff

## What the customer can do

The selected V1 is unrecognized-charge intake: sign in with a **simulated** identity, inspect only that identity's charges, select one, describe it, explicitly confirm, and receive a reference **after** PostgreSQL commits the case. An agent can then read the persisted request. The reference confirms local acceptance for review, not fraud, reimbursement, card blocking, or final resolution. A read-only account/payment inquiry remains a comparison workflow in the [Gold request](marketing-product-gold-contract.md). The hackathon also asks for a normal resolution path, an ambiguous case, safe human handoff, and Spanish/Portuguese demonstrations in [the challenge brief](../FACTORED_HACKATHON_2026.md); this demo currently covers intake/handoff only.

AI has not been added. The next bounded experiment is a checklist versus AI for clarifying a customer's description and drafting an agent summary. Both must use only permitted transaction evidence; the customer must confirm the statement and the backend must accept it. Evaluate held-out, human-reviewed Spanish and Portuguese case families, including ambiguous/unrecognized, unauthorized, missing evidence, and safe transfer. Count safe accepted intakes over **all eligible starts**, plus failures, abandonment, harmful suggestions, duplicate requests, and agent usefulness. The current interface has no start-to-receipt instrumentation, so it has no end-to-end baseline or model gain yet. Do not treat a handoff as a completed dispute resolution.

## Sources and one-day sample

The production source is the authorized S3 `data/` prefix configured in `Makefile`. DuckDB's temporary `credential_chain` secret uses an AWS profile or role. S3 is read-only; the browser and request handlers never access it. The same Bronze and Silver code can read local CSVs for offline fixtures. Use a separate ignored DuckDB under `data/demo_s3` so the full analytical database cannot be replaced by this one-day build.

```bash
make setup
make demo-setup
make demo-test
make demo-migrate
make demo-seed
make demo-sample-bronze AWS_PROFILE=default
make demo-sample-silver
make demo-sample-quality
make demo-sample-load
make demo-ui-build
```

`DEMO_DATE=2026-02-26`, `DEMO_DATA_DIR=data/demo_s3`, and `DEMO_CUSTOMER_ID=CLI-U53R5AZVLET0` are defaults for this demonstration. A different identity requires an explicit update to the loader's fixed allowlist and API login Literal after checking ownership. Do not add a public customer search. For local offline reproduction, call `run_ingestion.py` with `--local-source "$PWD/data"`, `--tables customers,products,daily_exchange_rates,transactions`, `--partition-date 2026-02-26`, and `DATA_DIR`/`DUCKDB_PATH` pointed at a separate ignored directory. This is the **existing** extractor with one exact fact-day path; it does not list or read all fact partitions. If the selected source day changes, use `--full-refresh --partition-date ...` only on an isolated one-day database and rerun Silver, quality and the loader. The loader rejects an existing PostgreSQL row if its content differs; it never silently overwrites cases or source transactions.

The loader projects needed columns, filters `transaction_date` and `Purchase/Approved` before joining, checks unique transaction IDs and N:1 product/customer links, and selects at most 20 rows for the fixed allowlist. DuckDB is limited to 1 GB with disk spill for the load; Bronze defaults to 2 GB and Silver to 3 GB with ignored spill directories. `process_date` is a storage/process field; the query uses the business `transaction_date`. Source `amount` is parsed as decimal in its original currency; `amount_usd` is deliberately unused. Source `transaction_date` remains a timezone-free PostgreSQL timestamp and the UI labels it accordingly. The selected source file, business date, source/customer/product/transaction IDs and mapping are stored in an ignored local manifest and in `intake_demo.sample_loads` for traceability. Silver removes duplicate transaction IDs before the selection; the sample loader requires one matching Bronze row for each selected ID.

In the checked 2026-02-26 sample, Bronze/Silver contained 150,000 customers, 400,000 products, 13,164 FX records and 3,787 transactions. Of that day, 625 distinct transactions were `Purchase/Approved`; the selected customer had one. The focused quality run reported 0 errors and 1 warning: 4,407/150,000 customer rows had `customer_status` outside its contract domain. The selected customer's `Inactive` is a current snapshot, not status at purchase time. The selected transaction's product and customer each joined once with matching ownership. A two-way `EXCEPT ALL` comparison found zero row differences between local CSV and S3 Bronze for all four selected tables after excluding `_source_file` and `_ingested_at`; the S3 loader found the previously inserted PostgreSQL row identical and added zero rows. These checks describe one day and dimensions, not overall dataset quality.

The observed customer CSV contains `first_name`, `last_name`, `last_updated` and other fields absent from the summary dictionary; products also has additional fields. The observed transaction columns match the detailed dictionary. The [Silver mapping](../../data_pipelines/silver/table_specs.py) and focused quality report determine executable columns; dictionary omissions are recorded rather than silently discarded.

## Local state and limitations

`DEMO_DATABASE_DSN` overrides the local DSN. Local PostgreSQL's `trust` authentication is only for this machine; never expose that container. `make demo-migrate` applies versioned SQL transactionally; `make demo-seed` adds only three fictitious charges and refuses conflicting values. Neither command seeds accepted cases. The four existing local cases remain. The API limits customers to their simulated session, gives the agent a separate simulated session, and commits before returning a reference. A retry with the same UUID and content returns the same reference; different content gets 409. Another UUID can create a second case for the same charge, so no cross-key duplicate policy is claimed.

When a request fails, the UI holds its payload and key in memory for retry and does not let the identity change. Reloading the tab loses this pending state. Simulated sessions also disappear when the one-worker API restarts; accepted cases remain in PostgreSQL. The client must reauthenticate after restart. No historical complaint is joined to this transaction by customer ID alone.

## PostgreSQL deployment alternative

`make demo-docker-build` builds a code-only, non-root web image with Angular and FastAPI on one origin. `demo_pg/loader.Dockerfile` builds a separate bounded S3 job image; the web image has no DuckDB, S3 code or AWS credentials. Neither image contains CSVs, DuckDB, cases or secrets. For a private team link on Render, use one **paid** `0.5c-512mb` web instance and a managed `0.1c-256mb` PostgreSQL in the same region. As checked on 2026-09-28, these plans are **$7 + $6 = $13/month** before extra storage, bandwidth and job compute; [current pricing](https://render.com/pricing) can change. A separately provisioned, short-lived one-off S3 load job adds usage charges; the 4 GB `2c-4g` plan is listed at $85/month equivalent and one-off jobs are billed per second. Render's [pre-deploy command](https://render.com/docs/deploys) is only available for paid web instances, so use `python -m demo_pg.db.migrate` there for versioned, nondestructive migrations before serving traffic; run the fictitious seed as a reviewed one-time setup action. Do not run migrations or ingestion on web startup.

Use HTTPS and the **internal authenticated** PostgreSQL connection string in `DEMO_DATABASE_DSN`. Render [allows external PostgreSQL connections by default](https://render.com/docs/postgresql-creating-connecting); explicitly **clear the database's external IP allowlist** before sharing. Set `DEMO_PUBLIC=1`, `DEMO_ACCESS_USERNAME`, and a long random `DEMO_ACCESS_PASSWORD` as platform secrets. The server rejects startup without them. Set health path `/healthz`. Use a separate job service from `demo_pg/loader.Dockerfile`, with its own `DEMO_DATABASE_DSN` and read-only AWS credentials restricted to the required S3 prefix. Run `python -m demo_pg.db.run_sample` there with a 4 GB or larger job plan, then remove its credentials and stop/delete that service. The job uses only one transaction day and three dimensions, never the full fact history. No data or credentials are embedded in either image.

The Basic prompt is a team access gate, not bank authentication; every allowed teammate can still use simulated customer and agent views. Keep one web worker and one instance because sessions are in memory. The container serves the Angular build and API on the same origin with a SPA fallback that excludes API routes. The development proxy is not used in production. Render's [free tier](https://render.com/docs/free) could host an ephemeral prototype, but free web has no pre-deploy command, sleeps after 15 minutes idle, and free PostgreSQL expires after 30 days without managed backups. It is not the proposed sharing configuration.

The separate [Cloudflare Worker + D1 pilot](../../cloudflare/README.md) has been deployed. This Render/PostgreSQL alternative has not been deployed. Recheck prices and access controls before using it; a remote end-to-end test must cover customer isolation, acceptance/reference, agent retrieval, retry and access denial.
