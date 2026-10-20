import { z } from "zod";

import type { Account } from "../domain/accounts.js";
import type { Card, CardDiscovery } from "../domain/cards.js";
import {
  CANONICAL_TEXT_MAX_LENGTH,
  RESOURCE_ID_MAX_LENGTH,
} from "../domain/model.js";
import type { editSchema } from "../domain/plans/annotation.js";
import type {
  postingSchema,
  PostingSplit,
  removalSchema,
} from "../domain/plans/lifecycle.js";
import type { RunInput, SyncResult } from "../domain/plans/sync.js";
import type { calculateTotals, TransactionView } from "../domain/read-model.js";
import type {
  Annotation,
  LedgerEvent,
  Transaction,
} from "../domain/records.js";
import type { Connection, ConnectionConfig } from "../domain/records.js";
import type { SourceAdapter } from "../domain/source-adapter.js";
import type {
  CatalogPageInput,
  EventPageInput,
  TransactionFilters,
  TransactionPageInput,
} from "./query-inputs.js";
import type { Refresh, RefreshPageInput, RefreshStore } from "./refreshes.js";
import type { ScheduledCollectionStore } from "./scheduled-collections.js";

/** URLs normalize away "." and ".." path segments, so no API could address them. */
export function isPathAddressable(id: string): boolean {
  return id !== "." && id !== "..";
}

export const PATH_ADDRESSABLE_MESSAGE = 'Identifiers cannot be "." or ".."';

export const connectionInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(RESOURCE_ID_MAX_LENGTH)
    .refine(isPathAddressable, PATH_ADDRESSABLE_MESSAGE),
  provider: z.string().min(1).max(CANONICAL_TEXT_MAX_LENGTH),
  displayName: z.string().min(1).max(CANONICAL_TEXT_MAX_LENGTH).optional(),
});

export interface PublicConnection {
  id: string;
  provider: string;
  displayName: string;
  createdAt: string;
  /** Newest refresh or recorded scheduled occurrence, without windows; null before any. */
  latestRefresh: Refresh | null;
}

export interface CardPage {
  cards: Card[];
  hasMore: boolean;
}

export interface AccountPage {
  accounts: Account[];
  hasMore: boolean;
}

export interface SyncRunPageInput {
  limit: number;
  after?: { startedAt: string; id: string } | undefined;
}

export interface SyncRun {
  id: string;
  connectionId: string;
  startedAt: string;
  completedAt: string | null;
  status: "started" | "completed" | "partial" | "failed";
  appliedAt: string | null;
  collectorVersion: string;
  parserVersion: string;
  refreshId: string | null;
}

export interface TransactionPage {
  transactions: TransactionView[];
  hasMore: boolean;
}

export interface UndoAnnotationInput {
  eventId: number;
  expectedVersion: number;
}

/** The existing application operations, independent of a database driver. */
export interface FinancialStore {
  readonly backend: "sqlite" | "turso" | "postgres" | "d1";
  listConnections(): Promise<PublicConnection[]>;
  listCards(input: CatalogPageInput): Promise<CardPage>;
  getCard(id: string): Promise<Card | undefined>;
  listAccounts(input: CatalogPageInput): Promise<AccountPage>;
  getAccount(id: string): Promise<Account | undefined>;
  getConnection(id: string): Promise<PublicConnection | undefined>;
  listTransactionPage(input?: TransactionPageInput): Promise<TransactionPage>;
  getTransaction(id: string): Promise<TransactionView | undefined>;
  getTotals(
    input?: TransactionFilters,
  ): Promise<ReturnType<typeof calculateTotals>>;
  listEvents(input?: EventPageInput): Promise<LedgerEvent[]>;
  listSyncRuns(
    connectionId: string,
    page: SyncRunPageInput,
  ): Promise<SyncRun[]>;
  /** One refresh with its windows. */
  getRefresh(id: string): Promise<Refresh | undefined>;
  /** Newest first, without windows. */
  listRefreshes(
    connectionId: string,
    page: RefreshPageInput,
  ): Promise<Refresh[]>;
  editAnnotation(input: z.input<typeof editSchema>): Promise<Annotation>;
  undoAnnotation(input: UndoAnnotationInput): Promise<Annotation>;
  linkPendingTransaction(
    input: z.input<typeof postingSchema>,
  ): Promise<Transaction>;
  unlinkPendingTransaction(
    input: z.input<typeof postingSchema>,
  ): Promise<PostingSplit>;
  confirmRemoval(input: z.input<typeof removalSchema>): Promise<Transaction>;
}

/** Internal collection and consumer capabilities; credentials stay outside this contract. */
export interface InternalStore
  extends FinancialStore, ScheduledCollectionStore, RefreshStore {
  readonly identity: object;
  recordCardDiscovery(
    connectionId: string,
    discovery: CardDiscovery,
  ): Promise<void>;
  /** Unpaged rows for internal callers; every perspective unless one is named. */
  listTransactions(input?: TransactionFilters): Promise<TransactionView[]>;
  ensureConnection(input: {
    id: string;
    provider: string;
    displayName?: string;
  }): Promise<Connection>;
  getStoredConnection(id: string): Promise<Connection | undefined>;
  ingestRun(input: RunInput, adapter: SourceAdapter): Promise<SyncResult>;
  applyRun(id: string, adapter: SourceAdapter): Promise<SyncResult>;
  updateConfig(
    id: string,
    change: (config: ConnectionConfig) => ConnectionConfig,
  ): Promise<ConnectionConfig>;
  /**
   * Highest event ID in the ledger, or only in one connection's feed. Any
   * ledger mutation advances the unscoped value.
   */
  latestEventId(connectionId?: string): Promise<number>;
  /**
   * Cheap ledger revision for a connection: the latest event ID plus its
   * transaction count, so recorded mutations and out-of-band row deletion
   * both change it.
   */
  ledgerRevision(connectionId: string): Promise<string>;
  getDeliveryCursor(connectionId: string, consumerId: string): Promise<number>;
  acknowledgeCursor(
    connectionId: string,
    consumerId: string,
    expected: number,
    next: number,
  ): Promise<void>;
}
