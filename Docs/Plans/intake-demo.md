# Charge-intake demo: runbook

## What it does

The V1 workflow ([ADR-002](../ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md)):

1. A customer signs in with a **simulated** identity and sees only their own charges.
2. They pick one, describe it and explicitly confirm.
3. They get a reference once the case is stored.
4. A simulated agent reads the case.

The reference means "accepted for human review". It is not a fraud decision, a refund, a card block or a resolution. The MVP is deterministic, and no model is called. The runtime is one Cloudflare Worker with D1 ([ADR-003](../ADRs/ADR-003-intake-single-runtime-worker-d1.md)). Capacity and cost are covered in [ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md).

| Part | Path | Role |
|---|---|---|
| Batch data | `data_pipelines/bronze`, `silver`, `quality`, `gold` | Bounded one-day sample → validated D1 seed and manifest |
| API | `back-end/` | Worker + D1: sessions, customer scope, idempotent cases, agent view |
| Web client | `front-end/` | Angular customer and agent views; response contracts in `front-end/contracts/` |

## Local run (no Cloudflare account)

You need Python 3.10+ and Node 22+. From the repository root:

```bash
make setup                 # Python pipeline dependencies in .venv
make intake-setup          # npm ci for front-end and back-end
make intake-test           # Gold slice tests, Angular specs, Worker unit and integration tests
```

`make intake-test` builds the UI and runs the Worker against a throwaway local D1. For browsing, see [back-end/README.md](../../back-end/README.md).

## One-day dataset slice

The production source is the authorized S3 `data/` prefix configured in the `Makefile`. S3 is read-only. The browser and the Worker never touch it. The sample uses a separate ignored DuckDB under `data/demo_s3`, so the full analytical database is never replaced.

```bash
make intake-sample-bronze AWS_PROFILE=default    # exact fact-day path; it doesn't list other partitions
make intake-sample-silver
make intake-sample-quality
make intake-sample-slice                          # D1 seed + manifest under data/demo_s3/
make intake-seed-local                            # migrations, fictitious seed and slice into local D1
```

Defaults: `INTAKE_DATE=2026-02-26`, `INTAKE_DATA_DIR=data/demo_s3`. The dataset identity is allowlisted in `back-end/src/config/identities.json`, which the Worker and the slice both read. Adding an identity means editing that file together with a reviewed seed. There is no public customer search. For an offline build, pass `--local-source "$PWD/data"` to `run_ingestion.py` with `DATA_DIR`/`DUCKDB_PATH` pointed at a separate ignored directory.

The slice checks and writes the following ([data_pipelines/gold/README.md](../../data_pipelines/gold/README.md)):

- a ready quality run for this exact database and day;
- unique IDs and N:1 product/customer ownership;
- at most 20 allowlisted rows;
- one Bronze row per selected transaction;
- the original Bronze amount and currency (`amount_usd` is deliberately unused);
- the timezone-free source timestamp.

The seed can be rerun safely, and D1 rejects any row that changed since it was stored.

**Checked on 2026-02-26:**

- Bronze/Silver held 150,000 customers, 400,000 products, 13,164 FX records and 3,787 transactions.
- 625 transactions were `Purchase/Approved`, and the allowlisted customer had one.
- The focused quality run reported 0 errors and 1 warning: 4,407/150,000 customer rows had `customer_status` outside its domain.
- The product and customer of the selected transaction each joined once.
- A two-way `EXCEPT ALL` found no row differences between local CSV and S3 Bronze for the four tables.
- On 2026-09-29 the Gold slice produced the same transaction and provenance statements as the previous loader.

These checks describe one day and the dimensions, not the whole dataset.

The observed customer CSV has fields such as `first_name`, `last_name` and `last_updated` that the summary dictionary omits, and the products file has extra fields too. The [Silver mapping](../../data_pipelines/silver/table_specs.py) decides which columns are used. Omissions are recorded rather than silently dropped.

## Deployed preview

The Worker `factored-hackathon-2026-arabicaai` runs at https://factored-hackathon-2026-arabicaai.lucas-tramonte.workers.dev/. Cloudflare Access (email allowlist) and a Basic gate protect it. Neither is bank authentication.

- On 2026-09-29, production D1 held both migrations, the fictitious seed and no cases.
- Loading the Gold slice into production is a reviewed, manual step (`back-end/README.md`, "Deployment").
- Build settings and the post-deploy checklist are in [back-end/README.md](../../back-end/README.md).

## Known limits

- Simulated identities: anyone who passes Access can act as any demo customer.
- Sessions last one hour and are stored in D1.
- A retry with the same key and content returns the same reference, and different content gets 409. A second case for the same charge under a new key is possible: there is no cross-key duplicate rule yet (tracked in the roadmap).
- If the browser tab is closed with a request pending, the pending state is lost, but no duplicate is created.
- No historical complaint is linked to a transaction, so none is joined here by `customer_id` alone.
