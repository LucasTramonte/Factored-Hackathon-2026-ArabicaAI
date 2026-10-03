"""Offline tests for the Bedrock transport of extractor v1: HTTP is mocked, no network, no credentials needed."""
import io
import json
import os
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
        with mock.patch.object(bedrock.urllib.request, "urlopen", urlopen):
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
                mock.patch.object(bedrock.urllib.request, "urlopen", side_effect=AssertionError("no request")):
            with self.assertRaises(workers_ai.CredentialsError):
                bedrock.extract(MESSAGE, "es", None, VOCABULARY)

    def test_status_codes_map_like_workers_ai_and_never_echo_the_body(self):
        cases = [(403, workers_ai.CredentialsError), (401, workers_ai.CredentialsError), (429, ConnectionError),
                 (503, ConnectionError), (400, workers_ai.ConfigurationError)]
        for code, expected in cases:
            err = urllib.error.HTTPError("u", code, "x", {}, io.BytesIO(b"echo " + MESSAGE.encode()))
            with self.subTest(code=code), self.assertRaises(expected) as ctx:
                self.run_with(err)
            self.assertNotIn(MESSAGE, str(ctx.exception))
            self.assertEqual(ctx.exception.usage.get("usage_unavailable_calls"), 1)

    def test_a_non_json_body_is_a_service_failure_not_model_output(self):
        with self.assertRaises(ConnectionError):
            self.run_with(b"<html>502</html>")

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


if __name__ == "__main__":
    unittest.main()
