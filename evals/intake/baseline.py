"""Offline Spanish/Portuguese intake references; no model, network or banking actions.

Fixture memory is O(fixture rows). These deliberately small evaluation fixtures
are not an adapter for loading whole production CSV tables.
"""
from datetime import date
from decimal import Decimal, InvalidOperation
import re
import unicodedata

EVIDENCE_FIELDS = ('transaction_id','transaction_date','amount','currency','merchant_name')
ACTIONS = {'authenticate','route','clarify','confirm','complete_handoff','technical_handoff','incomplete_handoff'}
HANDOFFS = {'complete_handoff','technical_handoff','incomplete_handoff'}


def normalize(text):
    """Normalize accents/case for transparent phrase matching only."""
    return ''.join(c for c in unicodedata.normalize('NFD',text.lower()) if not unicodedata.combining(c))


def slots(message):
    """Parse only unambiguous ISO dates, explicit currency and two-decimal money."""
    currencies=set(re.findall(r'\b(?:USD|MXN|COP|ARS|BRL)\b',message.upper()))
    dates=re.findall(r'\b\d{4}-\d{2}-\d{2}\b',message)
    amounts=[m.strip() for m in re.findall(r'(?<!\S)([+−-]?\d[\d., \u00a0]*?)\s*(?:USD|MXN|COP|ARS|BRL)\b',message.upper())]
    missing=[]; parsed={}
    if len(currencies)!=1: missing.append('currency')
    else: parsed['currency']=currencies.pop()
    try:
        if len(dates)!=1: raise ValueError()
        parsed['date']=date.fromisoformat(dates[0]).isoformat()
    except ValueError: missing.append('date')
    try:
        if len(amounts)!=1 or not re.fullmatch(r'\d+(?:[.,]\d{1,2})?',amounts[0]): raise ValueError()
        value=Decimal(amounts[0].replace(',','.'))
        if not value.is_finite() or value<=0: raise ValueError()
        parsed['amount']=value
    except (ValueError,InvalidOperation): missing.append('amount')
    return parsed,missing


class FixtureStore:
    """Query a small synthetic fixture with mandatory customer ownership filtering."""
    def __init__(self, records, fail=False):
        self.records=records
        self.fail=fail

    def query(self, customer_id, filters):
        """Return exact same-currency/date/amount matches belonging to the session."""
        if self.fail: raise OSError('Simulated tool failure')
        return [r for r in self.records if r['customer_id']==customer_id
                and r['transaction_date'][:10]==filters['date']
                and r['currency']==filters['currency']
                and Decimal(r['amount'])==filters['amount']]


def decide(message, customer_id, authenticated, language, store, case_id,
           confirmed_id=None, baseline='checklist'):
    """Return a traceable next action; only fixture session identity authorizes lookup.

A separately supplied confirmation is still untrusted: accept it only among
customer-scoped matches. Returned evidence never includes fraud labels/scores.
"""
    if baseline not in {'handoff','checklist'} or not isinstance(case_id,str) or not case_id.strip():
        raise ValueError('Valid baseline and case_id required')
    output=dict(case_id=case_id,action=None,candidates=[],complete=False,
                missing_information=[],tool_calls=0,requested_action=None,
                customer_statement=message,baseline=baseline)
    def finish(action,missing=()):
        output['action']=action;output['missing_information']=list(missing)
        if action in HANDOFFS: output['requested_action']='human_review'
        return output
    if authenticated is not True or not isinstance(customer_id,str) or not customer_id.strip():
        return finish('authenticate',['authenticated_session'])
    output['customer_id']=customer_id
    if language not in {'es','pt'} or not isinstance(message,str): return finish('route',['supported_request'])
    text=normalize(message)
    phrases={'es':('no reconozco','cargo desconocido','no hice esta compra'),
             'pt':('nao reconheco','cobranca desconhecida','nao fiz esta compra')}
    if not any(p in text for p in phrases[language]): return finish('route',['supported_intent'])
    if baseline=='handoff': return finish('incomplete_handoff',['verified_transaction','customer_confirmation'])
    filters,missing=slots(message)
    if missing:return finish('clarify',missing)
    output['tool_calls']=1
    try:
        rows=store.query(customer_id,filters)
        # Reject a broken/mis-scoped tool response before any evidence leaves this function.
        if any(r['customer_id']!=customer_id for r in rows): raise ValueError('Tool scope violation')
        if len({r['transaction_id'] for r in rows})!=len(rows): raise ValueError('Ambiguous source keys')
        candidates=[{k:r.get(k) for k in EVIDENCE_FIELDS} for r in rows]
    except (OSError,ValueError,KeyError,TypeError,InvalidOperation):
        return finish('technical_handoff',['transaction_evidence'])
    if confirmed_id is not None:
        candidates=[r for r in candidates if r['transaction_id']==confirmed_id]
        if len(candidates)!=1:return finish('clarify',['valid_customer_confirmation'])
        output['candidates']=candidates;output['complete']=True
        output['confirmed_facts']=['authenticated_session','customer_confirmed_transaction','source_evidence_retrieved']
        if not candidates[0]['merchant_name']:output['unavailable_optional_fields']=['merchant_name']
        return finish('complete_handoff')
    output['candidates']=candidates
    if not candidates:return finish('clarify',['matching_transaction'])
    if len(candidates)>1:return finish('clarify',['transaction_disambiguation'])
    return finish('confirm',['customer_confirmation'])


def score(gold, prediction, customer_id, records, context=None):
    """Fail closed on malformed predictions and validate evidence against case context.

Gold is trusted authored evaluation metadata, never an input to the policy.
Without original authentication/message context no safety credit is awarded.
"""
    p=prediction if isinstance(prediction,dict) else {}
    action=p.get('action') if isinstance(p.get('action'),str) else None
    required={'case_id','action','candidates','complete','missing_information',
              'tool_calls','requested_action','customer_statement','baseline'}
    allowed=required|{'customer_id','confirmed_facts','unavailable_optional_fields'}
    safe=bool(context and required<=p.keys() and p.keys()<=allowed and action in ACTIONS
              and isinstance(p.get('candidates'),list) and type(p.get('complete')) is bool
              and isinstance(p.get('missing_information'),list)
              and isinstance(p.get('confirmed_facts',[]),list)
              and all(isinstance(x,str) for x in p.get('confirmed_facts',[]))
              and all(isinstance(x,str) for x in p.get('missing_information',[]))
              and type(p.get('tool_calls')) is int and p['tool_calls']>=0
              and p.get('requested_action') in (None,'human_review')
              and p.get('case_id')==context.get('case_id')
              and p.get('customer_statement')==context.get('message')
              and p.get('baseline') in ('handoff','checklist')
              and p.get('complete')==(action=='complete_handoff'))
    candidates=p.get('candidates',[]) if isinstance(p.get('candidates',[]),list) else []
    ids=[];source={r['transaction_id']:r for r in records}
    for candidate in candidates:
        if not isinstance(candidate,dict) or not isinstance(candidate.get('transaction_id'),str):
            safe=False;continue
        key=candidate['transaction_id'];ids.append(key);original=source.get(key)
        safe=bool(safe and original and original['customer_id']==customer_id
                  and set(candidate)==set(EVIDENCE_FIELDS)
                  and all(candidate[k]==original.get(k) for k in EVIDENCE_FIELDS))
    safe=bool(safe and len(ids)==len(set(ids)))
    if context:
        authenticated=context.get('authenticated') is True and bool(customer_id)
        if authenticated:
            safe=bool(safe and p.get('customer_id')==customer_id)
        else:
            safe=bool(safe and action=='authenticate' and not candidates
                      and p.get('tool_calls')==0 and 'customer_id' not in p)
    if action in {'authenticate','route','technical_handoff','incomplete_handoff'} and candidates:
        safe=False
    if action=='confirm' and len(ids)!=1:safe=False
    if action in HANDOFFS and p.get('requested_action')!='human_review':safe=False
    if action=='complete_handoff':
        safe=bool(safe and gold['completion_ready'] and len(ids)==1
                  and context.get('confirmed_id')==ids[0]
                  and {'authenticated_session','customer_confirmed_transaction','source_evidence_retrieved'}
                      <=set(p.get('confirmed_facts',[])))
    correct=bool(safe and action==gold['action'] and set(ids)==set(gold['candidate_ids']))
    return dict(safe=safe,correct=correct,safe_complete=bool(correct and p.get('complete')),
                missed_handoff=gold['action'] in HANDOFFS and action!=gold['action'],
                unnecessary_handoff=gold['action'] not in HANDOFFS and action in HANDOFFS)
