CREATE TABLE sync_run_history (
  connection_id TEXT COLLATE "C" PRIMARY KEY NOT NULL REFERENCES connections(id),
  document_json TEXT COLLATE "C" NOT NULL
);
