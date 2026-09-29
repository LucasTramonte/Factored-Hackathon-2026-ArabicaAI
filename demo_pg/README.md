# PostgreSQL intake demo

This package is the local FastAPI/PostgreSQL implementation and the bounded Silver-to-PostgreSQL sample loader. It remains a tested alternative to the deployed [Worker + D1 pilot](../cloudflare/README.md). Both implementations use the Angular app in [`demo-ui/`](../demo-ui/README.md). Neither runtime is banking authentication.

From the repository root, run `make demo-setup`, `make demo-migrate`, `make demo-seed`, and `make demo-test`. Start the local API with:

```bash
.venv/bin/python -m uvicorn demo_pg.api:app --host 127.0.0.1 --port 8001
```

The loader uses the existing Bronze → Silver → quality path for one business date; see [the reproducibility guide](../Docs/Plans/intake-demo.md). `web.Dockerfile` packages the FastAPI app and Angular build. `loader.Dockerfile` packages the separate, bounded data job. The root `Dockerfile` belongs to the main data pipeline.
