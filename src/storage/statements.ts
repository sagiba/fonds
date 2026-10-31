import type {
  SyncRun,
  SyncRunPageInput,
} from "../application/financial-store.js";
import type {
  CatalogQuery,
  EventQuery,
  TransactionQuery,
} from "../application/query-inputs.js";
import type {
  RefreshPageInput,
  RefreshStatus,
  RefreshTrigger,
  SkipReason,
  WindowStatus,
} from "../application/refreshes.js";
import type { Account } from "../domain/accounts.js";
import type { Card } from "../domain/cards.js";
import type { RefreshFailureCode } from "../domain/model.js";
import type {
  PriorRun,
  RunHistoryDocument,
} from "../domain/plans/run-history.js";
import type { FinancialPlan } from "../domain/plans/state.js";
import type {
  calculateTotals,
  TransactionListFacts,
} from "../domain/read-model.js";
import type {
  Annotation,
  Connection,
  ConnectionConfig,
  LedgerEvent,
  Run,
  Transaction,
} from "../domain/records.js";
import type { FailureReason, ProviderStopReason } from "../domain/refreshes.js";
import type { RetainedRun } from "./run-evidence.js";
import type { PlanScope } from "./sql.js";

/** A run with the columns that place it in application order. */
export type OrderedRun = PriorRun & {
  appliedAt: string | null;
  ingestionOrder: number;
};

export type LatestAppliedRun = OrderedRun & {
  appliedAt: string;
  appliedRuns: number;
  document: unknown;
};

export interface PlanRow {
  row: Transaction;
  annotation: Annotation | null;
}

export interface RefreshRow {
  id: string;
  connectionId: string;
  trigger: RefreshTrigger;
  status: RefreshStatus;
  skipReason: SkipReason | null;
  rangeFrom: string | null;
  rangeTo: string | null;
  occurrence: string | null;
  scheduledAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  requiresAttention: boolean;
  providerStopReason: ProviderStopReason | null;
  hasAcceptedEvidence: boolean;
  captures: number;
  unchanged: number;
  failures: number;
  created: number;
  updated: number;
  observed: number;
  unchangedTransactions: number;
  unlisted: number;
  failureCodes: RefreshFailureCode[];
  failureReason: FailureReason | null;
  missedThrough: string | null;
  missedCount: number | null;
}

export interface RefreshWindowRow {
  refreshId: string;
  rangeFrom: string;
  rangeTo: string;
  status: WindowStatus;
  hasAcceptedEvidence: boolean;
}

/** Content-addressed evidence that cannot safely belong to a ledger transaction. */
export interface DeferredEvidenceWrite {
  id: string;
  connectionId: string;
  sourceScope: string;
  sourceKey: string;
  reason: string;
  content: Record<string, unknown>;
  firstSeenRunId: string;
  lastSeenRunId: string;
}

/** Unexecuted Drizzle statements. The driver owns execution and transactions. */
export interface Statements<Db> {
  cards(db: Db, connectionId: string): PromiseLike<Card[]>;
  card(db: Db, id: string): PromiseLike<Card[]>;
  cardPage(db: Db, input: CatalogQuery): PromiseLike<Card[]>;
  accounts(db: Db, connectionId: string): PromiseLike<Account[]>;
  account(db: Db, id: string): PromiseLike<Account[]>;
  accountPage(db: Db, input: CatalogQuery): PromiseLike<Account[]>;
  connection(db: Db, id: string): PromiseLike<Connection[]>;
  lockConnection(db: Db, id: string): PromiseLike<Connection[]>;
  lockConnectionOf(db: Db, transactionId: string): PromiseLike<Connection[]>;
  connections(db: Db): PromiseLike<Connection[]>;
  transaction(db: Db, id: string): PromiseLike<Transaction[]>;
  transactionWithAnnotation(db: Db, id: string): PromiseLike<PlanRow[]>;
  transactionPage(db: Db, input: TransactionQuery): PromiseLike<PlanRow[]>;
  transactionListPage(
    db: Db,
    input: TransactionQuery,
  ): PromiseLike<
    { row: TransactionListFacts; annotation: Annotation | null }[]
  >;
  totals(
    db: Db,
    input: TransactionQuery,
  ): PromiseLike<Parameters<typeof calculateTotals>[0]>;
  events(db: Db, input: EventQuery): PromiseLike<LedgerEvent[]>;
  transactionCount(
    db: Db,
    connectionId: string,
  ): PromiseLike<{ count: number }[]>;
  latestEvent(
    db: Db,
    connectionId?: string,
  ): PromiseLike<{ id: number | null }[]>;
  event(db: Db, id: number): PromiseLike<LedgerEvent[]>;
  run(db: Db, id: string): PromiseLike<Run[]>;
  runWithConnection(
    db: Db,
    id: string,
  ): PromiseLike<{ run: Run; connection: Connection }[]>;
  runState(
    db: Db,
    id: string,
  ): PromiseLike<
    Pick<Run, "appliedAt" | "status" | "warnings" | "evidenceDigest">[]
  >;
  syncRuns(db: Db, id: string, page: SyncRunPageInput): PromiseLike<SyncRun[]>;
  /** Archived runs not yet applied, oldest first. */
  pendingRuns(
    db: Db,
    id: string,
    limit: number,
  ): PromiseLike<Pick<Run, "id" | "parserVersion">[]>;
  planRows(db: Db, id: string, scope?: PlanScope): PromiseLike<PlanRow[]>;
  /** Every applied run, in application order. */
  priorRuns(db: Db, id: string): PromiseLike<PriorRun[]>;
  /**
   * The last applied run in application order, with the applied-run count and
   * the stored run-history summary; empty before any run is applied.
   */
  runHistory(db: Db, id: string): PromiseLike<LatestAppliedRun[]>;
  /** The connection's runs among `ids`, applied or not, in no particular order. */
  runsById(db: Db, id: string, ids: string[]): PromiseLike<OrderedRun[]>;
  saveRunHistory(
    db: Db,
    id: string,
    document: RunHistoryDocument,
  ): PromiseLike<unknown>;
  removals(
    db: Db,
    id: string,
  ): PromiseLike<Pick<LedgerEvent, "transactionId" | "createdAt">[]>;
  insertConnection(db: Db, row: Connection): PromiseLike<Connection[]>;
  insertRun(db: Db, row: RetainedRun): PromiseLike<{ id: string }[]>;
  upsertDeferredEvidence(
    db: Db,
    row: DeferredEvidenceWrite,
  ): PromiseLike<unknown>;
  insertRunBody(db: Db, row: RetainedRun): PromiseLike<unknown>;
  finishRunEvidence(
    db: Db,
    id: string,
    keepUntil: string | null,
  ): Iterable<PromiseLike<unknown>>;
  pruneDebugBodies(db: Db, now: string): PromiseLike<unknown>;
  setConfig(db: Db, id: string, config: ConnectionConfig): PromiseLike<unknown>;
  latestOccurrence(db: Db): PromiseLike<{ scheduledAt: string | null }[]>;
  claimOccurrence(
    db: Db,
    row: {
      occurrence: string;
      scheduledAt: string;
      status: "running";
      leaseUntil: string;
    },
    now: string,
  ): PromiseLike<{ occurrence: string }[]>;
  finishOccurrence(
    db: Db,
    occurrence: string,
    claim: string,
  ): PromiseLike<unknown>;
  releaseOccurrence(
    db: Db,
    occurrence: string,
    claim: string,
    leaseUntil: string,
  ): PromiseLike<unknown>;
  pruneOccurrences(db: Db, before: string): PromiseLike<unknown>;
  setting(db: Db, name: string): PromiseLike<{ value: string }[]>;
  insertRefresh(db: Db, row: RefreshRow): PromiseLike<unknown>;
  insertRefreshWindows(
    db: Db,
    rows: RefreshWindowRow[],
  ): PromiseLike<unknown>[];
  refresh(db: Db, id: string): PromiseLike<RefreshRow[]>;
  refreshWindows(db: Db, id: string): PromiseLike<RefreshWindowRow[]>;
  refreshPage(
    db: Db,
    connectionId: string,
    page: RefreshPageInput,
  ): PromiseLike<RefreshRow[]>;
  lastExecutedRefresh(db: Db, connectionId: string): PromiseLike<RefreshRow[]>;
  activeRefresh(db: Db, connectionId: string): PromiseLike<RefreshRow[]>;
  activeRefreshes(db: Db): PromiseLike<RefreshRow[]>;
  occurrenceRefresh(
    db: Db,
    connectionId: string,
    occurrence: string,
  ): PromiseLike<RefreshRow[]>;
  updateRefresh(
    db: Db,
    id: string,
    set: Partial<RefreshRow>,
  ): PromiseLike<unknown>;
  updateRefreshWindow(
    db: Db,
    id: string,
    from: string,
    status: WindowStatus,
  ): PromiseLike<unknown>;
  markRefreshWindowAccepted(
    db: Db,
    id: string,
    from: string,
  ): PromiseLike<unknown>;
  insertSetting(db: Db, name: string, value: string): PromiseLike<unknown>;
  /** Writes accounts, cards, transactions, annotations, events, then the run. */
  applyPlan(
    db: Db,
    plan: FinancialPlan,
    runId?: string,
  ): Iterable<PromiseLike<unknown>>;
}
