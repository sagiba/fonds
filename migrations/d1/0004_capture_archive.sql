CREATE TABLE capture_archives (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  kind TEXT NOT NULL CHECK (kind IN ('run','card_discovery')),
  captured_at TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  body BLOB,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX capture_archives_content ON capture_archives(connection_id, content_digest);
CREATE INDEX capture_archives_expiry ON capture_archives(expires_at);
