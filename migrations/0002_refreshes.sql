-- Refreshes as recorded resources. A ranged refresh checkpoints one window per
-- calendar month; sync runs name the refresh that archived them.
CREATE TABLE refreshes (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('manual','scheduled')),
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','partial','failed','skipped')),
  skip_reason TEXT CHECK (skip_reason IN ('busy','cooldown','requires_attention','missed')),
  range_from TEXT,
  range_to TEXT,
  occurrence TEXT,
  scheduled_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  requires_attention INTEGER NOT NULL CHECK (requires_attention IN (0,1)),
  captures INTEGER NOT NULL CHECK (captures BETWEEN 0 AND 9007199254740991),
  unchanged INTEGER NOT NULL CHECK (unchanged BETWEEN 0 AND 9007199254740991),
  failures INTEGER NOT NULL CHECK (failures BETWEEN 0 AND 9007199254740991),
  created INTEGER NOT NULL CHECK (created BETWEEN 0 AND 9007199254740991),
  updated INTEGER NOT NULL CHECK (updated BETWEEN 0 AND 9007199254740991),
  failure_codes_json TEXT NOT NULL CHECK (json_valid(failure_codes_json)),
  failure_reason TEXT CHECK (failure_reason IN ('expired')),
  missed_through TEXT,
  missed_count INTEGER CHECK (missed_count BETWEEN 1 AND 9007199254740991),
  CHECK ((skip_reason IS NULL) = (status <> 'skipped')),
  CHECK (status <> 'skipped' OR trigger = 'scheduled'),
  CHECK ((range_from IS NULL) = (range_to IS NULL)),
  CHECK (range_from <= range_to),
  CHECK ((occurrence IS NULL) = (scheduled_at IS NULL)),
  CHECK (started_at IS NOT NULL OR status IN ('pending','skipped')),
  CHECK ((finished_at IS NULL) = (status IN ('pending','running'))),
  CHECK (failure_reason IS NULL OR status = 'failed'),
  CHECK ((missed_count IS NULL) = (missed_through IS NULL)),
  CHECK ((missed_count IS NULL) = (skip_reason IS NOT 'missed'))
) STRICT;
CREATE UNIQUE INDEX refreshes_active ON refreshes(connection_id) WHERE status IN ('pending','running');
CREATE UNIQUE INDEX refreshes_occurrence ON refreshes(connection_id, occurrence) WHERE occurrence IS NOT NULL;
CREATE INDEX refreshes_connection ON refreshes(connection_id, created_at, id);
CREATE TABLE refresh_windows (
  refresh_id TEXT NOT NULL REFERENCES refreshes(id) ON DELETE CASCADE,
  range_from TEXT NOT NULL,
  range_to TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','partial','failed')),
  PRIMARY KEY (refresh_id, range_from),
  CHECK (range_from <= range_to)
) STRICT;
ALTER TABLE sync_runs ADD COLUMN refresh_id TEXT REFERENCES refreshes(id) ON DELETE SET NULL;
CREATE INDEX sync_runs_refresh ON sync_runs(refresh_id);
