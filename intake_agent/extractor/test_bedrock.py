"""Offline tests for the Bedrock transport of extractor v1: HTTP is mocked, no network, no credentials needed."""
import io
import json
import os
import socket
import unittest
import urllib.error
from unittest import mock

from evals.intake.systems import VOCABULARY
from intake_agent.extractor import bedrock, workers_ai

ENV = {"AWS_BEARER_TOKEN_BEDROCK": "bedrock-key-test", "AWS_REGION": "us-east-2"}
MESSAGE = "No reconozco un cargo de 12.00 USD en Uber"
GOOD = {"intent": "report", "stated_facts": {"merchant": "Uber", "amount": {"value": "12.00", "approx": False},
                                              "currency": "USD"}, "invalid": None, "demand": None, "injection": False}


def openai_payload(content, prompt_tokens=100, completion_tokens=20):
    """Bedrock's OpenAI-compatible Chat Completions response shape."""
    return {"id": "chatcmpl-test", "object": "chat.completion", "model": bedrock.MODEL,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens}}


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def responder(*items):
    calls = []
    queue = list(items)

    def urlopen(request, timeout):
        calls.append((request, timeout))
        item = queue.pop(0)
        if isinstance(item, BaseException):
            raise item
        return FakeResponse(json.dumps(item).encode() if isinstance(item, dict) else item)
    return urlopen, calls


@mock.patch.dict(os.environ, ENV, clear=False)
class BedrockTransportTests(unittest.TestCase):
    def run_with(self, *items):
        urlopen, calls = responder(*items)
        with mock.patch.object(bedrock._OPENER, "open", urlopen):
            return bedrock.extract(MESSAGE, "es", "2026-06-12T10:00:00", VOCABULARY), calls

    def test_same_body_as_workers_ai_plus_the_model_id_and_a_bearer_key(self):
        out, calls = self.run_with(openai_payload(json.dumps(GOOD)))
        request = calls[0][0]
        self.assertEqual(request.full_url, "https://bedrock-runtime.us-east-2.amazonaws.com/openai/v1/chat/completions")
        self.assertEqual(request.get_header("Authorization"), "Bearer bedrock-key-test")
        sent = json.loads(request.data)
        expected = workers_ai.build_body(MESSAGE, "es", "2026-06-12T10:00:00", VOCABULARY)
        self.assertEqual({k: v for k, v in sent.items() if k != "model"}, expected, "prompt, inputs, temperature and max_tokens unchanged")
        self.assertEqual(sent["model"], "openai.gpt-oss-20b-1:0")
        self.assertEqual(out["extracted"]["intent"], "report")
        self.assertEqual(out["usage"], {"input_tokens": 100, "output_tokens": 20})

    def test_region_comes_from_the_environment(self):
        with mock.patch.dict(os.environ, {"AWS_REGION": "us-west-2"}):
            _, calls = self.run_with(openai_payload(json.dumps(GOOD)))
        self.assertIn("bedrock-runtime.us-west-2.amazonaws.com", calls[0][0].full_url)

    def test_missing_key_stops_before_any_request(self):
        with mock.patch.dict(os.environ, {"AWS_BEARER_TOKEN_BEDROCK": ""}), \
                mock.patch.object(bedrock._OPENER, "open", side_effect=AssertionError("no request")):
            with self.assertRaises(workers_ai.CredentialsError) as ctx:
                bedrock.extract(MESSAGE, "es", None, VOCABULARY)
        self.assertEqual(ctx.exception.usage, {"input_tokens": 0, "output_tokens": 0})

    def test_invalid_region_stops_before_attaching_a_key_to_a_request(self):
        for region in ("us-east-2.amazonaws.com@attacker.example/", "../us-east-2", "us east 2"):
            with self.subTest(region=region), mock.patch.dict(os.environ, {"AWS_REGION": region}), \
                    mock.patch.object(bedrock._OPENER, "open", side_effect=AssertionError("no request")), \
                    self.assertRaises(workers_ai.ConfigurationError) as ctx:
                bedrock.extract(MESSAGE, "es", None, VOCABULARY)
            self.assertNotIn(region, str(ctx.exception))
            self.assertEqual(ctx.exception.usage, {"input_tokens": 0, "output_tokens": 0})

    def test_status_codes_map_like_workers_ai_and_never_echo_the_body(self):
        cases = [(302, workers_ai.ConfigurationError), (403, workers_ai.CredentialsError), (401, workers_ai.CredentialsError), (429, ConnectionError),
                 (503, ConnectionError), (400, workers_ai.ConfigurationError)]
        for code, expected in cases:
            err = urllib.error.HTTPError("u", code, "x", {}, io.BytesIO(b"echo " + MESSAGE.encode()))
            with self.subTest(code=code):
                with self.assertRaises(expected) as ctx:
                    self.run_with(err)
                self.assertNotIn(MESSAGE, str(ctx.exception))
            self.assertEqual(ctx.exception.usage.get("usage_unavailable_calls"), 1)

    def test_a_non_json_body_is_a_service_failure_not_model_output(self):
        with self.assertRaises(ConnectionError) as ctx:
            self.run_with(b"<html>502</html>")
        self.assertEqual(ctx.exception.usage["usage_unavailable_calls"], 1)

    def test_provider_error_envelope_is_not_retried_or_echoed(self):
        urlopen, calls = responder({"error": {"message": MESSAGE + ENV["AWS_BEARER_TOKEN_BEDROCK"]}})
        with mock.patch.object(bedrock._OPENER, "open", urlopen), self.assertRaises(ConnectionError) as ctx:
            bedrock.extract(MESSAGE, "es", None, VOCABULARY)
        self.assertEqual(len(calls), 1)
        self.assertNotIn(MESSAGE, str(ctx.exception))
        self.assertNotIn(ENV["AWS_BEARER_TOKEN_BEDROCK"], str(ctx.exception))
        self.assertEqual(ctx.exception.usage["usage_unavailable_calls"], 1)

    def test_redirect_handler_refuses_before_forwarding_bearer_headers(self):
        handler = bedrock._NoRedirect()
        handler.parent = mock.Mock()
        request = bedrock.urllib.request.Request("https://bedrock-runtime.us-east-2.amazonaws.com/",
                                                data=b"{}", headers={"Authorization": "Bearer test-secret"})
        with self.assertRaises(urllib.error.HTTPError):
            handler.http_error_302(request, io.BytesIO(b""), 302, "redirect",
                                   {"location": "https://attacker.example/"})
        handler.parent.open.assert_not_called()

    def test_invalid_output_is_retried_once_then_counted_with_both_attempts_tokens(self):
        out, calls = self.run_with(openai_payload("not json", 50, 5), openai_payload(json.dumps(GOOD), 60, 6))
        self.assertEqual(len(calls), 2)
        self.assertEqual(out["usage"], {"input_tokens": 110, "output_tokens": 11})
        with self.assertRaises(ValueError) as ctx:
            self.run_with(openai_payload("no", 1, 1), openai_payload("still no", 1, 1))
        self.assertEqual(ctx.exception.usage, {"input_tokens": 2, "output_tokens": 2})

    def test_missing_usage_is_unavailable_not_free(self):
        body = openai_payload(json.dumps(GOOD))
        del body["usage"]
        out, _ = self.run_with(body)
        self.assertEqual(out["usage"]["usage_unavailable_calls"], 1)

    def test_failed_second_attempt_retains_the_first_attempt_tokens(self):
        for failure in (urllib.error.URLError(OSError(MESSAGE)), socket.timeout(MESSAGE)):
            expected = TimeoutError if isinstance(failure, socket.timeout) else ConnectionError
            with self.subTest(failure=type(failure).__name__), self.assertRaises(expected) as ctx:
                self.run_with(openai_payload("invalid", 50, 5), failure)
            self.assertEqual(ctx.exception.usage, {"input_tokens": 50, "output_tokens": 5, "usage_unavailable_calls": 1})
            self.assertNotIn(MESSAGE, str(ctx.exception))
            self.assertIsNone(ctx.exception.__cause__)

    def test_malformed_usage_is_unknown_even_when_the_extraction_is_valid(self):
        for counts in ((True, 5), (-1, 5), ("100", 5), (100, None)):
            with self.subTest(counts=counts):
                out, _ = self.run_with(openai_payload(json.dumps(GOOD), *counts))
                self.assertEqual(out["usage"], {"input_tokens": 0, "output_tokens": 0, "usage_unavailable_calls": 1})


if __name__ == "__main__":
    unittest.main()
