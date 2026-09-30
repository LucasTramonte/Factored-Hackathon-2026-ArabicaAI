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
- A service or network failure (HTTP 429/5xx, connection reset, truncated or non-JSON body) raises
  ``ConnectionError``, which the harness turns into a technical handoff. Any other HTTP 4xx is a
  configuration problem: 401/403 raise ``CredentialsError`` and the rest ``ConfigurationError``, and
  both stop the run, so a configuration error is never counted as handoffs.
- A ``success: false`` envelope is a provider failure: ``ConnectionError``, no retry, never counted
  as invalid model output.
- Every exception raised by ``extract`` carries ``usage`` (tokens of the attempts that returned),
  so failed cases still count in token and cost totals. A response whose usage is missing or not a
  non-negative integer, or an attempt that fails in transport, adds 0 tokens and one to
  ``usage_unavailable_calls``, so unmeasured is never
  reported as free.
- At most ``MAX_IN_FLIGHT`` HTTP workers exist at once, and each stops reading at the deadline.
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
MAX_IN_FLIGHT = 4  # HTTP workers alive at once, including abandoned ones still unwinding
WORKER_NAME = "workers-ai-call"
_READ_CHUNK = 65536
_slots = threading.BoundedSemaphore(MAX_IN_FLIGHT)
_URL = "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/" + MODEL


class ConfigurationError(RuntimeError):
    """A problem on our side (bad request, wrong model path): it stops the run instead of being scored."""


class CredentialsError(ConfigurationError):
    """Raised when the Workers AI credentials are missing or rejected."""


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


def _set_read_timeout(response, seconds: float) -> None:
    """Best effort: bound the next socket read by the time left (urllib keeps the socket private)."""
    sock = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
    if sock is not None:
        sock.settimeout(max(seconds, 0.001))


def _read_until(response, deadline: float) -> bytes:
    """Read the body one socket read at a time and stop at ``deadline`` instead of draining a trickle."""
    chunks = []
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"Workers AI call exceeded {TIMEOUT_S:.0f} s")
        _set_read_timeout(response, remaining)
        chunk = response.read1(_READ_CHUNK)
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)


def _post(url: str, token: str, body: dict, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    request = urllib.request.Request(url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST",
                                     headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = _read_until(response, deadline)
    except urllib.error.HTTPError as exc:
        exc.close()  # the error is a response with an open body
        # Status only: the error body is not echoed, so nothing from the request can leak into logs.
        if exc.code in (401, 403):
            raise CredentialsError(f"Workers AI rejected the credentials (HTTP {exc.code})") from None
        if exc.code == 429 or exc.code >= 500:
            raise ConnectionError(f"Workers AI HTTP {exc.code}") from None
        raise ConfigurationError(f"Workers AI HTTP {exc.code}: check the model path and request") from None
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
        # A gateway page or a cut body is a service failure, not the model's output.
        raise ConnectionError("Workers AI returned a non-JSON body") from None


def _within(deadline: float, fn, *args):
    """Run ``fn`` in a worker thread and give up at ``deadline``.

    Socket timeouts bound each connect or read, not the whole call (a response that trickles in can
    exceed them, and DNS is not covered), so the overall deadline is enforced here. An abandoned
    worker stops at its own deadline once its current socket read returns (``_read_until``); one
    blocked where no timeout applies (DNS) keeps its slot, and when all ``MAX_IN_FLIGHT`` slots are
    taken a new call times out without starting a worker.
    """
    remaining = deadline - time.monotonic()
    if remaining <= 0 or not _slots.acquire(timeout=remaining):
        raise TimeoutError(f"Workers AI call exceeded {TIMEOUT_S:.0f} s")
    remaining = deadline - time.monotonic()
    box: dict = {}

    def run():
        try:
            box["value"] = fn(*args, remaining)
        except BaseException as exc:  # re-raised in the caller's thread
            box["error"] = exc
        finally:
            _slots.release()
    worker = threading.Thread(target=run, name=WORKER_NAME, daemon=True)
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


def _usage(payload: dict) -> tuple[int, int] | None:
    """Provider token counts, or ``None`` when they are missing or not non-negative integers."""
    result = payload.get("result") if isinstance(payload, dict) else None
    usage = result.get("usage") if isinstance(result, dict) else None
    if not isinstance(usage, dict):
        return None
    counts = usage.get("prompt_tokens"), usage.get("completion_tokens")
    if all(isinstance(n, int) and not isinstance(n, bool) and n >= 0 for n in counts):
        return counts
    return None


def _provider_failure(payload) -> ConnectionError | None:
    """A ``success: false`` envelope, reported by its numeric error codes only (messages may echo input)."""
    if not (isinstance(payload, dict) and payload.get("success") is False):
        return None
    errors = payload.get("errors") if isinstance(payload.get("errors"), list) else []
    codes = [str(e["code"]) for e in errors if isinstance(e, dict) and isinstance(e.get("code"), int)]
    return ConnectionError("Workers AI reported a failure" + (f" (codes {', '.join(codes)})" if codes else ""))


def parse(content: str) -> dict:
    """Parse the model's JSON and apply the fixed output normalisation, then validate the schema.

    Normalisation (parsing only, no inference): surrounding prose or code fences are ignored;
    ``stated_facts`` entries whose value is null are dropped, since a null means "not stated".
    Every stated fact, including a date, is kept whether or not the session has an ``as_of``.
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
        data["stated_facts"] = {k: v for k, v in data["stated_facts"].items() if v is not None}
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
    usage = {"input_tokens": 0, "output_tokens": 0}
    for attempt in range(ATTEMPTS):
        try:
            payload = _within(deadline, _post, url, token, body)
        except Exception as exc:
            # Tokens of earlier attempts still count; this attempt's are unknown (a timeout may still be billed).
            usage["usage_unavailable_calls"] = usage.get("usage_unavailable_calls", 0) + 1
            exc.usage = dict(usage)
            raise
        counts = _usage(payload)
        if counts is None:
            usage["usage_unavailable_calls"] = usage.get("usage_unavailable_calls", 0) + 1
        else:
            usage["input_tokens"] += counts[0]
            usage["output_tokens"] += counts[1]
        failure = _provider_failure(payload)
        if failure is not None:
            failure.usage = dict(usage)
            raise failure
        try:
            extracted = parse(_content(payload))
        except (ValueError, TypeError):  # schema validation raises TypeError for wrongly typed fields
            if attempt + 1 == ATTEMPTS:
                exc = ValueError(f"invalid model output after {ATTEMPTS} attempts")
                exc.usage = dict(usage)
                raise exc from None
            continue
        return {"extracted": extracted, "usage": usage}
    raise ValueError("unreachable")  # pragma: no cover
