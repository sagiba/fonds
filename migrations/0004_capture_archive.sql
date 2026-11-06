CREATE TABLE capture_archives (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (sequence BETWEEN 1 AND 9007199254740991),
  id TEXT NOT NULL UNIQUE,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  kind TEXT NOT NULL CHECK (kind IN ('run','card_discovery')),
  captured_at TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  body BLOB,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX capture_archives_content ON capture_archives(connection_id, content_digest);
CREATE INDEX capture_archives_expiry ON capture_archives(expires_at);
