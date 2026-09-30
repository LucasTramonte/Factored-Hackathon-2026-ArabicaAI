-- Deadline pages skip terminal/pending episodes. The expression matches the housekeeping predicate.
CREATE INDEX intake_episodes_idle ON intake_episodes(MIN(updated_at+600000,expires_at),episode_id)
  WHERE state='selection_required';
-- Match both queue sort keys; pending density still affects scans and is measured separately.
CREATE INDEX intake_handoffs_queue_protocol ON intake_handoffs(accepted_at DESC,COALESCE(complete_case_id,handoff_id));
