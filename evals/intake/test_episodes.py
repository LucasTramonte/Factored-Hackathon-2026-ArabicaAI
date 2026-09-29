"""Episode KPI scorer regressions: denominators, safety gate and event-order validation."""
import unittest
from evals.intake.episodes import summarize


def ev(name, case_id, ts, language='es', **fields):
    return dict(event=name, version='1', case_id=case_id, ts=f'2026-09-29T10:{ts:02d}:00Z', session_ref='s-'+case_id,
                language=language, model_version='checklist-0.1', **fields)


ACCEPTED = [ev('intake_started', 'a', 0), ev('clarification_requested', 'a', 1, missing=['date']),
            ev('transaction_confirmed', 'a', 2, transaction_ref='tx-1'),
            ev('handoff_created', 'a', 3, kind='complete', case_ref='REF-1'),
            ev('handoff_accepted', 'a', 4, case_ref='REF-1'),
            ev('intake_ended', 'a', 5, outcome='accepted', safety='assessed_safe', duration_ms=300000, llm_calls=4,
               input_tokens=2000, output_tokens=400, tool_calls=2)]
ABANDONED = [ev('intake_started', 'b', 0, language='pt'), ev('clarification_requested', 'b', 1, language='pt', missing=['currency']),
             ev('intake_ended', 'b', 2, language='pt', outcome='abandoned', safety='assessed_safe', duration_ms=60000, llm_calls=2,
                input_tokens=900, output_tokens=100, tool_calls=0)]
TECHNICAL = [ev('intake_started', 'c', 0), ev('transaction_confirmed', 'c', 1, transaction_ref='tx-2'),
             ev('handoff_created', 'c', 2, kind='technical', case_ref='REF-2'),
             ev('intake_ended', 'c', 3, outcome='technical_failure', safety='assessed_safe', duration_ms=120000, llm_calls=3,
                input_tokens=1500, output_tokens=300, tool_calls=1)]
UNSAFE = [ev('intake_started', 'd', 0), ev('transaction_confirmed', 'd', 1, transaction_ref='tx-3'),
          ev('handoff_created', 'd', 2, kind='complete', case_ref='REF-3'), ev('handoff_accepted', 'd', 3, case_ref='REF-3'),
          ev('intake_ended', 'd', 4, outcome='accepted', safety='unsafe', duration_ms=200000, llm_calls=3,
             input_tokens=1000, output_tokens=200, tool_calls=2)]
PENDING = [ev('intake_started', 'e', 0, language='pt')]


class EpisodeTests(unittest.TestCase):
    def test_primary_kpi_counts_every_eligible_start_once(self):
        s = summarize(ACCEPTED + ABANDONED + TECHNICAL + UNSAFE + PENDING)
        total = s['all']
        self.assertEqual(total['eligible_started'], 5)
        self.assertEqual(total['safe_accepted'], 1)
        self.assertEqual(total['safe_accepted_intake_rate'], 0.2)
        self.assertEqual(total['unsafe'], 1)
        self.assertEqual(total['outcomes'], dict(accepted=2, abandoned=1, technical_failure=1, pending=1))
        self.assertEqual(total['clarifications_per_episode'], 0.4)
        self.assertEqual(total['llm_calls'], 12)
        self.assertEqual(total['input_tokens'], 5400)
        self.assertEqual(total['output_tokens'], 1000)
        self.assertEqual(total['latency_p50_ms'], 160000)
        self.assertEqual(total['latency_p95_ms'], 300000)
        self.assertIsNone(total['operating_cost'])
        self.assertEqual(s['pt']['eligible_started'], 2)
        self.assertEqual(s['pt']['safe_accepted'], 0)
        self.assertEqual(s['pt']['outcomes'], dict(abandoned=1, pending=1))
        self.assertEqual(s['es']['safe_accepted_intake_rate'], 1/3)

    def test_empty_log_keeps_rates_undefined(self):
        s = summarize([])
        self.assertEqual(s['all']['eligible_started'], 0)
        self.assertIsNone(s['all']['safe_accepted_intake_rate'])
        self.assertIsNone(s['all']['latency_p50_ms'])

    def test_acceptance_requires_the_full_chain_in_order(self):
        missing_receipt = [e for e in ACCEPTED if e['event'] != 'handoff_accepted']
        self.assertEqual(summarize(missing_receipt)['all']['safe_accepted'], 0)
        no_confirmation = [e for e in ACCEPTED if e['event'] != 'transaction_confirmed']
        with self.assertRaisesRegex(ValueError, 'transaction_confirmed'):
            summarize(no_confirmation)
        out_of_order = [dict(e, ts='2026-09-29T10:02:30Z') if e['event'] == 'handoff_accepted' else e for e in ACCEPTED]
        with self.assertRaisesRegex(ValueError, 'order'):
            summarize(out_of_order)

    def test_log_validation_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'intake_started'):
            summarize(ACCEPTED + [ev('intake_started', 'a', 9)])
        with self.assertRaisesRegex(ValueError, 'Unknown event'):
            summarize([ev('intake_started', 'z', 0), ev('refund_issued', 'z', 1)])
        with self.assertRaisesRegex(ValueError, 'version'):
            summarize([dict(ev('intake_started', 'z', 0), version='2')])
        with self.assertRaisesRegex(ValueError, 'language'):
            summarize([ev('intake_started', 'z', 0, language='en')])
        with self.assertRaisesRegex(ValueError, 'intake_started'):
            summarize([ev('intake_ended', 'z', 0, outcome='abandoned', safety='assessed_safe', duration_ms=1, llm_calls=0,
                          input_tokens=0, output_tokens=0, tool_calls=0)])
        with self.assertRaisesRegex(ValueError, 'customer'):
            summarize([dict(ev('intake_started', 'z', 0), customer_id='CLI-1')])


if __name__ == '__main__':
    unittest.main()
