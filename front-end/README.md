# ArabicaAI charge-intake demo

This Angular screen is a synthetic, English-language demo of a request **accepted for human review**. It does not decide fraud, block a card, or issue a refund. Customer and agent sign-ins are simulated. The charge from the supplied dataset remains synthetic and keeps its source currency and timezone-free wall time.

From the repository root:

```bash
make demo-setup
make demo-migrate
make demo-seed
.venv/bin/python -m uvicorn demo_pg.api:app --host 127.0.0.1 --port 8001
npm --prefix demo-ui start -- --host 127.0.0.1 --port 4200 --proxy-config proxy.conf.json
```

Open `http://127.0.0.1:4200`. The Angular development proxy forwards API routes to port 8001. `make demo-ui-build` creates the production assets served by FastAPI. Database setup, a one-day S3 load, tests, and deployment preparation are described in [the demo guide](../Docs/Plans/intake-demo.md).
