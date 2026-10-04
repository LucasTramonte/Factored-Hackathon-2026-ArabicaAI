-- Delete demo activity in foreign-key order: AI suggestion marks, choices, suggestions and runs (0024), report feedback and
-- status history (they reference handoffs), guided
-- intake events, turns and handoffs, then episodes, then cases
-- (intake_handoffs.complete_case_id references cases), then charge views, then sessions. Customers, transactions,
-- context cards and sample provenance stay until the seed version is replaced.
-- Local use: npx wrangler d1 execute arabica-intake-demo --local --file scripts/reset-demo-activity.sql
-- Remote use is the ADR-004 retention step (after a final event export); it is not run by tests or CI.
-- Clear the optional episode -> previous handoff links first (0020), breaking the handoff -> episode FK cycle.
UPDATE intake_episodes SET previous_handoff_id=NULL WHERE previous_handoff_id IS NOT NULL;
DELETE FROM handoff_suggestion_marks;
DELETE FROM handoff_suggestion_choices;
DELETE FROM handoff_suggestions;
DELETE FROM handoff_suggestion_runs;
DELETE FROM ai_daily_calls;
DELETE FROM report_feedback;
DELETE FROM handoff_status_history;
DELETE FROM intake_events;
DELETE FROM intake_turns;
DELETE FROM intake_handoffs;
DELETE FROM intake_episodes;
DELETE FROM cases;
DELETE FROM charge_views;
DELETE FROM sessions;
