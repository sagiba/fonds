CREATE TABLE connections (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CONSTRAINT connection_revision CHECK (revision BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  provider_key TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('depository','credit')),
  institution_name TEXT CHECK (institution_name IS NULL OR length(institution_name) BETWEEN 1 AND 128),
  mask TEXT CHECK (mask IS NULL OR mask GLOB '[0-9][0-9][0-9][0-9]'),
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  UNIQUE (connection_id, id),
  UNIQUE (connection_id, provider_key)
) STRICT;
CREATE TABLE cards (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  provider_key TEXT NOT NULL,
  billing_account_id TEXT,
  last4 TEXT CHECK (last4 IS NULL OR last4 GLOB '[0-9][0-9][0-9][0-9]'),
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 128),
  attributes_json TEXT CHECK (attributes_json IS NULL OR json_valid(attributes_json)),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  UNIQUE (connection_id, id),
  UNIQUE (connection_id, provider_key),
  FOREIGN KEY (connection_id, billing_account_id) REFERENCES accounts(connection_id, id)
) STRICT;
CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('started','completed','partial','failed')),
  collector_version TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  coverage_json TEXT NOT NULL CHECK (json_valid(coverage_json)),
  warnings_json TEXT NOT NULL CHECK (json_valid(warnings_json)),
  applied_at TEXT
) STRICT;
CREATE TABLE transactions (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  source_scope TEXT NOT NULL,
  card_id TEXT,
  source_key TEXT NOT NULL,
  source_aliases_json TEXT NOT NULL CHECK (json_valid(source_aliases_json)),
  identity_strength TEXT NOT NULL CHECK (identity_strength IN ('native','weak','ambiguous')),
  status TEXT NOT NULL CHECK (status IN ('pending','posted')),
  presence TEXT NOT NULL CHECK (presence IN ('seen','not_returned','removed')),
  description TEXT,
  counterparty_name TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('purchase','refund','income','transfer','fee','interest','cash_withdrawal','unknown')),
  merchant_name TEXT,
  merchant_provider_id TEXT,
  merchant_category_code TEXT CHECK (merchant_category_code IS NULL OR merchant_category_code GLOB '[0-9][0-9][0-9][0-9]'),
  transaction_date TEXT,
  booking_date TEXT,
  billing_date TEXT,
  amount_minor INTEGER CHECK (amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  currency TEXT CHECK (currency IS NULL OR currency GLOB '[A-Z][A-Z][A-Z]'),
  amount_basis TEXT NOT NULL CHECK (amount_basis IN ('booked_entry','authorization','purchase_commitment','unknown')),
  original_amount_minor INTEGER CHECK (original_amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  original_currency TEXT CHECK (original_currency IS NULL OR original_currency GLOB '[A-Z][A-Z][A-Z]'),
  installment_count INTEGER CHECK (installment_count BETWEEN 0 AND 9007199254740991),
  card_present INTEGER CHECK (card_present IN (0,1)),
  authorization_method TEXT CHECK (authorization_method IN ('chip','contactless','keyed_in','online','swipe')),
  wallet TEXT CHECK (wallet IN ('apple_pay','google_pay','samsung_pay')),
  three_d_secure_used INTEGER CHECK (three_d_secure_used IN (0,1)),
  recurring INTEGER CHECK (recurring IN (0,1)),
  purchase_id TEXT,
  installment_number INTEGER CHECK (installment_number BETWEEN 1 AND 9007199254740991),
  provider_transaction_code TEXT,
  fx_fee_minor INTEGER CHECK (fx_fee_minor BETWEEN -9007199254740991 AND 9007199254740991),
  fx_fee_currency TEXT CHECK (fx_fee_currency IS NULL OR fx_fee_currency GLOB '[A-Z][A-Z][A-Z]'),
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_seen_run_id TEXT NOT NULL REFERENCES sync_runs(id),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  superseded_by_id TEXT REFERENCES transactions(id),
  UNIQUE (connection_id, id),
  FOREIGN KEY (connection_id, card_id) REFERENCES cards(connection_id, id),
  FOREIGN KEY (connection_id, purchase_id) REFERENCES transactions(connection_id, id) ON DELETE RESTRICT,
  CHECK (purchase_id <> id),
  CHECK ((amount_minor IS NULL) = (currency IS NULL)),
  CHECK ((original_amount_minor IS NULL) = (original_currency IS NULL)),
  CHECK ((fx_fee_minor IS NULL) = (fx_fee_currency IS NULL))
) STRICT;
CREATE INDEX transactions_source ON transactions(connection_id, source_scope, source_key);
CREATE INDEX transactions_purchase ON transactions(connection_id, purchase_id);
CREATE INDEX transactions_date ON transactions(transaction_date);
CREATE INDEX transactions_merchant_name ON transactions(merchant_name);
CREATE INDEX transactions_status ON transactions(status);
CREATE TABLE annotations (
  transaction_id TEXT PRIMARY KEY NOT NULL REFERENCES transactions(id),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id BETWEEN 1 AND 9007199254740991),
  connection_id TEXT NOT NULL REFERENCES connections(id),
  transaction_id TEXT REFERENCES transactions(id),
  run_id TEXT REFERENCES sync_runs(id),
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json))
) STRICT;
CREATE INDEX events_connection ON events(connection_id, id);
CREATE TABLE provider_credentials (
  connection_id TEXT PRIMARY KEY NOT NULL REFERENCES connections(id),
  provider TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version = 1),
  key_id TEXT NOT NULL CHECK (length(key_id) BETWEEN 1 AND 64),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) BETWEEN 17 AND 32768),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE scheduled_collections (
  occurrence TEXT PRIMARY KEY NOT NULL,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','finished')),
  lease_until TEXT NOT NULL
) STRICT;
CREATE INDEX scheduled_collections_scheduled_at ON scheduled_collections(scheduled_at);
CREATE TABLE settings (
  name TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE collection_leases (
  connection_id TEXT PRIMARY KEY NOT NULL,
  holder TEXT NOT NULL CHECK (length(holder) BETWEEN 1 AND 64),
  expires_at INTEGER NOT NULL CHECK (expires_at BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TABLE event_subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK (status IN ('active','inactive','failed','revoked')),
  expires_at INTEGER NOT NULL CHECK (expires_at BETWEEN 0 AND 9007199254740991),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at BETWEEN 0 AND 9007199254740991),
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
) STRICT;
CREATE INDEX event_subscriptions_due ON event_subscriptions(next_attempt_at) WHERE status = 'active';
