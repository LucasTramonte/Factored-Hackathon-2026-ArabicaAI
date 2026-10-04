"""Chart the extractor-v1 frozen comparison from the committed aggregates only (no case data).

Left: correct next action with Wilson 95% intervals, per system, on all 60 cases and on the 52 never
exposed. Right: correct cases per scenario family (2–4 cases each, so counts, never rates), checklist
against the model. Standard library only; render the SVG to PNG with headless Chrome if needed.
"""
import json
from pathlib import Path

HERE = Path(__file__).parent
cuts = json.loads((HERE / "frozen-v1-cuts-2026-10-04.json").read_text(encoding="utf-8"))
mcnemar = json.loads((HERE / "frozen-v1-unexposed-2026-10-04.json").read_text(encoding="utf-8"))["mcnemar"]
rows = cuts["summary"]
SYSTEMS = [("handoff", None, "Always hand off", "#9aa5b1"), ("checklist", None, "Checklist (rules)", "#e8a33d"),
           ("extractor-v1", "majority", "Extractor v1 (majority of 3)", "#1a73e8")]


def pick(pop, dim, base, rep, value=None):
    return next(r for r in rows if r["analysis_population"] == pop and r["dimension"] == dim and r["baseline"] == base
                and r["repetition"] == rep and r["value"] == value)


W, H = 1500, 720
out = []
add = out.append
add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" '
    'aria-labelledby="t d" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif">')
add('<title id="t">Extractor v1 against the checklist on the frozen set</title>')
add('<desc id="d">Correct next action with 95% intervals on all 60 and the 52 never-exposed cases, and correct cases per scenario family.</desc>')
add(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')
add('<text x="40" y="44" font-size="24" font-weight="700" fill="#16191f">Frozen comparison, extractor v1 (run once, 2026-10-04)</text>')
add('<text x="40" y="70" font-size="14" fill="#414d5c">Same cases for every system. Authored Spanish and Portuguese messages, a coverage mix, not real-customer prevalence. '
    'Unsafe outcomes: 0 for every system.</text>')

# Left panel: rates with intervals
x0, y0, pw, ph = 90, 120, 560, 480
add(f'<text x="{x0}" y="{y0 - 14}" font-size="16" font-weight="650" fill="#16191f">Correct next action (Wilson 95% interval)</text>')
for i in range(0, 101, 20):
    y = y0 + ph - ph * i / 100
    add(f'<line x1="{x0}" y1="{y}" x2="{x0 + pw}" y2="{y}" stroke="#e3e7ec"/>')
    add(f'<text x="{x0 - 10}" y="{y + 4}" text-anchor="end" font-size="12" fill="#414d5c">{i}%</text>')
groups = [("all", "All 60 cases"), ("unexposed", "52 never exposed")]
bw, gap = 70, 20
for g, (pop, label) in enumerate(groups):
    gx = x0 + 40 + g * (3 * (bw + gap) + 60)
    for s, (base, rep, name, color) in enumerate(SYSTEMS):
        r = pick(pop, "all", base, rep)
        rate, (lo, hi) = r["correct"] / r["cases"], r["correct_rate_ci95"]
        x = gx + s * (bw + gap)
        top = y0 + ph - ph * rate
        add(f'<rect x="{x}" y="{top}" width="{bw}" height="{ph * rate}" fill="{color}" rx="3"/>')
        ylo, yhi = y0 + ph - ph * lo, y0 + ph - ph * hi
        add(f'<line x1="{x + bw / 2}" y1="{ylo}" x2="{x + bw / 2}" y2="{yhi}" stroke="#16191f" stroke-width="1.6"/>')
        for yy in (ylo, yhi):
            add(f'<line x1="{x + bw / 2 - 8}" y1="{yy}" x2="{x + bw / 2 + 8}" y2="{yy}" stroke="#16191f" stroke-width="1.6"/>')
        add(f'<text x="{x + bw / 2}" y="{yhi - 8}" text-anchor="middle" font-size="13" font-weight="650" fill="#16191f">'
            f'{r["correct"]}/{r["cases"]}</text>')
    add(f'<text x="{gx + (3 * bw + 2 * gap) / 2}" y="{y0 + ph + 26}" text-anchor="middle" font-size="14" fill="#16191f">{label}</text>')
for s, (_, _, name, color) in enumerate(SYSTEMS):
    lx = x0 + s * 195
    add(f'<rect x="{lx}" y="{y0 + ph + 48}" width="14" height="14" fill="{color}" rx="2"/>')
    add(f'<text x="{lx + 20}" y="{y0 + ph + 60}" font-size="13" fill="#16191f">{name}</text>')

# Right panel: per family counts
fams = sorted({r["value"] for r in rows if r["dimension"] == "family" and r["analysis_population"] == "all"})
rx0, ry0, rw = 820, 120, 600
add(f'<text x="{rx0}" y="{ry0 - 14}" font-size="16" font-weight="650" fill="#16191f">Correct cases per scenario family (all 60; counts, not rates)</text>')
rowh = 30
for i, f in enumerate(fams):
    y = ry0 + 14 + i * rowh
    ck, mx = pick("all", "family", "checklist", None, f), pick("all", "family", "extractor-v1", "majority", f)
    n = ck["cases"]
    add(f'<text x="{rx0 + 230}" y="{y + 15}" text-anchor="end" font-size="12.5" fill="#16191f">{f.replace("_", " ")}</text>')
    unit = 70
    for j in range(n):
        cx = rx0 + 250 + j * unit / 2
        add(f'<rect x="{cx}" y="{y + 2}" width="{unit / 2 - 4}" height="9" fill="{"#e8a33d" if j < ck["correct"] else "#f3e6d1"}" rx="2"/>')
        add(f'<rect x="{cx}" y="{y + 13}" width="{unit / 2 - 4}" height="9" fill="{"#1a73e8" if j < mx["correct"] else "#d6e4fb"}" rx="2"/>')
    add(f'<text x="{rx0 + 250 + 2 * unit + 12}" y="{y + 11}" font-size="11.5" fill="#8a5a12">{ck["correct"]}/{n}</text>')
    add(f'<text x="{rx0 + 250 + 2 * unit + 12}" y="{y + 23}" font-size="11.5" fill="#0b4fb3">{mx["correct"]}/{n}</text>')
add(f'<text x="{rx0 + 250}" y="{ry0 + 14 + len(fams) * rowh + 16}" font-size="12" fill="#414d5c">'
    'Top: checklist · bottom: model · filled = correct.</text>')

add(f'<text x="40" y="{H - 24}" font-size="12.5" fill="#414d5c">Source: frozen-v1-cuts-2026-10-04.json (aggregates; raw result SHA-256 '
    f'{cuts["result_sha256"][:12]}…). Paired McNemar on the 52 never-exposed cases: {mcnemar["c"]} cases only the model got right, {mcnemar["b"]} only the checklist, p ≈ {mcnemar["p"]:.2g}.</text>')
add("</svg>")
(HERE / "frozen-v1-comparison.svg").write_text("\n".join(out) + "\n", encoding="utf-8")
print("wrote frozen-v1-comparison.svg")
