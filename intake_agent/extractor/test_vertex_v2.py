"""Offline tests for extractor v2: v1's body with two fields changed, and the 429-only retry. No network, no credentials."""
import os
import unittest
from unittest import mock

from evals.intake.systems import VOCABULARY
from intake_agent.extractor import vertex, vertex_v2, workers_ai

URL = "https://vertex.test/chat/completions"
MESSAGE = "No reconozco un cargo de 12.00 USD en Uber"
GOOD = '{"intent":"report","stated_facts":{"merchant":"Uber"},"invalid":null,"demand":null,"injection":false}'


def payload(content=GOOD):
    """The Workers AI envelope ``vertex._post`` returns for an OpenAI-shaped answer."""
    return {"result": {"choices": [{"message": {"content": content}}], "usage": {"prompt_tokens": 10, "completion_tokens": 2}},
            "success": True}


class VertexV2Tests(unittest.TestCase):
    def run_with(self, outcomes, **kwargs):
        """Run ``extract`` with ``vertex._post`` answering ``outcomes`` in order (an exception is raised)."""
        queue = list(outcomes)

        def post(*_):
            item = queue.pop(0)
            if isinstance(item, BaseException):
                raise item
            return item

        sleeps = []
        with mock.patch.object(vertex_v2, "_credentials", return_value=(URL, "t")), mock.patch.object(vertex, "_post", side_effect=post) as p:
            try:
                result = vertex_v2.extract(MESSAGE, "es", None, VOCABULARY, sleep=sleeps.append, **kwargs)
            except Exception as exc:  # noqa: BLE001 (returned for assertions)
                result = exc
        return result, p.call_count, sleeps

    def test_body_is_v1s_with_only_the_model_and_thinking_level_changed(self):
        v1 = vertex.build_body(MESSAGE, "es", None, VOCABULARY)
        v2 = vertex_v2.build_body(MESSAGE, "es", None, VOCABULARY)
        self.assertEqual({k for k in v1 if v1[k] != v2[k]}, {"model", "reasoning_effort"})
        self.assertEqual((v2["model"], v2["reasoning_effort"]), ("google/gemini-3.5-flash-lite", "minimal"))
        self.assertEqual(vertex.MODEL, "openai/gpt-oss-20b-maas", "v1's registered module is not edited")

    def test_a_429_is_retried_once_after_the_wait(self):
        result, calls, sleeps = self.run_with([ConnectionError("Vertex HTTP 429"), payload()], wait=0.7)
        self.assertEqual((calls, sleeps), (2, [0.7]))
        self.assertEqual(result["usage"], {"input_tokens": 10, "output_tokens": 2, "usage_unavailable_calls": 1})

    def test_timeouts_5xx_and_other_failures_are_never_retried(self):
        for error in (TimeoutError("x"), ConnectionError("Vertex HTTP 503"), ConnectionError("Vertex reported a failure"),
                      workers_ai.ConfigurationError("x")):
            result, calls, sleeps = self.run_with([error, payload()], wait=0)
            self.assertIs(result, error)
            self.assertEqual((calls, sleeps), (1, []), repr(error))

    def test_no_retry_when_the_wait_would_pass_the_deadline(self):
        result, calls, sleeps = self.run_with([ConnectionError("Vertex HTTP 429"), payload()], wait=workers_ai.TIMEOUT_S + 1)
        self.assertIsInstance(result, ConnectionError)
        self.assertEqual((calls, sleeps), (1, []))

    def test_at_most_two_calls_whatever_fails(self):
        for outcomes in ([ConnectionError("Vertex HTTP 429"), ConnectionError("Vertex HTTP 429")],
                         [ConnectionError("Vertex HTTP 429"), payload("nope")], [payload("nope"), ConnectionError("Vertex HTTP 429")]):
            _, calls, _ = self.run_with(outcomes + [payload()], wait=0)
            self.assertEqual(calls, 2)

    def test_multi_region_urls_reuse_v1s_checks(self):
        env = {"VERTEX_PROJECT": "factored-hackathon-arabica-ai", "VERTEX_ACCESS_TOKEN": "t"}
        base = "/v1/projects/factored-hackathon-arabica-ai/locations/{}/endpoints/openapi/chat/completions"
        for location, host in (("us", "aiplatform.us.rep.googleapis.com"), ("eu", "aiplatform.eu.rep.googleapis.com"),
                               ("global", "aiplatform.googleapis.com"), ("us-central1", "us-central1-aiplatform.googleapis.com")):
            with mock.patch.dict("os.environ", {**env, "VERTEX_LOCATION": location}, clear=True):
                self.assertEqual(vertex_v2._credentials(), (f"https://{host}" + base.format(location), "t"), location)
                self.assertEqual(os.environ["VERTEX_LOCATION"], location, "the environment is restored")
        with mock.patch.dict("os.environ", {"VERTEX_LOCATION": "us", "VERTEX_ACCESS_TOKEN": "t", "VERTEX_PROJECT": "Bad Id"}, clear=True):
            self.assertRaises(workers_ai.ConfigurationError, vertex_v2._credentials)


if __name__ == "__main__":
    unittest.main()
