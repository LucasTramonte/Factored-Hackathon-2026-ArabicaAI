"""Offline tests for extractor v1: HTTP is mocked, no network, no credentials needed."""
import io
import json
import os
import socket
import unittest
import urllib.error
from unittest import mock

from evals.intake.systems import VOCABULARY, validate_extraction
from intake_agent.extractor import workers_ai

ENV = {"CLOUDFLARE_ACCOUNT_ID": "acct-test", "CLOUDFLARE_API_TOKEN": "token-test"}
MESSAGE = "No reconozco un cargo de 12.00 USD en Uber"
GOOD = {"intent": "report", "stated_facts": {"merchant": "Uber", "amount": {"value": "12.00", "approx": False},
                                              "currency": "USD"}, "invalid": None, "demand": None, "injection": False}


def payload(content, prompt_tokens=100, completion_tokens=20):
    """A Workers AI chat-completion envelope in the shape observed on 2026-09-29."""
    return {"result": {"model": workers_ai.MODEL, "choices": [{"index": 0, "message": {"role": "assistant", "content": content}}],
                       "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens}},
            "success": True, "errors": []}


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def responder(*contents):
    """Mock ``urlopen`` returning each content in turn and recording every request."""
    calls = []
    queue = list(contents)

    def urlopen(request, timeout):
        calls.append((request, timeout))
        item = queue.pop(0)
        if isinstance(item, BaseException):
            raise item
        return FakeResponse(json.dumps(payload(item)).encode())
    return urlopen, calls


@mock.patch.dict(os.environ, ENV, clear=False)
class ExtractTests(unittest.TestCase):
    def run_with(self, *contents, as_of="2026-06-12T10:00:00"):
        urlopen, calls = responder(*contents)
        with mock.patch.object(workers_ai.urllib.request, "urlopen", urlopen):
            out = workers_ai.extract(MESSAGE, "es", as_of, VOCABULARY)
        return out, calls

    def test_valid_response_parses_and_passes_validation(self):
        out, calls = self.run_with(json.dumps(GOOD))
        self.assertEqual(set(out), {"extracted", "usage"})
        self.assertEqual(validate_extraction(out["extracted"]), GOOD)
        self.assertEqual(out["usage"], {"input_tokens": 100, "output_tokens": 20})
        self.assertEqual(len(calls), 1)
        request, timeout = calls[0]
        self.assertEqual(request.full_url, "https://api.cloudflare.com/client/v4/accounts/acct-test/ai/run/@cf/openai/gpt-oss-20b")
        self.assertEqual(request.get_header("Authorization"), "Bearer token-test")
        self.assertLessEqual(timeout, workers_ai.TIMEOUT_S)

    def test_fenced_output_and_null_facts_are_normalised(self):
        fenced = "```json\n" + json.dumps(dict(GOOD, stated_facts=dict(GOOD["stated_facts"], card=None))) + "\n```"
        out, _ = self.run_with(fenced)
        self.assertEqual(out["extracted"], GOOD)

    def test_date_is_dropped_only_without_a_session_time(self):
        dated = dict(GOOD, stated_facts=dict(GOOD["stated_facts"], date={"expression": "hoy", "from": "2026-06-12", "to": "2026-06-12"}))
        out, _ = self.run_with(json.dumps(dated))
        self.assertIn("date", out["extracted"]["stated_facts"])
        out, _ = self.run_with(json.dumps(dated), as_of=None)
        self.assertNotIn("date", out["extracted"]["stated_facts"])

    def test_one_retry_on_invalid_json_then_success(self):
        out, calls = self.run_with("not json", json.dumps(GOOD))
        self.assertEqual(out["extracted"], GOOD)
        self.assertEqual(len(calls), 2)
        self.assertEqual(out["usage"], {"input_tokens": 200, "output_tokens": 40})

    def test_invalid_json_twice_raises_value_error(self):
        with self.assertRaises(ValueError) as ctx:
            self.run_with("{broken", "still not json")
        self.assertNotIn(MESSAGE, str(ctx.exception))

    def test_schema_invalid_twice_raises_value_error(self):
        bad = json.dumps(dict(GOOD, customer_id="EVAL-C9"))
        with self.assertRaises(ValueError):
            self.run_with(bad, bad)

    def test_timeout_raises_timeout_error(self):
        for exc in (socket.timeout("timed out"), TimeoutError("timed out"), urllib.error.URLError(socket.timeout("timed out"))):
            with self.subTest(exc=type(exc).__name__), self.assertRaises(TimeoutError):
                self.run_with(exc)

    def test_http_error_reports_status_without_body(self):
        err = urllib.error.HTTPError("u", 429, "Too Many Requests", {}, io.BytesIO(b"echo " + MESSAGE.encode()))
        with self.assertRaises(RuntimeError) as ctx:
            self.run_with(err)
        self.assertEqual(str(ctx.exception), "Workers AI HTTP 429")

    def test_missing_credentials_give_a_clear_error(self):
        for missing in ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"):
            env = {k: v for k, v in ENV.items() if k != missing}
            with self.subTest(missing=missing), mock.patch.dict(os.environ, env, clear=True):
                with mock.patch.object(workers_ai.urllib.request, "urlopen", side_effect=AssertionError("no call")):
                    with self.assertRaises(workers_ai.CredentialsError) as ctx:
                        workers_ai.extract(MESSAGE, "es", None, VOCABULARY)
                self.assertIn(missing, str(ctx.exception))

    def test_request_body_contains_only_the_allowed_inputs(self):
        _, calls = self.run_with(json.dumps(GOOD))
        body = json.loads(calls[0][0].data.decode())
        self.assertEqual(set(body), {"messages", "temperature", "max_tokens"})
        self.assertEqual(body["temperature"], 0)
        system, user = body["messages"]
        self.assertEqual((system["role"], user["role"]), ("system", "user"))
        self.assertEqual(system["content"], workers_ai.PROMPT_PATH.read_text(encoding="utf-8"))
        self.assertEqual(json.loads(user["content"]), {"message": MESSAGE, "session_language": "es",
                                                       "as_of": "2026-06-12T10:00:00", "vocabulary": VOCABULARY})
        raw = calls[0][0].data.decode()
        for forbidden in ("customer_id", "transaction_id", "EVAL-", "confirmed_id", "authenticated", "tool_failure", "token-test"):
            self.assertNotIn(forbidden, raw)

    def test_message_text_is_never_printed_or_logged(self):
        with mock.patch("sys.stdout", new_callable=io.StringIO) as out, mock.patch("sys.stderr", new_callable=io.StringIO) as err, \
                self.assertLogs(level="DEBUG") as logs:
            import logging
            logging.getLogger("sentinel").debug("sentinel")
            self.run_with("junk", json.dumps(GOOD))
        self.assertNotIn(MESSAGE, out.getvalue() + err.getvalue() + "\n".join(logs.output))


if __name__ == "__main__":
    unittest.main()
