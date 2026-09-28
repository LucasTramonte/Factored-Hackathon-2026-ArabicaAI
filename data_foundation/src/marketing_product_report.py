"""Render self-contained, aggregate-only evidence pages for private repository review."""
from __future__ import annotations

import html
import json
import math
from calendar import monthrange
from datetime import date
from pathlib import Path

STYLE = """<style>
:root{font-family:Inter,system-ui,sans-serif;color:#162b35;background:#edf2f0}*{box-sizing:border-box}body{margin:0}
header{background:#10343a;color:#fff;padding:46px max(24px,calc((100vw - 1100px)/2))}header p{max-width:780px;line-height:1.6;color:#d0e5e1}
main{max-width:1100px;margin:auto;padding:28px 24px 70px}h1{font-size:clamp(2rem,5vw,3.4rem);margin:0 0 12px}h2{font-size:1.5rem;margin:0 0 16px}
section{background:#fff;border-radius:16px;padding:26px;margin:18px 0;box-shadow:0 2px 14px #173e3b12}p,li{line-height:1.55}small,.muted{color:#536970}
nav{display:flex;gap:18px;flex-wrap:wrap;margin-top:22px}a{color:#0e746f}header a{color:#b8fff3}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}.card{background:#eef7f4;padding:18px;border-radius:12px}.card b{display:block;font-size:1.8rem;color:#0b5f58}
.tablewrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{padding:10px;border-bottom:1px solid #d9e5e1;text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}th{background:#eaf4f0;position:sticky;top:0}
.bar{display:flex;align-items:center;gap:12px;margin:12px 0}.bar span:first-child{width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.track{height:22px;background:#e0ece8;border-radius:12px;flex:1;overflow:hidden}.fill{height:100%;background:#d68b53}.bar b{width:100px;text-align:right;font-size:.85rem}
.note{border-left:4px solid #d68b53;padding:12px 16px;background:#fff6eb}.timeseries{width:100%;height:auto}.timeseries text{fill:#536970;font-size:11px}figure{margin:20px 0}figcaption{font-weight:650;margin-bottom:8px}select{padding:8px;border:1px solid #9db5ad;border-radius:6px}footer{color:#617675;margin-top:30px}
</style>"""


def esc(value) -> str:
    """Escape any aggregate label before embedding it in HTML."""
    return html.escape(str(value if value is not None else "Unknown"))


def pct(numerator, denominator) -> str:
    """Display a percentage only when its denominator is positive."""
    return f"{100 * numerator / denominator:.2f}%" if denominator else "n/a"


def num(value) -> str:
    """Format an integer count."""
    return f"{int(value or 0):,}"


def table(items: list[dict], columns: list[tuple[str, str]]) -> str:
    """Render selected aggregate columns as a readable table."""
    head = "".join(f"<th>{esc(label)}</th>" for _, label in columns)
    body = "".join("<tr>" + "".join(f"<td>{esc(row.get(key))}</td>" for key, _ in columns) + "</tr>" for row in items)
    return f'<div class="tablewrap"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def card(label: str, value: str, note: str) -> str:
    """Render an aggregate KPI with its denominator context."""
    return f'<div class="card"><small>{esc(label)}</small><b>{esc(value)}</b><small>{esc(note)}</small></div>'


def shell(title: str, subtitle: str, body: str) -> str:
    """Wrap an offline report in a shared visual system."""
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(title)}</title>{STYLE}</head><body>
<header><h1>{esc(title)}</h1><p>{esc(subtitle)}</p><nav><a href="index.html">Report hub</a><a href="marketing-product.html">Marketing & Product</a><a href="intake-decision.html">Intake decision</a></nav></header><main>{body}<footer>Aggregate synthetic data · Private repository · Offline report</footer></main></body></html>'''


def monthly_plot(monthly: list[dict], metric: str, title: str, last_send: str) -> str:
    """Draw a zero-based monthly SVG series with exact values in hover titles."""
    if not monthly:
        return '<p>No dated sends available.</p>'
    values = [r['sends'] if metric == 'sends' else 100 * r['recorded_conversions'] / r['sends'] if r['sends'] else 0 for r in monthly]
    ceiling = (math.ceil(max(values) / 10000) * 10000) if metric == 'sends' else (math.ceil(max(values) * 5) / 5)
    ceiling = max(ceiling, 1)
    left, right, top, bottom = 65, 925, 25, 226
    x = lambda i: left + i * (right-left) / max(1,len(monthly)-1)
    y = lambda value: bottom - value * (bottom-top) / ceiling
    last_month = date.fromisoformat(str(monthly[-1]['month'])[:10])
    last_date = date.fromisoformat(str(last_send)[:10])
    partial = last_date.year == last_month.year and last_date.month == last_month.month and last_date.day < monthrange(last_date.year,last_date.month)[1]
    output = [f'<figure><figcaption>{esc(title)}</figcaption><svg class="timeseries" role="img" aria-label="{esc(title)} by send month" viewBox="0 0 980 280">']
    if partial:
        width = (right-left)/max(1,len(monthly)-1)
        output.append(f'<rect x="{x(len(monthly)-1)-width/2:.1f}" y="{top}" width="{width/2+20:.1f}" height="{bottom-top}" fill="#fff2d8"/>')
    for fraction in (0,0.25,0.5,0.75,1):
        yy = y(ceiling*fraction)
        label = f'{int(ceiling*fraction):,}' if metric=='sends' else f'{ceiling*fraction:.2f}%'
        output.append(f'<line x1="{left}" y1="{yy:.1f}" x2="{right}" y2="{yy:.1f}" stroke="#d5e3de"/><text x="{left-8}" y="{yy+4:.1f}" text-anchor="end">{label}</text>')
    color = '#0d756e' if metric=='sends' else '#bc653a'
    points = ' '.join(f'{x(i):.1f},{y(value):.1f}' for i,value in enumerate(values))
    output.append(f'<polyline points="{points}" fill="none" stroke="{color}" stroke-width="3"/>')
    for i,(row,value) in enumerate(zip(monthly,values)):
        month = str(row['month'])[:7]
        tooltip = f"{month}: {row['sends']:,} sends; {row['recorded_conversions']:,} recorded conversions; {100*row['recorded_conversions']/row['sends']:.2f}% per send" if row['sends'] else f'{month}: 0 sends'
        output.append(f'<circle cx="{x(i):.1f}" cy="{y(value):.1f}" r="4.5" fill="{color}"><title>{esc(tooltip)}</title></circle>')
        if i % 3 == 0 or i == len(monthly)-1:
            output.append(f'<text x="{x(i):.1f}" y="{bottom+22}" text-anchor="middle">{esc(month)}</text>')
    if partial:
        output.append(f'<text x="{right}" y="{top+15}" text-anchor="end" fill="#885315">Partial month</text>')
    output.append('</svg></figure>')
    return ''.join(output)


def marketing_product(data: dict) -> str:
    """Render Marketing and Product counts, sensitivity, funnel and caveats."""
    m, p, d, econ = data["marketing"], data["products"], data["digital"], data["economics"]
    o, q, e, s = m["overall"], m["quality"], d["events"], d["sessions"]
    body = '<section><h2>What the customer needs</h2><p>Relevant messages and digital tasks that can be completed with clear recovery paths. These data describe current records; they do not prove a campaign or feature improved customer outcomes.</p></section>'
    body += '<section><h2>Can we decide where to invest?</h2><p><strong>Not yet.</strong> The available records describe campaigns sent to customer IDs, but do not connect eligible leads, verified new-customer acquisition, fully loaded cost, and bank contribution over time. Thus acquisition versus conversion versus retention cannot be ranked from this snapshot.</p><div class="cards">'
    for label, key in [('CAC','CAC'),('LTV','LTV'),('LTV / CAC','LTV/CAC'),('CAC versus average ticket','CAC/average ticket'),('Lead → customer','lead-to-customer'),('Retention','retention')]:
        item=econ['metrics'][key]
        body += card(label,item['status'].title(),item['missing'])
    body += '</div><p class="note">The 3:1 LTV/CAC rule is a contextual heuristic, not a bank acceptance criterion. A ratio above or below 3 cannot be interpreted here because neither component is identified. Compare margin-adjusted LTV and fully loaded CAC for the same acquired cohort and currency, then inspect payback and risk.</p>'
    body += '<p>Observed field coverage: '+num(econ['customer_snapshot_rows'])+' customer snapshots with '+num(econ['known_registration_dates'])+' known registration dates; send_cost on '+num(econ['send_cost_known'])+' / '+num(econ['sends'])+' sends; campaign budget on '+num(econ['campaign_budget_known'])+' / '+num(econ['campaigns'])+' campaigns; conversion_value on '+num(econ['conversion_value_known'])+' / '+num(econ['sends'])+' sends. Cost and conversion-value currency are not documented. Gross customer transaction value is not bank revenue.</p>'
    body += '<p>Acquisition-labelled campaigns have '+num(econ['acquisition_objective_sends'])+' sends and '+num(econ['acquisition_objective_recorded_conversions'])+' recorded conversions; '+num(econ['acquisition_objective_pre_registration_sends'])+' sends precede the recipient’s current registration date. Across all campaigns, '+num(econ['pre_registration_sends'])+' sends precede registration. These records cannot be recast as leads or proven acquisitions.</p>'
    timing_rows=[{**r,'conversion_per_send':pct(r['recorded_conversions'],r['sends'])} for r in econ['registration_sensitivity']]
    body += '<h3>Send-date versus customer registration-date sensitivity</h3>'+table(timing_rows, [('registration_timing','Timing'),('sends','Sends'),('recorded_conversions','Recorded conversions'),('conversion_per_send','Recorded conversion / send'),('delivered','Delivered')])
    body += '<p>Minimum next dataset: prospect/lead ID and creation date, qualification event, campaign assignment, verified customer creation with lead-to-customer key, spend with currency and cost scope, plus customer contribution and exit history. Until then, test message execution separately from acquisition and retention economics.</p></section>'
    body += '<section><h2>Marketing execution diagnostics</h2><div class="cards">'
    body += card('Valid sends', num(o['sends']), 'One deduplicated send_id')
    body += card('Delivery', pct(o['delivered'], o['delivery_known']), f"{num(o['delivered'])} / {num(o['delivery_known'])} known flags")
    body += card('Known opens', pct(o['opens'], o['open_known']), f"{num(o['opens'])} / {num(o['open_known'])} delivered, known flags")
    body += card('Known clicks', pct(o['clicks'], o['click_known']), f"{num(o['clicks'])} / {num(o['click_known'])} delivered, known flags")
    body += card('Recorded conversion', pct(o['recorded_conversions'], o['sends']), f"{num(o['recorded_conversions'])} / {num(o['sends'])} sends; descriptive")
    body += '</div><p class="note">Unknown flags: delivery '+num(o['delivery_unknown'])+', open '+num(o['open_unknown'])+', click '+num(o['click_unknown'])+', conversion '+num(o['conversion_unknown'])+'. Open/click denominators include only delivered sends with a known respective flag.</p>'
    body += '<label>Compare by <select id="dimension"><option value="channel">Channel</option><option value="objective">Campaign objective</option><option value="segment">Customer segment</option><option value="country">Customer country</option></select></label><div id="chart"></div><p class="muted">Bar width uses a 0–10% conversion scale. Other rate denominators appear below.</p><div id="group-table" class="tablewrap"></div>'
    body += '<p>Business send-date range: '+esc(q['first_send'])+' through '+esc(q['last_send'])+'. The first and last calendar years are partial.</p>'
    body += '<h3>Campaign-window sensitivity</h3>'+table(m['date_sensitivity'], [('campaign_window','Window'),('sends','Sends'),('recorded_conversions','Recorded conversions'),('delivery_unknown','Unknown delivery')])
    body += '<p>Rates by group always use the send grain. Out-of-window sends remain in the overall result; the sensitivity table shows their volume.</p><h3>Monthly campaign response by business send date</h3>'+monthly_plot(m['monthly'],'sends','Send volume',q['last_send'])+monthly_plot(m['monthly'],'rate','Recorded conversion per send',q['last_send'])+'<p>Both charts start at zero. Hover a point for exact numerator and denominator; the final month is incomplete and later conversions may still be unobserved. Counts describe synthetic records, not incremental customer acquisition.</p></section>'
    body += '<section><h2>Data readiness for targeting</h2><div class="cards">'
    for label,key,note in [('Repeat exposed customers','repeat_exposed_customers','of '+num(m['exposure']['exposed_customers'])+' exposed customers'),('Current opt-out sends','current_opt_out_sends','Snapshot consent, not historical'),('Outside campaign dates','outside_campaign_dates','Compared with business send_date'),('Target country mismatch','target_country_mismatch','Joined customer snapshot'),('Target segment mismatch','target_segment_mismatch','Joined customer snapshot')]:
        value = m['exposure'][key] if key in m['exposure'] else q[key]
        body += card(label,num(value),note)
    body += '</div><p>Conversion timing, among records marked converted:</p>'+table(m['timing'], [('window','Elapsed time'),('sends','Sends')])
    body += '<p>Missing campaign links: '+num(q['missing_campaign'])+'; missing customer links: '+num(q['missing_customer'])+'; send/process day mismatches: '+num(q['send_partition_day_mismatch'])+'.</p></section>'
    body += '<section><h2>Product snapshot</h2><p>Active ownership and app linkage refer to current product rows. Transaction activity is first aggregated at product_id, then joined to the product dimension only when customer_id agrees and the transaction is on or after opening_date.</p>'
    body += table(p['ownership'], [('product_type','Product type'),('active_products','Active products'),('owning_customers','Owners'),('linked_products','Linked app'),('linked_known','Known app flag')])
    t=p['transaction_activity']; body += '<div class="cards">'+card('Eligible transactions',num(t['eligible_transactions']),f"of {num(t['total_transactions'])} Silver transactions")+card('Before opening',num(t['before_opening']),'Excluded from eligible activity')+card('Owner mismatch',num(t['owner_mismatch']),'Excluded from eligible activity')+'</div>'
    body += '<h3>Eligible activity by product type</h3>'+table(p['transaction_by_type'], [('product_type','Type'),('active_products','Active snapshot'),('with_eligible_activity','With eligible activity'),('eligible_transactions','Eligible transactions')])
    body += '<h3>Customer segment snapshot</h3>'+table(p['cohorts'], [('segment','Segment'),('customers','Customers'),('active_owners','Active owners')])+'<details><summary>Active product opening years (snapshot only)</summary>'+table(p['opening_year'], [('opening_year','Opening year'),('active_products_in_snapshot','Active now')])+'</details>'
    body += '<p class="note">Opening-year counts are a current active-product snapshot grouped by opening_date, not a historical adoption series. Digital product-type usage is suppressed because '+num(d['product_links']['owner_mismatch'])+' of '+num(d['product_links']['identified_links'])+' identified product links disagree on customer ownership.</p></section>'
    body += '<section><h2>Digital session engagement</h2><p>Ordered stages: Navigation PageView → Product Click → Transaction FormSubmit. Stages use earliest event timestamps within an unambiguous session_id; a Purchase label does not prove product acquisition.</p><div class="cards">'
    for label,key,denom in [('Navigation view','navigation_view','sessions'),('Click after view','click_after_view','navigation_view'),('Submit after click','submit_after_click','click_after_view')]:
        body += card(label,num(s[key]),pct(s[key],s[denom])+f" of {num(s[denom])} {denom.replace('_',' ')}")
    body += '</div><p>Business event-date range: '+esc(e['first_event'])+' through '+esc(e['last_event'])+'. The first and last calendar years are partial.</p><p>Sessions: '+num(s['sessions'])+'; ambiguous customer sessions: '+num(s['ambiguous_customer_sessions'])+'; mixed anonymous/identified sessions: '+num(s['mixed_identity_sessions'])+'; anonymous events: '+num(e['anonymous_events'])+'; missing action: '+num(e['missing_action'])+' of '+num(e['events'])+' events. Event/process day mismatches: '+num(e['event_partition_day_mismatch'])+'.</p>'
    body += '<h3>Event labels and action coverage</h3>'+table(d['labels'], [('event_type','Type'),('event_category','Category'),('events','Events'),('missing_action','No action')])+'</section>'
    body += '<section><h2>Decision and limits</h2><p>Use these descriptive counts to choose a controlled test of clearer, consent-respecting communication and supported digital tasks. Measure verified customer completion and errors before claiming value. No causal attribution, targeting model, cross-currency ROI, or acquisition model is validated here.</p><ul>'
    for item in m['limitations']+p['limitations']+d['limitations']: body += '<li>'+esc(item)+'</li>'
    body += '</ul><p>Source: one verified Silver snapshot; see aggregate JSON and quality-run manifest for exact counts and provenance.</p></section>'
    groups = json.dumps(m['groups'], ensure_ascii=False).replace('<','\\u003c')
    body += f'''<script>const groups={groups};const chart=document.getElementById('chart');const groupTable=document.getElementById('group-table');
function rate(n,d){{return d? (100*n/d).toFixed(2)+'% ('+n.toLocaleString()+'/'+d.toLocaleString()+')':'n/a (0 known)'}}
function draw(){{const dim=document.getElementById('dimension').value;chart.replaceChildren();const t=document.createElement('table');const head=document.createElement('tr');for(const name of ['Group','Sends','Delivery','Known opens','Known clicks','Recorded conversion']){{const th=document.createElement('th');th.textContent=name;head.append(th)}}t.append(head);
for(const row of groups[dim]){{const r=row.sends?100*row.recorded_conversions/row.sends:0;const div=document.createElement('div');div.className='bar';const label=document.createElement('span');label.textContent=row.label;const track=document.createElement('div');track.className='track';const fill=document.createElement('div');fill.className='fill';fill.style.width=Math.min(r*10,100)+'%';track.append(fill);const value=document.createElement('b');value.textContent=r.toFixed(2)+'% · '+row.recorded_conversions.toLocaleString()+'/'+row.sends.toLocaleString();div.append(label,track,value);chart.append(div);
const tr=document.createElement('tr');for(const val of [row.label,row.sends.toLocaleString(),rate(row.delivered,row.delivery_known),rate(row.opens,row.open_known),rate(row.clicks,row.click_known),rate(row.recorded_conversions,row.sends)]){{const td=document.createElement('td');td.textContent=val;tr.append(td)}}t.append(tr)}}groupTable.replaceChildren(t)}}document.getElementById('dimension').addEventListener('change',draw);draw()</script>'''
    return shell('Marketing & Product evidence', 'Descriptive, denominator-first analysis from verified Silver data. Interactive chart shows recorded conversion per send, with no causal claim.', body)


def intake(data: dict) -> str:
    """Render corrected V1 complaint population and its decision limits."""
    i=data['intake']; rows_by={r['population']:r for r in i['populations']}; v=rows_by.get('V1: Cargo no reconocido',{}); combined=sum(r['complaints'] for r in i['populations'])
    body='<section><h2>Proposed V1: useful human handoff</h2><p>A customer reporting an unrecognized charge needs a complete, secure account of the issue that a human agent can use. The data support testing the handoff, not a promise of faster resolution.</p><div class="cards">'
    body += card('V1 complaints',num(v.get('complaints',0)),'Cargo no reconocido only')
    body += card('Via Call Center',num(v.get('call_center',0)),pct(v.get('call_center',0),v.get('complaints',0))+' of V1')
    body += card('Combined complaint labels',num(combined),'V1 plus Cobro indebido; separate population')
    body += card('Observed SLA breach',num(v.get('sla_breached',0)),pct(v.get('sla_breached',0),v.get('complaints',0))+' of V1; no causal link')
    body += '</div><p>Grouped by complaint creation_date. The broader combined total must never be labeled “unrecognized charges.”</p>'+table(i['populations'], [('population','Population'),('complaints','Complaints'),('call_center','Call Center'),('sla_breached','SLA breached'),('claimed_amount_known','Known claimed amount')])+'</section>'
    if i['bronze_link_audit']:
        audit=i['bronze_link_audit']; body += '<p class="note">Bronze origin_interaction_id populated: '+num(audit['populated_origin_links'])+' / '+num(audit['bronze_complaints'])+' complaints. This field was intentionally dropped from Silver.</p>'
    body += '<section><h2>Trend: separate populations</h2>'+table(i['monthly'], [('month','Creation month'),('v1','V1 only'),('broader_combined','Combined')])+'</section>'
    body += '<section><h2>What this cannot show</h2><ul>'+''.join('<li>'+esc(x)+'</li>' for x in i['limitations'])+'</ul><p>Do not infer that intake caused delays, reduced SLA breaches, or saved call time. Marketing targeting scores are unrelated to evidence for this V1. Next test: instrument case start, submission, server-confirmed acceptance, handoff completeness, agent correction, and safe resolution.</p></section>'
    return shell('Suspicious-charge intake decision', 'Corrected complaint population and evidence for a human-handoff test.', body)


def hub(data: dict) -> str:
    """Render a concise private report index from the same aggregate run."""
    m=data['marketing']['overall']; v=next((r for r in data['intake']['populations'] if r['population'].startswith('V1:')),None)
    body='<section><h2>Customer questions</h2><div class="cards">'+card('CAC and LTV','Unavailable','Lead, acquisition, cost and contribution links missing')+card('Recorded send conversion',pct(m['recorded_conversions'],m['sends']),f"{num(m['recorded_conversions'])} / {num(m['sends'])} sends; not new customers")+card('V1 complaint cases',num(v['complaints'] if v else 0),'Cargo no reconocido')+'</div><p>Marketing and Product describe possible test cohorts and journeys. The intake page sizes one narrow handoff workflow. These are separate populations and cannot be joined into a customer outcome.</p></section>'
    body += '<section><h2>Read the evidence</h2><p><a href="marketing-product.html">Marketing & Product analysis →</a></p><p><a href="intake-decision.html">Corrected intake decision →</a></p><p><a href="aggregates.json">Download aggregate JSON →</a></p><p><a href="manifest.json">Source and quality manifest →</a></p></section>'
    return shell('Arabica evidence hub','Private, offline review of the verified synthetic-data snapshot.',body)


def write_reports(data: dict, destination: Path) -> None:
    """Write the three self-contained HTML views and their aggregate JSON."""
    destination.mkdir(parents=True,exist_ok=True)
    (destination/'aggregates.json').write_text(json.dumps(data,indent=2,ensure_ascii=False,default=str)+'\n',encoding='utf-8')
    for name,content in [('index.html',hub(data)),('marketing-product.html',marketing_product(data)),('intake-decision.html',intake(data))]:
        (destination/name).write_text(content,encoding='utf-8')
