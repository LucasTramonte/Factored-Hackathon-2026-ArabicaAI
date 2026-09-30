"""Workers AI fact extraction; no transaction access or policy decisions."""
import json
import os
from contextlib import contextmanager
from pathlib import Path
import signal
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from evals.intake.systems import validate_extraction


@contextmanager
def _deadline(seconds):
    """Interrupt CLI I/O on POSIX; never overwrite another process timer."""
    if not hasattr(signal, "setitimer") or threading.current_thread() is not threading.main_thread():
        raise RuntimeError("Workers AI deadline requires a POSIX main thread")
    if any(signal.getitimer(signal.ITIMER_REAL)):
        raise RuntimeError("Workers AI deadline cannot replace an active process timer")

    def expired(_signum, _frame):
        raise TimeoutError("Workers AI request timed out")

    previous = signal.signal(signal.SIGALRM, expired)
    started = time.monotonic()
    try:
        signal.setitimer(signal.ITIMER_REAL, seconds)
        yield
        # A native call may defer the Python handler; it must not yield late success.
        if time.monotonic() - started >= seconds:
            raise TimeoutError("Workers AI request timed out")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def extract(message, session_language, as_of, vocabulary):
    """Extract stated facts with one invalid-output retry; never log customer text.

    Each HTTP attempt uses a 10-second POSIX main-thread deadline. Usage
    includes retries; absent provider usage is an error, never a fake zero.
    """
    credentials = {key: os.environ.get(key) for key in
                   ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN")}
    missing = [key for key, value in credentials.items() if not value]
    if missing:
        raise RuntimeError("Missing Workers AI credentials: " + ", ".join(missing))
    body = {
        "messages": [
            {"role": "system", "content": Path(__file__).with_name("prompt.md").read_text(encoding="utf-8")},
            {"role": "user", "content": json.dumps({"message": message, "session_language": session_language,
                                                     "as_of": as_of, "vocabulary": vocabulary}, ensure_ascii=False)},
        ],
        "temperature": 0, "max_tokens": 512, "response_format": {"type": "json_object"},
    }
    request = Request(
        "https://api.cloudflare.com/client/v4/accounts/" + credentials["CLOUDFLARE_ACCOUNT_ID"]
        + "/ai/run/@cf/openai/gpt-oss-20b",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": "Bearer " + credentials["CLOUDFLARE_API_TOKEN"],
                 "Content-Type": "application/json"}, method="POST",
    )
    usage = {"input_tokens": 0, "output_tokens": 0}
    for attempt in range(2):
        try:
            with _deadline(10):
                with urlopen(request, timeout=10) as response:
                    raw = response.read()
        except TimeoutError:
            raise TimeoutError("Workers AI request timed out") from None
        except HTTPError as error:
            error.close()
            raise RuntimeError(f"Workers AI HTTP error {error.code}") from None
        except URLError as error:
            if isinstance(error.reason, TimeoutError):
                raise TimeoutError("Workers AI request timed out") from None
            raise RuntimeError("Workers AI connection failed") from None
        try:
            envelope = json.loads(raw)
            if envelope.get("success") is not True:
                raise RuntimeError("Workers AI API reported failure")
            result = envelope["result"]
            measured = result.get("usage", {})
            for target, source in (("input_tokens", "prompt_tokens"), ("output_tokens", "completion_tokens")):
                value = measured.get(source)
                if type(value) is not int or value < 0:
                    raise RuntimeError("Workers AI response omitted valid token usage")
                usage[target] += value
            content = result["response"] if "response" in result else result["choices"][0]["message"]["content"]
            extracted = json.loads(content) if isinstance(content, str) else content
            validate_extraction(extracted)
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            if attempt == 1:
                raise ValueError("Workers AI returned invalid extraction after two attempts") from None
            continue
        return {"extracted": extracted, "usage": usage}
