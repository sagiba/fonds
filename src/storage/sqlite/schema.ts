import {
  type AnySQLiteColumn,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

import type { Card } from "../../domain/cards.js";
import type {
  AnnotationData,
  ReconciliationFailureCode,
  TransactionInput,
} from "../../domain/model.js";
import type {
  CollectionFailure,
  ConnectionConfig,
  FinancialResponse,
  Partition,
} from "../../domain/records.js";
import {
  FAILURE_REASONS,
  REFRESH_STATUSES,
  REFRESH_TRIGGERS,
  SKIP_REASONS,
  WINDOW_STATUSES,
} from "../../domain/refreshes.js";

export type {
  CollectionFailure,
  CollectionScope,
  FinancialResponse,
  Partition,
  Transaction,
} from "../../domain/records.js";

export const connections = sqliteTable("connections", {
  id: text().primaryKey(),
  provider: text().notNull(),
  displayName: text("display_name").notNull(),
  config: text("config_json", { mode: "json" })
    .$type<ConnectionConfig>()
    .notNull(),
  createdAt: text("created_at").notNull(),
});

export const accounts = sqliteTable(
  "accounts",
  {
    id: text().primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id),
    providerKey: text("provider_key").notNull(),
    type: text({ enum: ["depository", "credit"] }).notNull(),
    institutionName: text("institution_name"),
    mask: text(),
    displayName: text("display_name"),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at"),
  },
  (table) => [
    unique().on(table.connectionId, table.id),
    unique().on(table.connectionId, table.providerKey),
  ],
);

export const cards = sqliteTable(
  "cards",
  {
    id: text().primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id),
    providerKey: text("provider_key").notNull(),
    billingAccountId: text("billing_account_id"),
    last4: text("last4"),
    displayName: text("display_name"),
    attributes: text("attributes_json", { mode: "json" }).$type<
      Card["attributes"]
    >(),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at"),
  },
  (table) => [
    unique().on(table.connectionId, table.id),
    unique().on(table.connectionId, table.providerKey),
    foreignKey({
      columns: [table.connectionId, table.billingAccountId],
      foreignColumns: [accounts.connectionId, accounts.id],
    }),
  ],
);

export const syncRuns = sqliteTable("sync_runs", {
  id: text().primaryKey(),
  connectionId: text("connection_id")
    .notNull()
    .references(() => connections.id),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  status: text({
    enum: ["started", "completed", "partial", "failed"],
  }).notNull(),
  collectorVersion: text("collector_version").notNull(),
  parserVersion: text("parser_version").notNull(),
  snapshot: text("snapshot_json", { mode: "json" })
    .$type<{
      schemaVersion: 1;
      responses: FinancialResponse[];
      failures?: CollectionFailure[];
    }>()
    .notNull(),
  coverage: text("coverage_json", { mode: "json" })
    .$type<Partition[]>()
    .notNull(),
  warnings: text("warnings_json", { mode: "json" }).$type<string[]>().notNull(),
  appliedAt: text("applied_at"),
  refreshId: text("refresh_id").references(
    (): AnySQLiteColumn => refreshes.id,
    {
      onDelete: "set null",
    },
  ),
});

export const transactions = sqliteTable(
  "transactions",
  {
    id: text().primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id),
    sourceScope: text("source_scope").notNull(),
    cardId: text("card_id"),
    sourceKey: text("source_key").notNull(),
    sourceAliases: text("source_aliases_json", { mode: "json" })
      .$type<string[]>()
      .notNull(),
    identityStrength: text("identity_strength", {
      enum: ["native", "weak", "ambiguous"],
    }).notNull(),
    status: text({ enum: ["pending", "posted"] }).notNull(),
    presence: text({ enum: ["seen", "not_returned", "removed"] }).notNull(),
    description: text(),
    counterpartyName: text("counterparty_name"),
    kind: text().$type<TransactionInput["kind"]>().notNull(),
    merchantName: text("merchant_name"),
    merchantProviderId: text("merchant_provider_id"),
    merchantCategoryCode: text("merchant_category_code"),
    transactionDate: text("transaction_date"),
    bookingDate: text("booking_date"),
    billingDate: text("billing_date"),
    amountMinor: integer("amount_minor"),
    currency: text(),
    amountBasis: text("amount_basis")
      .$type<TransactionInput["amountBasis"]>()
      .notNull(),
    originalAmountMinor: integer("original_amount_minor"),
    originalCurrency: text("original_currency"),
    installmentCount: integer("installment_count"),
    cardPresent: integer("card_present", { mode: "boolean" }),
    authorizationMethod: text("authorization_method", {
      enum: ["chip", "contactless", "keyed_in", "online", "swipe"],
    }),
    wallet: text({ enum: ["apple_pay", "google_pay", "samsung_pay"] }),
    threeDSecureUsed: integer("three_d_secure_used", { mode: "boolean" }),
    recurring: integer("recurring", { mode: "boolean" }),
    purchaseId: text("purchase_id"),
    installmentNumber: integer("installment_number"),
    providerTransactionCode: text("provider_transaction_code"),
    fxFeeMinor: integer("fx_fee_minor"),
    fxFeeCurrency: text("fx_fee_currency"),
    details: text("details_json", { mode: "json" })
      .$type<TransactionInput["details"]>()
      .notNull(),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    lastSeenRunId: text("last_seen_run_id")
      .notNull()
      .references(() => syncRuns.id),
    version: integer().notNull(),
    supersededById: text("superseded_by_id").references(
      (): AnySQLiteColumn => transactions.id,
    ),
  },
  (table) => [
    unique().on(table.connectionId, table.id),
    foreignKey({
      columns: [table.connectionId, table.cardId],
      foreignColumns: [cards.connectionId, cards.id],
    }),
    foreignKey({
      columns: [table.connectionId, table.purchaseId],
      foreignColumns: [table.connectionId, table.id],
    }).onDelete("restrict"),
    index("transactions_source").on(
      table.connectionId,
      table.sourceScope,
      table.sourceKey,
    ),
    index("transactions_purchase").on(table.connectionId, table.purchaseId),
    index("transactions_date").on(table.transactionDate),
    index("transactions_merchant_name").on(table.merchantName),
    index("transactions_status").on(table.status),
  ],
);

export const annotations = sqliteTable("annotations", {
  transactionId: text("transaction_id")
    .primaryKey()
    .references(() => transactions.id),
  version: integer().notNull(),
  data: text("data_json", { mode: "json" }).$type<AnnotationData>().notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const events = sqliteTable(
  "events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id),
    transactionId: text("transaction_id").references(() => transactions.id),
    runId: text("run_id").references(() => syncRuns.id),
    type: text().notNull(),
    createdAt: text("created_at").notNull(),
    actor: text().notNull(),
    before: text("before_json", { mode: "json" }).$type<unknown>(),
    after: text("after_json", { mode: "json" }).$type<unknown>(),
  },
  (table) => [index("events_connection").on(table.connectionId, table.id)],
);

/** One row per scheduled run, keyed by its occurrence. */
export const scheduledCollections = sqliteTable(
  "scheduled_collections",
  {
    occurrence: text().primaryKey(),
    scheduledAt: text("scheduled_at").notNull(),
    status: text({ enum: ["running", "finished"] }).notNull(),
    leaseUntil: text("lease_until").notNull(),
  },
  (table) => [
    index("scheduled_collections_scheduled_at").on(table.scheduledAt),
  ],
);

/** Generated service settings, such as the random collection time. */
export const settings = sqliteTable("settings", {
  name: text().primaryKey(),
  value: text().notNull(),
});

/** Who may collect a connection, until when (ms since the epoch, database clock). */
export const collectionLeases = sqliteTable("collection_leases", {
  connectionId: text("connection_id").primaryKey(),
  holder: text().notNull(),
  expiresAt: integer("expires_at").notNull(),
});

/** One accepted refresh or recorded scheduled occurrence. */
export const refreshes = sqliteTable("refreshes", {
  id: text().primaryKey(),
  connectionId: text("connection_id")
    .notNull()
    .references(() => connections.id),
  trigger: text({ enum: REFRESH_TRIGGERS }).notNull(),
  status: text({ enum: REFRESH_STATUSES }).notNull(),
  skipReason: text("skip_reason", { enum: SKIP_REASONS }),
  rangeFrom: text("range_from"),
  rangeTo: text("range_to"),
  occurrence: text(),
  scheduledAt: text("scheduled_at"),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  requiresAttention: integer("requires_attention", {
    mode: "boolean",
  }).notNull(),
  captures: integer().notNull(),
  unchanged: integer().notNull(),
  failures: integer().notNull(),
  created: integer().notNull(),
  updated: integer().notNull(),
  failureCodes: text("failure_codes_json", { mode: "json" })
    .$type<ReconciliationFailureCode[]>()
    .notNull(),
  failureReason: text("failure_reason", { enum: FAILURE_REASONS }),
  missedThrough: text("missed_through"),
  missedCount: integer("missed_count"),
});

/** A ranged refresh's month checkpoints. */
export const refreshWindows = sqliteTable(
  "refresh_windows",
  {
    refreshId: text("refresh_id")
      .notNull()
      .references(() => refreshes.id, { onDelete: "cascade" }),
    rangeFrom: text("range_from").notNull(),
    rangeTo: text("range_to").notNull(),
    status: text({ enum: WINDOW_STATUSES }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.refreshId, table.rangeFrom] })],
);
