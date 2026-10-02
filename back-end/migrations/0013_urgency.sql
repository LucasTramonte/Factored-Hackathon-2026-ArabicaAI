-- Urgency lane by stated policy (config/urgency.json, DF-024): only a confirmed charge can be 'high'; incomplete and
-- technical handoffs stay 'normal'. It orders the agent queue; it never blocks a card (ADR-002).
ALTER TABLE intake_handoffs ADD COLUMN urgency TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('normal','high'));
-- The queue's high lane: open high reports only, so a normal handoff writes no entry and a closed one leaves it.
-- It spares every queue load a full scan of intake_handoffs_queue_protocol to find the high lane.
CREATE INDEX intake_handoffs_urgent ON intake_handoffs(accepted_at DESC,COALESCE(complete_case_id,handoff_id))
  WHERE urgency='high' AND status<>'closed';
