-- Delete demo activity in foreign-key order: guided intake events, turns and handoffs, then episodes, then cases
-- (intake_handoffs.complete_case_id references cases), then charge views, then sessions. Customers, transactions,
-- context cards and sample provenance stay until the seed version is replaced.
-- Local use: npx wrangler d1 execute arabica-intake-demo --local --file scripts/reset-demo-activity.sql
-- Remote use is the ADR-004 retention step (after a final event export); it is not run by tests or CI.
DELETE FROM intake_events;
DELETE FROM intake_turns;
DELETE FROM intake_handoffs;
DELETE FROM intake_episodes;
DELETE FROM cases;
DELETE FROM charge_views;
DELETE FROM sessions;
