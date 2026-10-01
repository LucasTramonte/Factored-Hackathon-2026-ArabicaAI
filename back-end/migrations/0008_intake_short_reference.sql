-- A short human reference per handoff (issue #52): AR- plus two groups of four Crockford base32 characters,
-- random and unrelated to the UUID, which stays the key everywhere. Additive and nullable: handoffs stored before
-- this migration read back with NULL. The unique index enforces one handoff per code (NULLs don't collide).
ALTER TABLE intake_handoffs ADD COLUMN reference_short TEXT
  CHECK (reference_short IS NULL OR (length(reference_short) = 12
    AND reference_short GLOB 'AR-[0-9ABCDEFGHJKMNPQRSTVWXYZ][0-9ABCDEFGHJKMNPQRSTVWXYZ][0-9ABCDEFGHJKMNPQRSTVWXYZ][0-9ABCDEFGHJKMNPQRSTVWXYZ]-[0-9ABCDEFGHJKMNPQRSTVWXYZ][0-9ABCDEFGHJKMNPQRSTVWXYZ][0-9ABCDEFGHJKMNPQRSTVWXYZ][0-9ABCDEFGHJKMNPQRSTVWXYZ]'));
CREATE UNIQUE INDEX intake_handoffs_reference_short ON intake_handoffs(reference_short);
