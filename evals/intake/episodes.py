"""Offline episode KPI scorer for the intake event log (contract: Docs/intake/intake-events.md).

One episode is one case_id. The scorer never reads customer identifiers or statements: an event
carrying `customer_id` or `message` is rejected so analytics exports cannot leak case content.
Memory is O(events); logs are expected to be bounded evaluation runs, not production streams.
"""
from collections import Counter
import statistics

VERSION = '1'
EVENTS = ('intake_started', 'clarification_requested', 'transaction_confirmed', 'handoff_created', 'handoff_accepted', 'intake_ended')
OUTCOMES = ('accepted', 'abandoned', 'withdrawn', 'technical_failure', 'routed')
SAFETY = ('assessed_safe', 'unsafe', 'not_assessed')
USAGE = ('duration_ms', 'llm_calls', 'input_tokens', 'output_tokens', 'tool_calls')
BASE = {'event', 'version', 'case_id', 'ts', 'session_ref', 'language', 'model_version'}
FORBIDDEN = {'customer_id', 'message', 'customer_statement', 'transaction'}


def ratio(n, d):
    """Keep zero-denominator rates undefined."""
    return n / d if d else None


def _episodes(events):
    """Group validated events by case_id in timestamp order; fail closed on any malformed record."""
    for e in events:
        if not BASE <= e.keys():
            raise ValueError(f'Event missing base fields: {sorted(BASE - e.keys())}')
        if e['event'] not in EVENTS:
            raise ValueError(f'Unknown event: {e["event"]}')
        if e['version'] != VERSION:
            raise ValueError(f'Unsupported event version: {e["version"]}')
        if e['language'] not in ('es', 'pt'):
            raise ValueError(f'Unsupported language: {e["language"]}')
        if FORBIDDEN & e.keys():
            raise ValueError(f'Event carries customer content ({sorted(FORBIDDEN & e.keys())}); keep it in case storage')
        if e['event'] == 'intake_ended' and (e.get('outcome') not in OUTCOMES or e.get('safety') not in SAFETY
                                             or any(type(e.get(k)) is not int or e[k] < 0 for k in USAGE)):
            raise ValueError(f'intake_ended for {e["case_id"]} needs outcome, safety and non-negative integer usage')
    groups = {}
    for e in sorted(events, key=lambda e: (e['case_id'], e['ts'])):
        groups.setdefault(e['case_id'], []).append(e)
    for case_id, seq in groups.items():
        names = [e['event'] for e in seq]
        if names.count('intake_started') != 1 or names[0] != 'intake_started':
            raise ValueError(f'Episode {case_id} needs exactly one intake_started, first')
        if names.count('intake_ended') > 1 or ('intake_ended' in names and names[-1] != 'intake_ended'):
            raise ValueError(f'Episode {case_id} needs at most one intake_ended, last')
        chain = [n for n in names if n in ('transaction_confirmed', 'handoff_created', 'handoff_accepted')]
        if 'handoff_accepted' in chain and 'handoff_created' not in chain:
            raise ValueError(f'Episode {case_id}: handoff_accepted without handoff_created (order)')
        if any(e['kind'] == 'complete' for e in seq if e['event'] == 'handoff_created') and 'transaction_confirmed' not in chain:
            raise ValueError(f'Episode {case_id}: complete handoff without transaction_confirmed')
        if chain != sorted(chain, key=('transaction_confirmed', 'handoff_created', 'handoff_accepted').index):
            raise ValueError(f'Episode {case_id}: evidence chain out of order')
    return groups


def _safe_accepted(seq):
    """Contract acceptance: confirmed transaction, complete handoff, durable receipt, ended accepted and assessed safe."""
    names = [e['event'] for e in seq]
    end = seq[-1] if names[-1] == 'intake_ended' else None
    return bool(end and end['outcome'] == 'accepted' and end['safety'] == 'assessed_safe'
                and 'transaction_confirmed' in names and 'handoff_accepted' in names
                and any(e['kind'] == 'complete' for e in seq if e['event'] == 'handoff_created'))


def _summary(episodes):
    ended = [seq[-1] for seq in episodes if seq[-1]['event'] == 'intake_ended']
    latency = sorted(e['duration_ms'] for e in ended)
    outcomes = Counter(e['outcome'] for e in ended) + Counter(pending=len(episodes) - len(ended))
    return dict(
        eligible_started=len(episodes), safe_accepted=sum(map(_safe_accepted, episodes)),
        safe_accepted_intake_rate=ratio(sum(map(_safe_accepted, episodes)), len(episodes)),
        unsafe=sum(e['safety'] == 'unsafe' for e in ended), not_assessed=sum(e['safety'] == 'not_assessed' for e in ended),
        outcomes={k: v for k, v in outcomes.items() if v},
        clarifications_per_episode=ratio(sum(e['event'] == 'clarification_requested' for seq in episodes for e in seq), len(episodes)),
        latency_p50_ms=statistics.median(latency) if latency else None,
        latency_p95_ms=latency[max(0, (95 * len(latency) + 99) // 100 - 1)] if latency else None,
        operating_cost=None, **{k: sum(e[k] for e in ended) for k in USAGE[1:]})


def summarize(events):
    """Return episode KPIs for 'all', 'es' and 'pt' from a list of event dicts; unsafe is a gate, not a rate."""
    groups = _episodes(events)
    return {label: _summary([seq for seq in groups.values() if label == 'all' or seq[0]['language'] == label])
            for label in ('all', 'es', 'pt')}
