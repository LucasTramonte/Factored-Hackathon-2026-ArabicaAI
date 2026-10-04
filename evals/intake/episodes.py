"""Offline episode KPI scorer for the intake event log (contract: Docs/intake/intake-events.md).

One episode is one case_id. Every event is checked against a per-event allowlist, so a field
outside the contract (a customer id, a name, a statement) rejects the whole log instead of
leaking into analytics. Memory is O(events); logs are bounded evaluation runs, not streams.
"""
import argparse
import json
from collections import Counter
from datetime import datetime
import re
import statistics

VERSIONS = ('1', '2')
BASE = {'event', 'version', 'case_id', 'ts', 'seq', 'session_ref', 'language', 'model_version'}
LANGUAGES = ('es', 'pt', 'en')  # en is additional (ADR-008); the frozen evaluation set is es/pt only.
USAGE = ('duration_ms', 'llm_calls', 'input_tokens', 'output_tokens', 'tool_calls')
TOKENS = ('input_tokens', 'output_tokens')
V2_USAGE = ('known_input_tokens', 'known_output_tokens', 'usage_unavailable_calls')
# One per incomplete handoff with details, after intake_ended (ADR-012): the pilot arm, the outcome kind and usage counts.
SUGGESTION = 'suggestion_recorded'
SUGGESTION_FIELDS = {'case_ref', 'arm', 'result', 'producer', 'llm_calls', 'known_input_tokens', 'known_output_tokens',
                     'usage_unavailable_calls', 'suggestions'}
REQUIRED = {'intake_started': set(), 'clarification_requested': {'missing'}, 'transaction_confirmed': {'transaction_ref'},
            'handoff_created': {'kind', 'case_ref'}, 'handoff_accepted': {'case_ref', 'accepted_by'},
            'intake_ended': {'outcome', 'safety', *USAGE}, SUGGESTION: SUGGESTION_FIELDS}
OPTIONAL = {'intake_started': {'scenario'}, 'handoff_created': {'tool_status'}}
KINDS = ('complete', 'technical', 'incomplete')
TOOL_STATUS = ('ok', 'failed', 'timeout')
REFS = {'case_id', 'session_ref', 'model_version', 'case_ref', 'transaction_ref', 'accepted_by'}
OUTCOMES = ('accepted', 'abandoned', 'withdrawn', 'technical_failure', 'routed')
SAFETY = ('assessed_safe', 'unsafe', 'not_assessed')
ARMS = (None, 'A', 'B')
# Outcome kinds of a suggestion run; the first three never call the model, and only 'suggested' shows charges.
RESULTS = ('off', 'capped', 'retired', 'auth_error', 'timeout', 'provider_error', 'config_error', 'invalid_output',
           'no_match', 'ambiguous', 'suggested')
CHAIN = ('transaction_confirmed', 'handoff_created', 'handoff_accepted')
TS = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z')
# Contract vocabulary for clarification_requested.missing (Docs/intake/intake-events.md).
MISSING = ('date', 'currency', 'amount', 'matching_transaction', 'transaction_disambiguation',
           'customer_confirmation', 'valid_customer_confirmation')
# Authored scenario ids such as V1-01 or safety-unsupported_language-en; never free text.
SCENARIO = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}')


def ratio(n, d):
    """Keep zero-denominator rates undefined."""
    return n / d if d else None


def _check_event(e):
    """Reject any event whose fields, names or values fall outside the contract."""
    name = e.get('event')
    if name not in REQUIRED:
        raise ValueError(f'Unknown event: {name}')
    required = BASE | REQUIRED[name] | (set(V2_USAGE) if e.get('version') == '2' and name == 'intake_ended' else set())
    allowed = required | OPTIONAL.get(name, set())
    if not required <= e.keys():
        raise ValueError(f'{name} missing fields: {sorted(required - e.keys())}')
    if e.keys() - allowed:
        raise ValueError(f'{name} carries fields outside the contract (customer content?): {sorted(e.keys() - allowed)}')
    if e['version'] not in VERSIONS:
        raise ValueError(f'Unsupported event version: {e["version"]}')
    if type(e['seq']) is not int or e['seq'] < 0:
        raise ValueError(f'{name}.seq must be a non-negative integer')
    if e['language'] not in LANGUAGES:
        raise ValueError(f'Unsupported language: {e["language"]}')
    if not isinstance(e['ts'], str) or not TS.fullmatch(e['ts']):
        raise ValueError(f'ts must be millisecond UTC like 2026-09-29T14:00:00.000Z, got {e["ts"]!r}')
    try:
        datetime.strptime(e['ts'], '%Y-%m-%dT%H:%M:%S.%fZ')
    except ValueError:
        raise ValueError(f'ts is not a real UTC date and time: {e["ts"]!r}') from None
    for k in REFS & e.keys():
        if not isinstance(e[k], str) or not e[k]:
            raise ValueError(f'{name}.{k} must be a non-empty string reference, got {e[k]!r}')
    if name == 'clarification_requested' and (not isinstance(e['missing'], list) or not e['missing']
                                              or any(m not in MISSING for m in e['missing'])):
        raise ValueError(f'clarification_requested.missing must be a non-empty list of {MISSING}, got {e["missing"]!r}')
    if 'scenario' in e and (not isinstance(e['scenario'], str) or not SCENARIO.fullmatch(e['scenario'])):
        raise ValueError(f'intake_started.scenario must be an authored scenario id, got {e["scenario"]!r}')
    if name == 'handoff_created' and e['kind'] not in KINDS:
        raise ValueError(f'handoff_created kind must be one of {KINDS}, got {e["kind"]!r}')
    if name == 'handoff_created' and e.get('tool_status', 'ok') not in TOOL_STATUS:
        raise ValueError(f'handoff_created tool_status must be one of {TOOL_STATUS}, got {e["tool_status"]!r}')
    if name == 'handoff_created' and e['kind'] == 'complete' and e.get('tool_status', 'ok') != 'ok':
        raise ValueError(f'handoff_created for {e["case_id"]}: a failed tool cannot back a complete handoff')
    if name == SUGGESTION:
        _check_suggestion(e)
    if name == 'intake_ended':
        integer_usage = USAGE if e['version'] == '1' else ('duration_ms', 'llm_calls', 'tool_calls', *V2_USAGE)
        if (e['outcome'] not in OUTCOMES or e['safety'] not in SAFETY
                or any(type(e[k]) is not int or e[k] < 0 for k in integer_usage)):
            raise ValueError(f'intake_ended for {e["case_id"]} needs a known outcome, safety and non-negative integer usage')
        if e['version'] == '2':
            unavailable = e['usage_unavailable_calls']
            if unavailable > e['llm_calls']:
                raise ValueError('usage_unavailable_calls cannot exceed llm_calls')
            if unavailable:
                if any(e[k] is not None for k in TOKENS):
                    raise ValueError('Unavailable usage requires null token totals')
            elif any(type(e[k]) is not int or e[k] < 0 or e[k] != e['known_' + k] for k in TOKENS):
                raise ValueError('Available usage requires non-negative integer token totals equal to known subtotals')


def _check_suggestion(e):
    """A suggestion run: references and counts only, consistent with its outcome kind."""
    counts = ('llm_calls', 'known_input_tokens', 'known_output_tokens', 'usage_unavailable_calls', 'suggestions')
    if e['version'] != '2' or e['arm'] not in ARMS or e['result'] not in RESULTS:
        raise ValueError('suggestion_recorded needs version 2, an arm in (null, A, B) and a known result')
    if any(type(e[k]) is not int or e[k] < 0 for k in counts):
        raise ValueError('suggestion_recorded counts must be non-negative integers')
    if e['producer'] is not None and (not isinstance(e['producer'], str) or not e['producer']):
        raise ValueError('suggestion_recorded.producer must be null or a model version')
    if e['llm_calls'] > 2 or e['usage_unavailable_calls'] > e['llm_calls'] or (e['llm_calls'] and e['producer'] is None):
        raise ValueError('suggestion_recorded usage is inconsistent')
    if (e['suggestions'] > 0) != (e['result'] == 'suggested') or e['suggestions'] > 3:
        raise ValueError('suggestion_recorded shows 1-3 charges exactly when the result is suggested')
    if e['result'] in ('off', 'capped', 'retired', 'auth_error') and e['llm_calls']:
        raise ValueError(f'suggestion_recorded result {e["result"]} makes no model call')
    if e['arm'] != 'B' and e['result'] != 'off':
        raise ValueError('only arm B is ever read by the model')


def _check_suggestions(groups, suggestions):
    """Each run follows its own episode's intake_ended, once, for that episode's incomplete handoff."""
    seen = set()
    for e in suggestions:
        seq = groups.get(e['case_id'])
        if not seq or seq[-1]['event'] != 'intake_ended' or e['seq'] <= seq[-1]['seq'] or e['case_id'] in seen:
            raise ValueError(f'Episode {e["case_id"]}: suggestion_recorded must follow intake_ended, once')
        if e['language'] != seq[0]['language'] or not any(x['event'] == 'handoff_created' and x['kind'] == 'incomplete'
                                                          and x['case_ref'] == e['case_ref'] for x in seq):
            raise ValueError(f'Episode {e["case_id"]}: suggestion_recorded without its incomplete handoff')
        seen.add(e['case_id'])


def _suggestion_summary(suggestions):
    """Runs by arm and result, with usage; unknown usage keeps the token totals null, never zero."""
    unknown = sum(e['usage_unavailable_calls'] for e in suggestions)
    return dict(runs=len(suggestions),
                by_arm={str(arm): dict(Counter(e['result'] for e in suggestions if e['arm'] == arm)) for arm in ARMS
                        if any(e['arm'] == arm for e in suggestions)},
                llm_calls=sum(e['llm_calls'] for e in suggestions), usage_unavailable_calls=unknown,
                known_input_tokens=sum(e['known_input_tokens'] for e in suggestions),
                known_output_tokens=sum(e['known_output_tokens'] for e in suggestions),
                input_tokens=None if unknown else sum(e['known_input_tokens'] for e in suggestions),
                output_tokens=None if unknown else sum(e['known_output_tokens'] for e in suggestions))


def _check_episode(case_id, seq):
    """Enforce one start, at most one end, single-shot evidence chain in order, and a complete chain behind 'accepted'."""
    if len({e['seq'] for e in seq}) != len(seq):
        raise ValueError(f'Episode {case_id} repeats a seq value')
    names = [e['event'] for e in seq]
    if names.count('intake_started') != 1 or names[0] != 'intake_started':
        raise ValueError(f'Episode {case_id} needs exactly one intake_started, first')
    if names.count('intake_ended') > 1 or ('intake_ended' in names and names[-1] != 'intake_ended'):
        raise ValueError(f'Episode {case_id} needs at most one intake_ended, last')
    if len({e['language'] for e in seq}) != 1:
        raise ValueError(f'Episode {case_id} mixes languages')
    if len({e['version'] for e in seq}) != 1:
        raise ValueError(f'Episode {case_id} mixes versions')
    chain = [n for n in names if n in CHAIN]
    if len(chain) != len(set(chain)):
        raise ValueError(f'Episode {case_id} repeats a chain event; retries must not re-emit evidence')
    if chain != sorted(chain, key=CHAIN.index):
        raise ValueError(f'Episode {case_id}: evidence chain out of order')
    created = [e for e in seq if e['event'] == 'handoff_created']
    accepted = [e for e in seq if e['event'] == 'handoff_accepted']
    if accepted and (not created or accepted[0]['case_ref'] != created[0]['case_ref']):
        raise ValueError(f'Episode {case_id}: handoff_accepted without a matching handoff_created (order)')
    if created and created[0]['kind'] == 'complete' and 'transaction_confirmed' not in chain:
        raise ValueError(f'Episode {case_id}: complete handoff without transaction_confirmed')
    if seq[-1]['event'] == 'intake_ended' and seq[-1]['outcome'] == 'accepted' and not _full_chain(seq):
        raise ValueError(f'Episode {case_id}: outcome accepted without the full chain (confirmed, complete handoff, receipt)')


def _full_chain(seq):
    return ('transaction_confirmed' in [e['event'] for e in seq] and any(e['event'] == 'handoff_accepted' for e in seq)
            and any(e['event'] == 'handoff_created' and e['kind'] == 'complete' for e in seq))


def _safe_accepted(seq):
    """Contract acceptance: full chain, ended accepted and assessed safe."""
    end = seq[-1]
    return bool(end['event'] == 'intake_ended' and end['outcome'] == 'accepted' and end['safety'] == 'assessed_safe' and _full_chain(seq))


def _summary(episodes):
    ended = [seq[-1] for seq in episodes if seq[-1]['event'] == 'intake_ended']
    latency = sorted(e['duration_ms'] for e in ended)
    outcomes = Counter(e['outcome'] for e in ended) + Counter(pending=len(episodes) - len(ended))
    accepted = sum(map(_safe_accepted, episodes))
    unknown = sum(e['input_tokens'] is None for e in ended)
    return dict(
        eligible_started=len(episodes), safe_accepted=accepted, safe_accepted_intake_rate=ratio(accepted, len(episodes)),
        unsafe=sum(e['safety'] == 'unsafe' for e in ended),
        not_assessed=sum(e['safety'] == 'not_assessed' for e in ended) + len(episodes) - len(ended),
        usage_unknown_episodes=unknown + len(episodes) - len(ended),
        outcomes={k: v for k, v in outcomes.items() if v},
        clarifications_per_episode=ratio(sum(e['event'] == 'clarification_requested' for seq in episodes for e in seq), len(episodes)),
        latency_p50_ms=statistics.median(latency) if latency else None,
        latency_p95_ms=latency[max(0, (95 * len(latency) + 99) // 100 - 1)] if latency else None,
        operating_cost=None,
        known_input_tokens=sum(e.get('known_input_tokens', e['input_tokens']) for e in ended),
        known_output_tokens=sum(e.get('known_output_tokens', e['output_tokens']) for e in ended),
        usage_unavailable_calls=sum(e.get('usage_unavailable_calls', 0) for e in ended),
        **{k: None if unknown and k in TOKENS else sum(e[k] for e in ended) for k in USAGE[1:]})


def summarize(events):
    """Return episode KPIs for 'all', 'es', 'pt' and 'en' from a list of event dicts; unsafe is a gate, not a rate."""
    for e in events:
        _check_event(e)
    suggestions = [e for e in events if e['event'] == SUGGESTION]
    groups = {}
    for e in sorted((e for e in events if e['event'] != SUGGESTION), key=lambda e: (e['case_id'], e['seq'])):
        groups.setdefault(e['case_id'], []).append(e)
    for case_id, seq in groups.items():
        _check_episode(case_id, seq)
    _check_suggestions(groups, suggestions)
    return {label: {**_summary([seq for seq in groups.values() if label == 'all' or seq[0]['language'] == label]),
                    'suggestions': _suggestion_summary([e for e in suggestions if label == 'all' or e['language'] == label])}
            for label in ('all', *LANGUAGES)}


def main():
    """Score a bounded JSONL export; reject invalid logs without echoing customer content."""
    parser = argparse.ArgumentParser(description='Validate intake event JSONL and print episode KPIs.')
    parser.add_argument('input', help='UTF-8 JSONL event export (one object per line)')
    args = parser.parse_args()
    events = []
    try:
        with open(args.input, encoding='utf-8') as source:
            for line_number, line in enumerate(source, 1):
                try:
                    event = json.loads(line)
                    if not isinstance(event, dict):
                        raise ValueError('Expected an object')
                    _check_event(event)
                except (ValueError, TypeError, RecursionError):
                    parser.error(f'Invalid JSON or event contract at line {line_number}')
                events.append(event)
    except (OSError, UnicodeError):
        parser.error('Cannot read input as UTF-8 JSONL')
    try:
        summary = summarize(events)
    except (ValueError, TypeError):
        parser.error('Invalid episode log: check event sequence and handoff evidence')
    print(json.dumps(summary, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
