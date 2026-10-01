-- id: DF-026
-- title: The dictionary's row counts are approximate; the supplied data is the source of truth
-- scope: full
-- memory: COUNT(*) per Bronze and Silver table (DuckDB answers from metadata or one columnar scan per table); 13 rows out. The dictionary figures are literals from Docs/LATAM_BANK_DATA_DICTIONARY.md.
WITH dictionary(source_table, dictionary_rows) AS (VALUES
  ('customers', 150000), ('products', 400000), ('branches', 350), ('service_agents', 1200),
  ('marketing_campaigns', 200), ('transactions', 5000000), ('call_center_interactions', 800000),
  ('call_transcripts', 200000), ('satisfaction_surveys', 250000), ('digital_events', 10000000),
  ('complaints', 80000), ('campaign_sends', 2000000), ('daily_exchange_rates', 3000)
), observed(source_table, bronze_rows, silver_rows) AS (
  SELECT 'customers', (SELECT COUNT(*) FROM bronze.customers), (SELECT COUNT(*) FROM silver.dim_customers) UNION ALL
  SELECT 'products', (SELECT COUNT(*) FROM bronze.products), (SELECT COUNT(*) FROM silver.dim_products) UNION ALL
  SELECT 'branches', (SELECT COUNT(*) FROM bronze.branches), (SELECT COUNT(*) FROM silver.dim_branches) UNION ALL
  SELECT 'service_agents', (SELECT COUNT(*) FROM bronze.service_agents), (SELECT COUNT(*) FROM silver.dim_service_agents) UNION ALL
  SELECT 'marketing_campaigns', (SELECT COUNT(*) FROM bronze.marketing_campaigns), (SELECT COUNT(*) FROM silver.dim_marketing_campaigns) UNION ALL
  SELECT 'transactions', (SELECT COUNT(*) FROM bronze.transactions), (SELECT COUNT(*) FROM silver.fact_transactions) UNION ALL
  SELECT 'call_center_interactions', (SELECT COUNT(*) FROM bronze.call_center_interactions), (SELECT COUNT(*) FROM silver.fact_call_center_interactions) UNION ALL
  SELECT 'call_transcripts', (SELECT COUNT(*) FROM bronze.call_transcripts), (SELECT COUNT(*) FROM silver.fact_call_transcripts) UNION ALL
  SELECT 'satisfaction_surveys', (SELECT COUNT(*) FROM bronze.satisfaction_surveys), (SELECT COUNT(*) FROM silver.fact_satisfaction_surveys) UNION ALL
  SELECT 'digital_events', (SELECT COUNT(*) FROM bronze.digital_events), (SELECT COUNT(*) FROM silver.fact_digital_events) UNION ALL
  SELECT 'complaints', (SELECT COUNT(*) FROM bronze.complaints), (SELECT COUNT(*) FROM silver.fact_complaints) UNION ALL
  SELECT 'campaign_sends', (SELECT COUNT(*) FROM bronze.campaign_sends), (SELECT COUNT(*) FROM silver.fact_campaign_sends) UNION ALL
  SELECT 'daily_exchange_rates', (SELECT COUNT(*) FROM bronze.daily_exchange_rates), (SELECT COUNT(*) FROM silver.dim_fx_rates)
)
SELECT d.source_table, d.dictionary_rows, o.bronze_rows, o.silver_rows,
       round(o.silver_rows / d.dictionary_rows, 3) AS silver_vs_dictionary,
       o.bronze_rows - o.silver_rows AS removed_in_silver
FROM dictionary d JOIN observed o USING (source_table)
ORDER BY d.dictionary_rows DESC, d.source_table
