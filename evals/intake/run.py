"""Reproduce the fixed intake reference evaluation and write inspectable aggregates."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import statistics
import time
from datetime import datetime,timezone
from .baseline import FixtureStore,decide,score,HANDOFFS
from .stats import wilson

# development: rule tuning; evaluation: authored regression; v1_authored: exposed regression cases from Andres's V1 scenarios; safety: red-team decision points;
# frozen_es_pt_v1: the blind held-out set (ADR-005), run once per pre-registered system version.
SPLITS=('development','evaluation','v1_authored','safety','frozen_es_pt_v1')
# Only the unsupported-language family may carry a non-ES/PT message language; it appears in the 'all' summary only.
LANGUAGES={'unsupported_language':('en','other')}

def ratio(n,d):
    """Keep zero-denominator rates undefined."""
    return n/d if d else None


def evaluate(corpus):
    """Score both references on each authored case, preserving splits and languages."""
    cases=corpus['cases'];records=corpus['transactions']
    if len({c['case_id'] for c in cases})!=len(cases):raise ValueError('Duplicate case IDs')
    bad=[c['case_id'] for c in cases if c['split'] not in SPLITS or c['language'] not in LANGUAGES.get(c['family'],('es','pt'))]
    if bad:raise ValueError(f'Unsupported split/language in cases: {bad}')
    # A scenario family lives in exactly one split; sharing one would leak tuning material into an evaluation set.
    if len({(c['family'],c['split']) for c in cases})!=len({c['family'] for c in cases}):raise ValueError('Scenario family split leakage')
    predictions=[]
    for c in cases:
        for name in ('handoff','checklist'):
            start=time.perf_counter()
            p=decide(**{k:c[k] for k in ('message','customer_id','authenticated','language','case_id','confirmed_id')},store=FixtureStore(records,c['tool_failure']),baseline=name)
            elapsed=(time.perf_counter()-start)*1000
            s=score(c['gold'],p,c['customer_id'],records,c)
            predictions.append(dict(case_id=c['case_id'],family=c['family'],split=c['split'],language=c['language'],baseline=name,gold=c['gold'],prediction=p,latency_ms=elapsed,**s))
    summaries=[]
    for split in SPLITS:
      for name in ('handoff','checklist'):
       for language in ('all','es','pt'):
        group=[r for r in predictions if r['split']==split and r['baseline']==name and (language=='all' or r['language']==language)]
        ready=sum(r['gold']['completion_ready'] for r in group)
        required=sum(r['gold']['action'] in HANDOFFS for r in group)
        latency=sorted(r['latency_ms'] for r in group)
        summaries.append(dict(split=split,baseline=name,language=language,cases=len(group),
          correct=sum(r['correct'] for r in group),correct_rate=ratio(sum(r['correct'] for r in group),len(group)),
          correct_rate_ci95=list(wilson(sum(r['correct'] for r in group),len(group))),
          unsafe=sum(not r['safe'] for r in group),safe_complete=sum(r['safe_complete'] for r in group),completion_ready=ready,
          completion_ready_rate=ratio(sum(r['safe_complete'] for r in group),ready),
          missed_handoff=sum(r['missed_handoff'] for r in group),required_handoff=required,
          unnecessary_handoff=sum(r['unnecessary_handoff'] for r in group),not_required_handoff=len(group)-required,
          latency_p50_ms=statistics.median(latency) if latency else None,
          latency_p95_ms=latency[max(0,(95*len(latency)+99)//100-1)] if latency else None,
          operating_cost=None,episode_completion_rate=None))
    return dict(summary=summaries,cases=predictions)


def main():
    """CLI stores only authored fixture content, never raw bank customer records."""
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,default=Path('data_foundation/runs/intake-evaluation/results.json'))
    p.add_argument('--cases',type=Path,default=Path(__file__).with_name('cases.json'),help='corpus to score; the frozen set is run once per pre-registered system version')
    args=p.parse_args();source=args.cases;blob=source.read_bytes()
    result=evaluate(json.loads(blob))
    result['provenance']=dict(corpus_path=str(source),executed_utc=datetime.now(timezone.utc).isoformat(),python=platform.python_version(),corpus_sha256=hashlib.sha256(blob).hexdigest(),code_sha256=hashlib.sha256(Path(__file__).with_name('baseline.py').read_bytes()+Path(__file__).read_bytes()).hexdigest(),gold_status='Authored; pending team review',latency_scope='One local call per case; descriptive microbenchmark only')
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps([r for r in result['summary'] if r['language']=='all'],indent=2))

if __name__=='__main__':main()
