"""Render self-contained, aggregate-only evidence pages for private repository review."""
from __future__ import annotations

import html
import json
from calendar import monthrange
from datetime import date
from pathlib import Path

from data_foundation.src.marketing_product_insights import summarize_insights

STYLE = """<style>
:root{font-family:Inter,system-ui,sans-serif;color:#162b35;background:#edf2f0}*{box-sizing:border-box}body{margin:0}
header{background:#10343a;color:#fff;padding:46px max(24px,calc((100vw - 1100px)/2))}header p{max-width:780px;line-height:1.6;color:#d0e5e1}
main{max-width:1100px;margin:auto;padding:28px 24px 70px}h1{font-size:clamp(2rem,5vw,3.4rem);margin:0 0 12px}h2{font-size:1.5rem;margin:0 0 16px}
section{background:#fff;border-radius:16px;padding:26px;margin:18px 0;box-shadow:0 2px 14px #173e3b12}p,li{line-height:1.55}small,.muted{color:#536970}
nav{display:flex;gap:18px;flex-wrap:wrap;margin-top:22px}a{color:#0e746f}header a{color:#b8fff3}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}.card{background:#eef7f4;padding:18px;border-radius:12px}.card b{display:block;font-size:1.8rem;color:#0b5f58}
.tablewrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{padding:10px;border-bottom:1px solid #d9e5e1;text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}th{background:#eaf4f0;position:sticky;top:0}
.bar{display:flex;align-items:center;gap:12px;margin:12px 0}.bar span:first-child{width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.track{height:22px;background:#e0ece8;border-radius:12px;flex:1;overflow:hidden}.fill{height:100%;background:#d68b53}.bar b{width:100px;text-align:right;font-size:.85rem}
.note{border-left:4px solid #d68b53;padding:12px 16px;background:#fff6eb}.timeseries{width:100%;height:auto}.timeseries text{fill:#536970;font-size:11px}figure{margin:20px 0}figcaption{font-weight:650;margin-bottom:8px}select{padding:8px;border:1px solid #9db5ad;border-radius:6px}.filters{display:flex;gap:16px;flex-wrap:wrap;align-items:end}.filters label{display:grid;gap:5px}.filters select{min-width:130px}.decision{border-left:5px solid #0e746f}.decision table td:first-child{white-space:normal}.takeaways{display:grid;gap:12px}.takeaways article{padding:14px 18px;background:#eef7f4;border-radius:10px}.takeaways h3{margin:0 0 6px}.takeaways p{margin:0}details{margin:14px 0}summary{cursor:pointer;font-weight:650}footer{color:#617675;margin-top:30px}
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


def complete_activity_rows(activity: dict) -> list[dict]:
    """Keep transitions whose previous and current calendar months are observed in full."""
    first_day = date.fromisoformat(str(activity['first_transaction'])[:10])
    last_day = date.fromisoformat(str(activity['last_transaction'])[:10])
    start = 2 if first_day.day > 1 else 1
    end = -1 if last_day.day < monthrange(last_day.year, last_day.month)[1] else None
    return activity['monthly'][start:end]


def complete_intake_years(intake: dict) -> list[dict]:
    """Sum V1 complaints for fully observed interior calendar years."""
    v1 = next((r for r in intake['populations'] if r['population'].startswith('V1:')), None)
    if not v1:
        return []
    first_date = date.fromisoformat(str(v1['first_created'])[:10])
    last_date = date.fromisoformat(str(v1['last_created'])[:10])
    months: dict[int, list[dict]] = {}
    for row in intake['monthly']:
        months.setdefault(int(str(row['month'])[:4]), []).append(row)
    full_months = {f'{month:02d}' for month in range(1, 13)}
    return [{'year': year, 'v1': sum(row['v1'] for row in rows)}
            for year, rows in sorted(months.items())
            if first_date < date(year, 1, 1) and date(year, 12, 31) < last_date
            and len(rows) == 12 and {str(row['month'])[5:7] for row in rows} == full_months]


def marketing_product(data: dict, insights: dict | None = None) -> str:
    """Render independent Marketing and Product decisions from aggregate evidence."""
    m, p, d, econ, activity = data["marketing"], data["products"], data["digital"], data["economics"], data["activity"]
    o, q, e, s = m["overall"], m["quality"], d["events"], d["sessions"]
    insight = insights if insights is not None else summarize_insights(data)
    marketing_change = insight["marketing"]["recorded_conversion_change"]
    activity_change = insight["product"]["activity_continuation_change"]
    activity_last_day = date.fromisoformat(str(activity['last_transaction'])[:10])
    body = '<section class="decision"><h2>Marketing and Product: what changes a decision?</h2><div class="takeaways">'
    if activity_change:
        change = activity_change
        spread = change["resampled_change_pp"]
        body += (
            '<article><h3>Product: repeat transaction activity rose</h3><p>'
            f'{change["earlier_rate_pct"]:.2f}% in 2024 → {change["later_rate_pct"]:.2f}% in 2025 '
            f'({change["observed_change_pp"]:+.2f} percentage points); '
            f'{change["matched_months_higher"]}/12 matched months were higher. '
            f'Month-pair Monte Carlo change: P20 {spread["p20"]:+.2f}, '
            f'P50 {spread["p50"]:+.2f}, P80 {spread["p80"]:+.2f} points. '
            'This is adjacent-month transaction activity; cohort mix and causes remain unknown.</p></article>'
        )
    body += (
        '<article><h3>Product: feature-use analysis is blocked</h3><p>'
        f'{num(insight["product"]["digital_product_owner_mismatch"])} / '
        f'{num(insight["product"]["identified_digital_product_links"])} identified '
        'digital product links disagree with the product owner. The generic session '
        'funnel has no verified task-completion event. Fix identity and outcome events '
        'before ranking features.</p></article>'
    )
    silent = insight["marketing"]["silent_channels"]
    body += (
        '<article><h3>Marketing: audit channel measurement first</h3><p>'
        f'{num(silent["sends"])} sends ({pct(silent["sends"],o["sends"])}) went through '
        'WhatsApp or Voice; they have no known opens and zero recorded clicks or '
        'conversions. Another '+num(insight["marketing"]["current_opt_out_sends"])+
        ' send records belong to customers opted out in the current snapshot. '
        'Neither finding proves poor channel performance or a historical consent violation.</p></article>'
    )
    if marketing_change:
        change = marketing_change
        spread = change["resampled_change_pp"]
        body += (
            '<article><h3>Marketing: the annual response change is uncertain</h3><p>'
            f'Recorded conversion per send moved from {change["earlier_rate_pct"]:.3f}% '
            f'to {change["later_rate_pct"]:.3f}% ({change["observed_change_pp"]:+.3f} points). '
            f'Month-pair Monte Carlo change: P20 {spread["p20"]:+.3f}, '
            f'P50 {spread["p50"]:+.3f}, P80 {spread["p80"]:+.3f} points. '
            'The wider exploratory range includes zero. Do not call this a measured '
            'decline in customer acquisition.</p></article>'
        )
    body += '</div></section>'
    body += '<section><h2>Which customer questions are worth pursuing?</h2><p><strong>Product:</strong> Why did adjacent-month transaction activity strengthen, and can customers actually finish a specific digital task? The current snapshot gives a behavioral signal, but no task outcome or historical product state. Start with one defined journey, repaired product ownership, completion/failure events and direct customer or agent review.</p><p><strong>Marketing:</strong> Are customers receiving too many or irrelevant messages, and which channel can be measured fairly? The sample has '+f'{insight["marketing"]["sends"] / insight["marketing"]["exposed_customers"]:.2f}'+' sends per exposed customer on average. Recover consent and segment at send time, reconcile channel-specific response definitions, and test a verified outcome against a holdout before personalizing.</p><p>These are discovery questions for this synthetic dataset, not claims about real bank customers. The selected hackathon intake workflow remains a separate decision; <a href="intake-decision.html">its complaint evidence is here</a>.</p></section>'
    if marketing_change and activity_change:
        def change_row(label: str, change: dict, digits: int) -> dict:
            """Format month-resampling sensitivity without implying causal inference."""
            spread = change["resampled_change_pp"]
            fmt = f".{digits}f"
            return {
                "metric": label,
                "annual": f'{change["earlier_rate_pct"]:{fmt}}% → {change["later_rate_pct"]:{fmt}}%',
                "observed": f'{change["observed_change_pp"]:+{fmt}}',
                "p20": f'{spread["p20"]:+{fmt}}',
                "p50": f'{spread["p50"]:+{fmt}}',
                "p80": f'{spread["p80"]:+{fmt}}',
                "range": f'{spread["p2_5"]:+{fmt}} to {spread["p97_5"]:+{fmt}}',
            }
        body += '<section><h2>2024–2025 month-level sensitivity</h2>'
        body += table([
            change_row('Activity continuation', activity_change, 2),
            change_row('Recorded conversion / send', marketing_change, 3),
        ], [('metric','Measure'),('annual','2024 → 2025'),('observed','Change, pp'),
            ('p20','P20, pp'),('p50','P50, pp'),('p80','P80, pp'),
            ('range','P2.5–P97.5, pp')])
        body += (
            '<p><strong>Method and assumption.</strong> The annual rates and changes above '
            'are exact for this synthetic snapshot. For sensitivity only, 20,000 seeded '
            'draws (20260928; product uses 20260929) sample 12 matched calendar-month '
            'pairs with replacement and recompute each denominator-weighted rate. '
            'This treats months as exchangeable; season pairing does not remove trend, '
            'serial dependence or repeated customers. P2.5–P97.5 is a simulation range, '
            'not a 95% confidence interval. It is not a production forecast or a '
            'causal effect. Only complete 2024 and 2025 enter.</p>'
            f'<p><strong>Without simulation:</strong> leaving out any one month gives '
            f'{activity_change["leave_one_month_out_change_pp"]["min"]:+.2f} to '
            f'{activity_change["leave_one_month_out_change_pp"]["max"]:+.2f} points '
            f'for activity continuation, and '
            f'{marketing_change["leave_one_month_out_change_pp"]["min"]:+.3f} to '
            f'{marketing_change["leave_one_month_out_change_pp"]["max"]:+.3f} for '
            f'recorded conversion per send. The Marketing change is '
            f'{marketing_change["half_year_change_pp"]["jan_jun"]:+.3f} points '
            f'in Jan–Jun and {marketing_change["half_year_change_pp"]["jul_dec"]:+.3f} '
            'in Jul–Dec. These are descriptive checks, not significance tests. '
            '<a href="marketing-product-insights.json">Download exact counts, diagnostics '
            'and simulation settings</a>.</p></section>'
        )
    body += '<section><h2>What is measurable by month or year?</h2><p>Choose a year and, optionally, one month. Send measures use business send_date; product activity uses transaction_date. A year combines monthly customer-month transitions, not distinct retained customers for the year.</p><div class="filters"><label>Year <select id="time-year"><option value="all">All available</option></select></label><label>Month <select id="time-month"><option value="all">All months</option></select></label></div><p id="time-window" class="muted"></p><div id="time-cards" class="cards"></div><div id="time-send"></div><div id="time-rate"></div><div id="time-activity"></div><p class="note">The activity measure is <strong>adjacent-month transaction activity continuation</strong>: customers with an approved, owner-matched, post-opening transaction in both months / customers with one in the previous month. It is not contractual customer retention or proof of feature use. The first month has no observed predecessor; if it began mid-month, its follow-up is also excluded from the continuation rate. The last observed transaction month ends on '+esc(activity_last_day)+'; if incomplete, it is excluded from the continuation rate. The latest send month may also have incomplete conversions. Current product ownership and the digital funnel below remain full-snapshot measures and do not change with this filter.</p></section>'
    body += '<section><h2>Decision from this evidence</h2>'
    body += table([
      {"work":"Product journey discovery", "decision":"Investigate", "reason":"Validate the repeat-activity signal with stable customer cohorts and one verified digital task outcome."},
      {"work":"Marketing measurement and consent history", "decision":"Repair first", "reason":"Reconcile channel response definitions and consent at send time before comparing or targeting customers."},
      {"work":"Attribution, CAC/LTV and personalization models", "decision":"Wait", "reason":"No verified acquisition, bank contribution, historical consent or randomized holdout supports a value claim."},
    ],[("work","Use case"),("decision","Decision"),("reason","Evidence threshold")])
    body += '<p>None of these records establishes what a real customer needs. Use interviews or reviewed service cases to validate the problem before funding a model.</p></section>'
    body += '<section><h2>Open questions and missing sources</h2>'
    body += table([
      {"question":"Did a customer complete a digital task?", "missing":"Task ID, start, backend-confirmed completion, error and subsequent support contact"},
      {"question":"Did a message help rather than add unwanted contact?", "missing":"Consent and segment at exposure time, outcome, customer-level assignment and holdout"},
      {"question":"Did a lead become a customer?", "missing":"Prospect ID, verified creation event and durable lead-to-customer link"},
      {"question":"Did activity become retention or bank value?", "missing":"Effective-dated lifecycle, cohort eligibility, bank contribution and complete cost currency"},
    ],[("question","Decision question"),("missing","Missing source")])
    body += '<p>Send cost is known on '+num(econ['send_cost_known'])+' / '+num(econ['sends'])+' sends and campaign budget on '+num(econ['campaign_budget_known'])+' / '+num(econ['campaigns'])+' campaigns, with undocumented currency and overlap. '+num(econ['pre_registration_sends'])+' sends precede recipients’ current registration dates; this does not make them leads. Transaction amounts are customer cash flows, not bank revenue. See the <a href="../../Docs/Plans/marketing-product-gold-contract.md">Gold data request</a>.</p></section>'
    body += '<details><summary>Detailed Marketing and Product diagnostics</summary>'
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
    body += '<p>Rates by group always use the send grain. Out-of-window sends remain in the overall result; the sensitivity table shows their volume. Use the time filter above for monthly and yearly totals.</p></section>'
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
    for label,key,denom in [('Navigation view','navigation_view','eligible_sessions'),('Click after view','click_after_view','navigation_view'),('Submit after click','submit_after_click','click_after_view')]:
        body += card(label,num(s[key]),pct(s[key],s[denom])+f" of {num(s[denom])} {denom.replace('_',' ')}")
    body += '</div><p>Business event-date range: '+esc(e['first_event'])+' through '+esc(e['last_event'])+'. The first and last calendar years are partial.</p><p>Sessions: '+num(s['sessions'])+'; ambiguous customer sessions: '+num(s['ambiguous_customer_sessions'])+'; mixed anonymous/identified sessions: '+num(s['mixed_identity_sessions'])+'; anonymous events: '+num(e['anonymous_events'])+'; missing action: '+num(e['missing_action'])+' of '+num(e['events'])+' events. Event/process day mismatches: '+num(e['event_partition_day_mismatch'])+'.</p>'
    body += '<h3>Event labels and action coverage</h3>'+table(d['labels'], [('event_type','Type'),('event_category','Category'),('events','Events'),('missing_action','No action')])+'</section>'
    body += '<section><h2>Reading these diagnostics</h2><p>Current consent, product status and segment are snapshots. Campaign flags do not identify acquired customers, and generic events do not identify accepted cases. Opening-year product counts are a current active-product snapshot. The <a href="aggregates.json">aggregate JSON</a> and <a href="manifest.json">manifest</a> record the full counts, exclusions and source run.</p></section></details>'
    send_series = json.dumps(m['monthly'], ensure_ascii=False, default=str).replace('<','\\u003c')
    activity_series = json.dumps(activity['monthly'], ensure_ascii=False, default=str).replace('<','\\u003c')
    filter_script = r'''<script>
const sendMonths=__SEND_SERIES__, activityMonths=__ACTIVITY_SERIES__;
const lastSendDate=__LAST_SEND__, lastActivityDate=__LAST_ACTIVITY__, firstActivityDate=__FIRST_ACTIVITY__;
const activityEnd=lastActivityDate.split('-').map(Number),lastActivityPartial=activityEnd[2]<new Date(activityEnd[0],activityEnd[1],0).getDate(),firstActivityPartial=Number(firstActivityDate.slice(8,10))>1;
const yearPick=document.getElementById('time-year'), monthPick=document.getElementById('time-month');
const years=[...new Set([...sendMonths,...activityMonths].map(r=>r.month.slice(0,4)))].sort();
for(const year of years){const option=document.createElement('option');option.value=year;option.textContent=year;yearPick.append(option)}
for(let n=1;n<=12;n++){const option=document.createElement('option');option.value=String(n).padStart(2,'0');option.textContent=new Date(2024,n-1,1).toLocaleString('en',{month:'long'});monthPick.append(option)}
const svgNS='http://www.w3.org/2000/svg';
function node(parent,tag,attrs={},text){const el=document.createElementNS(svgNS,tag);for(const [key,value] of Object.entries(attrs))el.setAttribute(key,value);if(text!==undefined)el.textContent=text;parent.append(el);return el}
function rateOrNA(n,d){return d?(100*n/d).toFixed(2)+'%':'n/a'}
function sum(rows,key){return rows.reduce((total,row)=>total+(row[key]||0),0)}
function filtered(rows){return rows.filter(row=>(yearPick.value==='all'||row.month.slice(0,4)===yearPick.value)&&(monthPick.value==='all'||row.month.slice(5,7)===monthPick.value))}
function drawTimePlot(target,rows,metric,title){
 target.replaceChildren();const figure=document.createElement('figure');const caption=document.createElement('figcaption');caption.textContent=title;figure.append(caption);target.append(figure);
 if(!rows.length){const empty=document.createElement('p');empty.textContent='No observations for this period';figure.append(empty);return}
 const svg=node(figure,'svg',{class:'timeseries',role:'img','aria-label':title,viewBox:'0 0 980 280'});
 const values=rows.map(r=>metric==='sends'?r.sends:metric==='rate'?(r.sends?100*r.recorded_conversions/r.sends:0):r.active_customers);
 const top=25,bottom=226,left=65,right=925,max=Math.max(...values);
 const ceiling=metric==='rate'?Math.max(1,Math.ceil(max*5)/5):Math.max(1,Math.ceil(max/10000)*10000);
 const x=i=>rows.length===1?(left+right)/2:left+i*(right-left)/(rows.length-1);
 const y=v=>bottom-v*(bottom-top)/ceiling;
 const last=rows[rows.length-1].month.slice(0,7),globalLast=(metric==='sends'||metric==='rate'?sendMonths:activityMonths).at(-1).month.slice(0,7);
 const endDate=metric==='activity'?lastActivityDate:lastSendDate;const parts=endDate.slice(0,10).split('-').map(Number);const isPartial=parts[2]<new Date(parts[0],parts[1],0).getDate();
 if(last===globalLast&&last===endDate.slice(0,7)&&isPartial){const width=rows.length===1?100:(right-left)/(rows.length-1);node(svg,'rect',{x:(x(rows.length-1)-width/2).toFixed(1),y:top,width:width.toFixed(1),height:bottom-top,fill:'#fff2d8'});node(svg,'text',{x:right,y:top+15,'text-anchor':'end'},'Partial month')}
 for(const f of [0,.25,.5,.75,1]){const yy=y(ceiling*f);node(svg,'line',{x1:left,y1:yy,x2:right,y2:yy,stroke:'#d5e3de'});node(svg,'text',{x:left-8,y:yy+4,'text-anchor':'end'},metric==='rate'?(ceiling*f).toFixed(2)+'%':Math.round(ceiling*f).toLocaleString())}
 const color=metric==='sends'?'#0d756e':metric==='rate'?'#bc653a':'#385f9a';
 node(svg,'polyline',{points:values.map((v,i)=>x(i).toFixed(1)+','+y(v).toFixed(1)).join(' '),fill:'none',stroke:color,'stroke-width':3});
 rows.forEach((r,i)=>{const dot=node(svg,'circle',{cx:x(i),cy:y(values[i]),r:5,fill:color});const detail=metric==='activity'?`${r.month.slice(0,7)}: ${r.active_customers.toLocaleString()} active customers; ${r.approved_transactions.toLocaleString()} approved transactions; ${r.continuing_customers.toLocaleString()}/${r.prior_active_customers.toLocaleString()} continued from prior month`: `${r.month.slice(0,7)}: ${r.sends.toLocaleString()} sends; ${r.recorded_conversions.toLocaleString()} recorded conversions; ${rateOrNA(r.recorded_conversions,r.sends)} per send`;node(dot,'title',{},detail);if(i%3===0||i===rows.length-1)node(svg,'text',{x:x(i),y:bottom+22,'text-anchor':'middle'},r.month.slice(0,7))});
}
function drawTime(){
 monthPick.disabled=yearPick.value==='all';if(monthPick.disabled)monthPick.value='all';
 const sends=filtered(sendMonths),activity=filtered(activityMonths),complete=activity.filter(r=>r.month!==activityMonths[0].month&&!(firstActivityPartial&&r.month===activityMonths[1]?.month)&&!(lastActivityPartial&&r.month===activityMonths.at(-1).month)),sc=sum(sends,'sends'),cv=sum(sends,'recorded_conversions'),tx=sum(activity,'approved_transactions'),ac=sum(activity,'active_customers'),co=sum(complete,'continuing_customers'),prior=sum(complete,'prior_active_customers');
 const cards=document.getElementById('time-cards');cards.replaceChildren();
 for(const [label,value,note] of [['Sends',sc.toLocaleString(),'deduplicated send records'],['Recorded conversion / send',rateOrNA(cv,sc),`${cv.toLocaleString()} / ${sc.toLocaleString()} sends`],['Approved transactions',tx.toLocaleString(),'owner matched; after product opening'],['Active customer-months',ac.toLocaleString(),'sum of monthly distinct customers'],['Adjacent-month continuation',rateOrNA(co,prior),`${co.toLocaleString()} / ${prior.toLocaleString()} complete previous-month customer-months; partial ends excluded`]]){const card=document.createElement('div');card.className='card';const small=document.createElement('small');small.textContent=label;const b=document.createElement('b');b.textContent=value;const detail=document.createElement('small');detail.textContent=note;card.append(small,b,detail);cards.append(card)}
 document.getElementById('time-window').textContent=`Selected: ${yearPick.value==='all'?'all available years':yearPick.value}${monthPick.value==='all'?'': '-'+monthPick.value}. ${sends.length} send months and ${activity.length} activity months. Activity months: ${activityMonths[0].month.slice(0,7)} to ${activityMonths.at(-1).month.slice(0,7)}; boundaries may be partial.`;
 drawTimePlot(document.getElementById('time-send'),sends,'sends','Campaign send volume by send month');drawTimePlot(document.getElementById('time-rate'),sends,'rate','Recorded conversion per send month');drawTimePlot(document.getElementById('time-activity'),activity,'activity','Approved transaction-active customers by transaction month');
}
yearPick.addEventListener('change',drawTime);monthPick.addEventListener('change',drawTime);drawTime();
</script>'''.replace('__SEND_SERIES__',send_series).replace('__ACTIVITY_SERIES__',activity_series).replace('__LAST_SEND__',json.dumps(str(q['last_send'])[:10])).replace('__LAST_ACTIVITY__',json.dumps(str(activity['last_transaction'])[:10])).replace('__FIRST_ACTIVITY__',json.dumps(str(activity['first_transaction'])[:10]))
    body += filter_script
    groups = json.dumps(m['groups'], ensure_ascii=False).replace('<','\\u003c')
    body += f'''<script>const groups={groups};const chart=document.getElementById('chart');const groupTable=document.getElementById('group-table');
function rate(n,d){{return d? (100*n/d).toFixed(2)+'% ('+n.toLocaleString()+'/'+d.toLocaleString()+')':'n/a (0 known)'}}
function draw(){{const dim=document.getElementById('dimension').value;chart.replaceChildren();const t=document.createElement('table');const head=document.createElement('tr');for(const name of ['Group','Sends','Delivery','Known opens','Known clicks','Recorded conversion']){{const th=document.createElement('th');th.textContent=name;head.append(th)}}t.append(head);
for(const row of groups[dim]){{const r=row.sends?100*row.recorded_conversions/row.sends:0;const div=document.createElement('div');div.className='bar';const label=document.createElement('span');label.textContent=row.label;const track=document.createElement('div');track.className='track';const fill=document.createElement('div');fill.className='fill';fill.style.width=Math.min(r*10,100)+'%';track.append(fill);const value=document.createElement('b');value.textContent=r.toFixed(2)+'% · '+row.recorded_conversions.toLocaleString()+'/'+row.sends.toLocaleString();div.append(label,track,value);chart.append(div);
const tr=document.createElement('tr');for(const val of [row.label,row.sends.toLocaleString(),rate(row.delivered,row.delivery_known),rate(row.opens,row.open_known),rate(row.clicks,row.click_known),rate(row.recorded_conversions,row.sends)]){{const td=document.createElement('td');td.textContent=val;tr.append(td)}}t.append(tr)}}groupTable.replaceChildren(t)}}document.getElementById('dimension').addEventListener('change',draw);draw()</script>'''
    return shell('Marketing & Product evidence', 'Customer questions, measured patterns and decisions from one verified synthetic-data snapshot.', body)


def intake(data: dict) -> str:
    """Render corrected V1 complaint population and its decision limits."""
    i=data['intake']; rows_by={r['population']:r for r in i['populations']}; v=rows_by.get('V1: Cargo no reconocido',{}); combined=sum(r['complaints'] for r in i['populations'])
    body='<section><h2>Selected V1: useful human handoff</h2><p>A customer reporting an unrecognized charge needs a complete, secure account of the issue that a human agent can use. The data support testing the handoff, not a promise of faster resolution.</p><div class="cards">'
    body += card('V1 complaints',num(v.get('complaints',0)),'Cargo no reconocido only')
    body += card('Via Call Center',num(v.get('call_center',0)),pct(v.get('call_center',0),v.get('complaints',0))+' of V1')
    body += card('Combined complaint labels',num(combined),'V1 plus Cobro indebido; separate population')
    body += card('Observed SLA breach',num(v.get('sla_breached',0)),pct(v.get('sla_breached',0),v.get('complaints',0))+' of V1; no causal link')
    body += '</div><p>Grouped by complaint creation_date. The broader combined total must never be labeled “unrecognized charges.”</p>'+table(i['populations'], [('population','Population'),('complaints','Complaints'),('call_center','Call Center'),('sla_breached','SLA breached'),('claimed_amount_known','Known claimed amount')])+'</section>'
    if i['bronze_link_audit']:
        audit=i['bronze_link_audit']; body += '<p class="note">Bronze origin_interaction_id populated: '+num(audit['populated_origin_links'])+' / '+num(audit['bronze_complaints'])+' complaints. This field was intentionally dropped from Silver.</p>'
    body += '<section><h2>Complete calendar years</h2><p>V1 complaint counts by creation date. The first and last observed years are partial.</p>'+table(complete_intake_years(i), [('year','Year'),('v1','V1 complaints')])+'</section>'
    body += '<details><summary>Monthly complaint counts by creation date</summary>'+table(i['monthly'], [('month','Creation month'),('v1','V1 only'),('broader_combined','Combined')])+'<p>Observed V1 dates: '+esc(v.get('first_created'))+' through '+esc(v.get('last_created'))+'. Boundary months can be partial.</p></details>'
    body += '<section><h2>What this cannot show</h2><ul>'+''.join('<li>'+esc(x)+'</li>' for x in i['limitations'])+'</ul><p>Do not infer that intake caused delays, reduced SLA breaches, or saved call time. Marketing targeting scores are unrelated to evidence for this V1. Next test: instrument every eligible start, customer approval, server-confirmed acceptance, reference delivery, failure, retry, handoff completeness, and unsafe outcomes. Accepted intake is not automated dispute resolution.</p></section>'
    return shell('Suspicious-charge intake decision', 'Corrected complaint population and evidence for a human-handoff test.', body)


def hub(data: dict, insights: dict | None = None) -> str:
    """Lead the private report index with the independent Marketing/Product findings."""
    result = insights if insights is not None else summarize_insights(data)
    activity = result["product"]["activity_continuation_change"]
    zero_channels = result["marketing"]["silent_channels"]
    body = '<section class="decision"><h2>Marketing and Product: decisions from this dataset</h2>'
    if activity:
        body += (
            f'<p><strong>Product:</strong> adjacent-month transaction activity rose '
            f'from {activity["earlier_rate_pct"]:.2f}% in 2024 to '
            f'{activity["later_rate_pct"]:.2f}% in 2025. That warrants cohort and '
            'task-completion discovery; it is not customer retention.</p>'
        )
    body += (
        f'<p><strong>Marketing:</strong> {num(zero_channels["sends"])} WhatsApp '
        'and Voice sends have no known opens and zero recorded clicks or '
        'conversions. Audit channel measurement and historical consent '
        'before reallocating spend or targeting customers.</p>'
        '<p><a href="marketing-product.html">Read the analysis and month-level '
        'Monte Carlo sensitivity →</a></p></section>'
    )
    body += (
        '<section><h2>Other evidence</h2><p><a href="intake-decision.html">'
        'Selected intake workflow →</a> · <a href="aggregates.json">'
        'Verified aggregate counts →</a> · <a href="marketing-product-insights.json">'
        'Derived findings and simulation settings →</a> · <a href="manifest.json">'
        'Source and quality manifest →</a></p><p>This is a synthetic snapshot. '
        'It does not establish campaign lift, product-feature effects, CAC, '
        'LTV or customer retention.</p></section>'
    )
    return shell('Arabica evidence hub',
                 'Private, offline review of verified synthetic data.', body)


def write_reports(data: dict, destination: Path) -> None:
    """Write offline HTML, source aggregates and deterministic derived insights."""
    destination.mkdir(parents=True,exist_ok=True)
    insights = summarize_insights(data)
    (destination/'aggregates.json').write_text(
        json.dumps(data,indent=2,ensure_ascii=False,default=str)+'\n',encoding='utf-8')
    (destination/'marketing-product-insights.json').write_text(
        json.dumps(insights,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    for name,content in [('index.html',hub(data,insights)),
                         ('marketing-product.html',marketing_product(data,insights)),
                         ('intake-decision.html',intake(data))]:
        (destination/name).write_text(content,encoding='utf-8')
