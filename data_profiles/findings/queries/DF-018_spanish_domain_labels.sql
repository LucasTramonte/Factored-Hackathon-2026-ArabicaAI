-- id: DF-018
-- title: Categorical values in Spanish where the dictionary lists English labels
-- scope: full
-- memory: Distinct values per column over dimensions and one fact; grouped strings only.
SELECT 'dim_products.product_type' AS column_name, string_agg(DISTINCT product_type, ', ' ORDER BY product_type) AS observed
FROM silver.dim_products
UNION ALL
SELECT 'dim_customers.document_type', string_agg(DISTINCT document_type, ', ' ORDER BY document_type) FROM silver.dim_customers
UNION ALL
SELECT 'dim_branches.geographic_zone', string_agg(DISTINCT geographic_zone, ', ' ORDER BY geographic_zone) FROM silver.dim_branches
UNION ALL
SELECT 'fact_call_center_interactions.reason_category', string_agg(DISTINCT reason_category, ', ' ORDER BY reason_category)
FROM silver.fact_call_center_interactions
UNION ALL
SELECT 'fact_call_center_interactions.detected_sentiment', string_agg(DISTINCT detected_sentiment, ', ' ORDER BY detected_sentiment)
FROM silver.fact_call_center_interactions
UNION ALL
SELECT 'fact_satisfaction_surveys.comment_sentiment', string_agg(DISTINCT comment_sentiment, ', ' ORDER BY comment_sentiment)
FROM silver.fact_satisfaction_surveys
