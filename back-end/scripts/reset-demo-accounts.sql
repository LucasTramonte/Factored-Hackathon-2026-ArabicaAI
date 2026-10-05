-- Reset the six fictitious demo accounts to a clean start before judging (2026-10-05): every report, message, suggestion,
-- feedback, alert answer, email outbox row, charge view and session of these customers is deleted, in foreign-key order.
-- Kept: the customers, their charges, context cards and enrolled sign-in emails (notification_targets), and every other
-- customer's activity. Deleting the sessions signs these accounts out. Irreversible: take a D1 Time Travel bookmark first.
-- A person runs it (agents never run --remote):
--   cd back-end && npx wrangler d1 time-travel info arabica-intake-demo
--   cd back-end && npx wrangler d1 execute arabica-intake-demo --remote --file scripts/reset-demo-accounts.sql
-- Local: npx wrangler d1 execute arabica-intake-demo --local --file scripts/reset-demo-accounts.sql
UPDATE intake_episodes SET previous_handoff_id=NULL
  WHERE customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco') AND previous_handoff_id IS NOT NULL;
DELETE FROM handoff_suggestion_marks WHERE handoff_id IN (SELECT h.handoff_id FROM intake_handoffs h JOIN intake_episodes e USING(episode_id)
  WHERE e.customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco'));
DELETE FROM handoff_suggestion_choices WHERE handoff_id IN (SELECT h.handoff_id FROM intake_handoffs h JOIN intake_episodes e USING(episode_id)
  WHERE e.customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco'));
DELETE FROM handoff_suggestions WHERE handoff_id IN (SELECT h.handoff_id FROM intake_handoffs h JOIN intake_episodes e USING(episode_id)
  WHERE e.customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco'));
DELETE FROM handoff_suggestion_runs WHERE handoff_id IN (SELECT h.handoff_id FROM intake_handoffs h JOIN intake_episodes e USING(episode_id)
  WHERE e.customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco'));
DELETE FROM report_feedback WHERE handoff_id IN (SELECT h.handoff_id FROM intake_handoffs h JOIN intake_episodes e USING(episode_id)
  WHERE e.customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco'));
DELETE FROM handoff_status_history WHERE handoff_id IN (SELECT h.handoff_id FROM intake_handoffs h JOIN intake_episodes e USING(episode_id)
  WHERE e.customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco'));
DELETE FROM handoff_messages WHERE handoff_id IN (SELECT h.handoff_id FROM intake_handoffs h JOIN intake_episodes e USING(episode_id)
  WHERE e.customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco'));
DELETE FROM support_assist_runs WHERE protocol IN (SELECT h.handoff_id FROM intake_handoffs h JOIN intake_episodes e USING(episode_id)
  WHERE e.customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco'))
  OR protocol IN (SELECT episode_id FROM intake_episodes WHERE customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco'));
DELETE FROM intake_events WHERE episode_id IN (SELECT episode_id FROM intake_episodes
  WHERE customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco'));
DELETE FROM intake_turns WHERE episode_id IN (SELECT episode_id FROM intake_episodes
  WHERE customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco'));
DELETE FROM intake_handoffs WHERE episode_id IN (SELECT episode_id FROM intake_episodes
  WHERE customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco'));
DELETE FROM intake_episodes WHERE customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
DELETE FROM cases WHERE customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
DELETE FROM charge_views WHERE customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
DELETE FROM proactive_answers WHERE customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
DELETE FROM email_outbox WHERE customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
DELETE FROM sessions WHERE customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
