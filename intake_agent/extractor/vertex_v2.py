"""Extractor v2: extractor v1's prompt, body, parsing and transport on Google's Gemini 3.5 Flash-Lite (ADR-006 amendment 10).

Why a v2: on 2026-10-04 Google's shared pool for ``openai/gpt-oss-20b-maas`` degraded (model latency from about 0.5 s to a
216 s hourly mean, then HTTP 429 "too many concurrent requests"), while Gemini answered 8 of 8 at the same moment; the
evidence is in ``Docs/deliverables/EVALUATION.md`` section 11. v1's registered files (``prompt.md``, ``workers_ai.py``,
``vertex.py``) are imported, never edited, so the v1 registration and its frozen result stay as they are.

What differs from v1, and nothing else:
- ``MODEL``: ``google/gemini-3.5-flash-lite``; ``reasoning_effort``: ``minimal`` (Gemini's lowest thinking level).
- One retry on HTTP 429 only, after a jittered wait inside the same 10 s deadline. A 429 is refused before any work, so the
  retry can't double-bill or duplicate; it shares the second attempt with v1's retry on invalid output, so a run still
  makes at most two calls. Timeouts and 5xx are never retried: Google keeps working on an abandoned call and bills it.

The Worker's port (``back-end/src/modules/intake/ai-transport.js``) is pinned to this module by
``evals/intake/online_parity.py``.
"""
from __future__ import annotations

import random
import time

from intake_agent.extractor import vertex
from intake_agent.extractor import workers_ai as w

MODEL = "google/gemini-3.5-flash-lite"
REASONING_EFFORT = "minimal"
#: The jittered wait before retrying a 429, in seconds; never past the deadline.
RETRY_WAIT_S = (0.5, 1.5)
_THROTTLED = "Vertex HTTP 429"


def build_body(message: str, session_language, as_of, vocabulary: dict) -> dict:
    """v1's body with v2's thinking level, then the model id: the committed prompt and the four inputs, nothing else."""
    return {**w.build_body(message, session_language, as_of, vocabulary), "reasoning_effort": REASONING_EFFORT, "model": MODEL}


def _throttled(exc: BaseException) -> bool:
    """Whether ``vertex._post`` refused the call with HTTP 429 (its ConnectionError message is the status, nothing else)."""
    return isinstance(exc, ConnectionError) and exc.args == (_THROTTLED,)


def extract(message: str, session_language, as_of, vocabulary: dict, *, sleep=time.sleep, wait=None) -> dict:
    """``vertex.extract``'s contract and attempt loop, plus one jittered retry on HTTP 429 (``sleep``/``wait`` are seams)."""
    usage = {"input_tokens": 0, "output_tokens": 0}
    try:
        url, token = vertex._credentials()
        body = build_body(message, session_language, as_of, vocabulary)
    except Exception as exc:
        exc.usage = dict(usage)  # No request was attempted, so these zeros are measured.
        raise
    deadline = time.monotonic() + w.TIMEOUT_S
    for attempt in range(w.ATTEMPTS):
        try:
            payload = w._within(deadline, vertex._post, url, token, body)
        except Exception as exc:
            usage["usage_unavailable_calls"] = usage.get("usage_unavailable_calls", 0) + 1
            pause = random.uniform(*RETRY_WAIT_S) if wait is None else wait
            if _throttled(exc) and attempt + 1 < w.ATTEMPTS and time.monotonic() + pause < deadline:
                sleep(pause)
                continue
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
