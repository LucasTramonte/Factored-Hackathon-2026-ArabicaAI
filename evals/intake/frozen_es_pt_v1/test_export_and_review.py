"""Export mapping and the Spanish reply parser, on synthetic data only (no withheld files)."""
import json
import tempfile
import unittest
from pathlib import Path

import continue_review as cr
from export_frozen import ACTION_NAMES, build_corpus, runner_language, to_runner_gold


class ExportTests(unittest.TestCase):
    def test_every_code_maps_to_a_runner_action_and_only_h_is_completion_ready(self):
        self.assertEqual(set(ACTION_NAMES.values()),
                         {'authenticate', 'technical_handoff', 'route', 'complete_handoff', 'confirm', 'clarify'})
        for code, name in ACTION_NAMES.items():
            gold = to_runner_gold({'action': code, 'candidate_ids': ['X2', 'X1'] if code == 'C' else []})
            self.assertEqual(gold['action'], name)
            self.assertEqual(gold['completion_ready'], code == 'H')
        self.assertEqual(to_runner_gold({'action': 'C', 'candidate_ids': ['X2', 'X1']})['candidate_ids'], ['X1', 'X2'])
        with self.assertRaises(ValueError):
            to_runner_gold({'action': 'Z', 'candidate_ids': []})

    def test_languages_are_normalised_for_the_runner(self):
        self.assertEqual(runner_language('es', 'pt', 'single_clear_match'), 'es')
        self.assertEqual(runner_language('es-pt', 'pt', 'mixed_language'), 'pt')
        self.assertEqual(runner_language('fr', 'pt', 'unsupported_language'), 'other')
        self.assertEqual(runner_language('en', 'es', 'unsupported_language'), 'en')
        with self.assertRaises(ValueError):
            runner_language('fr', 'pt', 'single_clear_match')

    def test_corpus_runs_through_the_real_runner(self):
        from evals.intake.run import evaluate
        tx = dict(transaction_id='X1', customer_id='C1', transaction_date='2026-02-26T10:00:00', amount='10.00',
                  currency='USD', merchant_name='Uber', merchant_category='Transport', product_type='Tarjeta Crédito',
                  last4='1111', transaction_country='México')
        spec = dict(situation_id='s1', family='mixed_language', customer_id='C1', authenticated=True, confirmed_id=None,
                    tool_failure=False, as_of='2026-02-27T09:00:00')
        customer = dict(customer_id='C1', country='México', segment='Basic',
                        cards=[dict(product_type='Tarjeta Crédito', last4='1111', currency='USD')])
        draft = dict(fixture=dict(transactions=[tx], customers=[customer]), specs=[spec], cases=[
            dict(case_id='c1', situation_id='s1', language='es-pt', session_language='pt', message='no reconheço un uber',
                 construction_gold=dict(action='C', candidate_ids=[], completion_ready=False))])
        corpus = build_corpus(draft)
        self.assertEqual(corpus['cases'][0]['gold']['action'], 'clarify')
        self.assertEqual(corpus['cases'][0]['message_language'], 'es-pt')
        self.assertEqual(corpus['cases'][0]['segment'], 'Basic')
        self.assertEqual(corpus['customers'][0]['country'], 'México')
        rows = [r for r in evaluate(corpus)['summary'] if r['split'] == 'frozen_es_pt_v1' and r['language'] == 'pt']
        self.assertTrue(all(r['cases'] == 1 for r in rows))


class SpanishReplyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / 'reviews').mkdir()
        options = [dict(number=1, action='F', candidate_ids=['X1']), dict(number=2, action='C', candidate_ids=[])]
        (root / 'queues.json').write_text(json.dumps({'es': [dict(case_id='c1', queue='flagged', options=options),
                                                             dict(case_id='c2', queue='audit', options=options)]}))
        self.old, cr.HERE = cr.HERE, root
        self.root = root

    def tearDown(self):
        cr.HERE = self.old
        self.tmp.cleanup()

    def test_duplicates_zero_and_out_of_range_are_rejected_without_writing(self):
        for reply in ('1a 1b 2a', '0a 1a 2a', '1a 2a 3a', '1a 2c', '1a', '1a 1i 2b', '1a; 2b', '1a 2b ok', '1 a 2b'):
            with self.assertRaises(SystemExit, msg=reply):
                cr.roberto_answers(reply)
        self.assertFalse((self.root / 'reviews' / 'roberto.jsonl').exists())

    def test_a_complete_reply_is_recorded_once_per_case(self):
        cr.roberto_answers('1a, 2b')
        rows = [json.loads(l) for l in (self.root / 'reviews' / 'roberto.jsonl').read_text().splitlines()]
        self.assertEqual([(r['case_id'], r['chosen_code']) for r in rows], [('c1', 'F'), ('c2', 'C')])
        with self.assertRaises(SystemExit):  # a second paste must not duplicate the review
            cr.roberto_answers('1a 2b')
        self.assertEqual(len((self.root / 'reviews' / 'roberto.jsonl').read_text().splitlines()), 2)


class AnswerRecordingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / 'reviews').mkdir()
        options = [dict(number=1, action='F', candidate_ids=['X1']), dict(number=2, action='C', candidate_ids=[])]
        (root / 'queues.json').write_text(json.dumps({'pt': [dict(case_id='c1', queue='audit', options=options),
                                                             dict(case_id='c2', queue='audit', options=options)]}))
        self.state = root / 'state.json'
        self.state.write_text(json.dumps(dict(language='pt', reviewer='r', current_index=0)))
        self.old = cr.HERE, cr.STATE_FILE
        cr.HERE, cr.STATE_FILE = root, self.state
        self.log = root / 'reviews' / 'r.jsonl'

    def tearDown(self):
        cr.HERE, cr.STATE_FILE = self.old
        self.tmp.cleanup()

    def test_a_finished_queue_refuses_new_answers_without_writing(self):
        cr.answer(cr.load_state(), '1', '')
        cr.answer(cr.load_state(), '2', '')
        with self.assertRaises(SystemExit):
            cr.answer(cr.load_state(), '1', '')
        self.assertEqual(len(self.log.read_text().splitlines()), 2)

    def test_a_crash_between_append_and_state_update_is_not_recorded_twice(self):
        cr.answer(cr.load_state(), '1', '')
        self.state.write_text(json.dumps(dict(language='pt', reviewer='r', current_index=0)))  # state lost the advance
        cr.answer(cr.load_state(), '2', '')
        rows = [json.loads(l) for l in self.log.read_text().splitlines()]
        self.assertEqual([r['case_id'] for r in rows], ['c1'])
        self.assertEqual(cr.load_state()['current_index'], 1)
        self.assertFalse(any(p.name.endswith('.tmp') for p in self.state.parent.iterdir()))


if __name__ == '__main__':
    unittest.main()
