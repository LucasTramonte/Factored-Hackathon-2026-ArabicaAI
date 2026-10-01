-- A short human reference per handoff (issue #52): AR- plus two groups of four Crockford base32 characters,
-- random and unrelated to the UUID, which stays the key everywhere. Additive and nullable: handoffs stored before
-- this migration read back with NULL. The unique index enforces one handoff per code (NULLs don't collide).
ALTER TABLE intake_handoffs ADD COLUMN reference_short TEXT
  CHECK (reference_short IS NULL OR (length(reference_short) = 12
    AND substr(reference_short, 1, 3) = 'AR-'
    AND substr(reference_short, 8, 1) = '-'
    AND substr(reference_short, 4, 4) GLOB '[0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]'
    AND substr(reference_short, 9, 4) GLOB '[0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]'
    AND reference_short NOT GLOB '*[ILOU]*'));
CREATE UNIQUE INDEX intake_handoffs_reference_short ON intake_handoffs(reference_short);
