CREATE TABLE connections (
  id TEXT COLLATE "C" PRIMARY KEY NOT NULL,
  provider TEXT COLLATE "C" NOT NULL,
  display_name TEXT COLLATE "C" NOT NULL,
  config_json TEXT COLLATE "C" NOT NULL,
  created_at TEXT COLLATE "C" NOT NULL
);
CREATE TABLE accounts (
  id TEXT COLLATE "C" PRIMARY KEY NOT NULL,
  connection_id TEXT COLLATE "C" NOT NULL REFERENCES connections(id),
  provider_key TEXT COLLATE "C" NOT NULL,
  type TEXT COLLATE "C" NOT NULL CHECK (type IN ('depository','credit')),
  institution_name TEXT COLLATE "C" CHECK (institution_name IS NULL OR length(institution_name) BETWEEN 1 AND 128),
  mask TEXT COLLATE "C" CHECK (mask IS NULL OR mask ~ '^[0-9]{4}$'),
  display_name TEXT COLLATE "C" CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 128),
  created_at TEXT COLLATE "C" NOT NULL,
  last_seen_at TEXT COLLATE "C",
  UNIQUE (connection_id, id),
  UNIQUE (connection_id, provider_key)
);
CREATE TABLE cards (
  id TEXT COLLATE "C" PRIMARY KEY NOT NULL,
  connection_id TEXT COLLATE "C" NOT NULL REFERENCES connections(id),
  provider_key TEXT COLLATE "C" NOT NULL,
  billing_account_id TEXT COLLATE "C",
  last4 TEXT COLLATE "C" CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
  display_name TEXT COLLATE "C" CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 128),
  attributes_json TEXT COLLATE "C",
  created_at TEXT COLLATE "C" NOT NULL,
  last_seen_at TEXT COLLATE "C",
  UNIQUE (connection_id, id),
  UNIQUE (connection_id, provider_key),
  FOREIGN KEY (connection_id, billing_account_id) REFERENCES accounts(connection_id, id)
);
CREATE TABLE sync_runs (
  id TEXT COLLATE "C" PRIMARY KEY NOT NULL,
  connection_id TEXT COLLATE "C" NOT NULL REFERENCES connections(id),
  started_at TEXT COLLATE "C" NOT NULL,
  completed_at TEXT COLLATE "C",
  status TEXT COLLATE "C" NOT NULL CHECK (status IN ('started','completed','partial','failed')),
  collector_version TEXT COLLATE "C" NOT NULL,
  parser_version TEXT COLLATE "C" NOT NULL,
  snapshot_json TEXT COLLATE "C" NOT NULL,
  metadata_json TEXT COLLATE "C" NOT NULL,
  coverage_json TEXT COLLATE "C" NOT NULL,
  warnings_json TEXT COLLATE "C" NOT NULL,
  applied_at TEXT COLLATE "C",
  ingestion_order BIGSERIAL NOT NULL UNIQUE CHECK (ingestion_order BETWEEN 1 AND 9007199254740991)
);
CREATE TABLE transactions (
  id TEXT COLLATE "C" PRIMARY KEY NOT NULL,
  ingestion_order BIGSERIAL NOT NULL UNIQUE CHECK (ingestion_order BETWEEN 1 AND 9007199254740991),
  connection_id TEXT COLLATE "C" NOT NULL REFERENCES connections(id),
  source_scope TEXT COLLATE "C" NOT NULL,
  card_id TEXT COLLATE "C",
  source_key TEXT COLLATE "C" NOT NULL,
  source_aliases_json TEXT COLLATE "C" NOT NULL,
  identity_strength TEXT COLLATE "C" NOT NULL CHECK (identity_strength IN ('native','weak','ambiguous')),
  status TEXT COLLATE "C" NOT NULL CHECK (status IN ('pending','posted')),
  presence TEXT COLLATE "C" NOT NULL CHECK (presence IN ('seen','not_returned','removed')),
  description TEXT COLLATE "C",
  counterparty_name TEXT COLLATE "C",
  kind TEXT COLLATE "C" NOT NULL CHECK (kind IN ('purchase','refund','income','transfer','fee','interest','cash_withdrawal','unknown')),
  merchant_name TEXT COLLATE "C",
  merchant_provider_id TEXT COLLATE "C",
  merchant_category_code TEXT COLLATE "C" CHECK (merchant_category_code IS NULL OR merchant_category_code ~ '^[0-9]{4}$'),
  transaction_date TEXT COLLATE "C",
  booking_date TEXT COLLATE "C",
  billing_date TEXT COLLATE "C",
  amount_minor BIGINT CHECK (amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  currency TEXT COLLATE "C" CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  amount_basis TEXT COLLATE "C" NOT NULL CHECK (amount_basis IN ('booked_entry','authorization','purchase_commitment','unknown')),
  original_amount_minor BIGINT CHECK (original_amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  original_currency TEXT COLLATE "C" CHECK (original_currency IS NULL OR original_currency ~ '^[A-Z]{3}$'),
  installment_count BIGINT CHECK (installment_count BETWEEN 0 AND 9007199254740991),
  card_present BOOLEAN,
  authorization_method TEXT COLLATE "C" CHECK (authorization_method IN ('chip','contactless','keyed_in','online','swipe')),
  wallet TEXT COLLATE "C" CHECK (wallet IN ('apple_pay','google_pay','samsung_pay')),
  three_d_secure_used BOOLEAN,
  recurring BOOLEAN,
  purchase_id TEXT COLLATE "C",
  installment_number BIGINT CHECK (installment_number BETWEEN 1 AND 9007199254740991),
  provider_transaction_code TEXT COLLATE "C",
  fx_fee_minor BIGINT CHECK (fx_fee_minor BETWEEN -9007199254740991 AND 9007199254740991),
  fx_fee_currency TEXT COLLATE "C" CHECK (fx_fee_currency IS NULL OR fx_fee_currency ~ '^[A-Z]{3}$'),
  details_json TEXT COLLATE "C" NOT NULL,
  first_seen_at TEXT COLLATE "C" NOT NULL,
  last_seen_at TEXT COLLATE "C" NOT NULL,
  last_seen_run_id TEXT COLLATE "C" NOT NULL REFERENCES sync_runs(id),
  version BIGINT NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  superseded_by_id TEXT COLLATE "C" REFERENCES transactions(id),
  UNIQUE (connection_id, id),
  FOREIGN KEY (connection_id, card_id) REFERENCES cards(connection_id, id),
  FOREIGN KEY (connection_id, purchase_id) REFERENCES transactions(connection_id, id) ON DELETE RESTRICT,
  CHECK (purchase_id <> id),
  CHECK ((amount_minor IS NULL) = (currency IS NULL)),
  CHECK ((original_amount_minor IS NULL) = (original_currency IS NULL)),
  CHECK ((fx_fee_minor IS NULL) = (fx_fee_currency IS NULL))
);
CREATE INDEX transactions_source ON transactions(connection_id, source_scope, source_key);
CREATE INDEX transactions_purchase ON transactions(connection_id, purchase_id);
CREATE INDEX transactions_date ON transactions(transaction_date);
CREATE INDEX transactions_merchant_name ON transactions(merchant_name);
CREATE INDEX transactions_status ON transactions(status);
CREATE TABLE annotations (
  transaction_id TEXT COLLATE "C" PRIMARY KEY NOT NULL REFERENCES transactions(id),
  version BIGINT NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  data_json TEXT COLLATE "C" NOT NULL,
  updated_at TEXT COLLATE "C" NOT NULL
);
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
  connection_id TEXT COLLATE "C" NOT NULL REFERENCES connections(id),
  transaction_id TEXT COLLATE "C" REFERENCES transactions(id),
  run_id TEXT COLLATE "C" REFERENCES sync_runs(id),
  type TEXT COLLATE "C" NOT NULL,
  created_at TEXT COLLATE "C" NOT NULL,
  actor TEXT COLLATE "C" NOT NULL,
  before_json TEXT COLLATE "C",
  after_json TEXT COLLATE "C"
);
CREATE INDEX events_connection ON events(connection_id, id);
ALTER SEQUENCE events_id_seq CACHE 1;
ALTER SEQUENCE sync_runs_ingestion_order_seq CACHE 1;
ALTER SEQUENCE transactions_ingestion_order_seq CACHE 1;
CREATE TABLE scheduled_collections (
  occurrence TEXT COLLATE "C" PRIMARY KEY NOT NULL,
  scheduled_at TEXT COLLATE "C" NOT NULL,
  status TEXT COLLATE "C" NOT NULL CHECK (status IN ('running','finished')),
  lease_until TEXT COLLATE "C" NOT NULL
);
CREATE INDEX scheduled_collections_scheduled_at ON scheduled_collections(scheduled_at);
CREATE TABLE settings (
  name TEXT COLLATE "C" PRIMARY KEY NOT NULL,
  value TEXT COLLATE "C" NOT NULL
);
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Operational state in the operations schema: credentials, Events
-- subscriptions and the installation record. No foreign keys: the financial
-- schema is selected by search_path, not named here.
CREATE SCHEMA operations;
CREATE TABLE operations.provider_credentials (
  connection_id text PRIMARY KEY,
  provider text NOT NULL,
  version smallint NOT NULL CHECK (version = 1),
  key_id text NOT NULL CHECK (length(key_id) BETWEEN 1 AND 64),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 32768),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE operations.event_subscriptions (
  id text PRIMARY KEY,
  generation bigint NOT NULL CHECK (generation > 0),
  status text NOT NULL CHECK (status IN ('active','inactive','failed','revoked')),
  expires_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  state_json jsonb NOT NULL
);
CREATE INDEX event_subscriptions_due
  ON operations.event_subscriptions (next_attempt_at) WHERE status='active';
CREATE TABLE operations.installation (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  owner_id text NOT NULL,
  auth_secret_digest text NOT NULL,
  credentials_key_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
