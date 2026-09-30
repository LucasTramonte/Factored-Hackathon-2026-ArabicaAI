"""Render the AWS production-target diagram (design only) as SVG from the same layout every time.

The drawing mirrors architecture.yaml and edge-us-east-1.yaml. Standard library only; rendering the
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
add('<text x="40" y="44" font-size="24" font-weight="700" fill="#16191f">ArabicaAI intake: AWS production target</text>')
add('<text x="40" y="70" font-size="14" fill="#414d5c">Transaction-dispute intake (unrecognized charges, human handoff). '
    'Design only, never deployed. The live prototype runs on Cloudflare Workers + D1.</text>')

# Actors and global edge
box(40, 400, 150, 70, "Customers", "and agents (browser)", fill="#f2f3f3")
group(220, 250, 250, 380, "Global edge", "#8c4fff", "#f7f3ff")
box(245, 300, 200, 90, "CloudFront", "one domain: app + /api/*|SPA routing function")
box(245, 470, 200, 110, "AWS WAF", "us-east-1 stack|3 managed rule groups|rate limit on /api/*", dash="5 4")
arrow(345, 470, 345, 392, "inspects", lx=395, ly=440)
arrow(190, 435, 243, 360)

# Region
group(500, 100, 1070, 800, "AWS Cloud · us-east-2 (Ohio)", "#232f3e", "#fbfbfb")
box(530, 150, 190, 80, "S3 · site", "Angular build, private|origin access control")
box(530, 390, 190, 90, "API Gateway", "HTTP API|checks X-Origin-Verify")
arrow(445, 330, 528, 195, "static files", lx=478, ly=250)
arrow(445, 360, 528, 425, "/api/* + secret|origin header", lx=470, ly=440)

# VPC
group(760, 150, 560, 720, "VPC · 2 Availability Zones · no NAT gateway", "#1d8102", "#f4fbf1")
add('<rect x="780" y="190" width="520" height="440" rx="8" fill="none" stroke="#1d8102" stroke-width="1.2" stroke-dasharray="4 4"/>')
add('<text x="792" y="210" font-size="12" fill="#1d8102">Private subnets (AZ a, AZ b)</text>')
box(800, 390, 200, 100, "Lambda", "Node 22 · arm64 · 512 MB|customer + agent routes")
box(1070, 250, 210, 110, "RDS PostgreSQL", "db.t4g.small · Multi-AZ|gp3 20 GB · IAM auth|7-day backups", fill="#fff7ec")
box(1070, 470, 210, 90, "VPC endpoint", "bedrock-runtime|interface, 2 AZs")
arrow(720, 435, 798, 435)
arrow(1000, 415, 1068, 330, "IAM auth", lx=1030, ly=360)
arrow(1000, 460, 1068, 510)
add('<rect x="780" y="660" width="520" height="190" rx="8" fill="none" stroke="#1d8102" stroke-width="1.2" stroke-dasharray="4 4"/>')
add('<text x="792" y="680" font-size="12" fill="#1d8102">Batch subnet · temporary public IPv4 while the task runs, no inbound</text>')
box(1000, 710, 280, 110, "Fargate · daily batch", "DuckDB: Bronze → Silver → quality → Gold|arm64 · 2 vCPU · 4 GB · about 15 min/day", fill="#eef6ff")
path([(1265, 708), (1265, 600), (1292, 600), (1292, 320), (1282, 320)], "loads the serving slice|(IAM auth)", lx=1175, ly=598)

# Managed services outside the VPC
box(1350, 470, 190, 90, "Amazon Bedrock", "gpt-oss-20b · In-Region|extracts facts only", fill="#eef6ff")
arrow(1280, 515, 1348, 515)
box(1350, 710, 190, 90, "S3 · data lake", "Bronze/Silver/Gold Parquet|versions kept 7 days")
arrow(1280, 765, 1348, 765)
box(800, 740, 170, 70, "EventBridge", "Scheduler · daily")
arrow(970, 775, 998, 775)
box(1350, 150, 190, 90, "CloudWatch", "logs (references only)|10 alarms · 30-day retention")
box(1350, 290, 190, 90, "AWS KMS", "one customer key|RDS · lake · logs · secrets")
path([(900, 388), (900, 228), (1348, 228)], "structured logs", dash=True, lx=1150, ly=222)

# Footer
add('<text x="40" y="918" font-size="13" fill="#414d5c">Estimated $86.36/month at list price (AWS Pricing Calculator, '
    'US East (Ohio), free tier not applied). Sizing, rejected alternatives and triggers: ADR-004, section 3. '
    'Sources: architecture.yaml, edge-us-east-1.yaml.</text>')
add("</svg>")
Path(__file__).with_name("architecture.svg").write_text("\n".join(out) + "\n", encoding="utf-8")
print("wrote architecture.svg")
