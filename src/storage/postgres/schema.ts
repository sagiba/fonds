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
  RefreshFailureCode,
  SourceAbsence,
  SourceEvidence,
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
} from "../../domain/records.js";
import {
  FAILURE_REASONS,
  PROVIDER_STOP_REASONS,
  REFRESH_STATUSES,
  REFRESH_TRIGGERS,
  SKIP_REASONS,
  WINDOW_STATUSES,
} from "../../domain/refreshes.js";
import { decodeScalarText, encodeScalarText } from "../scalar-text.js";

/** JSON stays text: PostgreSQL JSONB cannot retain NUL or the original document. */
const jsonText = <T>() =>
  customType<{ data: T; driverData: string }>({
    dataType: () => "text",
    toDriver: (value) => JSON.stringify(value),
    fromDriver: (value) => JSON.parse(value) as T,
  });

const scalarText = customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  toDriver: encodeScalarText,
  fromDriver: decodeScalarText,
});

/**
 * A native `date` read back as the stored `YYYY-MM-DD` text. Any other form
 * means a session `DateStyle` other than ISO; refuse it rather than reparse.
 */
const calendarDate = customType<{ data: string; driverData: string }>({
  dataType: () => "date",
  fromDriver: (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error("PostgreSQL dates require DateStyle ISO");
    }
    return value;
  },
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
    responses: Omit<FinancialResponse, "responseText">[];
    failures?: CollectionFailure[];
  }>()("metadata_json").notNull(),
  evidenceDigest: text("evidence_digest").notNull(),
  coverage: jsonText<Partition[]>()("coverage_json").notNull(),
  warnings: jsonText<string[]>()("warnings_json").notNull(),
  appliedAt: text("applied_at"),
  ingestionOrder: bigserial("ingestion_order", { mode: "number" }).notNull(),
  refreshId: text("refresh_id").references((): AnyPgColumn => refreshes.id, {
    onDelete: "set null",
  }),
});

/** One derived summary of a connection's applied runs; see run-history.ts. */
export const syncRunHistory = pgTable("sync_run_history", {
  connectionId: text("connection_id")
    .primaryKey()
    .references(() => connections.id),
  document: jsonText<unknown>()("document_json").notNull(),
});

export const syncRunBodies = pgTable("sync_run_bodies", {
  runId: text("run_id")
    .primaryKey()
    .references(() => syncRuns.id),
  snapshot: jsonText<{
    schemaVersion: 1;
    responses: FinancialResponse[];
    failures?: CollectionFailure[];
  }>()("snapshot_json").notNull(),
  retention: text({ enum: ["staged", "debug"] }).notNull(),
  expiresAt: text("expires_at"),
});

export const deferredEvidence = pgTable("deferred_evidence", {
  id: text().primaryKey(),
  connectionId: text("connection_id")
    .notNull()
    .references(() => connections.id),
  sourceScope: text("source_scope").notNull(),
  sourceKey: text("source_key").notNull(),
  reason: text().notNull(),
  content: jsonText<Record<string, unknown>>()("content_json").notNull(),
  firstSeenRunId: text("first_seen_run_id")
    .notNull()
    .references(() => syncRuns.id),
  lastSeenRunId: text("last_seen_run_id")
    .notNull()
    .references(() => syncRuns.id),
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
    sourceAbsence: jsonText<SourceAbsence>()("source_absence_json"),
    description: text(),
    counterpartyName: text("counterparty_name"),
    kind: text().$type<TransactionInput["kind"]>().notNull(),
    merchantName: text("merchant_name"),
    merchantProviderId: text("merchant_provider_id"),
    merchantCategoryCode: text("merchant_category_code"),
    transactionDate: calendarDate("transaction_date"),
    bookingDate: calendarDate("booking_date"),
    billingDate: calendarDate("billing_date"),
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
    transactionDateTime: text("transaction_date_time"),
    merchantAddressLine: scalarText("merchant_address_line"),
    merchantPhone: scalarText("merchant_phone"),
    merchantCity: scalarText("merchant_city"),
    merchantCountryCode: text("merchant_country_code"),
    additionalInformation: jsonText<
      NonNullable<TransactionInput["details"]["additionalInformation"]>
    >()("additional_information_json"),
    currencyExchange: jsonText<
      NonNullable<TransactionInput["details"]["currencyExchange"]>
    >()("currency_exchange_json"),
    sourceIssues: jsonText<string[]>()("source_issues_json").notNull(),
    provider:
      jsonText<TransactionInput["details"]["provider"]>()(
        "provider_json",
      ).notNull(),
    firstSeenAt: text("first_seen_at").notNull(),
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

export const transactionObservations = pgTable("transaction_observations", {
  transactionId: text("transaction_id")
    .primaryKey()
    .references(() => transactions.id),
  lastSeenAt: text("last_seen_at").notNull(),
  lastSeenRunId: text("last_seen_run_id")
    .notNull()
    .references(() => syncRuns.id),
  sourceRefs:
    jsonText<TransactionInput["details"]["sourceRefs"]>()(
      "source_refs_json",
    ).notNull(),
});

export const transactionReconciliation = pgTable("transaction_reconciliation", {
  transactionId: text("transaction_id")
    .primaryKey()
    .references(() => transactions.id),
  paymentContextConflicts: jsonText<
    NonNullable<TransactionInput["details"]["paymentContextConflicts"]>
  >()("payment_context_conflicts_json"),
  pendingPostingCandidates: jsonText<string[]>()(
    "pending_posting_candidates_json",
  ),
  rejectedPostingKeys: jsonText<string[]>()("rejected_posting_keys_json"),
  sourceEvidence: jsonText<SourceEvidence>()("source_evidence_json"),
  postingOverlap: jsonText<
    NonNullable<TransactionInput["details"]["postingOverlap"]>
  >()("posting_overlap_json"),
  providerIdentity: jsonText<
    Record<string, import("../../domain/model.js").JsonValue>
  >()("provider_identity_json"),
  providerObservations: jsonText<
    Record<string, import("../../domain/model.js").JsonValue>
  >()("provider_observations_json"),
  providerMonetaryEvidence: jsonText<
    Record<string, import("../../domain/model.js").JsonValue>
  >()("provider_monetary_evidence_json"),
  providerBillingMonth: jsonText<
    Record<string, import("../../domain/model.js").JsonValue>
  >()("provider_billing_month_json"),
  providerCurrencyMapping: jsonText<
    Record<string, import("../../domain/model.js").JsonValue>
  >()("provider_currency_mapping_json"),
});

export const transactionPostingLinks = pgTable("transaction_posting_links", {
  transactionId: text("transaction_id")
    .primaryKey()
    .references(() => transactions.id),
  postingLink:
    jsonText<NonNullable<TransactionInput["details"]["postingLink"]>>()(
      "posting_link_json",
    ),
});

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

export type { Transaction } from "../../domain/records.js";

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
  providerStopReason: text("provider_stop_reason", {
    enum: PROVIDER_STOP_REASONS,
  }),
  hasAcceptedEvidence: boolean("has_accepted_evidence").notNull(),
  captures: bigint({ mode: "number" }).notNull(),
  unchanged: bigint({ mode: "number" }).notNull(),
  failures: bigint({ mode: "number" }).notNull(),
  created: bigint({ mode: "number" }).notNull(),
  updated: bigint({ mode: "number" }).notNull(),
  observed: bigint("observed", { mode: "number" }).notNull(),
  unchangedTransactions: bigint("unchanged_transactions", {
    mode: "number",
  }).notNull(),
  unlisted: bigint("unlisted", { mode: "number" }).notNull(),

  failureCodes:
    jsonText<RefreshFailureCode[]>()("failure_codes_json").notNull(),
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
    hasAcceptedEvidence: boolean("has_accepted_evidence").notNull(),
  },
  (table) => [primaryKey({ columns: [table.refreshId, table.rangeFrom] })],
);

/** Who may collect a connection, until when (ms since the epoch, database clock). */
export const collectionLeases = pgTable("collection_leases", {
  connectionId: text("connection_id").primaryKey(),
  holder: text().notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});
