"""The Worker's parity fixtures are exactly what the evaluated Python produces today (Docs/Plans/ai-suggestion-plan.md)."""
import json
import unittest

from evals.intake import online_parity


class OnlineParityFixtureTests(unittest.TestCase):
    def test_committed_fixtures_match_a_fresh_build(self):
        text = json.dumps(online_parity.build(), ensure_ascii=False, indent=1) + "\n"
        self.assertEqual(online_parity.OUTPUT.read_text(encoding="utf-8"), text,
                         "stale: run python -m evals.intake.online_parity and commit back-end/test/fixtures/ai-parity.json")

    def test_inputs_come_from_the_development_split_only(self):
        cases, _, _ = online_parity._dev_cases()
        self.assertEqual({c["split"] for c in cases}, {"development"})
        fixture = json.loads(online_parity.OUTPUT.read_text(encoding="utf-8"))
        allowed = {c["message"] for c in cases} | {m for m, _, _ in online_parity.SYNTHETIC_MESSAGES}
        self.assertEqual({b["message"] for b in fixture["bodies"]} - allowed, set())


if __name__ == "__main__":
    unittest.main()
