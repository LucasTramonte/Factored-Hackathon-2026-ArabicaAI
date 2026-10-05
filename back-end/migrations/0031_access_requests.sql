-- Evaluator access requests from the sign-in screen (POST /auth/access-request). Additive only. The address itself is never
-- stored: one row per SHA-256 of the lowercased address and UTC day, so a resubmission sends the team no second email and the
-- route can cap how many addresses reach the team a day. ``token`` marks the request that holds the row; when the email fails
-- that request deletes its own row, so the person can ask again. The next request deletes rows older than seven days.
CREATE TABLE access_requests (
  email_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (email_hash, day)
);
-- The daily cap counts one day's rows, and the retention delete drops old days, without scanning the table.
CREATE INDEX access_requests_day ON access_requests(day);
