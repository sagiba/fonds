CREATE TABLE sync_run_history (
  connection_id TEXT PRIMARY KEY NOT NULL REFERENCES connections(id),
  document_json TEXT NOT NULL CHECK (json_valid(document_json))
) STRICT;
