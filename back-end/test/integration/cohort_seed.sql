-- Fixture only: dataset-shaped customers with made-up ids, never real dataset rows (migration 0006).
INSERT INTO customers(customer_id,display_name,source,country) VALUES
  ('CLI-COHORT-1','Zoë O.','dataset','México'),
  ('CLI-COHORT-2','Ana P.','dataset','Colombia'),
  ('demo-hidden','Hidden fixture','fictitious',NULL);
INSERT INTO transactions(transaction_id,customer_id,occurred_at,source_occurred_at,merchant_name,amount,currency) VALUES
  ('cohort-tx-1','CLI-COHORT-1',NULL,'2026-06-10T12:00:00','Shop','10.50','USD'),
  ('cohort-tx-2','CLI-COHORT-2',NULL,'2026-06-11T12:00:00','Tienda','20000.00','COP');
