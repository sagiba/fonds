import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  customType,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";

import type { Account } from "../../domain/accounts.js";
import type { Card } from "../../domain/cards.js";
import type {
  AnnotationData,
  ReconciliationFailureCode,
  TransactionInput,
} from "../../domain/model.js";
import type {
  Annotation,
  CollectionFailure,
  Connection,
  ConnectionConfig,
  FinancialResponse,
  LedgerEvent,
  Partition,
  Run,
  Transaction as StoredTransaction,
} from "../../domain/records.js";
import {
  FAILURE_REASONS,
  REFRESH_STATUSES,
  REFRESH_TRIGGERS,
  SKIP_REASONS,
  WINDOW_STATUSES,
} from "../../domain/refreshes.js";

/** JSON stays text: PostgreSQL JSONB cannot retain NUL or the original document. */
const jsonText = <T>() =>
  customType<{ data: T; driverData: string }>({
    dataType: () => "text",
    toDriver: (value) => JSON.stringify(value),
    fromDriver: (value) => JSON.parse(value) as T,
  });

export const connections = pgTable("connections", {
  id: text().primaryKey(),
  provider: text().notNull(),
  displayName: text("display_name").notNull(),
  config: jsonText<ConnectionConfig>()("config_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const accounts = pgTable(
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

export const cards = pgTable(
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
    attributes: jsonText<Card["attributes"]>()("attributes_json"),
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

export const syncRuns = pgTable("sync_runs", {
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
  snapshot: jsonText<{
    schemaVersion: 1;
    responses: FinancialResponse[];
    failures?: CollectionFailure[];
  }>()("snapshot_json").notNull(),
  metadata: jsonText<{
    responses: Omit<FinancialResponse, "responseText">[];
    failures: CollectionFailure[];
  }>()("metadata_json").notNull(),
  coverage: jsonText<Partition[]>()("coverage_json").notNull(),
  warnings: jsonText<string[]>()("warnings_json").notNull(),
  appliedAt: text("applied_at"),
  ingestionOrder: bigserial("ingestion_order", { mode: "number" }).notNull(),
  refreshId: text("refresh_id").references((): AnyPgColumn => refreshes.id, {
    onDelete: "set null",
  }),
});

export const transactions = pgTable(
  "transactions",
  {
    id: text().primaryKey(),
    ingestionOrder: bigserial("ingestion_order", { mode: "number" }).notNull(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id),
    sourceScope: text("source_scope").notNull(),
    cardId: text("card_id"),
    sourceKey: text("source_key").notNull(),
    sourceAliases: jsonText<string[]>()("source_aliases_json").notNull(),
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
    amountMinor: bigint("amount_minor", { mode: "number" }),
    currency: text(),
    amountBasis: text("amount_basis")
      .$type<TransactionInput["amountBasis"]>()
      .notNull(),
    originalAmountMinor: bigint("original_amount_minor", { mode: "number" }),
    originalCurrency: text("original_currency"),
    installmentCount: bigint("installment_count", { mode: "number" }),
    cardPresent: boolean("card_present"),
    authorizationMethod: text("authorization_method", {
      enum: ["chip", "contactless", "keyed_in", "online", "swipe"],
    }),
    wallet: text({ enum: ["apple_pay", "google_pay", "samsung_pay"] }),
    threeDSecureUsed: boolean("three_d_secure_used"),
    recurring: boolean("recurring"),
    purchaseId: text("purchase_id"),
    installmentNumber: bigint("installment_number", { mode: "number" }),
    providerTransactionCode: text("provider_transaction_code"),
    fxFeeMinor: bigint("fx_fee_minor", { mode: "number" }),
    fxFeeCurrency: text("fx_fee_currency"),
    details: jsonText<TransactionInput["details"]>()("details_json").notNull(),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    lastSeenRunId: text("last_seen_run_id")
      .notNull()
      .references(() => syncRuns.id),
    version: bigint({ mode: "number" }).notNull(),
    supersededById: text("superseded_by_id").references(
      (): AnyPgColumn => transactions.id,
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

export const annotations = pgTable("annotations", {
  transactionId: text("transaction_id")
    .primaryKey()
    .references(() => transactions.id),
  version: bigint({ mode: "number" }).notNull(),
  data: jsonText<AnnotationData>()("data_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const events = pgTable(
  "events",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id),
    transactionId: text("transaction_id").references(() => transactions.id),
    runId: text("run_id").references(() => syncRuns.id),
    type: text().notNull(),
    createdAt: text("created_at").notNull(),
    actor: text().notNull(),
    before: jsonText<unknown>()("before_json"),
    after: jsonText<unknown>()("after_json"),
  },
  (table) => [index("events_connection").on(table.connectionId, table.id)],
);

export type Transaction = typeof transactions.$inferSelect;

// Adapter-only ordinals and metadata never become fields of application records.
type SameShape<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

type Assert<T extends true> = T;

export type PostgreSQLRowCompatibility = [
  Assert<SameShape<typeof accounts.$inferSelect, Account>>,
  Assert<SameShape<typeof cards.$inferSelect, Card>>,
  Assert<SameShape<typeof connections.$inferSelect, Connection>>,
  Assert<
    SameShape<
      Omit<typeof syncRuns.$inferSelect, "ingestionOrder" | "metadata">,
      Run
    >
  >,
  Assert<
    SameShape<
      Omit<typeof transactions.$inferSelect, "ingestionOrder">,
      StoredTransaction
    >
  >,
  Assert<SameShape<typeof annotations.$inferSelect, Annotation>>,
  Assert<SameShape<typeof events.$inferSelect, LedgerEvent>>,
];

/** One row per scheduled run, keyed by its occurrence. */
export const scheduledCollections = pgTable(
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
export const settings = pgTable("settings", {
  name: text().primaryKey(),
  value: text().notNull(),
});

/** One accepted refresh or recorded scheduled occurrence. */
export const refreshes = pgTable("refreshes", {
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
  requiresAttention: boolean("requires_attention").notNull(),
  captures: bigint({ mode: "number" }).notNull(),
  unchanged: bigint({ mode: "number" }).notNull(),
  failures: bigint({ mode: "number" }).notNull(),
  created: bigint({ mode: "number" }).notNull(),
  updated: bigint({ mode: "number" }).notNull(),
  failureCodes:
    jsonText<ReconciliationFailureCode[]>()("failure_codes_json").notNull(),
  failureReason: text("failure_reason", { enum: FAILURE_REASONS }),
  missedThrough: text("missed_through"),
  missedCount: bigint("missed_count", { mode: "number" }),
});

/** A ranged refresh's month checkpoints. */
export const refreshWindows = pgTable(
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

/** Who may collect a connection, until when (ms since the epoch, database clock). */
export const collectionLeases = pgTable("collection_leases", {
  connectionId: text("connection_id").primaryKey(),
  holder: text().notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});
