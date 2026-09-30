"""Episode KPI scorer regressions: denominators, safety gate, allowlist and event-order validation."""
import unittest
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from evals.intake.episodes import summarize


def ev(name, case_id, ts, language='es', seq=None, **fields):
    return dict(event=name, version='1', case_id=case_id, ts=f'2026-09-29T10:{ts:02d}:00.000Z', seq=ts if seq is None else seq,
                session_ref='s-'+case_id,
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
        self.assertEqual(total['not_assessed'], 1)
        self.assertEqual(total['usage_unknown_episodes'], 1)
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
            'order': [dict(e, seq=4) if e['event'] == 'handoff_created' else
                      dict(e, seq=3) if e['event'] == 'handoff_accepted' else e for e in ACCEPTED],
            'matching handoff_created': [dict(e, case_ref='REF-9') if e['event'] == 'handoff_accepted' else e for e in ACCEPTED],
            'repeats a chain event': ACCEPTED[:4] + [ev('handoff_created', 'a', 4, kind='complete', case_ref='REF-1')]
                                     + [dict(ACCEPTED[4], seq=5), dict(ACCEPTED[5], seq=6)],
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
            'non-empty string reference': [dict(e, case_ref=None) if e['event'] in ('handoff_created', 'handoff_accepted') else e for e in ACCEPTED],
            'case_ref must be a non-empty': [dict(e, case_ref='') if e['event'] == 'handoff_created' else e for e in ACCEPTED],
            'model_version must be': [dict(ev('intake_started', 'z', 0), model_version=3)],
            'tool_status must be': [dict(e, tool_status='crashed') if e['event'] == 'handoff_created' else e for e in ACCEPTED],
            'failed tool cannot back': [dict(e, tool_status='failed') if e['event'] == 'handoff_created' else e for e in ACCEPTED],
            'not a real UTC date': [dict(ev('intake_started', 'z', 0), ts='2026-02-30T25:61:00.000Z')],
            'missing must be a non-empty list': [ev('intake_started', 'z', 0),
                                                 ev('clarification_requested', 'z', 1, missing=['No reconozco este cargo'])],
            'missing must be a non-empty list of': [ev('intake_started', 'z', 0), ev('clarification_requested', 'z', 1, missing='date')],
            'non-empty list of': [ev('intake_started', 'z', 0), ev('clarification_requested', 'z', 1, missing=[])],
            'authored scenario id': [ev('intake_started', 'z', 0, scenario='Cliente Silvia dice: no fui yo')],
            'seq must be': [dict(ev('intake_started', 'z', 0), seq=True)],
            'repeats a seq': [ev('intake_started', 'z', 0), ended('z', 1, 'abandoned', seq=0)],
        }
        for message, log in cases.items():
            with self.subTest(message):
                with self.assertRaisesRegex(ValueError, message):
                    summarize(log)

    def test_seq_orders_events_with_the_same_millisecond_timestamp(self):
        tied = [dict(e, ts='2026-09-29T10:00:00.000Z') for e in ACCEPTED]
        self.assertEqual(summarize(list(reversed(tied)))['all']['safe_accepted'], 1)


class EpisodeCliTests(unittest.TestCase):
    def run_cli(self, content):
        """Exercise the module entry point with a real temporary export."""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'events.jsonl'
            path.write_text(content, encoding='utf-8')
            return subprocess.run([sys.executable, '-m', 'evals.intake.episodes', str(path)],
                                  capture_output=True, text=True)

    def test_cli_reports_accepted_and_pending_episodes(self):
        result = self.run_cli(''.join(json.dumps(e) + '\n' for e in ACCEPTED + PENDING))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout, 'CLI did not produce its JSON summary')
        summary = json.loads(result.stdout)
        self.assertEqual(summary['all']['eligible_started'], 2)
        self.assertEqual(summary['all']['safe_accepted'], 1)
        self.assertEqual(summary['all']['safe_accepted_intake_rate'], 0.5)
        self.assertEqual(summary['pt']['usage_unknown_episodes'], 1)
        self.assertIsNone(summary['pt']['latency_p95_ms'])
        self.assertEqual(result.stderr, '')

    def test_cli_rejects_bad_input_without_echoing_content_or_partial_results(self):
        valid = json.dumps(ACCEPTED[0]) + '\n'
        for bad in ['{"customer_name": "PRIVATE-CONTENT"', '"PRIVATE-CONTENT"',
                    '["PRIVATE-CONTENT"]', '{"event": "PRIVATE-CONTENT"}',
                    json.dumps(dict(ACCEPTED[1], missing=['PRIVATE-CONTENT'])),
                    json.dumps(dict(ACCEPTED[1], event={'private': 'PRIVATE-CONTENT'}))]:
            with self.subTest(bad=bad):
                result = self.run_cli(valid + bad + '\n')
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')
                self.assertIn('line 2', result.stderr)
                self.assertNotIn('PRIVATE-CONTENT', result.stderr)
                self.assertNotIn('Traceback', result.stderr)

    def test_cli_invalid_sequence_produces_no_partial_summary(self):
        events = [ACCEPTED[0], dict(ACCEPTED[1], seq=0)]
        result = self.run_cli(''.join(json.dumps(e) + '\n' for e in events))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertIn('Invalid episode log', result.stderr)
        self.assertNotIn('Traceback', result.stderr)

    def test_cli_empty_input_retains_undefined_rates(self):
        result = self.run_cli('')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout, 'CLI did not produce its JSON summary')
        summary = json.loads(result.stdout)
        self.assertEqual(summary['all']['eligible_started'], 0)
        self.assertIsNone(summary['all']['safe_accepted_intake_rate'])

    def test_cli_missing_input_fails_without_traceback(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, '-m', 'evals.intake.episodes',
                                     str(Path(directory) / 'missing.jsonl')], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertNotIn('Traceback', result.stderr)
        self.assertTrue(result.stderr)


if __name__ == '__main__':
    unittest.main()
