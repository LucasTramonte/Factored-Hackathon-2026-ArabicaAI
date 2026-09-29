"""Synthetic charge-intake demo API; never use simulated sessions for banking auth."""
import base64
import binascii
import hmac
import os
from pathlib import Path
from fastapi.responses import FileResponse
from datetime import datetime, timedelta, timezone
from secrets import token_urlsafe
from typing import Literal

import psycopg
from psycopg.rows import dict_row
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel

app = FastAPI(title="ArabicaAI local demo", description="Fictitious data; simulated login. No real bank integration.")
from demo_db.migrate import DEFAULT_DSN
DSN = os.environ.get("DEMO_DATABASE_DSN", DEFAULT_DSN)
PUBLIC = os.environ.get("DEMO_PUBLIC") == "1"
GATE_USER = os.environ.get("DEMO_ACCESS_USERNAME", "")
GATE_PASSWORD = os.environ.get("DEMO_ACCESS_PASSWORD", "")
if PUBLIC and (not GATE_USER or not GATE_PASSWORD or "DEMO_DATABASE_DSN" not in os.environ):
    raise RuntimeError("Public demo requires DEMO_DATABASE_DSN and server access credentials")
SECURE_COOKIES = PUBLIC or os.environ.get("DEMO_SECURE_COOKIES") == "1"


@app.middleware("http")
async def demo_access_gate(request: Request, call_next):
    """Require server-side HTTP Basic before all demo routes except health checks."""
    if PUBLIC and request.url.path != "/healthz":
        auth = request.headers.get("authorization", "")
        try:
            scheme, encoded = auth.split(" ", 1)
            decoded = base64.b64decode(encoded, validate=True).decode("utf-8")
            user, password = decoded.split(":", 1)
            valid = scheme.lower() == "basic" and hmac.compare_digest(user, GATE_USER) and hmac.compare_digest(password, GATE_PASSWORD)
        except (ValueError, UnicodeDecodeError, binascii.Error):
            valid = False
        if not valid:
            return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="ArabicaAI demo"', "Cache-Control": "no-store"})
    return await call_next(request)


@app.get("/healthz")
def healthz():
    """Check database reachability without exposing any case data."""
    try:
        with psycopg.connect(DSN, connect_timeout=3) as conn:
            conn.execute("SELECT 1")
    except psycopg.Error:
        raise HTTPException(503, "Database unavailable") from None
    return {"status": "ok"}
sessions = {}


class DemoLogin(BaseModel):
    """Select a fictitious identity for local testing only."""
    customer_id: Literal["demo-ana", "demo-bruno", "CLI-U53R5AZVLET0"]


@app.post("/demo/session")
def login(body: DemoLogin, request: Request, response: Response):
    """Create a one-hour simulated session; replace the previous cookie."""
    now = datetime.now(timezone.utc)
    for key in list(sessions):
        if sessions[key][1] <= now:
            sessions.pop(key, None)
    sessions.pop(request.cookies.get("demo_session"), None)
    token = token_urlsafe(32)
    sessions[token] = (body.customer_id, now + timedelta(hours=1))
    response.set_cookie("demo_session", token, httponly=True,
                        samesite="strict", secure=SECURE_COOKIES, max_age=3600, path="/")
    response.headers["Cache-Control"] = "no-store"
    return {"customer_id": body.customer_id, "mode": "simulated_login"}


@app.get("/transactions")
def transactions(request: Request, response: Response):
    """Return only transactions owned by the unexpired session identity."""
    session = sessions.get(request.cookies.get("demo_session"))
    if not session or session[1] <= datetime.now(timezone.utc):
        raise HTTPException(401, "Start a demo session first")
    try:
        with psycopg.connect(DSN, row_factory=dict_row) as conn:
            rows = conn.execute(
                "SELECT transaction_id, occurred_at, source_occurred_at, merchant_name, "
                "amount, currency FROM intake_demo.transactions "
                "WHERE customer_id = %s "
                "ORDER BY occurred_at DESC NULLS LAST, source_occurred_at DESC NULLS LAST, transaction_id LIMIT 21",
                (session[0],),
            ).fetchall()
    except psycopg.Error:
        raise HTTPException(503, "Transaction service unavailable; retry later") from None
    items = rows[:20]
    for row in items:
        row["amount"] = str(row["amount"])
    response.headers["Cache-Control"] = "no-store"
    return {"items": items, "has_more": len(rows) > 20,
            "coverage": "fictitious_demo_data_only"}


from uuid import UUID, uuid4
from pydantic import Field, StrictBool


class CaseRequest(BaseModel):
    transaction_id: str = Field(min_length=1, max_length=100)
    customer_statement: str = Field(min_length=10, max_length=2000)
    customer_confirmed: StrictBool
    idempotency_key: UUID


@app.post("/cases")
def create_case(body: CaseRequest, request: Request, response: Response):
    session = sessions.get(request.cookies.get("demo_session"))
    if not session or session[1] <= datetime.now(timezone.utc):
        raise HTTPException(401, "Start a demo session first")
    if not body.customer_confirmed:
        raise HTTPException(422, "Explicit confirmation is required")
    statement = body.customer_statement.strip()
    if len(statement) < 10:
        raise HTTPException(422, "Describe the charge in at least 10 characters")
    customer_id = session[0]
    try:
        with psycopg.connect(DSN, row_factory=dict_row) as conn:
            owned = conn.execute(
                "SELECT 1 FROM intake_demo.transactions "
                "WHERE customer_id = %s AND transaction_id = %s",
                (customer_id, body.transaction_id),
            ).fetchone()
            if not owned:
                raise HTTPException(404, "Transaction not found for this session")
            row = conn.execute(
                "INSERT INTO intake_demo.cases "
                "(case_id, customer_id, transaction_id, idempotency_key, "
                "customer_statement, customer_confirmed) "
                "VALUES (%s, %s, %s, %s, %s, TRUE) "
                "ON CONFLICT (customer_id, idempotency_key) DO NOTHING "
                "RETURNING case_id, transaction_id, customer_statement, "
                "status, accepted_at",
                (uuid4(), customer_id, body.transaction_id,
                 body.idempotency_key, statement),
            ).fetchone()
            created = row is not None
            if not created:
                row = conn.execute(
                    "SELECT case_id, transaction_id, customer_statement, "
                    "status, accepted_at FROM intake_demo.cases "
                    "WHERE customer_id = %s AND idempotency_key = %s",
                    (customer_id, body.idempotency_key),
                ).fetchone()
                if row is None:
                    raise HTTPException(503, "Retry with the same idempotency key")
                if (row["transaction_id"] != body.transaction_id
                        or row["customer_statement"] != statement):
                    raise HTTPException(409, "Key already used with different content")
        # The connection context committed successfully before this response.
    except psycopg.Error:
        raise HTTPException(
            503, "Acceptance not confirmed; retry with the same idempotency key"
        ) from None
    response.status_code = 201 if created else 200
    response.headers["Cache-Control"] = "no-store"
    return {
        "protocol": str(row["case_id"]),
        "transaction_id": row["transaction_id"],
        "status": row["status"],
        "accepted_at": row["accepted_at"],
        "replayed": not created,
        "scope": "local_demo_only",
        "next_step": "Await review in the demo agent view; no refund initiated",
    }


agent_sessions = {}


@app.post("/demo/agent-session")
def agent_login(request: Request, response: Response):
    """Simulated agent login for local fictitious-data testing only."""
    now = datetime.now(timezone.utc)
    for key in list(agent_sessions):
        if agent_sessions[key] <= now:
            agent_sessions.pop(key, None)
    agent_sessions.pop(request.cookies.get("demo_agent_session"), None)
    token = token_urlsafe(32)
    agent_sessions[token] = now + timedelta(hours=1)
    response.set_cookie("demo_agent_session", token, httponly=True,
                        samesite="strict", secure=SECURE_COOKIES, max_age=3600, path="/")
    response.headers["Cache-Control"] = "no-store"
    return {"role": "agent", "mode": "simulated_login"}


@app.get("/agent/cases")
def agent_cases(request: Request, response: Response):
    """Read persisted cases using a separate simulated agent session."""
    expiry = agent_sessions.get(request.cookies.get("demo_agent_session"))
    if not expiry or expiry <= datetime.now(timezone.utc):
        raise HTTPException(401, "Start a demo agent session first")
    try:
        with psycopg.connect(DSN, row_factory=dict_row) as conn:
            rows = conn.execute(
                "SELECT c.case_id AS protocol, c.customer_id, "
                "u.display_name, c.transaction_id, t.merchant_name, "
                "t.occurred_at, t.source_occurred_at, t.amount, t.currency, "
                "c.customer_statement, c.customer_confirmed, "
                "c.status, c.accepted_at "
                "FROM intake_demo.cases c "
                "JOIN intake_demo.customers u "
                "ON u.customer_id = c.customer_id "
                "JOIN intake_demo.transactions t "
                "ON t.transaction_id = c.transaction_id "
                "AND t.customer_id = c.customer_id "
                "ORDER BY c.accepted_at DESC, c.case_id LIMIT 51"
            ).fetchall()
    except psycopg.Error:
        raise HTTPException(503, "Case service unavailable; retry later") from None
    items = rows[:50]
    for row in items:
        row["amount"] = str(row["amount"])
    response.headers["Cache-Control"] = "no-store"
    return {"items": items, "has_more": len(rows) > 50,
            "scope": "local_demo_only"}


# The UI is an optional build artifact. Keep all API routes above this catch-all.
UI_BUILD = Path(__file__).resolve().parent / "demo-ui" / "dist" / "arabica-demo-ui" / "browser"
RESERVED = ("demo", "transactions", "cases", "agent", "healthz", "docs", "redoc", "openapi.json")


@app.get("/{path:path}", include_in_schema=False)
def ui(path: str):
    """Serve built assets and SPA paths without masking missing API endpoints."""
    if path.split("/", 1)[0] in RESERVED:
        raise HTTPException(404, "Not found")
    if not UI_BUILD.is_dir():
        raise HTTPException(404, "UI build unavailable")
    asset = (UI_BUILD / path).resolve()
    if asset.is_relative_to(UI_BUILD) and asset.is_file():
        return FileResponse(asset)
    if "." in Path(path).name:
        raise HTTPException(404, "Asset not found")
    return FileResponse(UI_BUILD / "index.html")
