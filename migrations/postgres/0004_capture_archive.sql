CREATE TABLE capture_archives (
  id TEXT COLLATE "C" PRIMARY KEY NOT NULL,
  connection_id TEXT COLLATE "C" NOT NULL REFERENCES connections(id),
  kind TEXT COLLATE "C" NOT NULL CHECK (kind IN ('run','card_discovery')),
  captured_at TEXT COLLATE "C" NOT NULL,
  content_digest TEXT COLLATE "C" NOT NULL,
  body BYTEA,
  expires_at TEXT COLLATE "C" NOT NULL
);
CREATE INDEX capture_archives_content ON capture_archives(connection_id, content_digest);
CREATE INDEX capture_archives_expiry ON capture_archives(expires_at);
