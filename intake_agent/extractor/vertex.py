"""Extractor v1 hosted on Google Vertex AI for evaluation runs (ADR-006, amendment 7).

Same weights (OpenAI ``gpt-oss-20b``), same committed prompt, same request body, same parsing, deadline and retry
as ``workers_ai``: only the transport differs. Vertex AI's managed open-model API (``openai/gpt-oss-20b-maas``)
exposes an OpenAI-compatible Chat Completions endpoint that takes a Google OAuth access token as a Bearer token and
answers in the OpenAI shape (reasoning in a separate ``reasoning_content`` field, never read), which is wrapped into
the ``workers_ai`` envelope so its ``_content`` / ``_usage`` / ``parse`` apply unchanged. This module adds no
behaviour: anything that changes what the model is asked or how its answer is read (prompt, parsing, the reasoning
level) belongs to ``workers_ai`` and the isolated builder (ADR-006, decision 5).

Invariants (as ``workers_ai``):
- Credentials come from ``VERTEX_ACCESS_TOKEN`` (``gcloud auth print-access-token``, valid about one hour),
  ``VERTEX_PROJECT`` and ``VERTEX_LOCATION`` (default ``global``) and are never logged; the message text is never
  printed, logged or put in an exception message.
- HTTP 401 raises ``CredentialsError`` (an expired or invalid token); 403 too (the account lacks Vertex AI permission on the project);
  429/5xx, network failures and non-JSON bodies raise ``ConnectionError``; other 4xx raise ``ConfigurationError``.
- Every exception from ``extract`` carries ``usage``; an attempt that fails in transport, or returns no usable
  token counts, adds one to ``usage_unavailable_calls``, so unmeasured is never reported as free.
"""
from __future__ import annotations

import http.client
import json
import os
import re
import socket
import time
import urllib.error
import urllib.request

from intake_agent.extractor import workers_ai as w

MODEL = "openai/gpt-oss-20b-maas"
_PATH = "/v1/projects/{project}/locations/{location}/endpoints/openapi/chat/completions"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse redirects so a bearer key can never be forwarded to another origin."""

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(request.full_url, code, "Vertex redirect refused", headers, fp)


_OPENER = urllib.request.build_opener(_NoRedirect)


def _credentials() -> tuple[str, str]:
    """``(url, token)``; project and location are checked before they go into a Google host name or path."""
    project = os.environ.get("VERTEX_PROJECT", "").strip()
    location = os.environ.get("VERTEX_LOCATION", "").strip() or "global"
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):
        raise w.ConfigurationError("Invalid or missing VERTEX_PROJECT: use a Google Cloud project id")
    if location != "global" and not re.fullmatch(r"[a-z]+-[a-z]+\d", location):
        raise w.ConfigurationError("Invalid VERTEX_LOCATION: use global or a region id such as us-central1")
    token = os.environ.get("VERTEX_ACCESS_TOKEN", "").strip()
    if not token:
        raise w.CredentialsError("Vertex credentials missing: set VERTEX_ACCESS_TOKEN from `gcloud auth print-access-token`")
    host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
    return f"https://{host}" + _PATH.format(project=project, location=location), token


def build_body(message: str, session_language, as_of, vocabulary: dict) -> dict:
    """``workers_ai``'s body (committed prompt, four inputs, temperature, max_tokens, reasoning_effort) plus Vertex's model id."""
    return {**w.build_body(message, session_language, as_of, vocabulary), "model": MODEL}


def _post(url: str, token: str, body: dict, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    request = urllib.request.Request(url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST",
                                     headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            raw = w._read_until(response, deadline)
    except urllib.error.HTTPError as exc:
        exc.close()
        # Status only: the error body is not echoed, so nothing from the request can leak into logs.
        if exc.code == 401:
            raise w.CredentialsError("Vertex rejected the token (HTTP 401); refresh VERTEX_ACCESS_TOKEN") from None
        if exc.code == 403:
            raise w.CredentialsError("Vertex denied access (HTTP 403); grant the account Vertex AI User on VERTEX_PROJECT") from None
        if exc.code == 429 or exc.code >= 500:
            raise ConnectionError(f"Vertex HTTP {exc.code}") from None
        raise w.ConfigurationError(f"Vertex HTTP {exc.code}: check the project, location, model id and request") from None
    except (socket.timeout, TimeoutError):
        raise TimeoutError(f"Vertex call exceeded {w.TIMEOUT_S:.0f} s") from None
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (socket.timeout, TimeoutError)):
            raise TimeoutError(f"Vertex call exceeded {w.TIMEOUT_S:.0f} s") from None
        raise ConnectionError(f"Vertex unreachable: {type(exc.reason).__name__}") from None
    except (OSError, http.client.HTTPException) as exc:
        raise ConnectionError(f"Vertex connection failed: {type(exc).__name__}") from None
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ConnectionError("Vertex returned a non-JSON body") from None
    if isinstance(payload, dict) and "error" in payload:
        # A provider error envelope is a transport failure, not an invalid model answer.
        # Do not include its message, which may echo the customer's text or credentials.
        raise ConnectionError("Vertex reported a failure")
    # The OpenAI shape, wrapped as the Workers AI envelope so the shared readers apply unchanged.
    return {"result": payload, "success": True} if isinstance(payload, dict) else payload


def extract(message: str, session_language, as_of, vocabulary: dict) -> dict:
    """Extract intent and stated facts from one message through Vertex AI; same contract as ``workers_ai.extract``."""
    usage = {"input_tokens": 0, "output_tokens": 0}
    try:
        url, token = _credentials()
        body = build_body(message, session_language, as_of, vocabulary)
    except Exception as exc:
        exc.usage = dict(usage)  # No request was attempted, so these zeros are measured.
        raise
    deadline = time.monotonic() + w.TIMEOUT_S
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
