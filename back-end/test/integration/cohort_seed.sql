-- Fixture only: dataset-shaped customers with made-up ids, never real dataset rows (migration 0006).
INSERT INTO customers(customer_id,display_name,source,country) VALUES
  ('CLI-COHORT-1','Zoë O.','dataset','México'),
  ('CLI-COHORT-2','Ana P.','dataset','Colombia'),
  ('CLI-COHORT-3','Rui M.','dataset','Brasil'),
  ('CLI-COHORT-4','Eva L.','dataset','Chile'),
  ('demo-hidden','Hidden fixture','fictitious',NULL);
INSERT INTO transactions(transaction_id,customer_id,occurred_at,source_occurred_at,merchant_name,amount,currency) VALUES
  ('cohort-tx-1','CLI-COHORT-1',NULL,'2026-06-10T12:00:00','Shop','10.50','USD'),
  ('cohort-tx-2','CLI-COHORT-2',NULL,'2026-06-11T12:00:00','Tienda','20000.00','COP');
-- Charge-view shapes (ADR-009 decision 5): CLI-COHORT-3 has 21 charges, one more than a page (has_more); CLI-COHORT-4 has none.
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 21)
INSERT INTO transactions(transaction_id,customer_id,occurred_at,source_occurred_at,merchant_name,amount,currency)
  SELECT printf('cohort3-tx-%02d', i), 'CLI-COHORT-3', NULL, printf('2026-05-%02dT12:00:00', i), 'Loja', '5.00', 'BRL' FROM n;
