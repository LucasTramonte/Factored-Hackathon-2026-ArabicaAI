"""Offline tests for the Vertex AI transport of extractor v1: HTTP is mocked, no network, no credentials needed."""
import io
import json
import os
import socket
import unittest
import urllib.error
from unittest import mock

from evals.intake.systems import VOCABULARY
from intake_agent.extractor import vertex, workers_ai

ENV = {"VERTEX_ACCESS_TOKEN": "vertex-token-test", "VERTEX_PROJECT": "factored-hackathon-arabica-ai", "VERTEX_LOCATION": "global"}
URL = "https://aiplatform.googleapis.com/v1/projects/factored-hackathon-arabica-ai/locations/global/endpoints/openapi/chat/completions"
MESSAGE = "No reconozco un cargo de 12.00 USD en Uber"
GOOD = {"intent": "report", "stated_facts": {"merchant": "Uber", "amount": {"value": "12.00", "approx": False},
                                              "currency": "USD"}, "invalid": None, "demand": None, "injection": False}


def openai_payload(content, prompt_tokens=100, completion_tokens=20):
    """Vertex AI's OpenAI-compatible Chat Completions shape (observed 2026-10-03), with reasoning in its own field."""
    return {"id": "chatcmpl-test", "object": "chat.completion", "model": vertex.MODEL,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content, "reasoning_content": "thinking {not json}"}, "finish_reason": "stop"}],
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
class VertexTransportTests(unittest.TestCase):
    def run_with(self, *items):
        urlopen, calls = responder(*items)
        with mock.patch.object(vertex._OPENER, "open", urlopen):
            return vertex.extract(MESSAGE, "es", "2026-06-12T10:00:00", VOCABULARY), calls

    def test_same_body_as_workers_ai_plus_the_model_id_and_a_bearer_key(self):
        out, calls = self.run_with(openai_payload(json.dumps(GOOD)))
        request = calls[0][0]
        self.assertEqual(request.full_url, URL)
        self.assertEqual(request.get_header("Authorization"), "Bearer vertex-token-test")
        sent = json.loads(request.data)
        expected = workers_ai.build_body(MESSAGE, "es", "2026-06-12T10:00:00", VOCABULARY)
        self.assertEqual({k: v for k, v in sent.items() if k != "model"}, expected, "prompt, inputs, temperature, max_tokens and reasoning_effort unchanged")
        self.assertEqual(sent["model"], "openai/gpt-oss-20b-maas")
        self.assertEqual(sent["reasoning_effort"], "low", "the reasoning level reaches Vertex explicitly")
        self.assertEqual(out["extracted"]["intent"], "report")
        self.assertEqual(out["usage"], {"input_tokens": 100, "output_tokens": 20})

    def test_a_regional_location_uses_its_regional_host(self):
        with mock.patch.dict(os.environ, {"VERTEX_LOCATION": "us-central1"}):
            _, calls = self.run_with(openai_payload(json.dumps(GOOD)))
        self.assertTrue(calls[0][0].full_url.startswith("https://us-central1-aiplatform.googleapis.com/v1/projects/factored-hackathon-arabica-ai/locations/us-central1/"))

    def test_the_reasoning_field_is_never_read(self):
        out, _ = self.run_with(openai_payload(json.dumps(GOOD)))
        self.assertEqual(out["extracted"]["intent"], "report", "only message.content is parsed")

    def test_missing_key_stops_before_any_request(self):
        with mock.patch.dict(os.environ, {"VERTEX_ACCESS_TOKEN": ""}), \
                mock.patch.object(vertex._OPENER, "open", side_effect=AssertionError("no request")):
            with self.assertRaises(workers_ai.CredentialsError) as ctx:
                vertex.extract(MESSAGE, "es", None, VOCABULARY)
        self.assertEqual(ctx.exception.usage, {"input_tokens": 0, "output_tokens": 0})

    def test_invalid_project_or_location_stops_before_attaching_a_token_to_a_request(self):
        for env in ({"VERTEX_PROJECT": "x@attacker.example/"}, {"VERTEX_PROJECT": "../proj-abcdef"}, {"VERTEX_PROJECT": ""},
                    {"VERTEX_LOCATION": "us-central1.attacker.example"}, {"VERTEX_LOCATION": "../global"}):
            region = next(iter(env.values()))
            with self.subTest(env=env):
                with mock.patch.dict(os.environ, env), \
                        mock.patch.object(vertex._OPENER, "open", side_effect=AssertionError("no request")), \
                        self.assertRaises(workers_ai.ConfigurationError) as ctx:
                    vertex.extract(MESSAGE, "es", None, VOCABULARY)
                if region:
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

    def test_401_says_refresh_and_403_says_grant_permission(self):
        for code, hint in ((401, "refresh VERTEX_ACCESS_TOKEN"), (403, "Vertex AI User")):
            with self.subTest(code=code):
                with self.assertRaises(workers_ai.CredentialsError) as ctx:
                    self.run_with(urllib.error.HTTPError("u", code, "x", {}, io.BytesIO(b"")))
                self.assertIn(hint, str(ctx.exception))

    def test_a_non_json_body_is_a_service_failure_not_model_output(self):
        with self.assertRaises(ConnectionError) as ctx:
            self.run_with(b"<html>502</html>")
        self.assertEqual(ctx.exception.usage["usage_unavailable_calls"], 1)

    def test_provider_error_envelope_is_not_retried_or_echoed(self):
        urlopen, calls = responder({"error": {"message": MESSAGE + ENV["VERTEX_ACCESS_TOKEN"]}})
        with mock.patch.object(vertex._OPENER, "open", urlopen), self.assertRaises(ConnectionError) as ctx:
            vertex.extract(MESSAGE, "es", None, VOCABULARY)
        self.assertEqual(len(calls), 1)
        self.assertNotIn(MESSAGE, str(ctx.exception))
        self.assertNotIn(ENV["VERTEX_ACCESS_TOKEN"], str(ctx.exception))
        self.assertEqual(ctx.exception.usage["usage_unavailable_calls"], 1)

    def test_redirect_handler_refuses_before_forwarding_bearer_headers(self):
        handler = vertex._NoRedirect()
        handler.parent = mock.Mock()
        request = vertex.urllib.request.Request(URL,
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
            with self.subTest(failure=type(failure).__name__):
                with self.assertRaises(expected) as ctx:
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
