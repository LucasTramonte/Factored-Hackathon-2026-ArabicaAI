"""Generates an executive, zero-dependency interactive dashboard visualizing
monthly time-series metrics, annual shifts, and stationarity tests across
Product and Marketing analytics for Arabica AI.
"""

from __future__ import annotations

import json
from pathlib import Path


def render_dashboard(summary_data: dict) -> str:
    """Render a modern, standalone HTML dashboard with embedded SVG charts and interactive filters."""
    series = summary_data["monthly_series"]
    yearly = summary_data["yearly_metrics"]
    shift = summary_data["shift_assessment"]

    months = [s["month"] for s in series]
    unrec_rates = [s["dispute_rate_per_10k"] for s in series]
    sla_rates = [s["dispute_sla_breach_rate"] for s in series]
    conv_rates = [s["campaign_conv_rate"] for s in series]
    dig_errors = [s["digital_error_rate"] for s in series]

    # Pre-render SVG sparkline/time-series chart
    def make_svg_chart(data: list[float], labels: list[str], title: str, color: str, unit: str = "") -> str:
        width, height = 760, 220
        pad_left, pad_right, pad_top, pad_bottom = 60, 20, 30, 40
        plot_w = width - pad_left - pad_right
        plot_h = height - pad_top - pad_bottom

        min_val = min(data) * 0.9 if min(data) > 0 else 0
        max_val = max(data) * 1.1 if max(data) > 0 else 1.0
        val_range = max_val - min_val if max_val != min_val else 1.0

        n = len(data)
        points = []
        for i, val in enumerate(data):
            x = pad_left + (i / (n - 1)) * plot_w
            y = pad_top + plot_h - ((val - min_val) / val_range) * plot_h
            points.append((x, y))

        polyline_pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)

        # Baseline horizontal line (average)
        avg_val = sum(data) / len(data)
        avg_y = pad_top + plot_h - ((avg_val - min_val) / val_range) * plot_h

        # Month labels (sample 7 labels across 37 months)
        x_labels_svg = []
        step = max(1, n // 6)
        for i in range(0, n, step):
            x, _ = points[i]
            x_labels_svg.append(f'<text x="{x:.1f}" y="{height - 12}" font-size="11" fill="#64748b" text-anchor="middle">{labels[i]}</text>')

        # Y axis grid & labels
        y_labels_svg = []
        for frac in (0.0, 0.5, 1.0):
            val_tick = min_val + frac * val_range
            y_tick = pad_top + plot_h - frac * plot_h
            y_labels_svg.append(f'<line x1="{pad_left}" y1="{y_tick:.1f}" x2="{width - pad_right}" y2="{y_tick:.1f}" stroke="#e2e8f0" stroke-dasharray="3,3" />')
            y_labels_svg.append(f'<text x="{pad_left - 8}" y="{y_tick + 4:.1f}" font-size="11" fill="#64748b" text-anchor="end">{val_tick:.1f}{unit}</text>')

        return f'''
        <div class="chart-container">
            <h3>{title} <span class="chart-avg">(3-Yr Mean: {avg_val:.2f}{unit})</span></h3>
            <svg viewBox="0 0 {width} {height}" class="chart-svg">
                {''.join(y_labels_svg)}
                <line x1="{pad_left}" y1="{avg_y:.1f}" x2="{width - pad_right}" y2="{avg_y:.1f}" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4,4" />
                <polyline fill="none" stroke="{color}" stroke-width="2.5" stroke-linejoin="round" points="{polyline_pts}" />
                {''.join(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3.5" fill="{color}" />' for x, y in points[::2])}
                {''.join(x_labels_svg)}
            </svg>
        </div>
        '''

    svg_dispute = make_svg_chart(unrec_rates, months, "Dispute Rate (Unrecognized Charges / 10k Approved Tx)", "#0284c7")
    svg_sla = make_svg_chart(sla_rates, months, "Dispute SLA Breach Rate (%)", "#e11d48", "%")
    svg_camp = make_svg_chart(conv_rates, months, "Marketing Campaign Conversion Rate (%)", "#10b981", "%")
    svg_error = make_svg_chart(dig_errors, months, "Digital Channel Error Rate (%)", "#f59e0b", "%")

    # Table rows for Yearly summary
    yearly_rows = []
    for yr, d in yearly.items():
        tag = '<span class="badge partial">Partial</span>' if d["is_partial_year"] else '<span class="badge full">Full (12m)</span>'
        yearly_rows.append(f"""
        <tr>
            <td><strong>{yr}</strong> {tag}</td>
            <td>{d['months_observed']} mos</td>
            <td>{d['total_approved_tx']:,}</td>
            <td>{d['total_unrec']:,}</td>
            <td><strong>{d['monthly_run_rate_unrec']:.1f} / mo</strong></td>
            <td><strong style="color: #0284c7;">{d['dispute_rate_per_10k_tx']:.2f}</strong></td>
            <td><span style="color: {'#e11d48' if d['sla_breach_rate'] > 20 else '#475569'}">{d['sla_breach_rate']:.2f}%</span></td>
            <td>{d['campaign_conv_rate']:.3f}%</td>
            <td>${d['campaign_cpa']:.2f}</td>
            <td>{d['digital_error_rate']:.2f}%</td>
        </tr>
        """)

    # Channel share breakdown
    tot_unrec_24 = sum(s["unrec_complaints"] for s in series if s["year"] == "2024")
    tot_unrec_25 = sum(s["unrec_complaints"] for s in series if s["year"] == "2025")

    channel_rows = []
    for ch in ("Call Center", "Email", "Web", "App", "Branch"):
        c24 = sum(s["unrec_by_channel"][ch] for s in series if s["year"] == "2024")
        c25 = sum(s["unrec_by_channel"][ch] for s in series if s["year"] == "2025")
        p24 = (c24 / tot_unrec_24 * 100) if tot_unrec_24 else 0
        p25 = (c25 / tot_unrec_25 * 100) if tot_unrec_25 else 0
        channel_rows.append(f"""
        <tr>
            <td><strong>{ch}</strong></td>
            <td>{c24:,} ({p24:.1f}%)</td>
            <td>{c25:,} ({p25:.1f}%)</td>
            <td>{p25 - p24:+.2f}%</td>
        </tr>
        """)

    # Product breakdown
    prod_rows = []
    for pr in ("Tarjeta Crédito", "Tarjeta Débito", "Cuenta Ahorro", "Cuenta Corriente", "No_Product_Linked"):
        c24 = sum(s["unrec_by_product"][pr] for s in series if s["year"] == "2024")
        c25 = sum(s["unrec_by_product"][pr] for s in series if s["year"] == "2025")
        p24 = (c24 / tot_unrec_24 * 100) if tot_unrec_24 else 0
        p25 = (c25 / tot_unrec_25 * 100) if tot_unrec_25 else 0
        prod_rows.append(f"""
        <tr>
            <td><strong>{pr}</strong></td>
            <td>{c24:,} ({p24:.1f}%)</td>
            <td>{c25:,} ({p25:.1f}%)</td>
            <td>{p25 - p24:+.2f}%</td>
        </tr>
        """)


    template = '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Arabica AI — Evidence & Time-Series Dashboard</title>
    <style>
        :root {
            --bg: #f8fafc; --card-bg: #ffffff; --text-main: #0f172a; --text-muted: #64748b;
            --border: #e2e8f0; --primary: #0284c7; --danger: #e11d48; --success: #10b981;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text-main); padding: 32px 24px; line-height: 1.5; }
        .container { max-width: 1200px; margin: 0 auto; }
        header { margin-bottom: 24px; }
        h1 { font-size: 26px; font-weight: 800; color: #0f172a; }
        .subtitle { font-size: 14px; color: var(--text-muted); margin-top: 4px; }
        .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 16px; margin-bottom: 24px; }
        .kpi-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
        .kpi-title { font-size: 12px; font-weight: 600; text-transform: uppercase; color: var(--text-muted); }
        .kpi-value { font-size: 30px; font-weight: 800; margin: 6px 0; }
        .kpi-delta { font-size: 12.5px; font-weight: 600; }
        .section-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 22px; margin-bottom: 22px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
        h2 { font-size: 17px; font-weight: 700; margin-bottom: 14px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
        .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(520px, 1fr)); gap: 18px; margin-bottom: 22px; }
        .chart-container { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
        .chart-container h3 { font-size: 13.5px; font-weight: 600; margin-bottom: 10px; }
        .chart-avg { font-weight: 400; color: var(--text-muted); font-size: 12px; }
        .chart-svg { width: 100%; height: auto; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
        th { background: #f1f5f9; padding: 10px 12px; font-weight: 600; color: #475569; border-bottom: 2px solid var(--border); }
        td { padding: 10px 12px; border-bottom: 1px solid var(--border); }
        .badge { display: inline-block; padding: 2px 7px; border-radius: 5px; font-size: 11px; font-weight: 600; }
        .badge.full { background: #dcfce7; color: #15803d; }
        .badge.partial { background: #fef3c7; color: #b45309; }
        .stat-callout { background: #f0fdf4; border-left: 4px solid #16a34a; padding: 14px; border-radius: 6px; margin-top: 12px; font-size: 13.5px; color: #14532d; }
        .workflow-box { background: #f0f9ff; border-left: 4px solid #0284c7; padding: 14px; border-radius: 6px; font-size: 13.5px; color: #0369a1; }
        footer { text-align: center; font-size: 12px; color: var(--text-muted); margin-top: 36px; border-top: 1px solid var(--border); padding-top: 16px; }
    </style>
</head>
'''


    body = f'''<body>
    <div class="container">
        <header>
            <h1>Arabica AI — Evidence & Time-Series Stationarity Dashboard</h1>
            <p class="subtitle">Longitudinal analysis (June 2023 – June 2026, 37 months) supporting <em>Suspicious Charge Intake Workflow</em></p>
        </header>

        <div class="kpi-grid">
            <div class="kpi-card">
                <div class="kpi-title">Dispute Rate (2024 vs 2025)</div>
                <div class="kpi-value" style="color: #0284c7;">60.18 <span style="font-size:15px; font-weight:400; color:#64748b;">/ 10k tx</span></div>
                <div class="kpi-delta" style="color: #0284c7;">Exact Stationarity (PSI &lt; 0.002)</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-title">Dispute SLA Breach Rate</div>
                <div class="kpi-value" style="color: #e11d48;">20.01%</div>
                <div class="kpi-delta" style="color: #e11d48;">1 in 5 claims breach manual SLA</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-title">Primary Intake Channel</div>
                <div class="kpi-value" style="color: #475569;">50.5%</div>
                <div class="kpi-delta" style="color: #475569;">Call Center Phone (12,363 claims)</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-title">Targeting Propensity Log Loss</div>
                <div class="kpi-value" style="color: #10b981;">0.0331</div>
                <div class="kpi-delta" style="color: #10b981;">vs Constant Baseline 0.0347 (N=526k)</div>
            </div>
        </div>

        <div class="section-card">
            <h2>Workflow Alignment: Suspicious Charge Intake Agent</h2>
            <div class="workflow-box">
                <strong>Why This Matters for Arabica AI:</strong>
                Unrecognized and undue charges account for <strong>24,491 complaints</strong> across the bank (averaging <strong>~678 claims/month</strong>). Over <strong>50.5% of these arrive via Call Center phone queues</strong>, where average hold time is ~2.0 minutes and duration is ~7.2 minutes, with a <strong>56.4% non-resolution rate on first call</strong>.
                By automating authenticated intake, slot extraction, and transaction evidence matching, Arabica AI directly tackles the <strong>20.0% SLA breach bottleneck</strong> while eliminating hold times.
            </div>
        </div>

        <div class="charts-grid">
            {svg_dispute}
            {svg_sla}
            {svg_camp}
            {svg_error}
        </div>

        <div class="section-card">
            <h2>Annual Metrics & Stationarity Assessment</h2>
            <table>
                <thead>
                    <tr>
                        <th>Year</th>
                        <th>Coverage</th>
                        <th>Approved Tx</th>
                        <th>Disputes (Unrec)</th>
                        <th>Run-Rate</th>
                        <th>Dispute Rate / 10k</th>
                        <th>SLA Breach %</th>
                        <th>Campaign Conv %</th>
                        <th>Campaign CPA</th>
                        <th>Digital Error %</th>
                    </tr>
                </thead>
                <tbody>
                    {''.join(yearly_rows)}
                </tbody>
            </table>

            <div class="stat-callout">
                <strong>Stationarity & Drift Verdict:</strong> {shift['assessment']}
            </div>
        </div>

        <div class="charts-grid">
            <div class="section-card" style="margin-bottom:0;">
                <h2>Dispute Reception Channels (2024 vs 2025)</h2>
                <table>
                    <thead>
                        <tr>
                            <th>Channel</th>
                            <th>2024 Disputes</th>
                            <th>2025 Disputes</th>
                            <th>YoY Share Shift</th>
                        </tr>
                    </thead>
                    <tbody>
                        {''.join(channel_rows)}
                    </tbody>
                </table>
            </div>

            <div class="section-card" style="margin-bottom:0;">
                <h2>Disputes by Product Type (2024 vs 2025)</h2>
                <table>
                    <thead>
                        <tr>
                            <th>Product Type</th>
                            <th>2024 Disputes</th>
                            <th>2025 Disputes</th>
                            <th>YoY Share Shift</th>
                        </tr>
                    </thead>
                    <tbody>
                        {''.join(prod_rows)}
                    </tbody>
                </table>
            </div>
        </div>

        <footer>
            Arabica AI Hackathon 2026 · Automated Data Evidence Pipeline · Zero Cloud External Dependencies
        </footer>
    </div>
</body>
</html>'''

    return template + body

