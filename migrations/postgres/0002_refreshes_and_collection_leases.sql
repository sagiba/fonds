-- Refreshes as recorded resources. A ranged refresh checkpoints one window per
-- calendar month; sync runs name the refresh that archived them.
CREATE TABLE refreshes (
  id TEXT COLLATE "C" PRIMARY KEY NOT NULL,
  connection_id TEXT COLLATE "C" NOT NULL REFERENCES connections(id),
  trigger TEXT COLLATE "C" NOT NULL CHECK (trigger IN ('manual','scheduled')),
  status TEXT COLLATE "C" NOT NULL CHECK (status IN ('pending','running','completed','partial','failed','skipped')),
  skip_reason TEXT COLLATE "C" CHECK (skip_reason IN ('busy','cooldown','requires_attention','missed')),
  range_from TEXT COLLATE "C",
  range_to TEXT COLLATE "C",
  occurrence TEXT COLLATE "C",
  scheduled_at TEXT COLLATE "C",
  created_at TEXT COLLATE "C" NOT NULL,
  started_at TEXT COLLATE "C",
  finished_at TEXT COLLATE "C",
  requires_attention BOOLEAN NOT NULL,
  captures BIGINT NOT NULL CHECK (captures BETWEEN 0 AND 9007199254740991),
  unchanged BIGINT NOT NULL CHECK (unchanged BETWEEN 0 AND 9007199254740991),
  failures BIGINT NOT NULL CHECK (failures BETWEEN 0 AND 9007199254740991),
  created BIGINT NOT NULL CHECK (created BETWEEN 0 AND 9007199254740991),
  updated BIGINT NOT NULL CHECK (updated BETWEEN 0 AND 9007199254740991),
  failure_codes_json TEXT COLLATE "C" NOT NULL,
  failure_reason TEXT COLLATE "C" CHECK (failure_reason IN ('expired')),
  missed_through TEXT COLLATE "C",
  missed_count BIGINT CHECK (missed_count BETWEEN 1 AND 9007199254740991),
  CHECK ((skip_reason IS NULL) = (status <> 'skipped')),
  CHECK (status <> 'skipped' OR trigger = 'scheduled'),
  CHECK ((range_from IS NULL) = (range_to IS NULL)),
  CHECK (range_from <= range_to),
  CHECK ((occurrence IS NULL) = (scheduled_at IS NULL)),
  CHECK (started_at IS NOT NULL OR status IN ('pending','skipped')),
  CHECK ((finished_at IS NULL) = (status IN ('pending','running'))),
  CHECK (failure_reason IS NULL OR status = 'failed'),
  CHECK ((missed_count IS NULL) = (missed_through IS NULL)),
  CHECK ((missed_count IS NULL) = (skip_reason IS DISTINCT FROM 'missed'))
);
CREATE UNIQUE INDEX refreshes_active ON refreshes(connection_id) WHERE status IN ('pending','running');
CREATE UNIQUE INDEX refreshes_occurrence ON refreshes(connection_id, occurrence) WHERE occurrence IS NOT NULL;
CREATE INDEX refreshes_connection ON refreshes(connection_id, created_at, id);
CREATE TABLE refresh_windows (
  refresh_id TEXT COLLATE "C" NOT NULL REFERENCES refreshes(id) ON DELETE CASCADE,
  range_from TEXT COLLATE "C" NOT NULL,
  range_to TEXT COLLATE "C" NOT NULL,
  status TEXT COLLATE "C" NOT NULL CHECK (status IN ('pending','running','completed','partial','failed')),
  PRIMARY KEY (refresh_id, range_from),
  CHECK (range_from <= range_to)
);
ALTER TABLE sync_runs ADD COLUMN refresh_id TEXT COLLATE "C" REFERENCES refreshes(id) ON DELETE SET NULL;
CREATE INDEX sync_runs_refresh ON sync_runs(refresh_id);
-- The same renewed, token-fenced collection lease as SQLite, in place of a
-- session lock, so a refresh can continue in another invocation.
CREATE TABLE collection_leases (
  connection_id TEXT COLLATE "C" PRIMARY KEY NOT NULL,
  holder TEXT COLLATE "C" NOT NULL CHECK (length(holder) BETWEEN 1 AND 64),
  expires_at BIGINT NOT NULL CHECK (expires_at BETWEEN 0 AND 9007199254740991)
);
