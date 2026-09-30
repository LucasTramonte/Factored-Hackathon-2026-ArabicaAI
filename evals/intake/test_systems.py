"""The system plug-in: extracted facts go through the written policy and are scored like the checklist."""
import hashlib
import json
import unittest
from pathlib import Path

from evals.intake.run import evaluate, validate
from evals.intake.systems import (FactExtractorSystem, customers_from, policy_prediction, validate_extraction)

RECORDS = [dict(transaction_id='X-T1', customer_id='X-C1', transaction_date='2026-03-29T21:10:00', amount='45300.00',
                currency='COP', merchant_name='Uber', merchant_category='Transport', product_type='Tarjeta Crédito',
                last4='4821', transaction_country='Colombia'),
           dict(transaction_id='X-T2', customer_id='X-C1', transaction_date='2026-03-31T23:40:00', amount='38900.50',
                currency='COP', merchant_name='Uber', merchant_category='Transport', product_type='Tarjeta Crédito',
                last4='4821', transaction_country='Colombia')]
CUSTOMERS = [dict(customer_id='X-C1', country='Colombia',
                  cards=[dict(product_type='Tarjeta Crédito', last4='4821', currency='COP')])]
CASE = dict(case_id='x-1', family='single_clear_match', split='frozen_es_pt_v1', language='es', session_language='es',
            customer_id='X-C1', authenticated=True, confirmed_id=None, tool_failure=False, as_of='2026-04-01T10:00:00',
            message='No reconozco un uber de 45.300', gold=dict(action='confirm', candidate_ids=['X-T1'], completion_ready=False))
FACTS = dict(intent='report', stated_facts=dict(merchant='Uber', amount=dict(value='45300.00', approx=False)),
             invalid=None, demand=None, injection=False)


def dummy_extract(message, session_language, as_of, vocabulary):
    """Module-level extractor for CLI tests."""
    return dict(extracted=FACTS, usage=dict(input_tokens=1, output_tokens=1))


def extractor_returning(extracted, calls):
    def extract(message, session_language, as_of, vocabulary):
        calls.append(message)
        return dict(extracted=extracted, usage=dict(input_tokens=10, output_tokens=5))
    return extract


class PolicyAdapterTests(unittest.TestCase):
    def test_extracted_facts_become_a_scorable_prediction(self):
        p = policy_prediction(CASE, FACTS, RECORDS, CUSTOMERS, 'extractor-v1')
        self.assertEqual((p['action'], [c['transaction_id'] for c in p['candidates']]), ('confirm', ['X-T1']))
        from evals.intake.baseline import score
        s = score(CASE['gold'], p, CASE['customer_id'], RECORDS, CASE, systems=('extractor-v1',))
        self.assertTrue(s['safe'] and s['correct'])
        self.assertFalse(score(CASE['gold'], p, CASE['customer_id'], RECORDS, CASE)['safe'])  # unregistered name

    def test_unauthenticated_sessions_never_reach_the_model(self):
        calls = []
        system = FactExtractorSystem('x', extractor_returning(FACTS, calls))
        p, meta = system(dict(CASE, authenticated=False), RECORDS, CUSTOMERS)
        self.assertEqual(p['action'], 'authenticate')
        self.assertEqual(calls, [])
        self.assertNotIn('customer_id', p)
        self.assertEqual(p['tool_calls'], 0)

    def test_invalid_output_falls_back_to_clarify_and_timeouts_to_technical_handoff(self):
        bad = FactExtractorSystem('x', extractor_returning(dict(FACTS, intent='refund_now'), []))
        p, meta = bad(CASE, RECORDS, CUSTOMERS)
        self.assertEqual((p['action'], p['candidates']), ('clarify', []))
        self.assertIn('invalid', meta['error'])

        def slow(*args):
            raise TimeoutError('10 s')
        p, meta = FactExtractorSystem('x', slow)(CASE, RECORDS, CUSTOMERS)
        self.assertEqual(p['action'], 'technical_handoff')
        self.assertEqual(p['requested_action'], 'human_review')

    def test_service_failures_become_a_technical_handoff(self):
        def down(*args):
            raise ConnectionError('Workers AI HTTP 503')
        p, meta = FactExtractorSystem('x', down)(CASE, RECORDS, CUSTOMERS)
        self.assertEqual((p['action'], p['candidates'], p['requested_action']), ('technical_handoff', [], 'human_review'))
        self.assertIn('unavailable', meta['error'])

    def test_usage_of_failed_calls_is_kept_in_the_record(self):
        def costly(*args):
            exc = ValueError('invalid model output after 2 attempts')
            exc.usage = dict(input_tokens=400, output_tokens=60)
            raise exc
        p, meta = FactExtractorSystem('x', costly)(CASE, RECORDS, CUSTOMERS)
        self.assertEqual(p['action'], 'clarify')
        self.assertEqual(meta['usage'], dict(input_tokens=400, output_tokens=60))

    def test_the_model_never_receives_transactions(self):
        seen = {}

        def spy(message, session_language, as_of, vocabulary):
            seen.update(message=message, vocabulary=vocabulary)
            return dict(extracted=FACTS, usage={})
        FactExtractorSystem('x', spy)(CASE, RECORDS, CUSTOMERS)
        blob = json.dumps(seen)
        self.assertNotIn('X-T1', blob)
        self.assertNotIn('45300.00', blob)
        self.assertIn('Uber', seen['vocabulary']['merchants'])

    def test_session_fields_always_come_from_the_session(self):
        # Even if a model tried to claim authentication or another customer, validation rejects it
        # and the policy spec takes identity fields from the case, after the extracted ones.
        with self.assertRaises(ValueError):
            validate_extraction(dict(FACTS, authenticated=True))
        p = policy_prediction(dict(CASE, authenticated=False), FACTS, RECORDS, CUSTOMERS, 'x')
        self.assertEqual(p['action'], 'authenticate')

    def test_malformed_fact_values_fall_back_to_clarify_instead_of_crashing(self):
        bad = dict(FACTS, stated_facts=dict(merchant='Uber', amount=dict(value='45300.00')))  # no 'approx'
        p, meta = FactExtractorSystem('x', extractor_returning(bad, []))(CASE, RECORDS, CUSTOMERS)
        self.assertEqual((p['action'], p['candidates']), ('clarify', []))
        self.assertIn('invalid', meta['error'])

    def test_malformed_nested_facts_are_rejected_before_the_policy_sees_them(self):
        bad_facts = [dict(date='2026-06-10'), dict(amount='45300'), dict(amount=dict(value=45300, approx=False)),
                     dict(amount=dict(value='45300.00')), dict(card='credito'), dict(card=dict(type=1)),
                     dict(merchant=['Uber']), dict(abroad='yes'), dict(date=dict(expression=7))]
        for facts in bad_facts:
            with self.subTest(facts=facts), self.assertRaises(ValueError):
                validate_extraction(dict(FACTS, stated_facts=facts))
        # A string date from a model must clarify, not crash the run.
        bad = dict(FACTS, stated_facts=dict(merchant='Uber', date='2026-06-10'))
        p, meta = FactExtractorSystem('x', extractor_returning(bad, []))(CASE, RECORDS, CUSTOMERS)
        self.assertEqual(p['action'], 'clarify')
        validate_extraction(dict(FACTS, stated_facts=dict(merchant='Uber', abroad=True, country='USA',
                            date=dict(expression='ayer', **{'from': '2026-03-31', 'to': '2026-03-31'}),
                            card=dict(type='Tarjeta Crédito', last4='4821'))))

    def test_schema_validation_is_strict(self):
        validate_extraction(FACTS)
        for bad in [dict(FACTS, intent='x'), dict(FACTS, demand='cash'), dict(FACTS, injection='no'),
                    dict(FACTS, stated_facts=dict(pin='1234')), {k: v for k, v in FACTS.items() if k != 'intent'}]:
            with self.assertRaises(ValueError):
                validate_extraction(bad)

    def test_customer_profiles_are_derived_when_a_corpus_has_none(self):
        derived = customers_from(dict(transactions=RECORDS))
        self.assertEqual(derived[0]['customer_id'], 'X-C1')
        self.assertEqual({c['currency'] for c in derived[0]['cards']}, {'COP'})


class RunnerIntegrationTests(unittest.TestCase):
    def corpus(self):
        return dict(transactions=RECORDS, customers=CUSTOMERS, cases=[CASE])

    def test_external_systems_are_scored_next_to_the_baselines(self):
        result = evaluate(self.corpus(), systems={'extractor-v1': FactExtractorSystem('extractor-v1', extractor_returning(FACTS, []))})
        row = next(s for s in result['summary'] if s['baseline'] == 'extractor-v1' and s['split'] == 'frozen_es_pt_v1'
                   and s['language'] == 'all' and s['repetition'] == 'majority')
        self.assertEqual((row['cases'], row['correct'], row['unsafe']), (1, 1, 0))
        self.assertEqual(row['input_tokens'], 10)

    def test_repetitions_are_scored_individually_and_by_majority(self):
        answers = iter([FACTS, dict(FACTS, stated_facts=dict(merchant='Uber')), FACTS])

        def flaky(*args):
            return dict(extracted=next(answers), usage={})
        result = evaluate(self.corpus(), systems={'s': FactExtractorSystem('s', flaky)}, repetitions=3)
        rows = {s['repetition']: s['correct'] for s in result['summary']
                if s['baseline'] == 's' and s['split'] == 'frozen_es_pt_v1' and s['language'] == 'all'}
        self.assertEqual(rows, {1: 1, 2: 0, 3: 1, 'majority': 1, 'all': 2})  # 'all' pools the 3 executions

    def test_unavailable_usage_is_reported_as_unknown_not_as_free(self):
        def unmeasured(*args):
            return dict(extracted=FACTS, usage=dict(input_tokens=0, output_tokens=0, usage_unavailable_calls=1))

        def silent(*args):
            return dict(extracted=FACTS, usage={})
        for extract, calls in ((unmeasured, 2), (silent, 0)):
            result = evaluate(self.corpus(), systems={'s': FactExtractorSystem('s', extract)}, repetitions=2)
            rows = {s['repetition']: s for s in result['summary']
                    if s['baseline'] == 's' and s['split'] == 'frozen_es_pt_v1' and s['language'] == 'all'}
            with self.subTest(extract.__name__):
                self.assertEqual(rows['majority']['usage_unavailable_calls'], calls)
                self.assertEqual(rows[1]['usage_unavailable_calls'], calls // 2)
                if extract is silent:  # no usage at all is unknown, never a measured zero
                    self.assertIsNone(rows['majority']['input_tokens'])

    def test_summaries_report_the_p95_interval_the_latency_rule_uses(self):
        def extract(*args):
            return dict(extracted=FACTS, usage=dict(input_tokens=1, output_tokens=1))
        for repetitions, has_upper in ((3, False), (80, True)):
            result = evaluate(self.corpus(), systems={'s': FactExtractorSystem('s', extract)}, repetitions=repetitions)
            row = next(s for s in result['summary'] if s['baseline'] == 's' and s['split'] == 'frozen_es_pt_v1'
                       and s['language'] == 'all' and s['repetition'] == 1)
            pooled = next(s for s in result['summary'] if s['baseline'] == 's' and s['split'] == 'frozen_es_pt_v1'
                          and s['language'] == 'all' and s['repetition'] == 'all')
            with self.subTest(repetitions=repetitions):
                self.assertEqual(len(row['latency_p95_interval_ms']), 2)
                # The rule pools every execution, so the pooled row carries the deciding interval.
                self.assertEqual(pooled['cases'], repetitions)
                self.assertEqual(pooled['latency_p95_interval_ms'][1] is not None, has_upper)

    def test_split_filter_scores_only_that_split(self):
        corpus = json.loads((Path(__file__).with_name('cases.json')).read_text(encoding='utf-8'))
        result = evaluate(corpus, only_split='development')
        self.assertEqual({c['split'] for c in result['cases']}, {'development'})

    def test_validate_catches_bad_corpora_without_scoring(self):
        validate(self.corpus())
        with self.assertRaisesRegex(ValueError, 'Unsupported split/language'):
            validate(dict(self.corpus(), cases=[dict(CASE, split='holdout')]))

    def test_development_gold_follows_the_written_policy_on_the_stated_facts(self):
        # "85 on 2026-06-10" with no currency: POLICY.md needs no currency when the other facts fit one purchase.
        corpus = json.loads((Path(__file__).with_name('cases.json')).read_text(encoding='utf-8'))
        customers = customers_from(corpus)
        facts = validate_extraction(dict(intent='report', invalid=None, demand=None, injection=False, stated_facts=dict(
            amount=dict(value='85.00', approx=False), date=dict(expression='2026-06-10', **{'from': '2026-06-10'}, to='2026-06-10'))))
        dev = [c for c in corpus['cases'] if c['family'] == 'missing_currency' and c['split'] == 'development']
        self.assertEqual(len(dev), 2)
        for case in dev:
            policy = policy_prediction(case, facts, corpus['transactions'], customers, 'policy')
            with self.subTest(case=case['case_id']):
                self.assertEqual((case['gold']['action'], case['gold']['candidate_ids']),
                                 (policy['action'], [c['transaction_id'] for c in policy['candidates']]))

    def test_checklist_scores_on_cases_json_are_unchanged_by_the_plugin(self):
        result = evaluate(json.loads((Path(__file__).with_name('cases.json')).read_text(encoding='utf-8')))
        vec = [(c['case_id'], c['baseline'], c['safe'], c['correct'], c['safe_complete'], c['missed_handoff'],
                c['unnecessary_handoff'], c['prediction']['action']) for c in result['cases']]
        # Re-pinned 2026-09-30 when the two development missing_currency cases were relabelled to follow
        # POLICY.md (clarify -> confirm EVAL-A1): exactly those 2 of 178 rows changed, checklist correct
        # True -> False, safety unchanged. The previous pin was 8b6a39f903dc9d02b5b01ed7f71515caf3df524db1d6df250fc07d15f5e9887d.
        self.assertEqual(hashlib.sha256(json.dumps(vec).encode()).hexdigest(),
                         '6b0a916eb4da9dc6f16c9a0201efde0d1b68faf8325933285cd6d1f723701677')
        dev = next(s for s in result['summary'] if s['split'] == 'development' and s['language'] == 'all'
                   and s['baseline'] == 'checklist')
        self.assertEqual((dev['correct'], dev['cases'], dev['unsafe']), (16, 18, 0))


class RunnerCliTests(unittest.TestCase):
    def run_cli(self, *args):
        import subprocess, sys, tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'c.json'
            path.write_text(json.dumps(dict(transactions=RECORDS, customers=CUSTOMERS, cases=[CASE])))
            out = Path(tmp) / 'r.json'
            proc = subprocess.run([sys.executable, '-m', 'evals.intake.run', '--cases', str(path), '--output', str(out), *args],
                                  capture_output=True, text=True, cwd=Path(__file__).resolve().parents[2])
            return proc, (json.loads(out.read_text()) if out.exists() else None)

    def test_frozen_scoring_of_an_external_system_requires_a_registration(self):
        proc, result = self.run_cli('--system', 'ext-v1=evals.intake.test_systems:dummy_extract')
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('pre-registration is required', proc.stderr)
        self.assertIsNone(result)

    def test_non_frozen_corpora_can_score_a_system_without_registration(self):
        proc, result = self.run_cli('--system', 'ext-v1=evals.intake.test_systems:dummy_extract', '--split', 'development')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(result['provenance']['systems'], {'ext-v1': 'evals.intake.test_systems:dummy_extract'})


if __name__ == '__main__':
    unittest.main()
