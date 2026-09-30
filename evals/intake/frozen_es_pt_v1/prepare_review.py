"""Compare independent verification and persist deterministic blind review queues."""
from copy import deepcopy
from decimal import Decimal
import json
from pathlib import Path
import random

ROOT = Path(__file__).resolve().parent
SEED = 20260929


def save(name, value):
    """Persist review metadata without modifying frozen inputs or construction gold."""
    (ROOT / name).write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n', encoding='utf-8')


def normalized_facts(facts):
    """Normalize bilingual date phrases and decimal formatting, preserving constraints."""
    facts = deepcopy(facts)
    date = facts.get('date')
    if date:
        aliases = {'ontem': 'ayer', 'yesterday': 'ayer', 'hoje': 'hoy', 'today': 'hoy',
                   'sexta passada': 'el viernes pasado', 'semana passada': 'la semana pasada'}
        date['expression'] = aliases.get(date.get('expression'), date.get('expression'))
    if facts.get('amount'):
        facts['amount']['value'] = format(Decimal(facts['amount']['value']), '.2f')
    return facts


def demands(value):
    """Treat a single demand string as one demand, never infer omitted demands."""
    return sorted(value if isinstance(value, list) else [value] if value else [])


def compare(case, spec, verifier):
    """Identify answer, semantic fact and ambiguity differences without relabeling."""
    expected = normalized_facts(spec['stated_facts'])
    actual = normalized_facts(verifier['extracted_facts'])
    differences = []
    for key in sorted(set(expected) | set(actual)):
        if expected.get(key) != actual.get(key):
            differences.append({'field': 'stated_facts.' + key, 'construction': expected.get(key), 'verifier': actual.get(key)})
    for key, left, right in [
        ('intent', spec['intent'], verifier['intent']),
        ('invalid', bool(spec['invalid']), bool(verifier['invalid'])),
        ('demand', demands(spec['demand']), demands(verifier['demand'])),
        ('injection_present', bool(spec['injection']), bool(verifier['injection'])),
    ]:
        if left != right:
            differences.append({'field': key, 'construction': left, 'verifier': right})
    gold = case['construction_gold']
    agrees = gold['action'] == verifier['action'] and sorted(gold['candidate_ids']) == sorted(verifier['candidate_ids'])
    ambiguous = bool(case['ambiguous_reading'] or verifier.get('ambiguous_reading', False))
    return {'case_id': case['case_id'], 'session_language': case['session_language'],
            'answer_agrees': agrees, 'facts_agree': not differences, 'fact_differences': differences,
            'ambiguous_reading': ambiguous, 'flagged': not agrees or bool(differences) or ambiguous}


def options(case, spec, verifier, purchases, rng):
    """Mix distinct substantive answers with plausible alternatives; unknown is last."""
    chosen = []
    def add(action, ids=()):
        item = {'action': action, 'candidate_ids': sorted(ids)}
        if item not in chosen:
            chosen.append(item)
    add(case['construction_gold']['action'], case['construction_gold']['candidate_ids'])
    add(verifier['action'], verifier['candidate_ids'])
    merchant = spec['stated_facts'].get('merchant')
    relevant = [t for t in purchases if merchant and t['merchant_name'] == merchant]
    target = (sorted(relevant or purchases, key=lambda t: t['transaction_date'])[-1])['transaction_id']
    if spec['confirmed_id']:
        pool = [('H', [spec['confirmed_id']]), ('F', [spec['confirmed_id']]), ('C', []), ('A', []), ('T', []), ('R', [])]
    elif spec['tool_failure']:
        pool = [('F', [target]), ('C', []), ('A', []), ('T', []), ('R', [])]
    elif case['construction_gold']['candidate_ids']:
        ids = case['construction_gold']['candidate_ids']
        pool = [('H', [ids[0]]), ('F', [ids[0]]), ('C', []), ('R', []), ('A', [])]
    else:
        pool = [('F', [target]), ('R', []), ('A', []), ('C', []), ('T', [])]
    for action, ids in pool:
        if len(chosen) == 4:
            break
        add(action, ids)
    rng.shuffle(chosen)
    chosen.append({'action': 'UNKNOWN', 'candidate_ids': []})
    return [dict(number=i, **o) for i, o in enumerate(chosen, 1)]


def main():
    """Validate verifier coverage, compare every case and sample disjoint review queues."""
    if (ROOT / 'queues.json').exists():
        raise SystemExit('queues.json already exists; preserve the established sample and review state.')
    draft = json.loads((ROOT / 'draft.json').read_text(encoding='utf-8'))
    outputs = [json.loads(s) for s in (ROOT / 'verifier_output.jsonl').read_text(encoding='utf-8').splitlines() if s.strip()]
    cases = {c['case_id']: c for c in draft['cases']}
    verifier = {v['case_id']: v for v in outputs}
    assert len(outputs) == len(verifier) == len(cases) == 60
    assert set(verifier) == set(cases)
    specs = {s['situation_id']: s for s in draft['specs']}
    comparison = []
    for cid in sorted(cases):
        v = verifier[cid]
        assert v['action'] in ('A', 'T', 'R', 'H', 'F', 'C')
        assert len(v['candidate_ids']) == len(set(v['candidate_ids']))
        assert set(v['extracted_facts']) == set(specs[cases[cid]['situation_id']]['stated_facts'])
        comparison.append(compare(cases[cid], specs[cases[cid]['situation_id']], v))
    rng, option_rng = random.Random(SEED), random.Random(SEED)
    queues = {'seed': SEED, 'sampling': 'One RNG; sorted case IDs; PT sample then ES sample without replacement; flagged first, audit in sampled order.',
              'normalization': 'Bilingual relative-date phrases and decimal representation normalized. Null invalid=false; reason string invalid=true. Injection boolean compared to presence; subtype not supplied by verifier. Demand string converted to singleton list; missing demands remain disagreements. Notes never silently fill missing structured facts.',
              'comparison': comparison, 'pt': [], 'es': []}
    counts = {}
    for language, n in [('pt', 12), ('es', 6)]:
        flagged = [x['case_id'] for x in comparison if x['session_language'] == language and x['flagged']]
        unflagged = [x['case_id'] for x in comparison if x['session_language'] == language and not x['flagged']]
        assert len(unflagged) >= n
        audit = rng.sample(unflagged, n)
        for cid, queue in [(c, 'flagged') for c in flagged] + [(c, 'audit') for c in audit]:
            case = cases[cid]
            s = specs[case['situation_id']]
            purchases = [t for t in draft['fixture']['transactions'] if t['customer_id'] == s['customer_id']]
            queues[language].append({'case_id': cid, 'queue': queue,
                                    'options': options(case, s, verifier[cid], purchases, option_rng)})
        counts[language] = {'flagged': len(flagged), 'audit': n, 'total': len(flagged) + n}
    queues['counts'] = counts
    queues['agreement'] = {'answer_agrees': sum(c['answer_agrees'] for c in comparison),
                           'facts_agree': sum(c['facts_agree'] for c in comparison),
                           'ambiguous_reading': sum(c['ambiguous_reading'] for c in comparison), 'n': 60}
    save('queues.json', queues)
    save('review_state.json', {'phase': 3, 'reviewer': 'lucas', 'language': 'pt', 'current_index': 0,
                               'pending_case_id': queues['pt'][0]['case_id'], 'paused': False})
    record = json.loads((ROOT / 'session_record.json').read_text(encoding='utf-8'))
    record.update(phase=3, status='portuguese_review_in_progress', next_step='Await answer to the pending Portuguese case; append every answer to reviews/lucas.jsonl.')
    for name in ('verifier_output.jsonl', 'prepare_review.py', 'queues.json', 'review_state.json', 'test_review.py'):
        path = str((ROOT / name).relative_to(ROOT.parents[2]))  # repository-relative, whatever the cwd
        if path not in record['files_read']:
            record['files_read'].append(path)
    save('session_record.json', record)
    print(json.dumps({'counts': counts, 'agreement': queues['agreement']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
