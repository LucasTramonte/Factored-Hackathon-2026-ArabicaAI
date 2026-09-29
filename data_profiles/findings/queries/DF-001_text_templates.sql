-- id: DF-001
-- title: Source text fields are fixed templates
-- scope: full
-- memory: Grouped counts over complaints and transcripts; one scalar subquery.
SELECT 'fact_complaints.description' AS field,
       COUNT(*) AS rows,
       COUNT(DISTINCT description) AS distinct_values,
       COUNT(DISTINCT subcategory) AS distinct_labels,
       NULL::BIGINT AS values_used_by_more_than_one_label,
       NULL::BIGINT AS distinct_languages
FROM silver.fact_complaints
UNION ALL
SELECT 'fact_call_transcripts.customer_text',
       COUNT(*),
       COUNT(DISTINCT t.customer_text),
       COUNT(DISTINCT i.contact_reason),
       (SELECT COUNT(*) FROM (
          SELECT t2.customer_text
          FROM silver.fact_call_transcripts t2
          JOIN silver.fact_call_center_interactions i2 USING (interaction_id)
          GROUP BY 1 HAVING COUNT(DISTINCT i2.contact_reason) > 1)),
       COUNT(DISTINCT t.detected_language)
FROM silver.fact_call_transcripts t
JOIN silver.fact_call_center_interactions i USING (interaction_id)
