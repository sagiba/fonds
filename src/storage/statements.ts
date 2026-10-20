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
import type { ReconciliationFailureCode } from "../domain/model.js";
import type { FinancialPlan } from "../domain/plans/state.js";
import type { PriorRun } from "../domain/plans/sync.js";
import type { calculateTotals } from "../domain/read-model.js";
import type {
  Annotation,
  Connection,
  ConnectionConfig,
  LedgerEvent,
  Run,
  Transaction,
} from "../domain/records.js";
import type { FailureReason } from "../domain/refreshes.js";
import type { RetainedRun } from "./run-evidence.js";
import type { PlanScope } from "./sql.js";

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
  captures: number;
  unchanged: number;
  failures: number;
  created: number;
  updated: number;
  failureCodes: ReconciliationFailureCode[];
  failureReason: FailureReason | null;
  missedThrough: string | null;
  missedCount: number | null;
}

export interface RefreshWindowRow {
  refreshId: string;
  rangeFrom: string;
  rangeTo: string;
  status: WindowStatus;
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
  ): PromiseLike<Pick<Run, "appliedAt" | "status" | "warnings">[]>;
  syncRuns(db: Db, id: string, page: SyncRunPageInput): PromiseLike<SyncRun[]>;
  /** Archived runs not yet applied, oldest first. */
  pendingRuns(
    db: Db,
    id: string,
    limit: number,
  ): PromiseLike<Pick<Run, "id" | "parserVersion">[]>;
  planRows(db: Db, id: string, scope?: PlanScope): PromiseLike<PlanRow[]>;
  priorRuns(db: Db, id: string): PromiseLike<PriorRun[]>;
  removals(
    db: Db,
    id: string,
  ): PromiseLike<Pick<LedgerEvent, "transactionId" | "createdAt">[]>;
  insertConnection(db: Db, row: Connection): PromiseLike<Connection[]>;
  insertRun(db: Db, row: RetainedRun): PromiseLike<{ id: string }[]>;
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
  insertSetting(db: Db, name: string, value: string): PromiseLike<unknown>;
  /** Writes accounts, cards, transactions, annotations, events, then the run. */
  applyPlan(
    db: Db,
    plan: FinancialPlan,
    runId?: string,
  ): Iterable<PromiseLike<unknown>>;
}
