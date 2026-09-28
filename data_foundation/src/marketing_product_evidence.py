"""Aggregate descriptive Marketing and Product evidence from verified Silver tables.

DuckDB scans projected fact columns and may spill to disk. Python holds only grouped
results, so its memory is O(number of displayed groups), not O(fact rows).
"""
from __future__ import annotations

from datetime import datetime, timezone

REQUIRED = {
    "dim_customers", "dim_products", "dim_marketing_campaigns",
    "fact_campaign_sends", "fact_transactions", "fact_digital_events", "fact_complaints",
}


def rows(con, statement: str) -> list[dict]:
    """Return a bounded SQL aggregate as named dictionaries."""
    cursor = con.execute(statement)
    names = [item[0] for item in cursor.description]
    return [dict(zip(names, item)) for item in cursor.fetchall()]


def scalar(con, statement: str) -> int:
    """Return a single integer aggregate."""
    return int(con.execute(statement).fetchone()[0])


def assert_ready(con) -> dict[str, int]:
    """Require every analysis table and return its row count."""
    present = {r[0] for r in con.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='silver'").fetchall()}
    missing = REQUIRED - present
    if missing:
        raise ValueError(f"Missing Silver tables: {sorted(missing)}")
    return {table: scalar(con, f"SELECT COUNT(*) FROM silver.{table}") for table in sorted(REQUIRED)}


SEND_BASE = """
WITH send_base AS (
 SELECT s.send_date, s.process_date, s.send_channel, s.was_delivered, s.was_opened,
        s.was_clicked, s.had_conversion, s.conversion_date, s.conversion_value,
        c.campaign_objective, c.target_segment, c.target_country, c.start_date, c.end_date,
        u.segment, u.country, u.accepts_marketing,
        c.campaign_id IS NOT NULL AS campaign_found, u.customer_id IS NOT NULL AS customer_found
 FROM silver.fact_campaign_sends s
 LEFT JOIN silver.dim_marketing_campaigns c ON s.campaign_id=c.campaign_id
 LEFT JOIN silver.dim_customers u ON s.customer_id=u.customer_id
)
"""

METRICS = """
COUNT(*) AS sends,
COUNT(*) FILTER (WHERE was_delivered IS NOT NULL) AS delivery_known,
COUNT(*) FILTER (WHERE was_delivered) AS delivered,
COUNT(*) FILTER (WHERE was_delivered IS NULL) AS delivery_unknown,
COUNT(*) FILTER (WHERE was_delivered AND was_opened IS NOT NULL) AS open_known,
COUNT(*) FILTER (WHERE was_delivered AND was_opened) AS opens,
COUNT(*) FILTER (WHERE was_delivered AND was_opened IS NULL) AS open_unknown,
COUNT(*) FILTER (WHERE was_delivered AND was_clicked IS NOT NULL) AS click_known,
COUNT(*) FILTER (WHERE was_delivered AND was_clicked) AS clicks,
COUNT(*) FILTER (WHERE was_delivered AND was_clicked IS NULL) AS click_unknown,
COUNT(*) FILTER (WHERE had_conversion IS NOT NULL) AS conversion_known,
COUNT(*) FILTER (WHERE had_conversion) AS recorded_conversions,
COUNT(*) FILTER (WHERE had_conversion IS NULL) AS conversion_unknown
"""


def marketing(con) -> dict:
    """Count send-grain outcomes and targeting feasibility without causal attribution."""
    result = {"grain": "one deduplicated Silver send", "overall": rows(con, SEND_BASE + "SELECT " + METRICS + " FROM send_base")[0]}
    dimensions = {
        "channel": "send_channel",
        "objective": "campaign_objective",
        "segment": "segment",
        "country": "country",
    }
    result["groups"] = {}
    for name, field in dimensions.items():
        result["groups"][name] = rows(con, SEND_BASE + f"SELECT COALESCE({field}, 'Unknown') AS label, {METRICS} FROM send_base GROUP BY 1 ORDER BY sends DESC")
    result["quality"] = rows(con, SEND_BASE + """SELECT
      COUNT(*) FILTER (WHERE NOT campaign_found) AS missing_campaign,
      COUNT(*) FILTER (WHERE NOT customer_found) AS missing_customer,
      COUNT(*) FILTER (WHERE accepts_marketing=FALSE) AS current_opt_out_sends,
      COUNT(*) FILTER (WHERE accepts_marketing IS NULL) AS unknown_current_consent_sends,
      COUNT(*) FILTER (WHERE campaign_found AND (send_date::DATE < start_date OR send_date::DATE > end_date)) AS outside_campaign_dates,
      COUNT(*) FILTER (WHERE campaign_found AND (start_date IS NULL OR end_date IS NULL OR send_date IS NULL)) AS campaign_date_uncheckable,
      COUNT(*) FILTER (WHERE target_segment IS NOT NULL AND customer_found AND target_segment<>segment) AS target_segment_mismatch,
      COUNT(*) FILTER (WHERE target_country IS NOT NULL AND customer_found AND target_country<>country) AS target_country_mismatch,
      COUNT(*) FILTER (WHERE target_country IS NOT NULL AND (NOT customer_found OR country IS NULL)) AS target_country_uncheckable,
      COUNT(*) FILTER (WHERE had_conversion AND conversion_date IS NULL) AS conversion_date_missing,
      COUNT(*) FILTER (WHERE had_conversion AND conversion_date<send_date) AS conversion_before_send,
      COUNT(*) FILTER (WHERE had_conversion AND conversion_value IS NULL) AS conversion_value_missing,
      COUNT(*) FILTER (WHERE (was_opened OR was_clicked) AND was_delivered IS DISTINCT FROM TRUE) AS engagement_without_delivery,
      COUNT(*) FILTER (WHERE send_date::DATE<>process_date) AS send_partition_day_mismatch,
      MIN(send_date) AS first_send, MAX(send_date) AS last_send
      FROM send_base""")[0]
    result["exposure"] = rows(con, """SELECT COUNT(*) AS exposed_customers,
      COUNT(*) FILTER (WHERE n>1) AS repeat_exposed_customers, MAX(n) AS max_sends_per_customer
      FROM (SELECT customer_id, COUNT(*) n FROM silver.fact_campaign_sends
            WHERE customer_id IS NOT NULL GROUP BY customer_id)""")[0]
    result["timing"] = rows(con, """SELECT
      CASE WHEN conversion_date IS NULL THEN 'missing date'
           WHEN send_date IS NULL THEN 'missing send date'
           WHEN conversion_date<send_date THEN 'before send'
           WHEN conversion_date<send_date+INTERVAL '1 day' THEN 'under 24 hours'
           WHEN conversion_date<send_date+INTERVAL '7 days' THEN '1 to 7 days'
           WHEN conversion_date<send_date+INTERVAL '30 days' THEN '7 to 30 days'
           ELSE '30 days or more' END AS window, COUNT(*) AS sends
      FROM silver.fact_campaign_sends WHERE had_conversion=TRUE GROUP BY 1 ORDER BY sends DESC""")
    result["date_sensitivity"] = rows(con, SEND_BASE + f"""SELECT
      CASE WHEN campaign_found AND send_date::DATE BETWEEN start_date AND end_date THEN 'inside'
           WHEN campaign_found AND send_date IS NOT NULL AND start_date IS NOT NULL AND end_date IS NOT NULL THEN 'outside'
           ELSE 'uncheckable' END AS campaign_window, {METRICS}
      FROM send_base GROUP BY 1 ORDER BY 1""")
    result["monthly"] = rows(con, """SELECT date_trunc('month', send_date)::DATE AS month,
      COUNT(*) AS sends, COUNT(*) FILTER (WHERE had_conversion) AS recorded_conversions
      FROM silver.fact_campaign_sends GROUP BY 1 ORDER BY 1""")
    result["limitations"] = ["Current consent is a snapshot, not consent at send time.",
      "Recorded conversion belongs to a send record; no randomized control or independently verified purchase link exists.",
      "Conversion value has no safe common currency for ROI."]
    return result


def economics(con) -> dict:
    """Audit whether acquisition and lifetime unit economics are identifiable."""
    costs = rows(con, """SELECT COUNT(*) AS campaigns,
      COUNT(*) FILTER (WHERE budget IS NOT NULL) AS campaign_budget_known
      FROM silver.dim_marketing_campaigns""")[0]
    sends = rows(con, """SELECT COUNT(*) AS sends,
      COUNT(*) FILTER (WHERE send_cost IS NOT NULL) AS send_cost_known,
      COUNT(*) FILTER (WHERE conversion_value IS NOT NULL) AS conversion_value_known
      FROM silver.fact_campaign_sends""")[0]
    timing = rows(con, """WITH dated AS (
      SELECT s.was_delivered,s.was_opened,s.was_clicked,s.had_conversion,
        CASE WHEN u.customer_id IS NULL OR u.registration_date IS NULL OR s.send_date IS NULL
             THEN 'uncheckable'
             WHEN s.send_date<u.registration_date THEN 'before registration'
             ELSE 'on or after registration' END AS registration_timing
      FROM silver.fact_campaign_sends s
      LEFT JOIN silver.dim_customers u ON s.customer_id=u.customer_id
    ) SELECT registration_timing,""" + METRICS + """ FROM dated GROUP BY 1 ORDER BY 1""")
    acquisition = rows(con, """SELECT COUNT(*) AS acquisition_objective_sends,
      COUNT(*) FILTER (WHERE s.had_conversion) AS acquisition_objective_recorded_conversions,
      COUNT(*) FILTER (WHERE s.send_date<u.registration_date) AS acquisition_objective_pre_registration_sends
      FROM silver.fact_campaign_sends s
      JOIN silver.dim_marketing_campaigns m ON s.campaign_id=m.campaign_id
      LEFT JOIN silver.dim_customers u ON s.customer_id=u.customer_id
      WHERE m.campaign_objective='Acquisition'""")[0]
    customers = rows(con, """SELECT COUNT(*) AS customer_snapshot_rows,
      COUNT(*) FILTER (WHERE registration_date IS NOT NULL) AS known_registration_dates,
      MIN(registration_date) AS earliest_registration,
      MAX(registration_date) AS latest_registration
      FROM silver.dim_customers""")[0]
    return {
      **costs, **sends, **acquisition, **customers,
      "registration_sensitivity": timing,
      "pre_registration_sends": next((r["sends"] for r in timing if r["registration_timing"]=="before registration"),0),
      "metrics": {
        "CAC": {"status":"not identifiable", "formula":"fully loaded sales and marketing acquisition cost / verified new customers acquired", "missing":"acquisition attribution, complete cost and currency"},
        "LTV": {"status":"not identifiable", "formula":"discounted customer contribution over a defined lifetime", "missing":"bank revenue or margin, servicing cost, credit loss and observed lifetime"},
        "LTV/CAC": {"status":"not identifiable", "formula":"cohort LTV / same-cohort CAC", "missing":"both valid components, common currency and horizon"},
        "CAC/average ticket": {"status":"not comparable", "formula":"compare CAC with the first verified transaction ticket for the same acquired cohort", "missing":"valid CAC and new-customer cohort; gross customer transaction amounts are not bank revenue"},
        "lead-to-customer": {"status":"not identifiable", "formula":"verified new customers / eligible leads from the same cohort", "missing":"prospect or lead stage, stable lead-to-customer key and acquisition event"},
        "retention": {"status":"not identifiable", "formula":"retained customers / eligible starting customer cohort", "missing":"longitudinal customer status and exit events"},
      },
      "limits": [
        "send_cost and campaign budget have no documented currency and may overlap; they cannot be summed into fully loaded CAC.",
        "Acquisition is a campaign objective label, not proof that a new customer was acquired.",
        "conversion_value is recorded only on marked conversions and has no documented currency or verified bank revenue meaning.",
        "A send dated before the current registration_date is shown separately, not treated as a lead or removed silently.",
      ],
    }


def products(con) -> dict:
    """Measure snapshot ownership and owner-safe transaction activity at product grain."""
    result = {"grain": "one active Silver product snapshot", "ownership": rows(con, """SELECT
      COALESCE(product_type,'Unknown') AS product_type, COUNT(*) AS active_products,
      COUNT(DISTINCT customer_id) AS owning_customers,
      COUNT(*) FILTER (WHERE has_linked_app IS NOT NULL) AS linked_known,
      COUNT(*) FILTER (WHERE has_linked_app) AS linked_products,
      COUNT(*) FILTER (WHERE has_linked_app IS NULL) AS linked_unknown
      FROM silver.dim_products WHERE product_status='Active' GROUP BY 1 ORDER BY active_products DESC""")}
    result["cohorts"] = rows(con, """SELECT COALESCE(c.segment,'Unknown') AS segment,
      COUNT(DISTINCT c.customer_id) AS customers,
      COUNT(DISTINCT p.customer_id) FILTER (WHERE p.product_status='Active') AS active_owners
      FROM silver.dim_customers c LEFT JOIN silver.dim_products p ON c.customer_id=p.customer_id
      GROUP BY 1 ORDER BY customers DESC""")
    result["opening_year"] = rows(con, """SELECT EXTRACT(year FROM opening_date)::INT AS opening_year,
      COUNT(*) AS active_products_in_snapshot FROM silver.dim_products
      WHERE product_status='Active' GROUP BY 1 ORDER BY 1""")
    # Aggregate transactions before joining the dimension. A mismatched owner cannot
    # contribute to activity. Pre-opening rows are counted separately, not silently erased.
    result["transaction_activity"] = rows(con, """WITH by_product AS (
      SELECT t.product_id,
        COUNT(*) AS total_transactions,
        COUNT(*) FILTER (WHERE p.product_id IS NULL) AS missing_product,
        COUNT(*) FILTER (WHERE p.product_id IS NOT NULL AND t.customer_id IS DISTINCT FROM p.customer_id) AS owner_mismatch,
        COUNT(*) FILTER (WHERE p.product_id IS NOT NULL AND t.customer_id=p.customer_id AND
          t.transaction_date::DATE<p.opening_date) AS before_opening,
        COUNT(*) FILTER (WHERE p.product_id IS NOT NULL AND t.customer_id=p.customer_id AND
          (p.opening_date IS NULL OR t.transaction_date IS NULL)) AS date_uncheckable,
        COUNT(*) FILTER (WHERE p.product_id IS NOT NULL AND t.customer_id=p.customer_id AND
          t.transaction_date::DATE>=p.opening_date) AS eligible_transactions
      FROM silver.fact_transactions t LEFT JOIN silver.dim_products p ON t.product_id=p.product_id
      GROUP BY t.product_id
    ) SELECT SUM(total_transactions)::BIGINT AS total_transactions,
      SUM(missing_product)::BIGINT AS missing_product,
      SUM(owner_mismatch)::BIGINT AS owner_mismatch,
      SUM(before_opening)::BIGINT AS before_opening,
      SUM(date_uncheckable)::BIGINT AS date_uncheckable,
      SUM(eligible_transactions)::BIGINT AS eligible_transactions,
      COUNT(*) FILTER (WHERE eligible_transactions>0) AS active_products_with_eligible_activity
      FROM by_product""")[0]
    result["transaction_by_type"] = rows(con, """WITH by_product AS (
      SELECT t.product_id, COUNT(*) FILTER (WHERE t.customer_id=p.customer_id AND
        t.transaction_date::DATE>=p.opening_date) AS eligible_transactions
      FROM silver.fact_transactions t JOIN silver.dim_products p ON t.product_id=p.product_id
      GROUP BY t.product_id
    ) SELECT COALESCE(p.product_type,'Unknown') AS product_type,
      COUNT(*) FILTER (WHERE p.product_status='Active') AS active_products,
      COUNT(*) FILTER (WHERE p.product_status='Active' AND b.eligible_transactions>0) AS with_eligible_activity,
      COALESCE(SUM(b.eligible_transactions) FILTER (WHERE p.product_status='Active'),0)::BIGINT AS eligible_transactions
      FROM silver.dim_products p LEFT JOIN by_product b ON p.product_id=b.product_id
      GROUP BY 1 ORDER BY active_products DESC""")
    result["limitations"] = ["Product status and app linkage are current snapshots, not historical usage.",
      "Transactions before a product's opening date are excluded from eligible activity and reported separately.",
      "No digital product-type chart: customer/product links are overwhelmingly inconsistent."]
    return result


def digital(con) -> dict:
    """Count event labels and an ordered navigation-to-action session engagement funnel."""
    result = {"grain": "one session_id with an unambiguous customer or anonymous identity"}
    result["events"] = rows(con, """SELECT COUNT(*) AS events,
      COUNT(*) FILTER (WHERE customer_id IS NULL) AS anonymous_events,
      COUNT(*) FILTER (WHERE product_id IS NOT NULL) AS product_linked_events,
      COUNT(*) FILTER (WHERE action IS NULL OR TRIM(action)='') AS missing_action,
      COUNT(*) FILTER (WHERE event_date::DATE<>process_date) AS event_partition_day_mismatch,
      MIN(event_date) AS first_event, MAX(event_date) AS last_event
      FROM silver.fact_digital_events""")[0]
    result["labels"] = rows(con, """SELECT event_type, event_category, COUNT(*) AS events,
      COUNT(*) FILTER (WHERE action IS NULL OR TRIM(action)='') AS missing_action
      FROM silver.fact_digital_events GROUP BY 1,2 ORDER BY events DESC""")
    result["product_links"] = rows(con, """SELECT
      COUNT(*) AS identified_links,
      COUNT(*) FILTER (WHERE p.product_id IS NULL) AS missing_product,
      COUNT(*) FILTER (WHERE p.product_id IS NOT NULL AND e.customer_id IS DISTINCT FROM p.customer_id) AS owner_mismatch
      FROM silver.fact_digital_events e LEFT JOIN silver.dim_products p ON e.product_id=p.product_id
      WHERE e.product_id IS NOT NULL AND e.customer_id IS NOT NULL""")[0]
    result["sessions"] = rows(con, """WITH session_counts AS (
      SELECT session_id, COUNT(DISTINCT customer_id) AS distinct_customers,
        COUNT(*) FILTER (WHERE customer_id IS NULL) AS anonymous_events
      FROM silver.fact_digital_events WHERE session_id IS NOT NULL GROUP BY session_id
    ), views AS (
      SELECT session_id, MIN(event_date) AS view_at FROM silver.fact_digital_events
      WHERE session_id IS NOT NULL AND event_type='PageView' AND event_category='Navigation'
      GROUP BY session_id
    ), clicks AS (
      SELECT v.session_id, MIN(e.event_date) AS click_at FROM views v
      JOIN silver.fact_digital_events e ON e.session_id=v.session_id
        AND e.event_type='Click' AND e.event_category='Product' AND e.event_date>=v.view_at
      GROUP BY v.session_id
    ), submits AS (
      SELECT c.session_id, MIN(e.event_date) AS submit_at FROM clicks c
      JOIN silver.fact_digital_events e ON e.session_id=c.session_id
        AND e.event_type='FormSubmit' AND e.event_category='Transaction' AND e.event_date>=c.click_at
      GROUP BY c.session_id
    ) SELECT COUNT(*) AS sessions,
      COUNT(*) FILTER (WHERE sc.distinct_customers>1) AS ambiguous_customer_sessions,
      COUNT(*) FILTER (WHERE sc.anonymous_events>0 AND sc.distinct_customers>0) AS mixed_identity_sessions,
      COUNT(*) FILTER (WHERE sc.anonymous_events>0) AS sessions_with_anonymous_events,
      COUNT(*) FILTER (WHERE v.view_at IS NOT NULL AND sc.distinct_customers<=1 AND NOT (sc.anonymous_events>0 AND sc.distinct_customers>0)) AS navigation_view,
      COUNT(*) FILTER (WHERE c.click_at IS NOT NULL AND sc.distinct_customers<=1 AND NOT (sc.anonymous_events>0 AND sc.distinct_customers>0)) AS click_after_view,
      COUNT(*) FILTER (WHERE f.submit_at IS NOT NULL AND sc.distinct_customers<=1 AND NOT (sc.anonymous_events>0 AND sc.distinct_customers>0)) AS submit_after_click
      FROM session_counts sc LEFT JOIN views v USING (session_id)
      LEFT JOIN clicks c USING (session_id) LEFT JOIN submits f USING (session_id)""")[0]
    result["limitations"] = ["The funnel is engagement within session, not an acquisition or completed transaction funnel.",
      "Session ordering uses earliest timestamps; tied timestamps cannot prove order.",
      "Sessions mixing anonymous and identified events, or multiple identified customers, are excluded from ordered stages."]
    return result


def intake(con) -> dict:
    """Return separate V1 and broader complaint populations without causal claims."""
    link_audit = rows(con, "SELECT COUNT(*) AS bronze_complaints, COUNT(*) FILTER (WHERE origin_interaction_id IS NOT NULL) AS populated_origin_links FROM bronze.complaints")[0] if con.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='bronze' AND table_name='complaints'").fetchone()[0] else None
    return {"grain": "one Silver complaint, grouped by creation_date", "bronze_link_audit": link_audit, "populations": rows(con, """SELECT
      CASE WHEN subcategory='Cargo no reconocido' THEN 'V1: Cargo no reconocido'
           ELSE 'Broader: Cobro indebido' END AS population,
      COUNT(*) AS complaints,
      COUNT(*) FILTER (WHERE reception_channel='Call Center') AS call_center,
      COUNT(*) FILTER (WHERE sla_breached) AS sla_breached,
      COUNT(*) FILTER (WHERE claimed_amount IS NOT NULL) AS claimed_amount_known,
      MIN(creation_date) AS first_created, MAX(creation_date) AS last_created
      FROM silver.fact_complaints
      WHERE subcategory IN ('Cargo no reconocido','Cobro indebido') GROUP BY 1 ORDER BY 1"""),
      "monthly": rows(con, """SELECT date_trunc('month',creation_date)::DATE AS month,
      COUNT(*) FILTER (WHERE subcategory='Cargo no reconocido') AS v1,
      COUNT(*) AS broader_combined
      FROM silver.fact_complaints WHERE subcategory IN ('Cargo no reconocido','Cobro indebido')
      GROUP BY 1 ORDER BY 1"""),
      "limitations": ["Complaint records cannot be linked to interactions when origin_interaction_id is absent.",
      "SLA breach is observed demand context; no intake effect or saved hold time was measured.",
      "Product segmentation is suppressed because complaint/product ownership links fail validation."]}


def analyze(con) -> dict:
    """Build all report aggregates from a single verified Silver snapshot."""
    counts = assert_ready(con)
    return {"generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "silver_counts": counts, "marketing": marketing(con), "economics": economics(con), "products": products(con),
            "digital": digital(con), "intake": intake(con)}
