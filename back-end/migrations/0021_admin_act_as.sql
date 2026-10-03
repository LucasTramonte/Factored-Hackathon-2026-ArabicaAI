-- Admins act as any loaded customer (ADR-007, decision 10). `admin` marks a customer session opened by a verified admin
-- token; only such a session may list customers or act as one, and the act-as session keeps the mark. `admin_actions`
-- records each act-as by reference only: the 12-hex prefixes of the admin's presented session hash and of the new
-- session's hash, and the request id. Never a customer id, email or token. Additive: existing sessions read admin = 0.
ALTER TABLE sessions ADD COLUMN admin INTEGER NOT NULL DEFAULT 0 CHECK (admin IN (0, 1));
CREATE TABLE admin_actions (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('act_as')),
  admin_session_ref TEXT NOT NULL CHECK (length(admin_session_ref) = 12),
  session_ref TEXT NOT NULL CHECK (length(session_ref) = 12),
  request_id TEXT NOT NULL
);
CREATE INDEX admin_actions_time ON admin_actions(ts DESC);
