-- A finished review keeps its immutable explanation; earlier reviews remain honestly null.
ALTER TABLE intake_handoffs ADD COLUMN closing_note TEXT;
