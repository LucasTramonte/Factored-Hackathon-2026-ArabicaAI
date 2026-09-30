"""Reproduce the fixed intake reference evaluation and write inspectable aggregates."""
import argparse
import importlib
import hashlib
import json
from pathlib import Path
import platform
import statistics
import time
from datetime import datetime,timezone
from .baseline import FixtureStore,decide,score,HANDOFFS
from .stats import quantile_interval, wilson
from .systems import FactExtractorSystem, customers_from
from .preregistration.prereg import check as check_registration

# development: rule tuning; evaluation: authored regression; v1_authored: exposed regression cases from Andres's V1 scenarios; safety: red-team decision points;
# frozen_es_pt_v1: the blind held-out set (ADR-005), run once per pre-registered system version.
SPLITS=('development','evaluation','v1_authored','safety','frozen_es_pt_v1')
# Only the unsupported-language family may carry a non-ES/PT message language; it appears in the 'all' summary only.
LANGUAGES={'unsupported_language':('en','other')}

def ratio(n,d):
    """Keep zero-denominator rates undefined."""
    return n/d if d else None


def validate(corpus):
    """Reject a corpus that would be silently mis-scored: duplicate IDs, unknown split/language, family leakage."""
    cases=corpus['cases']
    if len({c['case_id'] for c in cases})!=len(cases):raise ValueError('Duplicate case IDs')
    bad=[c['case_id'] for c in cases if c['split'] not in SPLITS or c['language'] not in LANGUAGES.get(c['family'],('es','pt'))]
    if bad:raise ValueError(f'Unsupported split/language in cases: {bad}')
    # A scenario family lives in exactly one split; sharing one would leak tuning material into an evaluation set.
    if len({(c['family'],c['split']) for c in cases})!=len({c['family'] for c in cases}):raise ValueError('Scenario family split leakage')


def _summary(split,name,language,repetition,group):
    ready=sum(r['gold']['completion_ready'] for r in group)
    required=sum(r['gold']['action'] in HANDOFFS for r in group)
    latency=sorted(r['latency_ms'] for r in group)
    usage=[r.get('usage') or {} for r in group]
    tokens=lambda k:sum(u.get(k,0) for u in usage) if any(k in u for u in usage) else None
    return dict(split=split,baseline=name,repetition=repetition,language=language,cases=len(group),
      correct=sum(r['correct'] for r in group),correct_rate=ratio(sum(r['correct'] for r in group),len(group)),
      correct_rate_ci95=list(wilson(sum(r['correct'] for r in group),len(group))),
      unsafe=sum(not r['safe'] for r in group),safe_complete=sum(r['safe_complete'] for r in group),completion_ready=ready,
      completion_ready_rate=ratio(sum(r['safe_complete'] for r in group),ready),
      missed_handoff=sum(r['missed_handoff'] for r in group),required_handoff=required,
      unnecessary_handoff=sum(r['unnecessary_handoff'] for r in group),not_required_handoff=len(group)-required,
      latency_p50_ms=statistics.median(latency) if latency else None,
      latency_p95_ms=latency[max(0,(95*len(latency)+99)//100-1)] if latency else None,
      # Equal-tailed 95% order-statistic interval for p95; a side is None when the sample can't support it (ADR-006 amendment 1).
      latency_p95_interval_ms=list(quantile_interval(latency,0.95,0.95)) if latency else [None,None],
      input_tokens=tokens('input_tokens'),output_tokens=tokens('output_tokens'),
      usage_unavailable_calls=sum(u.get('usage_unavailable_calls',0) for u in usage),
      errors=sum(bool(r.get('error')) for r in group),operating_cost=None,episode_completion_rate=None)


def evaluate(corpus,systems=None,repetitions=1,only_split=None):
    """Score the two references, plus any external systems, on each authored case.

    ``systems`` maps a name to a callable ``(case, records, customers) -> (prediction, meta)``
    (see ``systems.FactExtractorSystem``). External systems run ``repetitions`` times per case;
    a per-case majority row (strict majority correct, unsafe if any repetition was unsafe) is the
    primary result, as the pre-registration template fixes.
    """
    validate(corpus)
    cases=[c for c in corpus['cases'] if only_split is None or c['split']==only_split]
    records=corpus['transactions'];systems=systems or {}
    customers=customers_from(corpus) if systems else None
    base=lambda c:dict(case_id=c['case_id'],family=c['family'],split=c['split'],language=c['language'],
                       session_language=c.get('session_language',c['language']),gold=c['gold'])
    predictions=[];majority=[]
    for c in cases:
        for name in ('handoff','checklist'):
            start=time.perf_counter()
            p=decide(**{k:c[k] for k in ('message','customer_id','authenticated','language','case_id','confirmed_id')},store=FixtureStore(records,c['tool_failure']),baseline=name)
            elapsed=(time.perf_counter()-start)*1000
            s=score(c['gold'],p,c['customer_id'],records,c)
            predictions.append(dict(base(c),baseline=name,repetition=None,prediction=p,latency_ms=elapsed,**s))
        for name,system in systems.items():
            runs=[]
            for rep in range(1,repetitions+1):
                start=time.perf_counter()
                p,meta=system(c,records,customers)
                elapsed=(time.perf_counter()-start)*1000
                s=score(c['gold'],p,c['customer_id'],records,c,systems=('handoff','checklist',name))
                runs.append(dict(base(c),baseline=name,repetition=rep,prediction=p,latency_ms=elapsed,
                                 usage=meta.get('usage'),error=meta.get('error'),extracted=meta.get('extracted'),**s))
            predictions+=runs
            more=lambda k:2*sum(r[k] for r in runs)>len(runs)
            majority.append(dict(base(c),baseline=name,repetition='majority',correct=more('correct'),safe=all(r['safe'] for r in runs),
                                 safe_complete=more('safe_complete'),missed_handoff=more('missed_handoff'),unnecessary_handoff=more('unnecessary_handoff'),
                                 latency_ms=statistics.median(r['latency_ms'] for r in runs),error=any(r['error'] for r in runs),
                                 # A key no repetition reported stays absent (unknown), never a measured zero.
                                 usage={k:sum((r['usage'] or {}).get(k,0) for r in runs) for k in ('input_tokens','output_tokens','usage_unavailable_calls')
                                        if any(k in (r['usage'] or {}) for r in runs)}))
    rows=predictions+majority
    # 'all' pools every execution of an external system across repetitions: the latency rule decides on it.
    names=[('handoff',[None]),('checklist',[None])]+[(n,list(range(1,repetitions+1))+['majority','all']) for n in systems]
    summaries=[]
    for split in SPLITS:
      for name,reps in names:
       for rep in reps:
        for language in ('all','es','pt'):
         # Breakdowns follow the session language, so an unsupported-language message still counts in its session's row.
         same=(lambda r:isinstance(r['repetition'],int)) if rep=='all' else (lambda r:r['repetition']==rep)
         group=[r for r in rows if r['split']==split and r['baseline']==name and same(r) and (language=='all' or r['session_language']==language)]
         summaries.append(_summary(split,name,language,rep,group))
    return dict(summary=summaries,cases=predictions,majority=majority)


def main():
    """CLI stores only authored fixture content, never raw bank customer records."""
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,default=Path('data_foundation/runs/intake-evaluation/results.json'))
    p.add_argument('--cases',type=Path,default=Path(__file__).with_name('cases.json'),help='corpus to score; the frozen set is run once per pre-registered system version')
    p.add_argument('--system',action='append',default=[],metavar='NAME=module:callable',help='an external fact extractor (systems.FactExtractorSystem)')
    p.add_argument('--repetitions',type=int,default=1,help='runs per case for external systems (3 for a stochastic model)')
    p.add_argument('--split',choices=SPLITS,help='score only this split, e.g. development while tuning')
    p.add_argument('--preregistration',action='append',default=[],metavar='NAME=path',help='required to score an external system on frozen_es_pt_v1')
    args=p.parse_args();source=args.cases;blob=source.read_bytes();corpus=json.loads(blob)
    systems={};targets={}
    for item in args.system:
        name,target=item.split('=',1);module,func=target.split(':',1)
        systems[name]=FactExtractorSystem(name,getattr(importlib.import_module(module),func));targets[name]=target
    registrations={}
    if systems and any(c['split']=='frozen_es_pt_v1' and args.split in (None,c['split']) for c in corpus['cases']):
        regs=dict(x.split('=',1) for x in args.preregistration)
        for name in systems:
            if name not in regs:raise SystemExit(f'{name}: a pre-registration is required to score frozen_es_pt_v1 (--preregistration {name}=<file>)')
            data=check_registration(Path(regs[name]),target=targets[name])
            if data['system']!=name:raise SystemExit(f"{name}: registration is for {data['system']}")
            registrations[name]=data
    result=evaluate(corpus,systems,args.repetitions,args.split)
    result['provenance']=dict(corpus_path=str(source),executed_utc=datetime.now(timezone.utc).isoformat(),python=platform.python_version(),corpus_sha256=hashlib.sha256(blob).hexdigest(),code_sha256=hashlib.sha256(Path(__file__).with_name('baseline.py').read_bytes()+Path(__file__).read_bytes()).hexdigest(),gold_status='Authored; pending team review',latency_scope='One local call per case; descriptive microbenchmark only',
                              systems=targets,registrations=registrations,repetitions=args.repetitions,split=args.split)
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps([r for r in result['summary'] if r['language']=='all' and r['cases']],indent=2))

if __name__=='__main__':main()
