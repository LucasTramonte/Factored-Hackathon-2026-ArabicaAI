-- Who authenticated, when, and how it ended. References only: a 12-hex prefix of the session token hash and the
-- request id. Written on session start, logout, and on a presented cookie that was malformed or expired; never on a
-- request with no cookie, so anonymous traffic costs no writes.
CREATE TABLE auth_events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('customer','agent')),
  event TEXT NOT NULL CHECK (event IN ('session_started','session_rejected','session_expired','logged_out')),
  session_ref TEXT NOT NULL CHECK (length(session_ref) = 12),
  request_id TEXT NOT NULL
);
CREATE INDEX auth_events_time ON auth_events(ts DESC);
