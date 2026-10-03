"""Product report: problem-sizing KPIs and the "before" picture for unrecognized-charge intake.

Runs the reviewed SQL in ``data_foundation/queries/product`` against a verified, read-only Silver
DuckDB. DuckDB scans projected columns and may spill to disk; Python holds only grouped rows (a few
hundred), never fact keys. Design queries are bounded to [DESIGN_START, DESIGN_END) (ADR-005) and
there is deliberately no option to move either bound. Output is aggregates only: no identifiers.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from data_foundation.src.marketing_product_report import card, esc, num, pct, shell, table
from data_profiles.findings.run_findings import DESIGN_END, json_safe, load_queries

DESIGN_START = "2023-06-17"
QUERY_DIR = Path(__file__).resolve().parents[1] / "queries" / "product"
REPO_ROOT = Path(__file__).resolve().parents[2]
MIN_CELL = 30
TARGET = "Cargo no reconocido"
REQUIRED = {"fact_complaints", "fact_call_center_interactions", "fact_satisfaction_surveys", "dim_customers", "dim_fx_rates"}
NOT_TO_CLAIM = [
    "No survey CSAT for unrecognized-charge complainants: surveys link to contact-centre interactions, not complaints.",
    "Claimed amounts are recorded claims, not losses, refunds or savings, and source currencies are never summed together.",
    "No time saved, SLA effect or satisfaction change caused by the product: these are descriptive baselines.",
    "No \"large for this customer\" on dataset complaints: no complaint links to a transaction (DF-002, DF-003).",
    "Survey answers and comments are not evidence of measured wait or quality (F1, F2).",
    "Segment is today's snapshot, not the segment at complaint time.",
    "The data is synthetic; associations are descriptive, not causal.",
]


def run_queries(con) -> dict:
    """Execute every product query read-only and return its aggregate rows by query id."""
    present = {r[0] for r in con.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'silver'").fetchall()}
    missing = REQUIRED - present
    if missing:
        raise ValueError(f"Missing Silver tables: {sorted(missing)}")
    bounds = {"design_start": datetime.fromisoformat(DESIGN_START), "design_end": datetime.fromisoformat(DESIGN_END)}
    results = {}
    for q in load_queries(QUERY_DIR, "PR-*.sql"):
        cursor = con.execute(q.sql, {k: v for k, v in bounds.items() if f"${k}" in q.sql})
        columns = [c[0] for c in cursor.description]
        results[q.id] = {"title": q.title, "scope": q.scope, "query": q.path.relative_to(REPO_ROOT).as_posix(),
                         "rows": [{c: json_safe(v) for c, v in zip(columns, row)} for row in cursor.fetchall()]}
    return results


def silver_counts(con) -> dict[str, int]:
    """Row counts of the Silver tables the report reads, for the manifest's reconciliation against the quality run."""
    return {t: int(con.execute(f"SELECT count(*) FROM silver.{t}").fetchone()[0]) for t in sorted(REQUIRED)}


def _ratio(n, d):
    return round(n / d, 4) if d else None


def _by(rows: list[dict], key: str) -> dict:
    return {r[key]: r for r in rows}


def _scores(rows: list[dict]) -> dict:
    """Count, mean and distribution of survey scores in long-format rows; surveys without a score are left out."""
    dist: dict[int, int] = {}
    for r in rows:
        if r["score"] is None:
            continue
        dist[r["score"]] = dist.get(r["score"], 0) + r["surveys"]
    n = sum(dist.values())
    return {"n": n, "mean": round(sum(s * c for s, c in dist.items()) / n, 3) if n else None,
            "distribution": {str(s): dist[s] for s in sorted(dist)}}


def summarize(results: dict) -> dict:
    """Derive ratios and per-day values from the query rows; no new data is read here."""
    window = _by(results["PR-01"]["rows"], "period")["design window"]
    days = window["calendar_days"]
    currencies = results["PR-02"]["rows"]
    usd = next((r for r in currencies if r["currency"] == "USD"), {})
    complaints = sum(r["complaints"] for r in currencies)
    convertible = sum(r["usd_convertible"] for r in currencies)
    contacts = _by(results["PR-03"]["rows"], "reason")
    queja, every = contacts.get("Queja", {}), contacts["(all contacts)"]
    before = {(r["grp"], r["escalation"]): r for r in results["PR-04"]["rows"]}

    surveys = results["PR-07"]["rows"]
    satisfaction = {}
    for kind in sorted({r["survey_type"] for r in surveys}):
        rows = [r for r in surveys if r["survey_type"] == kind and r["reason"] != "(no interaction)"]
        cells = {}
        for group in ("Queja", "other reasons"):
            g = [r for r in rows if (r["reason"] == "Queja") == (group == "Queja")]
            cells[group] = {"all": _scores(g), "resolved": _scores([r for r in g if r["was_resolved"]]),
                            "not resolved": _scores([r for r in g if r["was_resolved"] is False])}
        satisfaction[kind] = cells
    csat_by_reason = []
    for reason, c in sorted(contacts.items(), key=lambda item: _ratio(item[1]["resolved"], item[1]["contacts"]) or 0):
        if reason == "(all contacts)":
            continue
        rows = [r for r in surveys if r["survey_type"] == "CSAT" and r["reason"] == reason]
        csat_by_reason.append({"reason": reason, "contacts": c["contacts"], "resolved": c["resolved"],
                               "resolved_rate": _ratio(c["resolved"], c["contacts"]), "csat": _scores(rows),
                               "csat_resolved": _scores([r for r in rows if r["was_resolved"]]),
                               "csat_not_resolved": _scores([r for r in rows if r["was_resolved"] is False])})
    nps_all = _scores([r for r in surveys if r["survey_type"] == "NPS"])
    nps_dist = {int(k): v for k, v in nps_all["distribution"].items()}
    promoters = sum(v for k, v in nps_dist.items() if k >= 9)
    detractors = sum(v for k, v in nps_dist.items() if k <= 6)

    closed = [r for r in results["PR-06"]["rows"] if r["closed_in_window"] and r["score"] is not None]
    scored = sum(r["complaints"] for r in closed)

    segments = []
    for r in results["PR-08"]["rows"]:
        too_few = r["complaints"] < MIN_CELL
        segments.append({**r, "too_few": too_few,
                         "unresolved_share": None if too_few else _ratio(r["unresolved"], r["complaints"]),
                         "sla_breach_rate": None if too_few else _ratio(r["sla_breached"], r["sla_known"]),
                         "closed_mean": round(r["closed_score_sum"] / r["closed_scored"], 3) if r["closed_score_sum"] is not None else None})
    segment_csat = [{**r, "too_few": r["surveys"] < MIN_CELL,
                     "mean": round(r["score_sum"] / r["surveys"], 3) if r["surveys"] >= MIN_CELL else None,
                     "top_score_share": _ratio(r["top_score"], r["surveys"]) if r["surveys"] >= MIN_CELL else None}
                    for r in results["PR-09"]["rows"]]

    return {
        "window": {"start": DESIGN_START, "end_exclusive": DESIGN_END, "calendar_days": days},
        "kpi1_demand": {"unrecognized_charges": window["unrecognized_charges"], "all_complaints": window["all_complaints"],
                        "per_day": round(window["unrecognized_charges"] / days, 2),
                        "share": _ratio(window["unrecognized_charges"], window["all_complaints"]),
                        "by_year": [{**r, "share": _ratio(r["unrecognized_charges"], r["all_complaints"])}
                                    for r in results["PR-01"]["rows"] if r["period"] != "design window"]},
        "kpi2_claimed": {"complaints": complaints, "usd_convertible": convertible, "coverage": _ratio(convertible, complaints),
                         "direct_usd_cases": usd.get("usd_convertible", 0),
                         "fx_estimated_cases": sum(r["usd_convertible"] for r in currencies if r["usd_is_estimated"]),
                         "fx_estimated_usd": round(sum(r["usd_amount_sum"] or 0 for r in currencies if r["usd_is_estimated"]), 2),
                         "no_amount": complaints - sum(r["amount_present"] for r in currencies),
                         "amount_without_currency": next((r["amount_present"] for r in currencies if r["currency"] == "(none)"), 0),
                         "direct_usd_per_day": round((usd.get("usd_amount_sum") or 0) / days, 2),
                         "usd_with_fx_estimates_per_day": round(sum(r["usd_amount_sum"] or 0 for r in currencies) / days, 2),
                         "by_currency": currencies},
        "kpi3_workload": {"contacts": queja.get("contacts"), "per_day": round(queja.get("contacts", 0) / days, 2),
                          "duration_observed": queja.get("duration_observed"),
                          "observed_hours_per_day": round((queja.get("duration_seconds_sum") or 0) / 3600 / days, 2),
                          "mean_duration_seconds": round(queja["duration_seconds_sum"] / queja["duration_observed"], 2) if queja.get("duration_observed") else None,
                          "duration_missing": (queja.get("contacts") or 0) - (queja.get("duration_observed") or 0),
                          "reason_fields_differ": every["reason_fields_differ"]},
        "resolution_gap": {"queja_resolved": queja.get("resolved"), "queja_contacts": queja.get("contacts"),
                           "queja_rate": _ratio(queja.get("resolved", 0), queja.get("contacts")),
                           "all_resolved": every["resolved"], "all_contacts": every["contacts"],
                           "all_rate": _ratio(every["resolved"], every["contacts"])},
        "before": {f"{g} / {e}": r for (g, e), r in before.items()},
        "escalated_age": results["PR-05"]["rows"][0],
        "closed_case_satisfaction": {"scored_closed": scored, "cohort": window["unrecognized_charges"],
                                     "mean": round(sum(r["score"] * r["complaints"] for r in closed) / scored, 3) if scored else None,
                                     "distribution": {str(int(r["score"])): r["complaints"] for r in closed}},
        "satisfaction": satisfaction, "csat_by_reason": csat_by_reason,
        "nps": {"answers": nps_all["n"], "max_score": max(nps_dist) if nps_dist else None, "promoters": promoters,
                "detractors": detractors, "detractor_share": _ratio(detractors, nps_all["n"]),
                "formal_score_note": "Not reported: no answer reaches 9-10, so the formal NPS would be almost all detractors and says nothing about loyalty."
                if promoters == 0 else None},
        "segments": segments, "segment_csat": segment_csat, "min_cell": MIN_CELL,
    }


def suppress_small_cells(results: dict) -> dict:
    """Null, in place, the raw numerators of segment cells under MIN_CELL, so a hidden rate or mean can't be
    recomputed from the published JSON. Cell counts stay, so the page can say how small a cell is."""
    for r in results["PR-08"]["rows"]:
        if r["complaints"] < MIN_CELL:
            r.update(unresolved=None, escalated=None, sla_known=None, sla_breached=None, closed_score_sum=None)
        elif r["closed_scored"] < MIN_CELL:
            r["closed_score_sum"] = None
    for r in results["PR-09"]["rows"]:
        if r["surveys"] < MIN_CELL:
            r.update(score_sum=None, top_score=None, resolved=None)
    return results


def build(con) -> dict:
    """Run the queries, suppress small cells, and derive the summary from one verified Silver snapshot."""
    results = suppress_small_cells(run_queries(con))
    return {"queries": results, "summary": summarize(results)}


UC = "uc"  # colour class for unrecognized charges and complaint contacts (amber); the comparison group stays blue
LEGEND = ('<p class="legend"><span><i class="sw uc"></i>Unrecognized charges or complaint contacts</span>'
          '<span><i class="sw"></i>Comparison group</span></p>')


def _bars(items: list[tuple]) -> str:
    """Horizontal CSS bars: (label, 0-1 share, text[, tone]); None renders an empty track."""
    out = ""
    for label, share, text, *tone in items:
        width = 0 if share is None else max(0.0, min(share, 1.0)) * 100
        out += (f'<div class="bar"><span>{esc(label)}</span><div class="track"><div class="fill {" ".join(tone)}" style="width:{width:.1f}%">'
                f'</div></div><b>{esc(text)}</b></div>')
    return out


def _range_plot(title: str, unit: str, rows: list[tuple], lo: float = 0.0, hi: float | None = None) -> str:
    """One measure: a row per group with a dot at p50 and a line to p90 (or a dot alone), on one shared axis.

    rows are (label, tone, p50, p90 or None, note). The axis runs from lo to hi (default: the largest value plus 10%).
    """
    values = [v for _, _, a, b, _ in rows for v in (a, b) if v is not None]
    hi = hi if hi is not None else (max(values) * 1.1 if values else 1.0)
    pos = lambda v: 100 * (v - lo) / (hi - lo) if hi > lo else 0
    out = f'<div class="rp"><h4>{esc(title)}</h4>'
    for label, tone, p50, p90, note in rows:
        mark = ""
        if p50 is not None:
            if p90 is not None:
                mark += f'<i class="rp-range {tone}" style="left:{pos(p50):.1f}%;width:{pos(p90) - pos(p50):.1f}%"></i>'
            mark += f'<b class="rp-dot {tone}" style="left:{pos(p50):.1f}%"></b>'
        out += f'<div class="rp-row"><span>{esc(label)}</span><div class="rp-track">{mark}</div><em>{esc(note)}</em></div>'
    out += f'<div class="rp-row rp-axis"><span></span><div><span>{_fmt(lo, 0 if lo == int(lo) else 1)}</span><span>{_fmt(hi, 0)} {esc(unit)}</span></div><span></span></div>'
    return out + '</div>'


def _scatter(points: list[tuple], x_label: str, y_label: str, x_range: tuple, y_range: tuple, x_ticks: list, y_ticks: list) -> str:
    """Inline SVG scatter of labelled points (label, x, y, tone); axes and ticks only, no external library."""
    w, h, left, right, top, bottom = 720, 340, 56, 24, 16, 52
    sx = lambda x: left + (x - x_range[0]) / (x_range[1] - x_range[0]) * (w - left - right)
    sy = lambda y: h - bottom - (y - y_range[0]) / (y_range[1] - y_range[0]) * (h - top - bottom)
    svg = f'<svg class="scatter" viewBox="0 0 {w} {h}" role="img" aria-label="{esc(y_label)} against {esc(x_label)}">'
    for t in x_ticks:
        svg += f'<line x1="{sx(t):.1f}" x2="{sx(t):.1f}" y1="{top}" y2="{h - bottom}"/><text x="{sx(t):.1f}" y="{h - bottom + 18}" text-anchor="middle">{t:.0%}</text>'
    for t in y_ticks:
        svg += f'<line x1="{left}" x2="{w - right}" y1="{sy(t):.1f}" y2="{sy(t):.1f}"/><text x="{left - 8}" y="{sy(t) + 4:.1f}" text-anchor="end">{t:.2f}</text>'
    svg += (f'<text x="{(left + w - right) / 2:.1f}" y="{h - 8}" text-anchor="middle">{esc(x_label)}</text>'
            f'<text transform="translate(14 {(top + h - bottom) / 2:.1f}) rotate(-90)" text-anchor="middle">{esc(y_label)}</text>')
    edge = x_range[0] + 0.75 * (x_range[1] - x_range[0])
    for i, (label, x, y, tone) in enumerate(sorted(points, key=lambda p: p[1])):
        # Labels right of the dot, except near the right edge: there they sit left, alternating above and below.
        near_edge = x > edge
        lx, anchor = (sx(x) - 11, "end") if near_edge else (sx(x) + 11, "start")
        ly = sy(y) + (4 if not near_edge else (-10 if i % 2 else 20))
        svg += (f'<circle class="{tone}" cx="{sx(x):.1f}" cy="{sy(y):.1f}" r="7"><title>{esc(label)}: {x:.1%} resolved, mean {y:.2f}</title></circle>'
                f'<text class="lbl" x="{lx:.1f}" y="{ly:.1f}" text-anchor="{anchor}">{esc(label)}</text>')
    return svg + '</svg>'


def _distributions(satisfaction: dict) -> str:
    """One panel per survey: a row per contact-reason group, a column per score, share plus a scaled bar."""
    labels = {"Queja": "Complaint contacts", "other reasons": "Other reasons"}
    out = '<div class="dists">'
    for kind in ("CSAT", "CES", "NPS"):
        groups = satisfaction.get(kind)
        if not groups:
            continue
        scores = sorted({int(k) for c in groups.values() for k in c["all"]["distribution"]})
        shares = {g: {k: c["all"]["distribution"].get(str(k), 0) / c["all"]["n"] if c["all"]["n"] else 0 for k in scores}
                  for g, c in groups.items()}
        top = max((v for row in shares.values() for v in row.values()), default=0) or 1
        head = "".join(f"<th>{k}</th>" for k in scores)
        body = ""
        for g, c in groups.items():
            cells = "".join(f'<td><span>{100 * shares[g][k]:.1f}%</span><i style="width:{100 * shares[g][k] / top:.1f}%"></i></td>' for k in scores)
            body += (f'<tr><th scope="row">{esc(labels.get(g, g))}<small>n = {num(c["all"]["n"])} · mean {_fmt(c["all"]["mean"], 2)}</small></th>'
                     f'{cells}</tr>')
        out += (f'<div class="dist"><h4>{esc(kind)} <small>score {scores[0]}–{scores[-1]} observed</small></h4>'
                f'<div class="tablewrap"><table><thead><tr><th>Contact reason</th>{head}</tr></thead><tbody>{body}</tbody></table></div></div>')
    return out + '</div>'


def _fmt(value, digits: int = 1) -> str:
    return "n/a" if value is None else f"{value:,.{digits}f}"


def _share(n, d) -> str:
    return f"{pct(n, d)} ({num(n)} of {num(d)})"


def render(report: dict, manifest: dict) -> str:
    """Offline, aggregate-only HTML; every value carries its numerator, denominator and limit."""
    s, q = report["summary"], report["queries"]
    k1, k2, k3, gap = s["kpi1_demand"], s["kpi2_claimed"], s["kpi3_workload"], s["resolution_gap"]
    w = s["window"]
    body = (f'<section class="note"><p>Design window {esc(w["start"])} to {esc(w["end_exclusive"])} (exclusive), '
            f'{num(w["calendar_days"])} calendar days, unless a figure is labelled <b>full period</b>. Synthetic data; '
            'every figure is descriptive and comes from the query named under it (appendix).</p></section>')

    body += '<section><h2>1. The problem in numbers</h2><div class="cards">'
    body += card("Unrecognized-charge complaints a day", _fmt(k1["per_day"], 2),
                 f'{num(k1["unrecognized_charges"])} complaints; {pct(k1["unrecognized_charges"], k1["all_complaints"])} of {num(k1["all_complaints"])} complaints (PR-01)')
    body += card("Recorded claims a day, USD only", f'US${_fmt(k2["direct_usd_per_day"], 2)}',
                 f'US${_fmt(k2["usd_with_fx_estimates_per_day"], 2)} with FX-estimated amounts; coverage {_share(k2["usd_convertible"], k2["complaints"])}. Claims, not losses (PR-02)')
    body += card("Complaint-contact hours a day", _fmt(k3["observed_hours_per_day"], 2),
                 f'{_fmt(k3["per_day"], 2)} complaint contacts a day; duration observed on {_share(k3["duration_observed"], k3["contacts"])}. All complaint contacts, not only unrecognized charges (PR-03)')
    body += card("Complaint contacts resolved", pct(gap["queja_resolved"], gap["queja_contacts"]),
                 f'{num(gap["queja_resolved"])} of {num(gap["queja_contacts"])}, against {_share(gap["all_resolved"], gap["all_contacts"])} for all contacts (PR-03)')
    body += ('</div><ul class="muted">'
             f'<li>Claims: {num(k2["direct_usd_cases"])} cases recorded in USD; {num(k2["fx_estimated_cases"])} FX-estimated at the creation-day rate '
             f'(US${_fmt(k2["fx_estimated_usd"], 2)} in all, flagged as estimated). Excluded: {num(k2["no_amount"])} with no amount and '
             f'{num(k2["amount_without_currency"])} with an amount but no currency.</li>'
             f'<li>Workload: mean duration {_fmt(k3["mean_duration_seconds"], 2)} s over {num(k3["duration_observed"])} observed durations; '
             f'{num(k3["duration_missing"])} missing. A cost per contact is only a scenario: contact hours times a rate the data does not contain.</li></ul>')
    body += '<figure><figcaption>Unrecognized charges as a share of all complaints, by year (PR-01; 2023 starts on 17 June)</figcaption>'
    body += _bars([(r["period"], r["share"], f'{pct(r["unrecognized_charges"], r["all_complaints"])} · {num(r["unrecognized_charges"])}/{num(r["all_complaints"])}', UC) for r in k1["by_year"]])
    body += '</figure><figure><figcaption>Claimed amounts per source currency, one row each, never added together (PR-02)</figcaption>'
    body += table([{**r, "present": _share(r["amount_present"], r["complaints"]), "sum": _fmt(r["source_amount_sum"], 2),
                    "p50": _fmt(r["source_amount_p50"], 2), "usd": _fmt(r["usd_amount_sum"], 2),
                    "est": "not converted" if r["usd_convertible"] == 0 else "FX estimate" if r["usd_is_estimated"] else "source USD"}
                   for r in k2["by_currency"]],
                  [("currency", "Currency"), ("present", "Amount present"), ("sum", "Sum, source currency"), ("p50", "Median, source currency"),
                   ("usd", "In USD"), ("est", "USD basis")])
    body += ('<p class="muted">FX uses the creation-day rate. Every source amount sits on the same scale as USD whatever its currency (DF-023), '
             'so converting ARS, COP and MXN with real rates shrinks them: the figure with FX estimates is the less certain one. '
             'Amounts without a currency are not converted.</p></figure></section>')

    groups = [("unrecognized charge", "Unrecognized charges", UC), ("other complaint", "Other complaints", "")]
    target, esc_age = s["before"]["unrecognized charge / all"], s["escalated_age"]
    escalated = s["before"]["unrecognized charge / escalated"]
    body += '<section><h2>2. The "before" picture: unrecognized charges against other complaints</h2>'
    body += (f'<p>Complaints chosen by creation date in the design window: {num(target["complaints"])} unrecognized charges against '
             f'{num(s["before"]["other complaint / all"]["complaints"])} other complaints.</p>' + LEGEND)
    body += '<figure><figcaption>How long each step takes (PR-04)</figcaption><p class="muted">Dot: median (p50). Line: to p90, the time 9 in 10 complaints stay within. Only complaints that have both dates.</p>'
    for title, unit, key in (("Assignment → first response", "hours", "first_response_h"), ("First response → resolution", "days", "to_resolution_d"),
                             ("First response → closing", "days", "to_closing_d"), ("Customer wait: creation → resolution", "days", "customer_wait_d"),
                             ("Resolution days (source field)", "days", "resolution_days")):
        n_key = "resolution_days_n" if key == "resolution_days" else key.rsplit("_", 1)[0] + "_n"
        rows = []
        for grp, label, tone in groups:
            r = s["before"][f"{grp} / all"]
            rows.append((label, tone, r[f"{key}_p50"], r[f"{key}_p90"],
                         f'p50 {_fmt(r[f"{key}_p50"])} · p90 {_fmt(r[f"{key}_p90"])} {unit} · n = {num(r[n_key])}'))
        body += _range_plot(title, unit, rows)
    body += '</figure>'
    rates = []
    for grp, label, tone in groups:
        r = s["before"][f"{grp} / all"]
        unresolved = r["open"] + r["in_process"] + r["escalated_status"]
        rates += [(f'{label}: unresolved', _ratio(unresolved, r["complaints"]), pct(unresolved, r["complaints"]), tone),
                  (f'{label}: SLA breached', _ratio(r["sla_breached"], r["sla_known"]), pct(r["sla_breached"], r["sla_known"]), tone)]
    body += '<figure><figcaption>Unresolved share (Open, In Process or Escalated) and SLA breach rate (PR-04)</figcaption>' + _bars(rates) + '</figure>'
    body += (f'<p><b>Escalated unrecognized charges have no outcome dates.</b> In the design window {num(escalated["complaints"])} are escalated, '
             f'with {num(escalated["first_response_n"])} first responses, {num(escalated["to_resolution_n"])} resolutions and {num(escalated["to_closing_n"])} closings. '
             f'Their time open is the only measure: at the data end ({esc(esc_age["data_end"])}, <b>full period</b>) the {num(esc_age["escalated"])} escalated '
             f'complaints had been open {_fmt(esc_age["age_since_creation_d_p50"], 0)} days at p50 and {_fmt(esc_age["age_since_creation_d_p90"], 0)} at p90 '
             f'since creation. That is a lower bound, not a closing time (PR-05).</p>')
    body += (f'<p class="muted">Kept and labelled: {num(target["outcome_after_window"])} unrecognized-charge complaints created in the window have an outcome date '
             f'in 2026. Counted and left out of the duration quantiles: {num(target["negative_intervals"])} with a resolution date before the first response.</p>')

    cc = s["closed_case_satisfaction"]
    body += '<h3>Satisfaction: three surveys, three populations, three scales</h3><div class="cards">'
    body += card("Closed-case satisfaction, unrecognized charges (scale 1–5)", f'{_fmt(cc["mean"], 2)} / 5',
                 f'{num(cc["scored_closed"])} scored cases closed in the window, {pct(cc["scored_closed"], cc["cohort"])} of {num(cc["cohort"])}: a selected subset (PR-06, F5)')
    nps = s["nps"]
    body += card("Contact NPS answers that are detractors (0–6)", pct(nps["detractors"], nps["answers"]),
                 f'{num(nps["detractors"])} of {num(nps["answers"])} answers; promoters (9–10): {num(nps["promoters"])}; highest answer {esc(nps["max_score"])} (PR-07)')
    body += '</div>'
    if nps["formal_score_note"]:
        body += f'<p class="note">{esc(nps["formal_score_note"])}</p>'
    csat = s["satisfaction"].get("CSAT", {})
    names = {"Queja": ("Complaint contacts", UC), "other reasons": ("Other reasons", "")}
    body += ('<figure><figcaption>Contact-centre CSAT, mean on the observed 1–4 scale (PR-07)</figcaption>'
             '<p class="muted">Contact-centre surveys, not complaint surveys: no survey CSAT exists for unrecognized-charge complainants.</p>')
    for title, part in (("All answers", "all"), ("Contact resolved", "resolved"), ("Contact not resolved", "not resolved")):
        body += _range_plot(title, "", [(names[g][0], names[g][1], csat[g][part]["mean"], None,
                                         f'mean {_fmt(csat[g][part]["mean"], 2)} · n = {num(csat[g][part]["n"])}') for g in names if g in csat], lo=1, hi=4)
    body += '</figure>'
    body += ('<figure><figcaption>How complaint contacts score against other contacts (PR-07)</figcaption>'
             '<p class="muted">Share of answers at each score; the bar length compares cells within one survey. '
             'Contact-centre surveys, not complaint surveys.</p>')
    body += _distributions(s["satisfaction"])
    body += ('<p class="muted">Observed scales: CSAT 1-4, CES 1-4, NPS 2-7, all inside the documented scales. A CSAT of 4 is the observed '
             'maximum. In-app thumbs up or down is not CSAT.</p></figure>')
    body += '<figure><figcaption>Mean CSAT against the share of contacts resolved, by contact reason (PR-03, PR-07; #86 F3, F4)</figcaption>'
    by_reason = [r for r in s["csat_by_reason"] if r["csat"]["n"] and r["resolved_rate"] is not None]
    if by_reason:
        xs, ys = [r["resolved_rate"] for r in by_reason], [r["csat"]["mean"] for r in by_reason]
        x_lo, y_lo, y_hi = min(0.9, int(min(xs) * 10) / 10), int(min(ys) * 4) / 4, (int(max(ys) * 4) + 1) / 4
        body += _scatter([(r["reason"], r["resolved_rate"], r["csat"]["mean"], UC if r["reason"] == "Queja" else "") for r in by_reason],
                         "Contacts resolved", "Mean CSAT (1–4)", (x_lo, 1.0), (y_lo, y_hi),
                         [x_lo + i / 10 for i in range(int(round((1.0 - x_lo) * 10)) + 1)],
                         [y_lo + i / 4 for i in range(int(round((y_hi - y_lo) * 4)) + 1)])
    body += table([{"reason": r["reason"], "contacts": num(r["contacts"]), "resolved": pct(r["resolved"], r["contacts"]),
                    "n": num(r["csat"]["n"]), "mean": _fmt(r["csat"]["mean"], 2),
                    "res": _fmt(r["csat_resolved"]["mean"], 2), "not": _fmt(r["csat_not_resolved"]["mean"], 2)}
                   for r in s["csat_by_reason"]],
                  [("reason", "Contact reason"), ("contacts", "Contacts"), ("resolved", "Resolved"), ("n", "CSAT answers"),
                   ("mean", "Mean CSAT"), ("res", "CSAT if resolved"), ("not", "CSAT if not resolved")])
    body += ('<p class="muted">Every reason scores about the same within each resolution outcome; the reasons with lower average CSAT are '
             'the ones resolved less often. A descriptive association, not evidence that resolution causes satisfaction.</p></figure></section>')

    seg_rows, seg_bars = [], []
    for r in s["segments"]:
        if r["too_few"]:
            seg_rows.append({"segment": r["segment"], "complaints": num(r["complaints"]), "unresolved": "too few to compare"})
            continue
        seg_rows.append({"segment": r["segment"], "complaints": num(r["complaints"]), "customers": num(r["customers"]),
                         "unresolved": pct(r["unresolved"], r["complaints"]), "sla": pct(r["sla_breached"], r["sla_known"]),
                         "escalated": pct(r["escalated"], r["complaints"]),
                         "closed": f'{_fmt(r["closed_mean"], 2)} (n={num(r["closed_scored"])})' if r["closed_mean"] is not None else f'too few (n={num(r["closed_scored"])})'})
        seg_bars.append((r["segment"], r["unresolved_share"], pct(r["unresolved"], r["complaints"]), UC))
    body += '<section><h2>3. The required cut: by customer segment</h2>'
    body += '<p>Segment is today\'s snapshot (<code>dim_customers.segment</code>), joined on each complaint\'s or survey\'s own customer. '
    body += f'Cells under {MIN_CELL} are shown as "too few to compare".</p>'
    body += table(seg_rows, [("segment", "Segment"), ("complaints", "Unrecognized-charge complaints"), ("customers", "Customers"), ("unresolved", "Unresolved"),
                             ("sla", "SLA breached"), ("escalated", "Escalated"), ("closed", "Closed-case satisfaction")])
    body += '<figure><figcaption>Unresolved share by segment (PR-08)</figcaption>' + _bars(seg_bars) + '</figure>'
    body += table([{"segment": r["segment"], "group": r["reason_group"], "n": num(r["surveys"]),
                    "mean": "too few to compare" if r["too_few"] else _fmt(r["mean"], 2),
                    "top": "" if r["too_few"] else pct(r["top_score"], r["surveys"])} for r in s["segment_csat"]],
                  [("segment", "Segment"), ("group", "Contact reason"), ("n", "CSAT answers"), ("mean", "Mean CSAT"), ("top", "Share scoring 4")])
    body += ('<p class="muted">By language: measured only on our live episodes, which are 5 team episodes so far, too few for any rate. '
             'The held-out comparison of the learned component against the baseline is reported separately and is not yet run.</p></section>')

    body += '<section><h2>4. Data trust and limits</h2>'
    body += (f'<p>Silver database <code>{esc(manifest.get("database"))}</code>, quality run <code>{esc(manifest.get("quality_run"))}</code>: '
             f'{num(manifest.get("quality_checks"))} checks, {num(manifest.get("quality_errors"))} errors, {num(manifest.get("quality_warnings"))} warnings. '
             f'Contact reason fields that differ: {num(k3["reason_fields_differ"])} (<code>contact_reason</code> equals <code>reason_category</code>, '
             'and neither identifies unrecognized charges). Wait time exists only for Phone contacts (DF-027).</p>')
    body += '<h3>What not to claim</h3><ul>' + "".join(f"<li>{esc(x)}</li>" for x in NOT_TO_CLAIM) + '</ul></section>'

    body += '<section><h2>Appendix: queries</h2>' + table(
        [{"id": k, "title": v["title"], "scope": v["scope"], "query": v["query"]} for k, v in q.items()],
        [("id", "ID"), ("title", "What it measures"), ("scope", "Window"), ("query", "SQL file")]) + '</section>'

    links = ('<p class="muted">Data: <a href="product-report.json">aggregate JSON</a> · '
             '<a href="product-manifest.json">quality manifest</a></p>')
    return shell("Unrecognized-charge intake: the baseline",
                 "Problem-sizing KPIs, how disputes are handled today, satisfaction with its populations, and the segment cut, "
                 "from one verified synthetic Silver snapshot.", body, "product-report.html", links)


def write_report(report: dict, manifest: dict, destination: Path) -> None:
    """Write the aggregate JSON, the HTML page and its manifest under ``destination``."""
    destination.mkdir(parents=True, exist_ok=True)
    for name, content in (("product-report.json", json.dumps(report, indent=2, ensure_ascii=False) + "\n"),
                          ("product-manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"),
                          ("product-report.html", render(report, manifest))):
        # LF on every OS, so a rebuild on Windows is byte-identical to the committed files.
        with open(destination / name, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
