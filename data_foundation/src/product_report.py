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

from data_foundation.src.marketing_product_report import STYLE, card, esc, num, pct, table
from data_profiles.findings.run_findings import DESIGN_END, _json_safe, load_queries

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
                         "rows": [{c: _json_safe(v) for c, v in zip(columns, row)} for row in cursor.fetchall()]}
    return results


def _ratio(n, d):
    return round(n / d, 4) if d else None


def _by(rows: list[dict], key: str) -> dict:
    return {r[key]: r for r in rows}


def _scores(rows: list[dict]) -> dict:
    """Count, mean and distribution of survey scores in long-format rows."""
    dist: dict[int, int] = {}
    for r in rows:
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
    nps_all = _scores([r for r in surveys if r["survey_type"] == "NPS"])
    nps_dist = {int(k): v for k, v in nps_all["distribution"].items()}
    promoters = sum(v for k, v in nps_dist.items() if k >= 9)
    detractors = sum(v for k, v in nps_dist.items() if k <= 6)

    closed = [r for r in results["PR-06"]["rows"] if r["closed_in_window"] and r["score"] is not None]
    scored = sum(r["complaints"] for r in closed)

    segments = []
    for r in results["PR-08"]["rows"]:
        segments.append({**r, "too_few": r["complaints"] < MIN_CELL,
                         "unresolved_share": _ratio(r["unresolved"], r["complaints"]),
                         "sla_breach_rate": _ratio(r["sla_breached"], r["sla_known"]),
                         "closed_mean": round(r["closed_score_sum"] / r["closed_scored"], 3) if r["closed_scored"] >= MIN_CELL else None})
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
                         "direct_usd_per_day": round((usd.get("usd_amount_sum") or 0) / days, 2),
                         "usd_with_fx_estimates_per_day": round(sum(r["usd_amount_sum"] or 0 for r in currencies) / days, 2),
                         "by_currency": currencies},
        "kpi3_workload": {"contacts": queja.get("contacts"), "per_day": round(queja.get("contacts", 0) / days, 2),
                          "duration_observed": queja.get("duration_observed"),
                          "observed_hours_per_day": round((queja.get("duration_seconds_sum") or 0) / 3600 / days, 2),
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
        "satisfaction": satisfaction,
        "nps": {"answers": nps_all["n"], "max_score": max(nps_dist) if nps_dist else None, "promoters": promoters,
                "detractors": detractors, "detractor_share": _ratio(detractors, nps_all["n"]),
                "formal_score_note": "Not reported: no answer reaches 9-10, so the formal NPS would be almost all detractors and says nothing about loyalty."
                if promoters == 0 else None},
        "segments": segments, "segment_csat": segment_csat, "min_cell": MIN_CELL,
    }


def build(con) -> dict:
    """Run the queries and derive the summary from one verified Silver snapshot."""
    results = run_queries(con)
    return {"queries": results, "summary": summarize(results)}


def _bars(items: list[tuple[str, float | None, str]]) -> str:
    """Horizontal CSS bars; value is a 0-1 share, None renders an empty track."""
    out = ""
    for label, share, text in items:
        width = 0 if share is None else max(0.0, min(share, 1.0)) * 100
        out += (f'<div class="bar"><span>{esc(label)}</span><div class="track"><div class="fill" style="width:{width:.1f}%">'
                f'</div></div><b>{esc(text)}</b></div>')
    return out


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

    body += '<section><h2>0. The problem in numbers</h2><div class="cards">'
    body += card("Unrecognized-charge complaints a day", _fmt(k1["per_day"], 2),
                 f'{num(k1["unrecognized_charges"])} complaints; {pct(k1["unrecognized_charges"], k1["all_complaints"])} of {num(k1["all_complaints"])} complaints (PR-01)')
    body += card("Recorded claims a day, USD only", f'US${_fmt(k2["direct_usd_per_day"], 2)}',
                 f'US${_fmt(k2["usd_with_fx_estimates_per_day"], 2)} with FX-estimated amounts; coverage {_share(k2["usd_convertible"], k2["complaints"])}. Claims, not losses (PR-02)')
    body += card("Complaint-contact hours a day", _fmt(k3["observed_hours_per_day"], 2),
                 f'{_fmt(k3["per_day"], 2)} complaint contacts a day; duration observed on {_share(k3["duration_observed"], k3["contacts"])}. All complaint contacts, not only unrecognized charges (PR-03)')
    body += card("Complaint contacts resolved", pct(gap["queja_resolved"], gap["queja_contacts"]),
                 f'{num(gap["queja_resolved"])} of {num(gap["queja_contacts"])}, against {_share(gap["all_resolved"], gap["all_contacts"])} for all contacts (PR-03)')
    body += '</div><p class="muted">A cost per contact is only a scenario: contact hours times a rate the data does not contain.</p>'
    body += '<figure><figcaption>Unrecognized charges as a share of all complaints, by year (PR-01; 2023 starts on 17 June)</figcaption>'
    body += _bars([(r["period"], r["share"], f'{pct(r["unrecognized_charges"], r["all_complaints"])} · {num(r["unrecognized_charges"])}/{num(r["all_complaints"])}') for r in k1["by_year"]])
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

    rows, labels = [], {"unrecognized charge": "Unrecognized charges", "other complaint": "Other complaints"}
    for grp in ("unrecognized charge", "other complaint"):
        r = s["before"][f"{grp} / all"]
        unresolved = r["open"] + r["in_process"] + r["escalated_status"]
        rows.append({"group": labels[grp], "complaints": num(r["complaints"]),
                     "unresolved": _share(unresolved, r["complaints"]), "sla": _share(r["sla_breached"], r["sla_known"]),
                     "res_days": f'{_fmt(r["resolution_days_p50"])} / {_fmt(r["resolution_days_p90"])} (n={num(r["resolution_days_n"])})',
                     "first": f'{_fmt(r["first_response_h_p50"])} / {_fmt(r["first_response_h_p90"])} h (n={num(r["first_response_n"])})',
                     "close": f'{_fmt(r["to_resolution_d_p50"])} / {_fmt(r["to_resolution_d_p90"])} d (n={num(r["to_resolution_n"])})',
                     "closing": f'{_fmt(r["to_closing_d_p50"])} / {_fmt(r["to_closing_d_p90"])} d (n={num(r["to_closing_n"])})',
                     "wait": f'{_fmt(r["customer_wait_d_p50"])} / {_fmt(r["customer_wait_d_p90"])} d (n={num(r["customer_wait_n"])})',
                     "_unresolved": unresolved / r["complaints"] if r["complaints"] else None,
                     "_sla": r["sla_breached"] / r["sla_known"] if r["sla_known"] else None})
    target, esc_age = s["before"]["unrecognized charge / all"], s["escalated_age"]
    escalated = s["before"]["unrecognized charge / escalated"]
    body += '<section><h2>4. The "before" picture: unrecognized charges against other complaints</h2>'
    body += '<p>Complaints chosen by creation date in the design window. Durations are p50 / p90 over complaints that have both dates.</p>'
    body += table(rows, [("group", "Complaints of type"), ("complaints", "Complaints"), ("unresolved", "Unresolved (Open, In Process, Escalated)"),
                         ("sla", "SLA breached"), ("res_days", "Resolution days p50 / p90"), ("first", "Assignment → first response"),
                         ("close", "First response → resolution"), ("closing", "First response → closing"), ("wait", "Customer wait: creation → resolution")])
    body += '<figure><figcaption>Unresolved share and SLA breach rate (PR-04)</figcaption>'
    body += _bars([(f'{r["group"]}: unresolved', r["_unresolved"], r["unresolved"]) for r in rows] +
                  [(f'{r["group"]}: SLA breached', r["_sla"], r["sla"]) for r in rows]) + '</figure>'
    body += (f'<p><b>Escalated unrecognized charges have no outcome dates.</b> In the design window {num(escalated["complaints"])} are escalated, '
             f'with {num(escalated["first_response_n"])} first responses, {num(escalated["to_resolution_n"])} resolutions and {num(escalated["to_closing_n"])} closings. '
             f'Their time open is the only measure: at the data end ({esc(esc_age["data_end"])}, <b>full period</b>) the {num(esc_age["escalated"])} escalated '
             f'complaints had been open {_fmt(esc_age["age_since_creation_d_p50"], 0)} days at p50 and {_fmt(esc_age["age_since_creation_d_p90"], 0)} at p90 '
             f'since creation. That is a lower bound, not a closing time (PR-05).</p>')
    body += (f'<p class="muted">Kept and labelled: {num(target["outcome_after_window"])} unrecognized-charge complaints created in the window have an outcome date '
             f'in 2026. Counted and left out of the duration quantiles: {num(target["negative_intervals"])} with a resolution date before the first response.</p>')

    cc = s["closed_case_satisfaction"]
    body += '<h3>Satisfaction</h3><div class="cards">'
    body += card("Closed-case satisfaction, unrecognized charges", _fmt(cc["mean"], 2) + " of 5",
                 f'{num(cc["scored_closed"])} scored cases closed in the window, {pct(cc["scored_closed"], cc["cohort"])} of {num(cc["cohort"])}: a selected subset (PR-06, F5)')
    csat = s["satisfaction"].get("CSAT", {})
    for group in ("Queja", "other reasons"):
        c = csat.get(group)
        if c:
            body += card(f"Contact CSAT, {group}", _fmt(c["all"]["mean"], 2) + " of 4 observed",
                         f'resolved {_fmt(c["resolved"]["mean"], 2)} (n={num(c["resolved"]["n"])}) · not resolved {_fmt(c["not resolved"]["mean"], 2)} (n={num(c["not resolved"]["n"])}) (PR-07)')
    nps = s["nps"]
    body += card("NPS answers that are detractors (0-6)", pct(nps["detractors"], nps["answers"]),
                 f'{num(nps["detractors"])} of {num(nps["answers"])}; promoters (9-10): {num(nps["promoters"])}; highest answer {esc(nps["max_score"])} (PR-07)')
    body += '</div>'
    if nps["formal_score_note"]:
        body += f'<p class="note">{esc(nps["formal_score_note"])}</p>'
    body += '<figure><figcaption>Score distributions by contact reason, each with its n (PR-07). Contact surveys are not about complaints.</figcaption>'
    dist_rows = []
    for kind, groups in s["satisfaction"].items():
        for group, c in groups.items():
            n = c["all"]["n"]
            dist_rows.append({"survey": kind, "group": group, "n": num(n),
                              "dist": " · ".join(f'{k}: {pct(v, n)}' for k, v in c["all"]["distribution"].items())})
    body += table(dist_rows, [("survey", "Survey"), ("group", "Contact reason"), ("n", "Answers"), ("dist", "Share by score")])
    body += ('<p class="muted">Observed scales: CSAT 1-4, CES 1-4, NPS 2-7, all inside the documented scales. A CSAT of 4 is the observed '
             'maximum. In-app thumbs up or down is not CSAT.</p></figure></section>')

    seg_rows, seg_bars = [], []
    for r in s["segments"]:
        if r["too_few"]:
            seg_rows.append({"segment": r["segment"], "complaints": num(r["complaints"]), "unresolved": "too few to compare"})
            continue
        seg_rows.append({"segment": r["segment"], "complaints": num(r["complaints"]), "customers": num(r["customers"]),
                         "unresolved": _share(r["unresolved"], r["complaints"]), "sla": _share(r["sla_breached"], r["sla_known"]),
                         "escalated": _share(r["escalated"], r["complaints"]),
                         "closed": f'{_fmt(r["closed_mean"], 2)} (n={num(r["closed_scored"])})' if r["closed_mean"] is not None else f'too few (n={num(r["closed_scored"])})'})
        seg_bars.append((r["segment"], r["unresolved_share"], pct(r["unresolved"], r["complaints"])))
    body += '<section><h2>9. The required cut: by customer segment</h2>'
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

    body += '<section><h2>11. Data trust and limits</h2>'
    body += (f'<p>Silver database <code>{esc(manifest.get("database"))}</code>, quality run <code>{esc(manifest.get("quality_run"))}</code>: '
             f'{num(manifest.get("quality_checks"))} checks, {num(manifest.get("quality_errors"))} errors, {num(manifest.get("quality_warnings"))} warnings. '
             f'Contact reason fields that differ: {num(k3["reason_fields_differ"])} (<code>contact_reason</code> equals <code>reason_category</code>, '
             'and neither identifies unrecognized charges). Wait time exists only for Phone contacts (DF-027).</p>')
    body += '<h3>What not to claim</h3><ul>' + "".join(f"<li>{esc(x)}</li>" for x in NOT_TO_CLAIM) + '</ul></section>'

    body += '<section><h2>Appendix: queries</h2>' + table(
        [{"id": k, "title": v["title"], "scope": v["scope"], "query": v["query"]} for k, v in q.items()],
        [("id", "ID"), ("title", "What it measures"), ("scope", "Window"), ("query", "SQL file")]) + '</section>'

    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>Unrecognized-charge baseline</title>{STYLE}</head><body><header><h1>Unrecognized-charge intake: the baseline</h1>'
            '<p>Problem-sizing KPIs, how disputes are handled today, satisfaction with its populations, and the segment cut, from one verified synthetic Silver snapshot.</p>'
            '<nav><a href="index.html">Report hub</a><a href="product-report.json">Aggregate JSON</a><a href="product-manifest.json">Manifest</a></nav></header>'
            f'<main>{body}<footer>Aggregate synthetic data · Offline report · No identifiers</footer></main></body></html>')


def write_report(report: dict, manifest: dict, destination: Path) -> None:
    """Write the aggregate JSON, the HTML page and its manifest under ``destination``."""
    destination.mkdir(parents=True, exist_ok=True)
    for name, content in (("product-report.json", json.dumps(report, indent=2, ensure_ascii=False) + "\n"),
                          ("product-manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"),
                          ("product-report.html", render(report, manifest))):
        # LF on every OS, so a rebuild on Windows is byte-identical to the committed files.
        with open(destination / name, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
