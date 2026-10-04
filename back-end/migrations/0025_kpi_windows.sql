-- The dispute managers' KPI read (store ``intakeKpis``, script ``scripts/intake-kpis.mjs``) selects the episodes started,
-- and the alert answers given, inside a time window. These two indexes let it find them by time instead of scanning every
-- episode or answer. Each costs one more row written when an episode starts or an alert is answered (ADR-004). Additive.
CREATE INDEX intake_episodes_created ON intake_episodes(created_at);
CREATE INDEX proactive_answers_time ON proactive_answers(answered_at);
