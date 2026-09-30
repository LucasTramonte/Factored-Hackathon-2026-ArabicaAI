"""Extractor v1: read one customer message with Workers AI ``@cf/openai/gpt-oss-20b`` (ADR-006).

The model only *reads* the message. It receives the message, the session language, the session time
``as_of``, the closed vocabulary and the committed system prompt (``prompt.md``), and nothing else:
no transactions, no customer identifiers. It returns the five extraction fields that
``evals.intake.systems.validate_extraction`` accepts; the deterministic policy decides the action.

Invariants:
- Credentials come from ``CLOUDFLARE_ACCOUNT_ID`` / ``CLOUDFLARE_API_TOKEN`` and are never logged.
- The message text is never printed, logged or put in an exception message.
- Temperature 0; a 10 s overall deadline raises ``TimeoutError``; one retry on invalid JSON or
  schema-invalid output, then ``ValueError``.
- A service or network failure (HTTP 429/5xx, connection reset, truncated body) raises
  ``ConnectionError``, which the harness turns into a technical handoff. Rejected credentials
  (HTTP 401/403) raise ``CredentialsError`` and stop the run, so a configuration error is never
  counted as handoffs.
"""
from __future__ import annotations

import http.client
import json
import os
import socket
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from evals.intake.systems import validate_extraction

MODEL = "@cf/openai/gpt-oss-20b"
PROMPT_PATH = Path(__file__).with_name("prompt.md")
TIMEOUT_S = 10.0
TEMPERATURE = 0
# gpt-oss is a reasoning model: its reasoning tokens count against max_tokens (the documented default is 256).
MAX_TOKENS = 2048
ATTEMPTS = 2  # the first call plus one retry
_URL = "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/" + MODEL


class CredentialsError(RuntimeError):
    """Raised when the Workers AI credentials are not configured in the environment."""


def _credentials() -> tuple[str, str]:
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    missing = [n for n, v in (("CLOUDFLARE_ACCOUNT_ID", account), ("CLOUDFLARE_API_TOKEN", token)) if not v]
    if missing:
        raise CredentialsError(f"Workers AI credentials missing: set {' and '.join(missing)} in the environment")
    return account, token


def build_body(message: str, session_language, as_of, vocabulary: dict) -> dict:
    """Return the request body: the committed prompt plus the four allowed inputs, nothing else."""
    user = {"message": message, "session_language": session_language, "as_of": as_of, "vocabulary": vocabulary}
    return {"messages": [{"role": "system", "content": PROMPT_PATH.read_text(encoding="utf-8")},
                         {"role": "user", "content": json.dumps(user, ensure_ascii=False)}],
            "temperature": TEMPERATURE, "max_tokens": MAX_TOKENS}


def _post(url: str, token: str, body: dict, timeout: float) -> dict:
    request = urllib.request.Request(url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST",
                                     headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        # Status only: the error body is not echoed, so nothing from the request can leak into logs.
        if exc.code in (401, 403):
            raise CredentialsError(f"Workers AI rejected the credentials (HTTP {exc.code})") from None
        raise ConnectionError(f"Workers AI HTTP {exc.code}") from None
    except (socket.timeout, TimeoutError) as exc:
        raise TimeoutError(f"Workers AI call exceeded {TIMEOUT_S:.0f} s") from exc
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (socket.timeout, TimeoutError)):
            raise TimeoutError(f"Workers AI call exceeded {TIMEOUT_S:.0f} s") from None
        raise ConnectionError(f"Workers AI unreachable: {type(exc.reason).__name__}") from None
    except (OSError, http.client.HTTPException) as exc:  # connection reset, truncated body
        raise ConnectionError(f"Workers AI connection failed: {type(exc).__name__}") from None
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("response is not JSON") from None


def _within(deadline: float, fn, *args):
    """Run ``fn`` in a worker thread and give up at ``deadline``.

    Socket timeouts bound each connect or read, not the whole call (a response that trickles in can
    exceed them, and DNS is not covered), so the overall deadline is enforced here. An abandoned
    call keeps running in its daemon thread; its result is discarded.
    """
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError(f"Workers AI call exceeded {TIMEOUT_S:.0f} s")
    box: dict = {}

    def run():
        try:
            box["value"] = fn(*args, remaining)
        except BaseException as exc:  # re-raised in the caller's thread
            box["error"] = exc
    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(remaining)
    if worker.is_alive():
        raise TimeoutError(f"Workers AI call exceeded {TIMEOUT_S:.0f} s")
    if "error" in box:
        raise box["error"]
    return box["value"]


def _content(payload: dict) -> str:
    """The assistant text of a chat-completion ``result`` (shape observed 2026-09-29)."""
    result = payload.get("result") if isinstance(payload, dict) else None
    if not isinstance(result, dict):
        raise ValueError("response without result")
    choices = result.get("choices")
    first = choices[0] if isinstance(choices, list) and choices else None
    message = first.get("message") if isinstance(first, dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip():
        raise ValueError("response without content")
    return content


def _usage(payload: dict) -> tuple[int, int]:
    result = payload.get("result") if isinstance(payload, dict) else None
    usage = result.get("usage") if isinstance(result, dict) else None
    if not isinstance(usage, dict):
        return 0, 0
    try:
        return int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0)
    except (TypeError, ValueError):
        return 0, 0


def parse(content: str, as_of) -> dict:
    """Parse the model's JSON and apply the fixed output normalisation, then validate the schema.

    Normalisation (parsing only, no inference): surrounding prose or code fences are ignored;
    ``stated_facts`` entries whose value is null are dropped, since a null means "not stated".
    With no session time (``as_of`` null) the date fact is dropped, because the written policy can
    only apply a date against an ``as_of``; the explicit confirmation step still guards the match.
    """
    text = content.strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object in model output")
    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        raise ValueError("model output is not valid JSON") from None
    if isinstance(data, dict) and isinstance(data.get("stated_facts"), dict):
        facts = {k: v for k, v in data["stated_facts"].items() if v is not None}
        if as_of is None:
            facts.pop("date", None)
        data["stated_facts"] = facts
    return validate_extraction(data)


def extract(message: str, session_language, as_of, vocabulary: dict) -> dict:
    """Extract intent and stated facts from one message.

    Returns ``{"extracted": {...}, "usage": {"input_tokens": n, "output_tokens": m}}`` where usage
    sums every attempt. Raises ``TimeoutError`` past the 10 s deadline, ``ValueError`` when both
    attempts return invalid output, and ``CredentialsError`` when credentials are missing.
    """
    account, token = _credentials()
    url = _URL.format(account=account)
    body = build_body(message, session_language, as_of, vocabulary)
    deadline = time.monotonic() + TIMEOUT_S
    input_tokens = output_tokens = 0
    for attempt in range(ATTEMPTS):
        payload = _within(deadline, _post, url, token, body)
        i, o = _usage(payload)
        input_tokens += i
        output_tokens += o
        try:
            extracted = parse(_content(payload), as_of)
        except ValueError:
            if attempt + 1 == ATTEMPTS:
                raise ValueError(f"invalid model output after {ATTEMPTS} attempts") from None
            continue
        return {"extracted": extracted, "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens}}
    raise ValueError("unreachable")  # pragma: no cover
