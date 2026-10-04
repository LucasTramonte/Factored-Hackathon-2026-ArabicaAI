"""Render the ArabicaAI architecture as one SVG with each tool's icon: the batch data path, the online service on
Cloudflare, the users, the managed services and the offline evaluation.

State: main after v0.3.0 (2026-10-04), from SYSTEM_DESIGN.md and ADR-002 to ADR-014. Solid lines are deployed or
built; dashed lines are off behind a switch. Icons come from icons/ (Simple Icons, see icons/README.md). Standard
library only; render to PNG with headless Chrome or Edge (see DATA_ENGINEERING.md, "Latency and the diagram").
Run from the repository root:  python Docs/Evidence/diagrams/build_architecture.py
"""
from __future__ import annotations

import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
W, H = 1600, 1010
INK, SUB, LINE, MUTED = "#16191f", "#414d5c", "#5b6b7d", "#6b7684"
COLOURS = {  # brand colours (Simple Icons data; AWS service colours for the three AWS icons)
    "amazons3": "#569A31", "python": "#3776AB", "duckdb": "#FFF000", "apacheparquet": "#50ABF1", "cloudflare": "#F38020",
    "cloudflareworkers": "#F38020", "sqlite": "#003B57", "angular": "#DD0031", "githubactions": "#2088FF",
    "googlecloud": "#4285F4", "amazoncognito": "#DD344C", "amazonsimpleemailservice": "#DD344C"}
out: list[str] = []
add = out.append


def icon(slug: str, x: float, y: float, size: float = 40, tile: str | None = None) -> None:
    """A Simple Icons path at (x, y), size px square, in its brand colour; optionally on a rounded tile."""
    d = re.search(r'<path d="([^"]+)"', (HERE / "icons" / f"{slug}.svg").read_text(encoding="utf-8")).group(1)
    if tile:
        pad = size * .18
        add(f'<rect x="{x - pad}" y="{y - pad}" width="{size + 2 * pad}" height="{size + 2 * pad}" rx="{size * .22}" fill="{tile}"/>')
    add(f'<g transform="translate({x},{y}) scale({size / 24})"><path d="{d}" fill="{COLOURS[slug]}"/></g>')


def text(x, y, s, size=13, weight=400, fill=INK, anchor="middle"):
    for i, line in enumerate(s.split("|")):
        add(f'<text x="{x}" y="{y + i * (size + 4)}" text-anchor="{anchor}" font-size="{size}" font-weight="{weight}" '
            f'fill="{fill}">{line}</text>')


def card(x, y, w, h, title, sub="", fill="#ffffff", stroke="#9aa7b5", dash=None, title_y=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{fill}" stroke="{stroke}" stroke-width="1.6"{d}/>')
    ty = title_y if title_y is not None else y + 24
    text(x + w / 2, ty, title, 14, 650)
    if sub:
        text(x + w / 2, ty + 19, sub, 11.5, 400, SUB)


def cylinder(cx, top, w, h, title, sub, fill="url(#cyl)"):
    """A database cylinder centred on cx, with a two-line label."""
    ry = 11
    add(f'<path d="M{cx - w / 2},{top} v{h} a{w / 2},{ry} 0 0 0 {w},0 v-{h}" fill="{fill}" stroke="#7a6a52" stroke-width="1.3"/>')
    add(f'<ellipse cx="{cx}" cy="{top}" rx="{w / 2}" ry="{ry}" fill="#fffaf0" stroke="#7a6a52" stroke-width="1.3"/>')
    text(cx, top + h / 2 + 2, title, 13, 650)
    text(cx, top + h / 2 + 19, sub, 11, 400, SUB)


def column(x, y, w, h, grad, label, slug=None, tile=None):
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="18" fill="url(#{grad})" stroke="#8c7a5b" stroke-width="1.5"/>')
    text(x + w / 2, y + 26, label, 15, 700)
    if slug:
        icon(slug, x + w - 34, y + 10, 22, tile)


def arrow(points, label="", lx=None, ly=None, dash=False, anchor="middle"):
    d = ' stroke-dasharray="6 5"' if dash else ""
    pts = " ".join(f"{px},{py}" for px, py in points)
    add(f'<polyline points="{pts}" fill="none" stroke="{LINE}" stroke-width="1.8" marker-end="url(#a)"{d}/>')
    if label:
        text(lx, ly, label, 11.5, 400, "#2c3a4a", anchor)


def pill(x, y, w, h, title, sub, slug=None):
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{h / 2}" fill="#ffffff" stroke="#3d8bd4" stroke-width="1.5"/>')
    if slug:
        icon(slug, x + 14, y + h / 2 - 10, 20)
    tx = x + w / 2 + (12 if slug else 0)
    text(tx, y + h / 2 - 3, title, 12.5, 650)
    text(tx, y + h / 2 + 13, sub, 11, 400, SUB)


add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" '
    'aria-labelledby="title description" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif">')
add('<title id="title">ArabicaAI architecture: batch data, online service, users and managed services</title>')
add('<desc id="description">The organizers\' Amazon S3 bucket is read once into a Python and DuckDB pipeline: Bronze Parquet, '
    'typed Silver tables, a quality gate and Gold tables with the reviewed serving slice. The slice is loaded by hand into '
    'Cloudflare D1. A Cloudflare Worker serves the Angular app and the API for customers, agents and admins, keeps every SQL '
    'statement in one file, and is deployed by GitHub Actions. Amazon Cognito signs people in with an email code, Amazon SES '
    'sends status emails, and Google Cloud Vertex AI runs the offline evaluation and the online suggestions, which are off. '
    'The Worker never reads S3, DuckDB or Silver.</desc>')
add('<defs>'
    f'<marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{LINE}"/></marker>'
    '<linearGradient id="bronze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbe2c6"/><stop offset="1" stop-color="#e09a55"/></linearGradient>'
    '<linearGradient id="silver" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f5f7"/><stop offset="1" stop-color="#b9bec6"/></linearGradient>'
    '<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff7d6"/><stop offset="1" stop-color="#f2cf5b"/></linearGradient>'
    '<linearGradient id="cyl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffaf0"/><stop offset="1" stop-color="#f1e3c8"/></linearGradient>'
    '<linearGradient id="d1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff4e8"/><stop offset="1" stop-color="#fbd2a8"/></linearGradient>'
    '</defs>')
add(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')
text(40, 46, "ArabicaAI · architecture", 26, 700, INK, "start")
text(40, 72, "main after v0.3.0 (2026-10-04) · solid: deployed or built · dashed: off behind a switch · "
     "the Worker never reads S3, DuckDB or Silver", 13.5, 400, SUB, "start")

# ---------- source ----------
card(30, 250, 170, 200, "Amazon S3", "Organizers' bucket|read-only, 13 tables|1,097 daily partitions", title_y=350)
icon("amazons3", 91, 270, 48)
arrow([(200, 350), (248, 350)], "read", 224, 340)

# ---------- batch data ----------
add('<rect x="250" y="104" width="630" height="556" rx="34" fill="#fbfbfa" stroke="#b5bcc5" stroke-width="1.6"/>')
icon("python", 392, 118, 26)
icon("duckdb", 428, 118, 26, tile="#1f1f1f")
text(468, 135, "Batch data · Python + DuckDB", 16, 700, INK, "start")
text(468, 154, "make pipeline · runs offline, never online", 11.5, 400, SUB, "start")

column(272, 178, 186, 300, "bronze", "Bronze", "apacheparquet")
cylinder(365, 240, 128, 70, "Raw Parquet", "source values kept")
cylinder(365, 352, 128, 70, "bronze.*", "watermarked loads")

column(472, 178, 186, 300, "silver", "Silver")
cylinder(565, 240, 128, 70, "dim_* tables", "typed snapshots")
cylinder(565, 352, 128, 70, "fact_* tables", "deduplicated, reconciled")

column(672, 178, 186, 300, "gold", "Gold")
cylinder(765, 240, 128, 70, "Analytical", "customers · purchases")
cylinder(765, 352, 128, 70, "Serving slice", "reviewed cohort")

pill(272, 510, 240, 54, "Typing + dedup", "reconciled to Bronze counts")
pill(618, 510, 240, 54, "Quality gate", "390 checks · errors block")
arrow([(365, 478), (365, 508)])
arrow([(512, 537), (536, 537), (536, 480)])
arrow([(600, 478), (600, 494), (700, 494), (700, 508)])
arrow([(790, 508), (790, 480)])
pill(272, 590, 240, 54, "Findings register", "DF-001 – DF-028, one query each")
pill(618, 590, 240, 54, "Offline reports", "make product-report · HTML + JSON")

# ---------- online: Cloudflare ----------
add('<rect x="960" y="104" width="360" height="556" rx="34" fill="#fff8f1" stroke="#f0b37a" stroke-width="1.6"/>')
icon("cloudflare", 1010, 114, 34)
text(1150, 135, "Online · Cloudflare", 16, 700)
text(1150, 154, "the only online runtime (ADR-003)", 11.5, 400, SUB)
card(990, 178, 300, 150, "Cloudflare Worker", "API + serves the Angular app|session, role and ownership checks|reference only after read-back|"
     "no refund, block or fraud verdict", title_y=232)
icon("cloudflareworkers", 1118, 186, 30)
cylinder(1140, 380, 220, 84, "D1 · SQLite", "cases · events · sessions|each customer's own charges", fill="url(#d1)")
icon("sqlite", 1236, 392, 24)
arrow([(1140, 328), (1140, 366)], "store/d1.js · all SQL", 1150, 352, anchor="start")
card(990, 540, 300, 96, "GitHub Actions", "CI must pass on main|deploy + additive D1 migrations", title_y=588)
icon("githubactions", 1124, 550, 26)
arrow([(1140, 538), (1140, 488)], "deploys", 1150, 516, anchor="start")

# ---------- hand-off (drawn over the Cloudflare box) ----------
arrow([(858, 420), (1028, 420)], "reviewed|D1 seed", 919, 390)

# ---------- users ----------
add('<rect x="1350" y="104" width="222" height="556" rx="26" fill="#ffffff" stroke="#b5bcc5" stroke-width="1.6"/>')
icon("angular", 1440, 120, 42)
text(1461, 186, "Angular web app", 16, 700)
text(1461, 205, "ES · PT · EN", 11.5, 400, SUB)
for i, (who, what) in enumerate([("Customer", "report a charge · pick|and confirm · receipt|status · thumbs feedback"),
                                 ("Agent", "queue by urgency|case detail · review|received → closed"),
                                 ("Admin", "one code, both views|view as a customer|audited by reference")]):
    y = 236 + i * 140
    add(f'<rect x="1370" y="{y}" width="182" height="118" rx="12" fill="#f4f6f9" stroke="#d3d9e0" stroke-width="1.2"/>')
    text(1461, y + 28, who, 14, 650)
    text(1461, y + 50, what, 11.5, 400, SUB)
arrow([(1348, 250), (1292, 250)], "HTTPS", 1320, 242)
arrow([(1292, 270), (1348, 270)])

# ---------- managed services ----------
add('<rect x="960" y="716" width="612" height="200" rx="26" fill="#f6f8fb" stroke="#b5bcc5" stroke-width="1.6"/>')
for i, (slug, title, sub, dash) in enumerate([
        ("amazoncognito", "Amazon Cognito", "email one-time code|verified ID token", None),
        ("amazonsimpleemailservice", "Amazon SES", "receipt + status emails|sandbox, attempted once", None),
        ("googlecloud", "Vertex AI", "suggestions for “I can't|find it” · switch OFF", "6 5")]):
    x = 980 + i * 198
    card(x, 742, 184, 150, title, sub, dash=dash, title_y=820)
    icon(slug, x + 72, 754, 40)
text(1266, 908, "managed services the Worker calls", 11.5, 400, MUTED)
arrow([(1072, 660), (1072, 740)], "verify token", 1080, 690, anchor="start")
arrow([(1270, 660), (1270, 740)], "emails, after|the response", 1262, 684, anchor="end")
arrow([(1306, 660), (1306, 704), (1468, 704), (1468, 740)], dash=True)

# ---------- offline evaluation ----------
add('<rect x="30" y="716" width="850" height="200" rx="26" fill="#fff9ec" stroke="#e6c77a" stroke-width="1.6"/>')
text(455, 744, "Offline evaluation · a model only reads, deterministic code decides (ADR-006)", 15, 700)
card(50, 762, 240, 136, "Authored test sets", "ES · PT dispute messages|development + frozen held-out|builder never sees the frozen set", title_y=812)
card(330, 762, 240, 136, "Vertex AI · gpt-oss-20b", "message → facts only|no tools, synthetic text", title_y=830)
icon("googlecloud", 435, 772, 30)
card(610, 762, 250, 136, "Policy + scorer", "same cases: checklist vs model|model 53/60 · checklist 23/60|0 unsafe (2026-10-04)", title_y=812)
arrow([(290, 830), (328, 830)])
arrow([(570, 830), (608, 830)])

text(40, 952, "Not deployed: the AWS Lambda + RDS and GCP targets are priced designs only (Docs/Costs). "
     "Sources: SYSTEM_DESIGN.md, DATA_ENGINEERING.md, EVALUATION.md, ADR-002 to ADR-014.", 12.5, 400, MUTED, "start")
text(40, 974, "Icons: Simple Icons (CC0), trademarks of their owners; Vertex AI shown with the Google Cloud mark.",
     12, 400, MUTED, "start")

add("</svg>")
HERE.joinpath("architecture.svg").write_text("\n".join(out) + "\n", encoding="utf-8", newline="\n")
print("wrote architecture.svg")
