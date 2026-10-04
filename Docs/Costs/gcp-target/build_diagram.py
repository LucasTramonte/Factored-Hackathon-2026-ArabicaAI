"""Render the GCP production-target diagram (design only) as SVG from the same layout every time.

The drawing mirrors main.tf, and uses the AWS diagram's helpers so the two compare side by side. Standard library only; rendering the
SVG to PNG is done separately with a headless browser.
"""
from pathlib import Path

W, H = 1600, 940
out = []
add = out.append

def box(x, y, w, h, title, sub="", fill="#ffffff", stroke="#232f3e", dash=None, bold=True, tsize=15):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.6"{d}/>')
    weight = "600" if bold else "400"
    add(f'<text x="{x + w / 2}" y="{y + (h / 2 if not sub else h / 2 - 7)}" text-anchor="middle" '
        f'font-size="{tsize}" font-weight="{weight}" fill="#16191f">{title}</text>')
    if sub:
        for i, line in enumerate(sub.split("|")):
            add(f'<text x="{x + w / 2}" y="{y + h / 2 + 13 + i * 15}" text-anchor="middle" font-size="12" fill="#414d5c">{line}</text>')

def group(x, y, w, h, label, stroke, fill, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="{stroke}" stroke-width="2"{d}/>')
    add(f'<text x="{x + 14}" y="{y + 22}" font-size="14" font-weight="700" fill="{stroke}">{label}</text>')

def arrow(x1, y1, x2, y2, label="", dash=False, lx=None, ly=None):
    d = ' stroke-dasharray="6 5"' if dash else ""
    add(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#414d5c" stroke-width="1.8" marker-end="url(#a)"{d}/>')
    if label:
        mx = lx if lx is not None else (x1 + x2) / 2
        my = ly if ly is not None else (y1 + y2) / 2 - 7
        for i, line in enumerate(label.split("|")):
            add(f'<text x="{mx}" y="{my + i * 14}" text-anchor="middle" font-size="12" fill="#232f3e" '
                f'paint-order="stroke" stroke="#ffffff" stroke-width="4">{line}</text>')

def path(points, label="", dash=False, lx=None, ly=None):
    d = ' stroke-dasharray="6 5"' if dash else ""
    pts = " ".join(f"{x},{y}" for x, y in points)
    add(f'<polyline points="{pts}" fill="none" stroke="#414d5c" stroke-width="1.8" marker-end="url(#a)"{d}/>')
    if label:
        for i, line in enumerate(label.split("|")):
            add(f'<text x="{lx}" y="{ly + i * 14}" text-anchor="middle" font-size="12" fill="#232f3e" '
                f'paint-order="stroke" stroke="#ffffff" stroke-width="4">{line}</text>')

add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
    'font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif">')
add('<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
    '<path d="M0,0 L10,5 L0,10 z" fill="#414d5c"/></marker></defs>')
add(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')
add('<text x="40" y="44" font-size="24" font-weight="700" fill="#16191f">ArabicaAI intake: GCP production target</text>')
add('<text x="40" y="70" font-size="14" fill="#414d5c">Transaction-dispute intake (unrecognized charges, human handoff). '
    'Design only, never applied. The live prototype runs on Cloudflare Workers + D1.</text>')

# Actors and global edge
box(40, 400, 150, 70, "Customers", "and agents (browser)", fill="#f2f3f3")
group(220, 250, 250, 380, "Global edge", "#8c4fff", "#f7f3ff")
box(245, 300, 200, 100, "External HTTPS LB", "one global IP · managed TLS|/api/* → Cloud Run|else → bucket + Cloud CDN")
box(245, 470, 200, 110, "Cloud Armor", "OWASP SQLi + XSS rules|per-IP rate limit on /api/*", dash="5 4")
arrow(345, 470, 345, 402, "inspects", lx=395, ly=440)
arrow(190, 435, 243, 360)

# Region
group(500, 100, 1070, 800, "Google Cloud · us-central1 (Iowa)", "#1a73e8", "#fbfbfb")
box(530, 150, 190, 80, "Cloud Storage · site", "Angular build|served via Cloud CDN")
arrow(445, 330, 528, 195, "static files", lx=478, ly=250)

# VPC
group(760, 150, 560, 720, "VPC · Private Google Access · no NAT", "#188038", "#f4fbf1")
add('<rect x="780" y="190" width="520" height="440" rx="8" fill="none" stroke="#188038" stroke-width="1.2" stroke-dasharray="4 4"/>')
add('<text x="792" y="210" font-size="12" fill="#188038">Private subnet · Direct VPC egress · regional (2 zones)</text>')
box(530, 390, 190, 100, "Cloud Run · API", "Node 22 · 1 vCPU · 512 MiB|ingress: load balancer only|0–10 instances")
arrow(445, 370, 528, 430, "/api/*", lx=480, ly=392)
box(1070, 250, 210, 110, "Cloud SQL PostgreSQL", "db-g1-small · regional HA|20 GB SSD · IAM auth|PITR 7 days · private IP", fill="#fff7ec")
box(800, 470, 200, 100, "Cloud Tasks", "suggestion queue|5/s cap · 1 retry|after the reference", fill="#eef6ff")
path([(720, 420), (900, 420), (900, 330), (1068, 330)], "IAM auth", lx=985, ly=322)
arrow(720, 465, 798, 505, "enqueue|after commit", lx=760, ly=500)
path([(900, 572), (900, 610), (625, 610), (625, 492)], "calls internal route (OIDC)", lx=760, ly=604)
add('<rect x="780" y="660" width="520" height="190" rx="8" fill="none" stroke="#188038" stroke-width="1.2" stroke-dasharray="4 4"/>')
add('<text x="792" y="680" font-size="12" fill="#188038">Batch · Cloud Run job, no inbound</text>')
box(1000, 710, 280, 110, "Cloud Run job · daily batch", "DuckDB: Bronze → Silver → quality → Gold|2 vCPU · 4 GiB · about 15 min/day", fill="#eef6ff")
path([(1265, 708), (1265, 600), (1292, 600), (1292, 320), (1282, 320)], "loads the serving slice|(IAM auth)", lx=1175, ly=598)

# Managed services outside the VPC
box(1350, 470, 190, 100, "Vertex AI", "Gemini 2.5 Flash-Lite|regional · us-central1|extracts facts only", fill="#eef6ff")
path([(690, 492), (690, 645), (1445, 645), (1445, 572)], "model call (from the task route) · Private Google Access", dash=True, lx=1080, ly=639)
box(1350, 710, 190, 90, "Cloud Storage · lake", "Bronze/Silver/Gold Parquet|CMEK · Silver/Gold kept 7 days")
arrow(1280, 765, 1348, 765)
box(800, 740, 170, 70, "Cloud Scheduler", "daily")
arrow(970, 775, 998, 775)
box(1350, 150, 190, 90, "Cloud Logging", "references only|30-day retention · alerts")
box(1350, 290, 190, 90, "Cloud KMS", "one customer key|SQL · lake (CMEK)")
path([(700, 388), (700, 245), (740, 245), (740, 135), (1330, 135), (1330, 195), (1348, 195)], "structured logs", dash=True, lx=1040, ly=129)

# Footer
add('<text x="40" y="918" font-size="13" fill="#414d5c">Estimated $90.09/month at list price (Cloud Billing Catalog, '
    'us-central1, read 2026-10-04, free tiers not applied). Same volumes as the AWS target. Sizing and comparison: README.md here. '
    'Source: main.tf.</text>')
add("</svg>")
Path(__file__).with_name("architecture.svg").write_text("\n".join(out) + "\n", encoding="utf-8")
print("wrote architecture.svg")
