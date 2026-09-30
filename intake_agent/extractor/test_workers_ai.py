"""Offline REST boundary checks; extraction validation remains real."""
import importlib
import io
import json
import os
from pathlib import Path
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from evals.intake.systems import VOCABULARY, validate_extraction


EXTRACTION = {
    "intent": "report",
    "stated_facts": {"amount": {"value": "47.30", "approx": False}, "currency": "USD"},
    "invalid": None, "demand": None, "injection": False,
}


def response(extracted, input_tokens=100, output_tokens=30):
    """Model the documented Cloudflare envelope and token usage."""
    return io.BytesIO(json.dumps({"success": True, "errors": [], "messages": [], "result": {
        "response": extracted,
        "usage": {"prompt_tokens": input_tokens, "completion_tokens": output_tokens,
                  "total_tokens": input_tokens + output_tokens},
    }}).encode())


class WorkersAITests(unittest.TestCase):
    """Exercise the adapter with only the network transport replaced."""

    def setUp(self):
        """Use dummy credentials without reading any credential file."""
        try:
            self.adapter = importlib.import_module("intake_agent.extractor.workers_ai")
        except ModuleNotFoundError:
            self.fail("Workers AI extractor has not been implemented")
        env = patch.dict(os.environ, {"CLOUDFLARE_ACCOUNT_ID": "test-account",
                                    "CLOUDFLARE_API_TOKEN": "test-token"}, clear=True)
        env.start()
        self.addCleanup(env.stop)

    def extract(self):
        """Provide exactly the extractor interface, with no customer records."""
        return self.adapter.extract("Não reconheço compra de 47,30 USD", "pt", None, VOCABULARY)

    def test_valid_json_and_structured_response_pass_real_validation(self):
        for content in (json.dumps(EXTRACTION), EXTRACTION):
            with self.subTest(content_type=type(content).__name__), patch.object(
                    self.adapter, "urlopen", return_value=response(content)):
                actual = self.extract()
                self.assertEqual(actual, {"extracted": EXTRACTION,
                                          "usage": {"input_tokens": 100, "output_tokens": 30}})
                self.assertEqual(validate_extraction(actual["extracted"]), EXTRACTION)

    def test_invalid_json_twice_raises_without_echoing_output(self):
        with patch.object(self.adapter, "urlopen", side_effect=[
                response("private bad output"), response("private bad output")]) as http:
            with self.assertRaises(ValueError) as error:
                self.extract()
            self.assertEqual(http.call_count, 2)
            self.assertNotIn("private bad output", str(error.exception))

    def test_extra_session_field_is_rejected_by_real_validator(self):
        invalid = {**EXTRACTION, "customer_id": "forged"}
        with patch.object(self.adapter, "urlopen", side_effect=[response(invalid), response(invalid)]):
            with self.assertRaises(ValueError):
                self.extract()

    def test_retry_counts_tokens_from_both_model_calls(self):
        with patch.object(self.adapter, "urlopen", side_effect=[
                response("not JSON", 100, 10), response(json.dumps(EXTRACTION), 110, 30)]):
            actual = self.extract()
            self.assertEqual(actual["usage"], {"input_tokens": 210, "output_tokens": 40})

    def test_direct_and_wrapped_timeouts_raise_timeout_without_echo(self):
        for failure in (TimeoutError("private transport"), URLError(TimeoutError("private transport"))):
            with self.subTest(failure=type(failure).__name__), patch.object(
                    self.adapter, "urlopen", side_effect=failure) as http:
                with self.assertRaises(TimeoutError) as error:
                    self.extract()
                self.assertNotIn("private transport", str(error.exception))
                self.assertEqual(http.call_count, 1)

    def test_missing_credentials_are_named_before_any_http_call(self):
        for missing in ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"):
            with self.subTest(missing=missing), patch.dict(os.environ, {missing: ""}), patch.object(
                    self.adapter, "urlopen") as http:
                with self.assertRaisesRegex(RuntimeError, missing):
                    self.extract()
                http.assert_not_called()

    def test_request_has_only_permitted_inputs_and_fixed_generation_parameters(self):
        with patch.object(self.adapter, "urlopen", return_value=response(json.dumps(EXTRACTION))) as http:
            self.extract()
            request = http.call_args.args[0]
            body = json.loads(request.data)
            self.assertEqual(request.full_url, "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/openai/gpt-oss-20b")
            self.assertEqual(request.get_method(), "POST")
            self.assertEqual(request.get_header("Authorization"), "Bearer test-token")
            self.assertEqual(request.get_header("Content-type"), "application/json")
            self.assertEqual(http.call_args.kwargs, {"timeout": 10})
            self.assertEqual(set(body), {"messages", "temperature", "max_tokens", "response_format"})
            self.assertEqual(body["temperature"], 0)
            self.assertEqual(body["max_tokens"], 512)
            self.assertEqual(body["response_format"], {"type": "json_object"})
            self.assertEqual(body["messages"][0], {"role": "system", "content": Path(
                self.adapter.__file__).with_name("prompt.md").read_text(encoding="utf-8")})
            self.assertEqual(body["messages"][1]["role"], "user")
            self.assertEqual(json.loads(body["messages"][1]["content"]), {
                "message": "Não reconheço compra de 47,30 USD", "session_language": "pt",
                "as_of": None, "vocabulary": VOCABULARY})
            self.assertEqual(len(body["messages"]), 2)

    def test_http_failure_stops_without_echoing_provider_error_or_retry(self):
        source = io.BytesIO(b"private response body")
        failure = HTTPError("https://private-token", 401, "private response", {}, source)
        self.addCleanup(failure.close)
        with patch.object(self.adapter, "urlopen", side_effect=failure) as http:
            with self.assertRaises(RuntimeError) as error:
                self.extract()
            self.assertIn("401", str(error.exception))
            self.assertNotIn("private", str(error.exception))
            self.assertEqual(http.call_count, 1)
            self.assertTrue(source.closed)

    def test_missing_usage_is_reported_instead_of_inventing_zero_tokens(self):
        raw = io.BytesIO(json.dumps({"success": True, "result": {"response": EXTRACTION}}).encode())
        with patch.object(self.adapter, "urlopen", return_value=raw):
            with self.assertRaisesRegex(RuntimeError, "token usage"):
                self.extract()

    @unittest.skipUnless(hasattr(signal, "setitimer"), "requires POSIX deadline support")
    def test_slow_local_body_times_out_at_attempt_deadline(self):
        payload = response(json.dumps(EXTRACTION)).getvalue()
        stop = threading.Event()

        class SlowBody(BaseHTTPRequestHandler):
            """Send body fragments faster than the socket timeout allows."""

            def do_POST(self):
                """Serve a complete valid body over twelve elapsed seconds."""
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                # Each socket wait is six seconds, but the body takes twelve.
                for chunk in (payload[:1], payload[1:2], payload[2:]):
                    try:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    except OSError:
                        break
                    if stop.wait(6):
                        break

            def log_message(self, *_args):
                """Keep local request logs out of test output."""
                pass

        with HTTPServer(("127.0.0.1", 0), SlowBody) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            local_url = f"http://127.0.0.1:{server.server_port}/"

            def local_transport(request, timeout):
                return urlopen(local_url, data=request.data, timeout=timeout)

            started = time.monotonic()
            try:
                with patch.object(self.adapter, "urlopen", side_effect=local_transport):
                    with self.assertRaises(TimeoutError):
                        self.extract()
                elapsed = time.monotonic() - started
                self.assertGreaterEqual(elapsed, 9.5)
                self.assertLess(elapsed, 11.5)
            finally:
                stop.set()
                server.shutdown()
                thread.join(timeout=2)

    @unittest.skipUnless(hasattr(signal, "setitimer"), "requires POSIX deadline support")
    def test_completed_attempt_restores_alarm_handler_and_cancels_timer(self):
        old_handler = signal.getsignal(signal.SIGALRM)
        handler = lambda *_args: None
        signal.signal(signal.SIGALRM, handler)
        try:
            with patch.object(self.adapter, "urlopen", return_value=response(EXTRACTION)):
                self.extract()
            self.assertIs(signal.getsignal(signal.SIGALRM), handler)
            self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
        finally:
            signal.signal(signal.SIGALRM, old_handler)

    @unittest.skipUnless(hasattr(signal, "setitimer"), "requires POSIX deadline support")
    def test_deferred_alarm_cannot_return_success_after_deadline(self):
        # Model a native call that defers Python's signal handler, without waiting.
        with patch.object(self.adapter.signal, "setitimer"), patch.object(
                self.adapter.time, "monotonic", side_effect=[0.0, 11.0]), patch.object(
                self.adapter, "urlopen", return_value=response(EXTRACTION)):
            with self.assertRaises(TimeoutError):
                self.extract()

    @unittest.skipUnless(hasattr(signal, "setitimer"), "requires POSIX deadline support")
    def test_existing_process_timer_is_preserved_and_request_refused(self):
        signal.setitimer(signal.ITIMER_REAL, 60)
        try:
            with patch.object(self.adapter, "urlopen", return_value=response(EXTRACTION)) as http:
                with self.assertRaisesRegex(RuntimeError, "active process timer"):
                    self.extract()
                http.assert_not_called()
            self.assertGreater(signal.getitimer(signal.ITIMER_REAL)[0], 0)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)

    def test_non_main_thread_is_refused_before_http(self):
        failures = []

        def call_in_thread():
            try:
                self.extract()
            except Exception as error:
                failures.append(error)

        with patch.object(self.adapter, "urlopen", return_value=response(EXTRACTION)) as http:
            thread = threading.Thread(target=call_in_thread)
            thread.start()
            thread.join(timeout=2)
            self.assertEqual(len(failures), 1)
            self.assertIsInstance(failures[0], RuntimeError)
            self.assertIn("POSIX main thread", str(failures[0]))
            http.assert_not_called()


if __name__ == "__main__":
    unittest.main()
