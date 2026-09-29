"""Build the editable, source-linked intake cost sensitivity workbook."""
from __future__ import annotations

from pathlib import Path

from openpyxl import Workbook
from openpyxl.chart import LineChart, Reference
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.workbook.properties import CalcProperties

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "INTAKE_COST_ESTIMATE.xlsx"
NAVY = "17343B"
TEAL = "147D76"
PALE = "EAF4F2"
AMBER = "FFF0C2"
WHITE = "FFFFFF"

# Row numbers are deliberate: scenario formulas point to these editable assumptions.
INPUTS = [
    (5, "V1 complaints, complete 2025", 4118, "complaints/year", "Silver aggregate: Cargo no reconocido by creation_date", "observed synthetic"),
    (6, "Calendar days in 2025", 365, "days", "Calendar fact", "fact"),
    (7, "Modeled days per month", 30, "days", "Comparable 30-day month", "assumption"),
    (8, "Current HTTP requests per episode", 3, "requests", "POST session, GET charges, POST case; agent reads excluded", "code-derived"),
    (9, "Planned HTTP requests per episode", 10, "requests", "Future AI flow; measure from application traces", "assumption"),
    (10, "Peak-hour fraction", 0.10, "share of day's requests", "10% of daily traffic in busiest hour", "assumption"),
    (11, "Within-hour burst multiplier", 1, "factor", "Set >1 to stress minute-level clustering", "assumption"),
    (12, "Mean request service time", 2, "seconds", "Not measured; not a p95 or capacity test", "assumption"),
    (13, "AI input tokens per episode", 12000, "tokens", "Total across model calls; no AI is running today", "assumption"),
    (14, "AI output tokens per episode", 2000, "tokens", "Total across model calls, including billed reasoning output", "assumption"),
    (15, "Model input rate", 0.20, "USD / 1M tokens", "OpenAI GPT-5.6 Luna standard text input", "official price"),
    (16, "Model output rate", 1.20, "USD / 1M tokens", "OpenAI GPT-5.6 Luna standard text output", "official price"),
    (17, "Render paid web", 7, "USD/month", "0.5c-512mb; one worker/instance", "official price"),
    (18, "Render Postgres compute", 6, "USD/month", "0.1c-256mb; not load-tested", "official price"),
    (19, "Render Postgres allocated storage", 1, "GB", "Model assumption; billed storage allocation", "assumption"),
    (20, "Render Postgres storage rate", 0.30, "USD/GB-month", "Published storage rate", "official price"),
    (21, "Lightsail Linux VM, public IPv4", 24, "USD/month", "4 GB, 2 vCPU, 80 GB SSD; fixed single VM", "official price"),
    (22, "Lightsail billable snapshot size", 20, "GB-month", "Snapshot usage assumption; not backup guarantee", "assumption"),
    (23, "Lightsail snapshot rate", 0.05, "USD/GB-month", "Instance/disk snapshots", "official price"),
    (24, "Lightsail object bundle", 1, "USD/month", "Optional 5 GB bundle; set 0 if unused", "optional price"),
    (25, "Lightsail managed DB alternative", 30, "USD/month", "2 GB encrypted standard plan; add to VM", "official price"),
    (26, "Other monthly costs", 0, "USD/month", "Placeholder only: domain, logs, egress, security, operations", "unknown"),
    (27, "Confirmed AWS monthly credit", 0, "USD/month", "Only if verified for this AWS account; AWS only", "unconfirmed"),
    (28, "Confirmed Render monthly credit", 0, "USD/month", "Only if verified for this Render account", "unconfirmed"),
    (29, "Confirmed model API monthly credit", 0, "USD/month", "Only if verified with model provider", "unconfirmed"),
    (30, "Safe accepted-intake rate", None, "share of eligible starts", "Blank until start-to-acceptance events exist", "not measured"),
    (31, "Safe automated-resolution rate", None, "share of eligible starts", "Blank; a handoff does not count as resolution", "not measured"),
    (32, "Agent minutes saved per accepted case", None, "minutes", "Blank: no causal comparison or time study", "not measured"),
    (33, "Loaded agent cost per minute", None, "USD/minute", "Blank: no approved labor-cost assumption", "not measured"),
    (34, "Illustrative model", "gpt-5.6-luna", "model", "Not implemented or selected for V1", "illustrative"),
    (35, "Eligible starts per complaint proxy", 1, "starts/complaint", "Only for demand illustration; complaint != observed app start", "assumption"),
]


def title(ws, text, last_col):
    """Add one readable title row and freeze the evidence headers."""
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=last_col)
    cell = ws.cell(1, 1, text)
    cell.fill = PatternFill("solid", fgColor=NAVY)
    cell.font = Font(name="Aptos Display", size=17, bold=True, color=WHITE)
    cell.alignment = Alignment(vertical="center")
    ws.row_dimensions[1].height = 34
    ws.sheet_view.showGridLines = False


def header(ws, row, labels):
    """Style the fixed column headers."""
    for col, label in enumerate(labels, start=1):
        c = ws.cell(row, col, label)
        c.fill = PatternFill("solid", fgColor=TEAL)
        c.font = Font(bold=True, color=WHITE)
        c.alignment = Alignment(wrap_text=True, vertical="center")
    ws.row_dimensions[row].height = 32


wb = Workbook()
wb.calculation = CalcProperties(calcMode="auto", fullCalcOnLoad=True)
readme = wb.active
readme.title = "Read me"
title(readme, "ArabicaAI | Intake cost sensitivity", 5)
readme["A3"] = "Decision use"
readme["B3"] = "Budget a small synthetic-data demo; validate V1 outcomes before claiming savings or production capacity."
readme["A5"] = "Observed demand"
readme["B5"] = "4,118 V1 complaints in 2025 (complete calendar year); not logged application starts or production traffic."
readme["A6"] = "Today"
readme["B6"] = "The demo has no model calls and no deployed cloud service. Model and cloud costs are proposed scenarios."
readme["A7"] = "Scenarios"
readme["B7"] = "11.3/day V1 complaint proxy, then 100, 900, and 9,000/day stress assumptions."
readme["A8"] = "Interpretation"
readme["B8"] = "900/day is an all-contact stress case, not V1 demand. Constant VM pricing does not establish capacity."
readme["A9"] = "Missing outcome"
readme["B9"] = "Safe accepted intake / all eligible starts and safe automated resolution are unmeasured."
readme["A10"] = "Important limit"
readme["B10"] = "Lightsail VM self-hosts PostgreSQL in the $24 scenario; managed DB is a separate $30 add-on."
readme["A11"] = "Editing"
readme["B11"] = "Change pale-yellow values on Inputs. Blue-green cells on Scenarios recalculate in Excel/LibreOffice."
readme["A12"] = "Cloudflare candidate"
readme["B12"] = "Worker + D1 may have $0 fixed cloud cost inside Free limits; a code migration and CPU/D1 checks are required. See its separate sheet."
readme["A13"] = "Not in estimate"
readme["B13"] = "Taxes, exchange rates, domain, paid logs, egress overages, S3 transfer, model tools/audio, labor, support, HA, security operations."
readme["A15"] = "Reviewed"
readme["B15"] = "2026-09-29; prices should be rechecked before spending. No credits assumed."
readme.column_dimensions["A"].width = 22
readme.column_dimensions["B"].width = 105
for row in range(3, 16):
    readme.cell(row, 2).alignment = Alignment(wrap_text=True, vertical="top")
    readme.row_dimensions[row].height = 32 if row in (3, 5, 6, 7, 8, 9, 10, 11, 12, 13) else 22

ws = wb.create_sheet("Inputs")
title(ws, "Editable inputs | yellow = change with evidence", 5)
header(ws, 3, ("Parameter", "Value", "Unit", "Definition or source", "Evidence status"))
for row, label, value, unit, evidence, status in INPUTS:
    ws.cell(row, 1, label)
    c = ws.cell(row, 2, value)
    c.fill = PatternFill("solid", fgColor=AMBER)
    c.font = Font(bold=True, color=NAVY)
    ws.cell(row, 3, unit)
    ws.cell(row, 4, evidence)
    ws.cell(row, 5, status)
    for col in range(1, 6):
        ws.cell(row, col).alignment = Alignment(wrap_text=True, vertical="center")
    ws.row_dimensions[row].height = 29
for col, width in {"A": 39, "B": 19, "C": 25, "D": 70, "E": 20}.items():
    ws.column_dimensions[col].width = width
ws.freeze_panes = "B4"
ws.auto_filter.ref = "A3:E35"
for row in (10, 30, 31):
    ws.cell(row, 2).number_format = "0.0%"
for row in (15, 16, 17, 18, 20, 21, 23, 24, 25, 26, 27, 28, 29, 33):
    ws.cell(row, 2).number_format = '"$"#,##0.00'
ws["B30"].comment = Comment("Leave blank until eligible starts and safe accepted cases are instrumented.", "ArabicaAI")
ws["B31"].comment = Comment("A handoff is not an automated resolution. Leave blank until measured.", "ArabicaAI")

sc = wb.create_sheet("Scenarios")
title(sc, "Volume, token and infrastructure sensitivity", 19)
sc["A2"] = "All totals USD/month, before taxes. Planned AI assumes GPT-5.6 Luna standard text; current demo uses no AI."
sc.merge_cells("A2:S2")
sc["A2"].font = Font(italic=True, color=NAVY)
headers = ["Scenario", "Episodes/day", "Episodes/month", "Current HTTP req/month", "Planned HTTP req/month",
           "Peak planned req/hour", "Peak req/s", "Mean in-flight req", "AI USD/episode",
           "AI USD/month", "Render fixed USD/month", "AWS single VM fixed", "AWS + managed DB fixed",
           "Render + AI USD/month", "AWS single VM + AI", "AWS managed DB + AI", "Cost / safe auto resolution",
           "Render + AI / attempt", "Render without AI / attempt"]
header(sc, 4, headers)
for r, name, daily in ((5, "2025 V1 complaint proxy", "=Inputs!B5/Inputs!B6*Inputs!B35"),
                       (6, "100/day test", 100), (7, "900/day all-contact stress", 900),
                       (8, "9,000/day stress", 9000)):
    sc.cell(r, 1, name)
    sc.cell(r, 2, daily)
    f = {
        3: f"=B{r}*Inputs!B7", 4: f"=C{r}*Inputs!B8", 5: f"=C{r}*Inputs!B9",
        6: f"=B{r}*Inputs!B9*Inputs!B10*Inputs!B11", 7: f"=F{r}/3600",
        8: f"=G{r}*Inputs!B12", 9: "=(Inputs!B13*Inputs!B15+Inputs!B14*Inputs!B16)/1000000",
        10: f"=MAX(0,C{r}*I{r}-Inputs!B29)",
        11: "=MAX(0,Inputs!B17+Inputs!B18+Inputs!B19*Inputs!B20+Inputs!B26-Inputs!B28)",
        12: "=MAX(0,Inputs!B21+Inputs!B22*Inputs!B23+Inputs!B24+Inputs!B26-Inputs!B27)",
        13: f"=L{r}+Inputs!B25", 14: f"=J{r}+K{r}", 15: f"=J{r}+L{r}",
        16: f"=J{r}+M{r}",
        17: f'=IF(OR(NOT(ISNUMBER(Inputs!B31)),Inputs!B31<=0),"not defined",N{r}/(C{r}*Inputs!B31))',
        18: f'=IF(C{r}>0,N{r}/C{r},"not defined")',
        19: f'=IF(C{r}>0,K{r}/C{r},"not defined")',
    }
    for col, formula in f.items():
        sc.cell(r, col, formula)
    for col in range(1, 20):
        sc.cell(r, col).alignment = Alignment(wrap_text=True, vertical="center")
        if col >= 3:
            sc.cell(r, col).fill = PatternFill("solid", fgColor=PALE)
    sc.row_dimensions[r].height = 40
    for col in (9, 10, 11, 12, 13, 14, 15, 16):
        sc.cell(r, col).number_format = '"$"#,##0.00;[Red]("$"#,##0.00)'
    for col in (17, 18, 19):
        sc.cell(r, col).number_format = '"$"#,##0.0000;[Red]("$"#,##0.0000)'
    for col in (2, 3, 4, 5, 6, 7, 8):
        sc.cell(r, col).number_format = '#,##0.00'
sc["A10"] = "Current demo cloud spend"
sc["B10"] = "Not deployed: $0 actual cloud bill. Render fixed cost is hypothetical if deployed."
sc.merge_cells("B10:S10")
sc["A11"] = "Capacity warning"
sc["B11"] = "Peak req/s and in-flight values are arithmetic from assumptions, not a benchmark or a latency guarantee."
sc.merge_cells("B11:S11")
sc["A12"] = "Success warning"
sc["B12"] = "Cost per safe automated resolution is not defined until numerator and eligible-start denominator are observed."
sc.merge_cells("B12:S12")
for col in range(1, 20):
    sc.column_dimensions[get_column_letter(col)].width = 22 if col > 1 else 31
sc.column_dimensions["Q"].width = 30
sc.column_dimensions["R"].width = 27
sc.column_dimensions["S"].width = 30
sc.freeze_panes = "C5"
sc.auto_filter.ref = "A4:S8"
chart = LineChart()
chart.title = "Illustrative monthly cost by daily episodes"
chart.y_axis.title = "USD/month"
chart.x_axis.title = "Scenario"
for col in (14, 15, 16):
    chart.add_data(Reference(sc, min_col=col, min_row=4, max_row=8), titles_from_data=True)
chart.set_categories(Reference(sc, min_col=1, min_row=5, max_row=8))
chart.height = 10
chart.width = 23
sc.add_chart(chart, "A15")

src = wb.create_sheet("Evidence and prices")
title(src, "Sources, scope and pricing basis", 4)
header(src, 3, ("Item", "Evidence", "Source URL or repo path", "Interpretation"))
sources = [
    ("V1 demand", "4,118 complaints in 2025; 12,297 all dates; 6,192 via Call Center all dates", "data_foundation/reports/aggregates.json", "Synthetic complaints, not app starts or forecast"),
    ("Actual application", "FastAPI intake; 3 customer HTTP calls in normal path; no AI SDK or model call", "demo_api.py; demo-ui/src/app/app.ts", "No measured tokens, p95 or production throughput"),
    ("Hackathon metric", "Cost per attempt and successful automated resolution, with denominator", "Docs/FACTORED_HACKATHON_2026.md", "Handoff is not automated resolution"),
    ("OpenAI model", "GPT-5.6 Luna standard: $0.20 input, $1.20 output per million text tokens", "https://developers.openai.com/api/docs/models/gpt-5.6-luna", "Illustrative provider/model; no cache, tool, audio or batch discount"),
    ("AWS Lightsail", "$24/mo IPv4 Linux VM 4GB; $0.05/GB-month snapshots; $1/mo 5GB object bundle; $30/mo 2GB encrypted managed DB", "https://aws.amazon.com/lightsail/pricing/", "VM alone means self-managed PostgreSQL; capacity untested"),
    ("Render", "$7/mo web, $6/mo Postgres, $0.30/GB-month allocated Postgres storage", "https://render.com/pricing", "Paid proposed deployment; job, egress, taxes extra"),
    ("AWS credits", "Up to $200 for eligible new accounts; workbook assumes zero", "https://aws.amazon.com/free/", "AWS credits cannot reduce separate OpenAI bill"),
    ("Official AWS calculator", "Use for region and service-specific quote before purchase", "https://calculator.aws/", "This workbook is not a calculator export"),
    ("Cloudflare Workers Free", "100,000 requests/day, 10 ms CPU/request", "https://developers.cloudflare.com/workers/platform/pricing/", "Conditional free candidate; this report has no measured CPU usage"),
    ("Cloudflare D1 Free", "5M rows read/day, 100k rows written/day, 500 MB per database", "https://developers.cloudflare.com/d1/platform/limits/", "No measured D1 row scans or storage forecast"),
]
for r, values in enumerate(sources, start=4):
    for col, value in enumerate(values, start=1):
        c = src.cell(r, col, value)
        c.alignment = Alignment(wrap_text=True, vertical="top")
        if col == 3 and value.startswith("https://"):
            c.hyperlink = value
            c.font = Font(color="0563C1", underline="single")
    src.row_dimensions[r].height = 62
for col, width in {"A": 24, "B": 78, "C": 74, "D": 63}.items():
    src.column_dimensions[col].width = width
src.freeze_panes = "A4"

cf = wb.create_sheet("Cloudflare candidate")
title(cf, "Cloudflare Worker + D1 | conditional Free plan", 7)
cf["A2"] = "A connected GitHub repo does not migrate the current PostgreSQL demo. The Worker variant must pass live CPU and D1 checks."
cf.merge_cells("A2:G2")
header(cf, 4, ("Scenario", "Episodes/day", "Planned Worker req/day", "Free req/day cap", "Request headroom", "Request-cap check", "Illustrative AI USD/month"))
for r, source_row in enumerate(range(5, 9), start=5):
    cf.cell(r, 1, f"=Scenarios!A{source_row}")
    cf.cell(r, 2, f"=Scenarios!B{source_row}")
    cf.cell(r, 3, f"=B{r}*Inputs!B9")
    cf.cell(r, 4, 100000)
    cf.cell(r, 5, f"=D{r}-C{r}")
    cf.cell(r, 6, f'=IF(C{r}<=D{r},"under request cap","over request cap")')
    cf.cell(r, 7, f"=Scenarios!J{source_row}")
    cf.cell(r, 7).number_format = '"$"#,##0.00'
    cf.row_dimensions[r].height = 28
cf["A10"] = "Potential fixed hosting"
cf["B10"] = "$0 only while Worker and D1 stay inside Free quotas; not a capacity promise."
cf.merge_cells("B10:G10")
cf["A11"] = "Still unmeasured"
cf["B11"] = "CPU ms/request (Free: 10 ms); D1 rows read/write, DB size, retries, static requests, peak traffic."
cf.merge_cells("B11:G11")
cf["A12"] = "Model charges"
cf["B12"] = "AI usage in column G is hypothetical and billed separately from Cloudflare. Current demo uses no model."
cf.merge_cells("B12:G12")
cf["A13"] = "Readiness"
cf["B13"] = "The 9,000/day scenario has only 10,000 requests/day headroom under the assumed 10 calls/episode."
cf.merge_cells("B13:G13")
for column, width in {"A": 34, "B": 20, "C": 27, "D": 24, "E": 23, "F": 25, "G": 31}.items():
    cf.column_dimensions[column].width = width
cf.freeze_panes = "B5"

wb.save(OUTPUT)
print(OUTPUT)
