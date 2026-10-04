"""Render the target intake workflow with the online AI suggestion path (planned, switch off) as SVG.

It mirrors Docs/Plans/ai-suggestion-plan.md: the customer's request stays deterministic, the model runs
after the reference, every failure falls back to today's handoff, and the pilot measures it. Standard
library only; render to PNG with headless Chrome (see DATA_ENGINEERING.md, "Latency and the diagram").
"""
from pathlib import Path

W, H = 1600, 1180
out = []
add = out.append
INK, SUB, LINE = "#16191f", "#414d5c", "#41556b"


def box(x, y, w, h, title, sub="", fill="#ffffff", stroke="#41556b", dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="{stroke}" stroke-width="1.8"{d}/>')
    lines = sub.split("|") if sub else []
    top = y + h / 2 - (len(lines) * 15) / 2 + (4 if lines else 5)
    add(f'<text x="{x + w / 2}" y="{top}" text-anchor="middle" font-size="16" font-weight="650" fill="{INK}">{title}</text>')
    for i, line in enumerate(lines):
        add(f'<text x="{x + w / 2}" y="{top + 19 + i * 15}" text-anchor="middle" font-size="12.5" fill="{SUB}">{line}</text>')


def diamond(cx, cy, w, h, text):
    add(f'<polygon points="{cx},{cy - h / 2} {cx + w / 2},{cy} {cx},{cy + h / 2} {cx - w / 2},{cy}" fill="#ffffff" stroke="{LINE}" stroke-width="1.8"/>')
    for i, line in enumerate(text.split("|")):
        add(f'<text x="{cx}" y="{cy - 4 + i * 15}" text-anchor="middle" font-size="12.5" font-weight="600" fill="{INK}">{line}</text>')


def lane(y, h, title, note, fill, stroke):
    add(f'<rect x="30" y="{y}" width="{W - 60}" height="{h}" rx="14" fill="{fill}" stroke="{stroke}" stroke-width="1.4"/>')
    add(f'<text x="54" y="{y + 30}" font-size="18" font-weight="700" fill="{INK}">{title}</text>')
    add(f'<text x="54" y="{y + 52}" font-size="13" fill="{SUB}">{note}</text>')


def label(x, y, text, anchor="middle"):
    for i, line in enumerate(text.split("|")):
        add(f'<text x="{x}" y="{y + i * 14}" text-anchor="{anchor}" font-size="12" fill="#232f3e" '
            f'paint-order="stroke" stroke="#ffffff" stroke-width="4">{line}</text>')


def path(points, text="", dash=False, lx=None, ly=None, color=LINE, marker="a"):
    d = ' stroke-dasharray="6 5"' if dash else ""
    pts = " ".join(f"{x},{y}" for x, y in points)
    add(f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="1.8" marker-end="url(#{marker})"{d}/>')
    if text:
        label(lx, ly, text)


add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" '
    'aria-labelledby="title description" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif">')
add('<title id="title">ArabicaAI: target intake workflow with online AI suggestions</title>')
add('<desc id="description">The customer request stays deterministic and returns a reference after read-back. '
    'When the customer cannot find the charge, a model on Vertex AI reads the description after the response, '
    'deterministic code suggests up to three of the customer\'s own charges, the customer confirms one, and a person reviews. '
    'Every failure falls back to the incomplete handoff used today. Events without text feed the pilot measures and the offline evaluation.</desc>')
add('<defs>'
    f'<marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{LINE}"/></marker>'
    '<marker id="r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#c5221f"/></marker>'
    '</defs>')
add(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')
add(f'<text x="40" y="46" font-size="26" font-weight="700" fill="{INK}">ArabicaAI · target workflow with online AI suggestions</text>')
add(f'<text x="40" y="72" font-size="14" fill="{SUB}">Planned (Docs/Plans/ai-suggestion-plan.md, ADR-012). Today the switch is off and '
    'the flow is the deterministic part only. Solid: synchronous request · dashed: after the response · red: fallback.</text>')

# ---------- Lane 1: the customer's request, deterministic ----------
lane(95, 270, "1 · The customer's request: deterministic, answered in one round trip",
     "No model call here. A reference is shown only after the case row is read back (ADR-002). Target p95 below 2,000 ms.",
     "#edf6f3", "#9cc8b8")
box(60, 175, 190, 90, "Customer", "signed in (Cognito code)|ES · PT · EN")
box(300, 175, 220, 90, "Worker · session", "identity from the session only|reason from a closed list")
diamond(640, 220, 170, 104, "Charge in|own list?")
box(780, 140, 230, 80, "Confirm the charge", "ownership checked in SQL")
box(780, 250, 230, 90, "“I can't find it”", "customer describes it|in their own words")
box(1080, 175, 230, 90, "D1 write + read-back", "complete or incomplete handoff")
box(1360, 175, 200, 90, "Reference", "shown at once|status emails after")
path([(250, 220), (298, 220)])
path([(520, 220), (555, 220)])
path([(640, 168), (640, 180), (725, 180), (778, 180)], "yes", lx=700, ly=172)
path([(640, 272), (640, 295), (778, 295)], "no", lx=700, ly=288)
path([(1010, 180), (1045, 180), (1045, 210), (1078, 210)])
path([(1010, 295), (1045, 295), (1045, 240), (1078, 240)])
path([(1310, 220), (1358, 220)])

# ---------- Lane 2: the AI suggestion, after the response ----------
lane(385, 330, "2 · AI suggestion, only for “I can't find it”, after the reference is returned",
     "ctx.waitUntil (Cloud Tasks in the GCP target). The model reads text; code decides; the customer confirms; a person reviews.",
     "#eef3fc", "#a9c1ea")
diamond(195, 525, 250, 130, "Guards pass?|switch · daily cap|model date · token")
box(360, 480, 230, 90, "Vertex AI", "reads the description only|facts in a closed vocabulary|10 s deadline · 1 retry", fill="#e8f0fe")
box(640, 480, 220, 90, "Schema check", "invalid → no suggestion")
box(910, 480, 240, 90, "Deterministic matcher", "facts → at most 3 of the|customer's own charges (SQL)")
box(1200, 480, 180, 90, "Store suggestions", "references only, no text")
box(1200, 610, 360, 80, "“Is it one of these?”", "customer confirms one · or “none of these”")
box(1410, 470, 150, 110, "Agent queue", "a person reviews|every report|suggestion marked as|customer-confirmed", fill="#fff7ec")
path([(1120, 342), (1120, 374), (18, 374), (18, 525), (68, 525)], "incomplete handoff stored", dash=True, lx=660, ly=368)
path([(320, 525), (358, 525)], "yes", lx=339, ly=517)
path([(590, 525), (638, 525)], "JSON", lx=614, ly=517)
path([(860, 525), (908, 525)], "facts", lx=884, ly=517)
path([(1150, 525), (1198, 525)], "1–3", lx=1174, ly=517)
path([(1290, 570), (1290, 608)], dash=True)
path([(1495, 608), (1495, 582)])

# Fallback rail
add('<rect x="60" y="625" width="1080" height="70" rx="10" fill="#fdecea" stroke="#c5221f" stroke-width="1.6" stroke-dasharray="6 4"/>')
add('<text x="80" y="652" font-size="15" font-weight="700" fill="#a50e0e">Fallback: the case stays today\'s incomplete handoff, unchanged</text>')
add('<text x="80" y="675" font-size="12.5" fill="#5f2120">off · capped · retired model · auth error · timeout · provider error (no retry) · '
    'invalid output · no match / ambiguous · not answered in 15 s. Each recorded as a kind.</text>')
for x in (195, 475, 750, 1030):
    path([(x, 591 if x == 195 else 572), (x, 623)], color="#c5221f", marker="r", dash=True)
label(222, 602, "no")

# ---------- Lane 3: measure, decide, improve ----------
lane(735, 255, "3 · Measure it, decide on it, improve it",
     "Events carry references, outcome kinds, calls and tokens, never the customer's words (intake-events.md).",
     "#f6f3fb", "#c3b5e3")
box(60, 820, 250, 130, "Pilot record", "arm A/B at random (50/50)|outcome kind per report|calls · tokens · latency|agent marks suggestion|correct / wrong")
box(360, 820, 280, 130, "Pilot measures", "share “I can't find it” (≥15% of ≥30)|suggestion confirmed rate|agent-marked correct rate|fallback rate · p95 · cost|agent time to match, A vs B")
box(690, 820, 270, 130, "Decision rules (fixed now)", "any unsafe → switch off|>5% failures in last 50 → off|>1 in 10 wrong (≥20) → off|request p95 ≥ 2,000 ms → off", fill="#fdecea", stroke="#c5221f")
box(1010, 820, 260, 130, "Offline evaluation", "new held-out set, other family|agent marks as extra labels|isolated builder · pre-registered|one run per version (ADR-006)")
box(1320, 820, 240, 130, "Model version", "v1 gpt-oss-20b until 2026-10-21|v2 Gemini Flash-Lite after|its own evaluation", fill="#e8f0fe")
path([(310, 885), (358, 885)])
path([(640, 885), (688, 885)])
path([(960, 885), (1008, 885)])
path([(1270, 885), (1318, 885)])
path([(1380, 692), (1380, 725), (42, 725), (42, 885), (58, 885)], "every report, both arms", dash=True, lx=840, ly=720)

# ---------- Lane 4: data prepared in advance ----------
lane(1005, 140, "4 · Data prepared in advance (batch, Python + DuckDB)",
     "The Worker never reads S3, DuckDB or Silver. The customer's own charges come from the reviewed slice.",
     "#f1f5fa", "#b6c6da")
x = 60
for i, (t, s) in enumerate([("S3 (read-only)", "organizers' bucket"), ("Bronze", "raw Parquet"), ("Silver", "typed tables"),
                           ("Quality gate", "errors block"), ("Gold slice", "provenance"), ("Reviewed D1 seed", "own charges list")]):
    box(x, 1070, 210, 60, t, s)
    if i:
        path([(x - 38, 1100), (x - 2, 1100)])
    x += 248
path([(1405, 1068), (1405, 1040), (1584, 1040), (1584, 122), (895, 122), (895, 138)])
label(1480, 1034, "serves each customer's own charges")

add("</svg>")
Path(__file__).with_name("target-workflow.svg").write_text("\n".join(out) + "\n", encoding="utf-8")
print("wrote target-workflow.svg")
