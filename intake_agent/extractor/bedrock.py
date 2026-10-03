"""Extractor v1 hosted on Amazon Bedrock for evaluation runs (ADR-006, amendment 6).

Same weights (OpenAI ``gpt-oss-20b``), same committed prompt, same request body, same parsing, deadline and retry
as ``workers_ai``: only the transport differs. Bedrock's OpenAI-compatible Chat Completions endpoint takes a Bedrock
API key as a Bearer token and answers in the OpenAI shape, which is wrapped into the ``workers_ai`` envelope so its
``_content`` / ``_usage`` / ``parse`` apply unchanged. This module adds no behaviour: anything that changes what the
model is asked or how its answer is read (prompt, parsing, the reasoning level) belongs to ``workers_ai`` and the
isolated builder (ADR-006, decision 5).

Invariants (as ``workers_ai``):
- Credentials come from ``AWS_BEARER_TOKEN_BEDROCK`` (a Bedrock API key) and ``AWS_REGION`` (default ``us-east-2``)
  and are never logged; the message text is never printed, logged or put in an exception message.
- HTTP 401/403 raise ``CredentialsError`` (a rejected key, or model access not enabled in the Bedrock console);
  429/5xx, network failures and non-JSON bodies raise ``ConnectionError``; other 4xx raise ``ConfigurationError``.
- Every exception from ``extract`` carries ``usage``; an attempt that fails in transport, or returns no usable
  token counts, adds one to ``usage_unavailable_calls``, so unmeasured is never reported as free.
"""
from __future__ import annotations

import http.client
import json
import os
import socket
import time
import urllib.error
import urllib.request

from intake_agent.extractor import workers_ai as w

MODEL = "openai.gpt-oss-20b-1:0"
_URL = "https://bedrock-runtime.{region}.amazonaws.com/openai/v1/chat/completions"


def _credentials() -> tuple[str, str]:
    region = os.environ.get("AWS_REGION", "").strip() or "us-east-2"
    token = os.environ.get("AWS_BEARER_TOKEN_BEDROCK", "").strip()
    if not token:
        raise w.CredentialsError("Bedrock credentials missing: set AWS_BEARER_TOKEN_BEDROCK (a Bedrock API key) in the environment")
    return region, token


def build_body(message: str, session_language, as_of, vocabulary: dict) -> dict:
    """``workers_ai``'s body (committed prompt, four inputs, temperature, max_tokens) plus Bedrock's model id."""
    return {**w.build_body(message, session_language, as_of, vocabulary), "model": MODEL}


def _post(url: str, token: str, body: dict, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    request = urllib.request.Request(url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST",
                                     headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = w._read_until(response, deadline)
    except urllib.error.HTTPError as exc:
        exc.close()
        # Status only: the error body is not echoed, so nothing from the request can leak into logs.
        if exc.code in (401, 403):
            raise w.CredentialsError(f"Bedrock rejected the key or the model isn't enabled (HTTP {exc.code})") from None
        if exc.code == 429 or exc.code >= 500:
            raise ConnectionError(f"Bedrock HTTP {exc.code}") from None
        raise w.ConfigurationError(f"Bedrock HTTP {exc.code}: check the model id, region and request") from None
    except (socket.timeout, TimeoutError) as exc:
        raise TimeoutError(f"Bedrock call exceeded {w.TIMEOUT_S:.0f} s") from exc
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (socket.timeout, TimeoutError)):
            raise TimeoutError(f"Bedrock call exceeded {w.TIMEOUT_S:.0f} s") from None
        raise ConnectionError(f"Bedrock unreachable: {type(exc.reason).__name__}") from None
    except (OSError, http.client.HTTPException) as exc:
        raise ConnectionError(f"Bedrock connection failed: {type(exc).__name__}") from None
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ConnectionError("Bedrock returned a non-JSON body") from None
    # The OpenAI shape, wrapped as the Workers AI envelope so the shared readers apply unchanged.
    return {"result": payload, "success": True} if isinstance(payload, dict) else payload


def extract(message: str, session_language, as_of, vocabulary: dict) -> dict:
    """Extract intent and stated facts from one message through Bedrock; same contract as ``workers_ai.extract``."""
    region, token = _credentials()
    url = _URL.format(region=region)
    body = build_body(message, session_language, as_of, vocabulary)
    deadline = time.monotonic() + w.TIMEOUT_S
    usage = {"input_tokens": 0, "output_tokens": 0}
    for attempt in range(w.ATTEMPTS):
        try:
            payload = w._within(deadline, _post, url, token, body)
        except Exception as exc:
            usage["usage_unavailable_calls"] = usage.get("usage_unavailable_calls", 0) + 1
            exc.usage = dict(usage)
            raise
        counts = w._usage(payload)
        if counts is None:
            usage["usage_unavailable_calls"] = usage.get("usage_unavailable_calls", 0) + 1
        else:
            usage["input_tokens"] += counts[0]
            usage["output_tokens"] += counts[1]
        try:
            extracted = w.parse(w._content(payload))
        except (ValueError, TypeError):
            if attempt + 1 == w.ATTEMPTS:
                exc = ValueError(f"invalid model output after {w.ATTEMPTS} attempts")
                exc.usage = dict(usage)
                raise exc from None
            continue
        return {"extracted": extracted, "usage": usage}
    raise ValueError("unreachable")  # pragma: no cover
