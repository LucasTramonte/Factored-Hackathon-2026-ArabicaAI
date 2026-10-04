-- Fixture only (kpi-instrumentation.test.js): three bank-flagged charges of the fictitious demo-carla, so the KPI journeys
-- can answer alerts (ADR-011) without touching the seed's flagged charges that proactive.test.js and budget.test.js answer.
-- One is in USD, so value at stake shows two source currencies. demo-carla is not used by any other suite's alert or report.
INSERT INTO transactions(transaction_id,customer_id,occurred_at,source_occurred_at,merchant_name,amount,currency,bank_flagged) VALUES
  ('kpi-tx-01','demo-carla','2026-09-30T10:00:00+00:00',NULL,'Pedagio Demo','12.40','BRL',1),
  ('kpi-tx-02','demo-carla','2026-09-30T11:00:00+00:00',NULL,'Hotel Demo','58.00','BRL',1),
  ('kpi-tx-03','demo-carla','2026-09-30T12:00:00+00:00',NULL,'Loja Online Demo','230.00','USD',1);
