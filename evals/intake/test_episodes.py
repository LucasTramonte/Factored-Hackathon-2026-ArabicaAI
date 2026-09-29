"""Episode KPI scorer regressions: denominators, safety gate, allowlist and event-order validation."""
import unittest
from evals.intake.episodes import summarize


def ev(name, case_id, ts, language='es', **fields):
    return dict(event=name, version='1', case_id=case_id, ts=f'2026-09-29T10:{ts:02d}:00.000Z', session_ref='s-'+case_id,
                language=language, model_version='checklist-0.1', **fields)


def ended(case_id, ts, outcome, safety='assessed_safe', language='es', **usage):
    u = dict(duration_ms=0, llm_calls=0, input_tokens=0, output_tokens=0, tool_calls=0)
    u.update(usage)
    return ev('intake_ended', case_id, ts, language, outcome=outcome, safety=safety, **u)


ACCEPTED = [ev('intake_started', 'a', 0, scenario='V1-01'), ev('clarification_requested', 'a', 1, missing=['date']),
            ev('transaction_confirmed', 'a', 2, transaction_ref='tx-1'),
            ev('handoff_created', 'a', 3, kind='complete', case_ref='REF-1', tool_status='ok'),
            ev('handoff_accepted', 'a', 4, case_ref='REF-1', accepted_by='case_service'),
            ended('a', 5, 'accepted', duration_ms=300000, llm_calls=4, input_tokens=2000, output_tokens=400, tool_calls=2)]
ABANDONED = [ev('intake_started', 'b', 0, language='pt'), ev('clarification_requested', 'b', 1, language='pt', missing=['currency']),
             ended('b', 2, 'abandoned', language='pt', duration_ms=60000, llm_calls=2, input_tokens=900, output_tokens=100)]
TECHNICAL = [ev('intake_started', 'c', 0), ev('transaction_confirmed', 'c', 1, transaction_ref='tx-2'),
             ev('handoff_created', 'c', 2, kind='technical', case_ref='REF-2'),
             ended('c', 3, 'technical_failure', duration_ms=120000, llm_calls=3, input_tokens=1500, output_tokens=300, tool_calls=1)]
UNSAFE = [ev('intake_started', 'd', 0), ev('transaction_confirmed', 'd', 1, transaction_ref='tx-3'),
          ev('handoff_created', 'd', 2, kind='complete', case_ref='REF-3'), ev('handoff_accepted', 'd', 3, case_ref='REF-3', accepted_by='q'),
          ended('d', 4, 'accepted', safety='unsafe', duration_ms=200000, llm_calls=3, input_tokens=1000, output_tokens=200, tool_calls=2)]
PENDING = [ev('intake_started', 'e', 0, language='pt')]


class EpisodeTests(unittest.TestCase):
    def test_primary_kpi_counts_every_eligible_start_once(self):
        s = summarize(ACCEPTED + ABANDONED + TECHNICAL + UNSAFE + PENDING)
        total = s['all']
        self.assertEqual(total['eligible_started'], 5)
        self.assertEqual(total['safe_accepted'], 1)
        self.assertEqual(total['safe_accepted_intake_rate'], 0.2)
        self.assertEqual(total['unsafe'], 1)
        self.assertEqual(total['not_assessed'], 0)
        self.assertEqual(total['outcomes'], dict(accepted=2, abandoned=1, technical_failure=1, pending=1))
        self.assertEqual(total['clarifications_per_episode'], 0.4)
        self.assertEqual((total['llm_calls'], total['input_tokens'], total['output_tokens'], total['tool_calls']), (12, 5400, 1000, 5))
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
        cases = {
            'full chain': [e for e in ACCEPTED if e['event'] != 'handoff_accepted'],
            'transaction_confirmed': [e for e in ACCEPTED if e['event'] != 'transaction_confirmed'],
            'order': [dict(e, ts='2026-09-29T10:02:30.000Z') if e['event'] == 'handoff_accepted' else e for e in ACCEPTED],
            'matching handoff_created': [dict(e, case_ref='REF-9') if e['event'] == 'handoff_accepted' else e for e in ACCEPTED],
            'repeats a chain event': ACCEPTED + [ev('handoff_created', 'a', 3, kind='complete', case_ref='REF-1')],
            'kind must be': [dict(e, kind='Complete') if e['event'] == 'handoff_created' else e for e in ACCEPTED],
        }
        for message, log in cases.items():
            with self.subTest(message):
                with self.assertRaisesRegex(ValueError, message):
                    summarize(log)
        not_assessed = [dict(e, safety='not_assessed') if e['event'] == 'intake_ended' else e for e in ACCEPTED]
        self.assertEqual((summarize(not_assessed)['all']['safe_accepted'], summarize(not_assessed)['all']['not_assessed']), (0, 1))

    def test_log_validation_fails_closed(self):
        cases = {
            'exactly one intake_started': ACCEPTED + [ev('intake_started', 'a', 9)],
            'Unknown event': [ev('intake_started', 'z', 0), ev('refund_issued', 'z', 1)],
            'version': [dict(ev('intake_started', 'z', 0), version='2')],
            'language': [ev('intake_started', 'z', 0, language='en')],
            'mixes languages': [ev('intake_started', 'z', 0), ended('z', 1, 'abandoned', language='pt')],
            'needs exactly one intake_started': [ended('z', 0, 'abandoned')],
            'outside the contract': [ev('intake_started', 'z', 0, customer_id='CLI-1')],
            'customer content': [ev('intake_started', 'z', 0, customer_name='Silvia')],
            'missing fields': [dict((k, v) for k, v in ev('intake_started', 'z', 0).items() if k != 'session_ref')],
            'missing fields:': [ev('handoff_created', 'z', 1, kind='complete')],
            'non-negative integer usage': [ev('intake_started', 'z', 0), ended('z', 1, 'abandoned', llm_calls=-1)],
            'known outcome': [ev('intake_started', 'z', 0), ended('z', 1, 'resolved')],
            'at most one intake_ended': [ev('intake_started', 'z', 0), ended('z', 1, 'abandoned'), ended('z', 2, 'abandoned')],
            'intake_ended, last': [ev('intake_started', 'z', 0), ended('z', 1, 'abandoned'), ev('clarification_requested', 'z', 2, missing=['date'])],
            'ts must be': [dict(ev('intake_started', 'z', 0), ts='2026-09-29T10:00:00Z')],
            'ts must be millisecond': [dict(ev('intake_started', 'z', 0), ts='2026-09-29T10:00:00.000+02:00')],
        }
        for message, log in cases.items():
            with self.subTest(message):
                with self.assertRaisesRegex(ValueError, message):
                    summarize(log)


if __name__ == '__main__':
    unittest.main()
