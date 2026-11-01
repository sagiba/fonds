import {
  acknowledgeConfig,
  configSchema,
  consumerSchema,
  cursorFor,
} from "../application/change-delivery.js";
import {
  type LockedCollectionStore,
  ManualRecoveryRequiredError,
  RetryableRecoveryError,
} from "../application/collection-lock.js";
import {
  connectionInputSchema,
  COVERAGE_MAX_MONTHS,
  type InternalStore,
  type TotalsGroup,
} from "../application/financial-store.js";
import {
  catalogPageSchema,
  cursorSchema,
  filtersSchema,
  pageSchema,
  totalsSchema,
  type TransactionQuery,
} from "../application/query-inputs.js";
import {
  type Admission,
  admissionHold,
  finalAttention,
  isActive,
  isExecuted,
  type NotStartedReason,
  type Refresh,
  refreshHealthEvents,
  type RefreshStore,
  type RefreshWriter,
  skippedRefresh,
} from "../application/refreshes.js";
import {
  OCCURRENCE_LEASE_MS,
  OCCURRENCE_RETENTION_MS,
} from "../application/scheduled-collections.js";
import {
  elapsedMs,
  syncCorrelationIds,
  syncDiagnostics,
  type SyncDiagnosticSink,
} from "../application/sync-diagnostics.js";
import type { Account } from "../domain/accounts.js";
import { type Card, cardDiscoverySchema } from "../domain/cards.js";
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from "../domain/errors.js";
import { toSafeMinor } from "../domain/money.js";
import { canonicalJson, compareStrings } from "../domain/observations.js";
import {
  editSchema,
  planAnnotation,
  planUndoAnnotation,
} from "../domain/plans/annotation.js";
import { planCardDiscovery } from "../domain/plans/catalog.js";
import {
  planPosting,
  planRemoval,
  planUnlinkPosting,
  postingSchema,
  removalSchema,
} from "../domain/plans/lifecycle.js";
import {
  copyRunHistory,
  decodeRunHistory,
  emptyRunHistory,
  encodeRunHistory,
  foldRunHistory,
  type PriorRun,
  referencedRunIds,
  type RunHistoryDocument,
  type RunHistorySummary,
  summarizeRunHistory,
} from "../domain/plans/run-history.js";
import {
  type DeferredCandidate,
  FinancialPlan,
  type FinancialSnapshot,
  isNarrow,
  type LedgerRow,
  type LedgerScope,
  type NarrowRow,
} from "../domain/plans/state.js";
import {
  extractRun,
  finishTransactionContent,
  planRun,
  predictHydration,
  refreshFailureCodes,
  type RunInput,
  type SyncResult,
} from "../domain/plans/sync.js";
import {
  ledgerScope,
  namedWindows,
  scopeNames,
  SYNC_SCOPE_DAYS,
  type SyncScope,
  syncScope,
  windowHolds,
} from "../domain/plans/sync-scope.js";
import { presentTransaction, totalsFromParts } from "../domain/read-model.js";
import type {
  Annotation,
  Connection,
  ConnectionConfig,
  LedgerEventWrite,
  Run,
  Transaction,
} from "../domain/records.js";
import { PROVIDER_STOP_REASONS } from "../domain/refreshes.js";
import type { SourceAdapter } from "../domain/source-adapter.js";
import {
  contentDigest,
  prepareRun,
  replayResult,
  requireEvidenceRetention,
  retainedRun,
  runEvidenceDigest,
} from "./run-evidence.js";
import {
  BACKFILL_OUTCOMES,
  chunks,
  clauseParameters,
  exactInteger,
  exactSumValue,
  type LedgerClause,
  type PlanScope,
} from "./sql.js";
import type {
  LatestAppliedRun,
  LedgerLoad,
  OrderedRun,
  RefreshRow,
  RefreshWindowRow,
  Statements,
} from "./statements.js";
import { narrowFacts } from "./transaction-codec.js";

// Keep public error identity (for example version conflicts) while classifying recovery.
const interpretationErrors = new WeakSet<Error>();

// D1 binds at most 100 parameters per statement; one is the connection ID.
const RUN_ID_BATCH = 99;

/** IDs per read by ID, well within D1's 100 parameters. */
const ID_BATCH = 50;

/** IDs per hydration read: one statement per round on most backends. */
const HYDRATION_BATCH = 1000;

/** Planning rounds before every row of the connection is hydrated. */
const HYDRATION_ROUNDS = 4;

/** Parameters a bounded ledger read's selection binds. */
const SCOPE_PARAMETERS = 1000;

/** D1's 100, less the connection ID and the narrow read's own text patterns. */
const D1_SCOPE_PARAMETERS = 90;

const utf8 = new TextEncoder();

/** PostgreSQL's "C" collation and SQLite's BINARY both compare UTF-8 bytes. */
function storedTextOrder(left: string, right: string): number {
  const a = utf8.encode(left);
  const b = utf8.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) {
      return a[index]! - b[index]!;
    }
  }
  return a.length - b.length;
}

/** `ORDER BY applied_at, ingestion_order`, as the run history is folded. */
function applicationOrder(
  left: { appliedAt: string; ingestionOrder: number },
  right: { appliedAt: string; ingestionOrder: number },
): number {
  return (
    storedTextOrder(left.appliedAt, right.appliedAt) ||
    left.ingestionOrder - right.ingestionOrder
  );
}

function priorRun({
  id,
  status,
  startedAt,
  coverage,
  snapshot,
}: PriorRun): PriorRun {
  return { id, status, startedAt, coverage, snapshot };
}

interface RunHistoryLoad extends Pick<FinancialSnapshot, "priorRuns"> {
  runHistory: RunHistorySummary;
  /** Applied runs a scoped load fetched, before the latest run. */
  dependent: (OrderedRun & { appliedAt: string })[];
  /** The run being applied, as its columns read before application. */
  applying: OrderedRun;
  latest: LatestAppliedRun | undefined;
  /** Whether only dependent runs loaded, rather than every applied run. */
  scoped: boolean;
}

/**
 * The run being applied as the complete history will read it once committed:
 * its stored receipt metadata, with the plan's run update as JSON columns
 * return it.
 */
function appliedRun(applying: OrderedRun, update: Partial<Run>): PriorRun {
  return {
    id: applying.id,
    status: update.status ?? applying.status,
    startedAt: update.startedAt ?? applying.startedAt,
    coverage: JSON.parse(
      JSON.stringify(update.coverage ?? applying.coverage),
    ) as Run["coverage"],
    snapshot: applying.snapshot,
  };
}

/**
 * The summary after this application, or none when appending would not fold
 * in application order: a run applied in the same millisecond as, but staged
 * before, the latest run, or after a clock step back, sorts earlier. Such a
 * summary would name a run that is not the latest, so it could not be used
 * anyway; the stored one no longer matches the applied-run count, and the
 * next application folds the complete history again.
 */
function nextRunHistory(
  load: RunHistoryLoad,
  update: Partial<Run> | undefined,
  adapter: SourceAdapter,
): RunHistoryDocument | undefined {
  if (
    !update?.appliedAt ||
    update.snapshot !== undefined ||
    (load.latest &&
      applicationOrder(
        {
          appliedAt: update.appliedAt,
          ingestionOrder: load.applying.ingestionOrder,
        },
        load.latest,
      ) < 0)
  ) {
    return undefined;
  }
  const summary = copyRunHistory(load.runHistory);
  foldRunHistory(summary, appliedRun(load.applying, update), adapter);
  return encodeRunHistory({
    provider: adapter.provider,
    parserVersion: adapter.parserVersion,
    appliedRuns: (load.latest?.appliedRuns ?? 0) + 1,
    latestRunId: load.applying.id,
    summary,
  });
}

/** One application's plan output, for comparing two ways of loading it. */
export interface PlannedApplication {
  result: SyncResult;
  transactionWrites: [string, Transaction][];
  observationWrites: [string, Transaction][];
  annotationWrites: [string, Annotation][];
  accountWrites: [string, Account][];
  cardWrites: [string, Card][];
  deferredCandidates: DeferredCandidate[];
  events: LedgerEventWrite[];
  runUpdate: Partial<Run> | undefined;
  runHistory: RunHistoryDocument | undefined;
}

export interface ApplicationLoadingComparison {
  /** Whether the dependency-driven plan loaded only dependent runs. */
  scoped: boolean;
  loadedRuns: number;
  appliedRuns: number;
  /** The committed plan: narrow rows, hydrated on demand, and dependent runs. */
  dependent: PlannedApplication;
  /** The same application planned from complete rows and every applied run. */
  complete: PlannedApplication;
  /** Rows as the narrow load decoded them, in ingestion order. */
  narrowRows: NarrowRow[];
  /** The committed plan's snapshot: each row's ID and whether it stayed narrow, in order. */
  plannedRows: { id: string; narrow: boolean }[];
  /** The same rows as a complete load decodes them. */
  completeRows: Transaction[];
  /** Rows the committed plan had hydrated. */
  hydrated: string[];
  /** Rows whose narrow decode was in doubt, hydrated before planning. */
  doubtful: string[];
  rounds: number;
  /** Whether the committed plan read only its scope, rather than every row. */
  bounded: boolean;
  /** Whether a scope miss made the committed plan read every row. */
  fallback: boolean;
  /**
   * Loaded rows whose exact-date group the bounded load left incomplete, as
   * the committed plan ends: their duplicate-plan flags are not decided.
   */
  undecided: string[];
}

interface HydrationOptions {
  /** Whether rows are predicted before the first round. */
  predict: boolean;
  /** Planning rounds before every row is hydrated. */
  rounds: number;
  /**
   * Whether a bounded load closes its seed over stored references and date
   * groups. Without it, plans miss rows and fall back to every row.
   */
  closure: boolean;
  /** Runs before each hydration read, with the IDs it will read. */
  beforeRead?: (ids: string[]) => Promise<void> | void;
}

const defaultHydration: HydrationOptions = {
  predict: true,
  rounds: HYDRATION_ROUNDS,
  closure: true,
};

let hydrationOptions = defaultHydration;

/** Test seam: changes how sync application hydrates. Production keeps the defaults. */
export function configureHydration(
  options: Partial<HydrationOptions> = {},
): void {
  hydrationOptions = { ...defaultHydration, ...options };
}

let loadingVerifier:
  ((comparison: ApplicationLoadingComparison) => void) | undefined;

/**
 * Test seam: every sync application in this module instance also plans from
 * complete rows and every applied run, with the same clock and IDs, and
 * reports both outcomes before committing the dependent one. Production sets
 * none.
 */
export function verifyApplicationLoading(
  verifier: ((comparison: ApplicationLoadingComparison) => void) | undefined,
): void {
  loadingVerifier = verifier;
}

function plannedApplication(
  plan: FinancialPlan,
  result: SyncResult,
  runHistory: RunHistoryDocument | undefined,
): PlannedApplication {
  return {
    result,
    transactionWrites: [...plan.transactionWrites],
    observationWrites: [...plan.observationWrites],
    annotationWrites: [...plan.annotationWrites],
    accountWrites: [...plan.accountWrites],
    cardWrites: [...plan.cardWrites],
    deferredCandidates: plan.deferredCandidates,
    events: plan.events,
    runUpdate: plan.runUpdate,
    runHistory,
  };
}

function interpretationError(cause: unknown): Error {
  const error =
    cause instanceof Error
      ? cause
      : new Error("Archived evidence cannot be interpreted", { cause });
  interpretationErrors.add(error);
  return error;
}

export type WriteResults<Writes extends readonly PromiseLike<unknown>[]> = {
  -readonly [Index in keyof Writes]: Awaited<Writes[Index]>;
};

/** Fixed-width ISO text, so stored instants order as strings on every backend. */
const iso = (instant: number) => new Date(instant).toISOString();

function refreshFromRow(
  row: RefreshRow,
  windows: readonly RefreshWindowRow[] = [],
): Refresh {
  return {
    id: row.id,
    connectionId: row.connectionId,
    trigger: row.trigger,
    status: row.status,
    skipReason: row.skipReason,
    range:
      row.rangeFrom === null || row.rangeTo === null
        ? null
        : { from: row.rangeFrom, to: row.rangeTo },
    occurrence: row.occurrence,
    scheduledAt: row.scheduledAt,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    requiresAttention: row.requiresAttention,
    providerStopReason: row.providerStopReason,
    hasAcceptedEvidence: row.hasAcceptedEvidence,
    counts: {
      captures: row.captures,
      unchanged: row.unchanged,
      failures: row.failures,
      created: row.created,
      updated: row.updated,
      observed: row.observed,
      unchangedTransactions: row.unchangedTransactions,
      unlisted: row.unlisted,
    },
    failureCodes: row.failureCodes,
    failureReason: row.failureReason,
    missed:
      row.missedThrough === null || row.missedCount === null
        ? null
        : { through: row.missedThrough, count: row.missedCount },
    windows: windows.map((window) => ({
      from: window.rangeFrom,
      to: window.rangeTo,
      status: window.status,
      hasAcceptedEvidence: window.hasAcceptedEvidence,
    })),
  };
}

function refreshRow(refresh: Refresh): RefreshRow {
  return {
    id: refresh.id,
    connectionId: refresh.connectionId,
    trigger: refresh.trigger,
    status: refresh.status,
    skipReason: refresh.skipReason,
    rangeFrom: refresh.range?.from ?? null,
    rangeTo: refresh.range?.to ?? null,
    occurrence: refresh.occurrence,
    scheduledAt: refresh.scheduledAt,
    createdAt: refresh.createdAt,
    startedAt: refresh.startedAt,
    finishedAt: refresh.finishedAt,
    requiresAttention: refresh.requiresAttention,
    providerStopReason: refresh.providerStopReason ?? null,
    hasAcceptedEvidence: refresh.hasAcceptedEvidence ?? false,
    ...refresh.counts,
    failureCodes: refresh.failureCodes,
    failureReason: refresh.failureReason,
    missedThrough: refresh.missed?.through ?? null,
    missedCount: refresh.missed?.count ?? null,
  };
}

function presentConnection(connection: Connection, latest?: RefreshRow) {
  return {
    id: connection.id,
    provider: connection.provider,
    displayName: connection.displayName,
    createdAt: connection.createdAt,
    latestRefresh: latest ? refreshFromRow(latest) : null,
  };
}

export interface StoreDatabase<Db> {
  backend: InternalStore["backend"];
  identity: object;
  root: Db;
  execute<T>(statement: PromiseLike<T>): Promise<T>;
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
  /**
   * Runs a transaction's only writes, after its reads, for the connection it locked.
   * Each statement already carries its executor/transaction context.
   * Defaults to sequential execution inside the driver transaction.
   */
  commit?<const Writes extends readonly PromiseLike<unknown>[]>(
    connection: Connection,
    writes: Writes,
  ): Promise<WriteResults<Writes>>;
  /**
   * A statement that leads every commit and fails it when this store may no
   * longer write, such as a collection whose lease was lost. It returns the
   * row it guarded; without `commit`, a missing row also fails the commit.
   */
  fence?(tx: Db): PromiseLike<readonly unknown[]>;
  /**
   * Bytes a network-metered database has sent `tx` since its work began, for
   * diagnostics only; undefined where the driver cannot measure them.
   */
  bytesRead?(tx: Db): number | undefined;
}

async function commitInOrder<
  const Writes extends readonly PromiseLike<unknown>[],
>(_connection: Connection, writes: Writes) {
  const results: unknown[] = [];
  for (const statement of writes) {
    results.push(await statement);
  }
  return results as WriteResults<Writes>;
}

/**
 * The store a collection uses while it holds its connection's lock. `db` is the
 * lock's own: a reserved session, or a fence that leads every write.
 */
export function lockedCollectionStore<Db>(
  db: StoreDatabase<Db>,
  statements: Statements<Db>,
  connectionId: string,
  signal: AbortSignal,
): LockedCollectionStore {
  const store = buildStore(db, statements);
  return {
    identity: store.identity,
    getConnection: store.getConnection,
    getStoredConnection: store.getStoredConnection,
    getRefresh: store.getRefresh,
    ingestRun: store.ingestRun,
    applyRun: store.applyRun,
    recordCardDiscovery: store.recordCardDiscovery,
    updateConfig: store.updateConfig,
    ledgerRevision: store.ledgerRevision,
    updateRefresh: store.updateRefresh,
    async recoverPendingRuns(adapter, onDiagnostic, refreshId) {
      signal.throwIfAborted();
      const pending = await db
        .execute(statements.pendingRuns(db.root, connectionId, 101))
        .catch(() => {
          signal.throwIfAborted();
          throw new RetryableRecoveryError();
        });
      if (
        pending.length > 100 ||
        pending.some((run) => run.parserVersion !== adapter.parserVersion)
      ) {
        throw new ManualRecoveryRequiredError();
      }
      const results: SyncResult[] = [];
      for (const run of pending) {
        signal.throwIfAborted();
        try {
          results.push(
            await store.applyRun(run.id, adapter, onDiagnostic, refreshId),
          );
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof Error && interpretationErrors.has(error)) {
            throw new ManualRecoveryRequiredError("execution");
          }
          throw new RetryableRecoveryError();
        }
      }
      return results;
    },
  };
}

/**
 * All adapters execute the same workflows against unexecuted Drizzle
 * statements. Refresh progress is left out: only a lease-fenced store writes it.
 */
export function createStore<Db>(
  db: StoreDatabase<Db>,
  statements: Statements<Db>,
): InternalStore {
  const { updateRefresh: _fencedOnly, ...store } = buildStore(db, statements);
  return store;
}

function buildStore<Db>(
  db: StoreDatabase<Db>,
  statements: Statements<Db>,
): InternalStore & RefreshWriter {
  const commitWrites = db.commit ?? commitInOrder;

  /** Every write of a transaction goes through here, after its reads. */
  async function commit<const Writes extends readonly PromiseLike<unknown>[]>(
    tx: Db,
    connection: Connection,
    writes: Writes,
  ): Promise<WriteResults<Writes>> {
    if (!db.fence) {
      return commitWrites(connection, writes);
    }
    if (!db.commit) {
      // Sequential writes: the fence runs first, inside the same transaction.
      if (!(await db.fence(tx)).length) {
        throw new Error("Write fence row is missing");
      }
      return commitInOrder(connection, writes);
    }
    const [, ...results] = await commitWrites(connection, [
      db.fence(tx),
      ...writes,
    ]);
    return results as WriteResults<Writes>;
  }

  const getConnection = async (id: string) =>
    (await db.execute(statements.connection(db.root, id)))[0];

  const latestRefresh = async (connectionId: string) =>
    (
      await db.execute(
        statements.refreshPage(db.root, connectionId, { limit: 1 }),
      )
    )[0];

  const present = async (connection: Connection) =>
    presentConnection(connection, await latestRefresh(connection.id));

  async function withWindows(tx: Db, row: RefreshRow) {
    return refreshFromRow(row, await statements.refreshWindows(tx, row.id));
  }

  /** A retried missed gap that has grown since extends its record. */
  async function extendMissedGap(
    tx: Db,
    connection: Connection,
    existing: RefreshRow,
    missed: Refresh["missed"],
  ): Promise<RefreshRow> {
    if (
      !missed ||
      existing.skipReason !== "missed" ||
      (existing.missedCount ?? 0) >= missed.count
    ) {
      return existing;
    }
    await commit(tx, connection, [
      statements.updateRefresh(tx, existing.id, {
        missedThrough: missed.through,
        missedCount: missed.count,
      }),
    ]);
    return {
      ...existing,
      missedThrough: missed.through,
      missedCount: missed.count,
    };
  }

  const refreshes: RefreshStore &
    RefreshWriter &
    Pick<InternalStore, "getRefresh" | "listRefreshes"> = {
    admitRefresh: (refresh, rules) =>
      db.transaction(async (tx): Promise<Admission> => {
        const connection = (
          await statements.lockConnection(tx, refresh.connectionId)
        )[0];
        if (!connection) {
          throw new NotFoundError("Connection not found");
        }
        // Two keys on purpose: the global occurrence claim picks the one
        // process that runs an occurrence, and this per-connection key keeps
        // a retried start of it from recording a second refresh.
        if (refresh.occurrence !== null) {
          const existing = (
            await statements.occurrenceRefresh(
              tx,
              refresh.connectionId,
              refresh.occurrence,
            )
          )[0];
          if (existing) {
            const recorded = await extendMissedGap(
              tx,
              connection,
              existing,
              refresh.missed,
            );
            return {
              reason: "occurrence",
              existing: await withWindows(tx, recorded),
            };
          }
        }
        let reason: NotStartedReason | null = null;
        let met: RefreshRow | undefined;
        if (refresh.status === "pending") {
          met = (await statements.activeRefresh(tx, refresh.connectionId))[0];
          if (met) {
            reason = "busy";
          } else if (!rules.operator) {
            met = (
              await statements.lastExecutedRefresh(tx, refresh.connectionId)
            )[0];
            reason = admissionHold(met, refresh, rules.now);
          }
        }
        const metRefresh = reason && met && (await withWindows(tx, met));
        if (metRefresh && refresh.occurrence === null) {
          return { reason: reason!, met: metRefresh };
        }
        const recorded = metRefresh
          ? skippedRefresh(refresh, reason!, rules.now)
          : refresh;
        await commit(tx, connection, [
          statements.insertRefresh(tx, refreshRow(recorded)),
          ...statements.insertRefreshWindows(
            tx,
            recorded.windows.map((window) => ({
              refreshId: recorded.id,
              rangeFrom: window.from,
              rangeTo: window.to,
              status: window.status,
              hasAcceptedEvidence: window.hasAcceptedEvidence ?? false,
            })),
          ),
        ]);
        return metRefresh
          ? { reason: reason!, met: metRefresh, skipped: recorded }
          : { reason: null, created: recorded };
      }),
    getRefresh: async (id) => {
      const row = (await db.execute(statements.refresh(db.root, id)))[0];
      return (
        row &&
        refreshFromRow(
          row,
          await db.execute(statements.refreshWindows(db.root, id)),
        )
      );
    },
    listRefreshes: async (connectionId, page) => {
      const rows = await db.execute(
        statements.refreshPage(db.root, connectionId, page),
      );
      await checkEmpty(rows, connectionId);
      return rows.map((row) => refreshFromRow(row));
    },
    activeRefreshes: async () =>
      (await db.execute(statements.activeRefreshes(db.root))).map((row) =>
        refreshFromRow(row),
      ),
    updateRefresh: (id, progress) =>
      db.transaction(async (tx) => {
        const reference = (await statements.refresh(tx, id))[0];
        const connection =
          reference &&
          (await statements.lockConnection(tx, reference.connectionId))[0];
        const row = connection && (await statements.refresh(tx, id))[0];
        if (!row || !connection) {
          throw new NotFoundError("Refresh not found");
        }
        const { window, counts, ...fields } = progress;
        const { status } = fields;
        const finishing = status && isExecuted({ status }) && isActive(row);
        const previous = finishing
          ? (await statements.lastExecutedRefresh(tx, row.connectionId))[0]
          : undefined;
        // A refresh's terminal status and its final attention commit together.
        if (finishing) {
          fields.requiresAttention = finalAttention(
            {
              status,
              requiresAttention:
                fields.requiresAttention ?? row.requiresAttention,
              providerStopReason: row.providerStopReason,
            },
            previous,
          );
        }
        const cumulative = counts && { ...counts };
        if (cumulative) {
          for (const key of Object.keys(
            cumulative,
          ) as (keyof typeof cumulative)[]) {
            cumulative[key] = Math.max(row[key], cumulative[key]);
          }
        }
        const set = {
          ...fields,
          ...cumulative,
          // Its counts keep retried failures; no failure explains a completed refresh.
          ...(fields.status === "completed" && { failureCodes: [] }),
        };
        // Health events commit with the finished state they announce.
        const health = new FinancialPlan({
          connection,
          rows: [],
          annotations: [],
          priorRuns: [],
          removals: [],
        });
        if (finishing) {
          health.events.push(
            ...refreshHealthEvents(
              previous,
              { ...row, ...set },
              set.finishedAt ?? new Date().toISOString(),
            ),
          );
        }
        await commit(tx, connection, [
          ...(Object.keys(set).length
            ? [statements.updateRefresh(tx, id, set)]
            : []),
          ...(health.events.length ? statements.applyPlan(tx, health) : []),
          ...(window
            ? [
                statements.updateRefreshWindow(
                  tx,
                  id,
                  window.from,
                  window.status,
                ),
              ]
            : []),
        ]);
      }),
  };

  async function requireConnection(id: string) {
    const row = await getConnection(id);
    if (!row) {
      throw new NotFoundError("Connection not found");
    }
    return row;
  }

  /** An empty page of an unknown connection is a missing connection. */
  async function checkEmpty(rows: readonly unknown[], id?: string) {
    if (rows.length || id === undefined) {
      return;
    }
    if (!(await getConnection(id))) {
      throw new NotFoundError("Connection not found");
    }
  }

  async function savePlan(
    tx: Db,
    plan: FinancialPlan,
    runId?: string,
    after: Iterable<PromiseLike<unknown>> = [],
  ) {
    // Catalog rows precede financial writes inside the same transaction/batch.
    await commit(tx, plan.snapshot.connection, [
      ...statements.applyPlan(tx, plan, runId),
      ...after,
    ]);
  }

  /** The planner resolves provider keys against this preloaded catalog. */
  async function loadCatalog(tx: Db, connectionId: string) {
    return {
      cards: await statements.cards(tx, connectionId),
      accounts: await statements.accounts(tx, connectionId),
    };
  }

  /** Reads IDs in chunks that keep each statement within D1's parameters. */
  async function byIds<Row>(
    ids: readonly string[],
    read: (db: Db, ids: string[]) => PromiseLike<Row[]>,
  ): Promise<Row[]> {
    const rows: Row[] = [];
    for (const chunk of chunks([...new Set(ids)], ID_BATCH)) {
      rows.push(...(await db.execute(read(db.root, chunk))));
    }
    return rows;
  }

  /** Card and account filters must belong to the requested connection. */
  async function checkScope(filters: TransactionQuery) {
    const owners: ({ connectionId: string } | undefined)[] = [];
    if (filters.cardId !== undefined) {
      owners.push(
        (await db.execute(statements.card(db.root, filters.cardId)))[0],
      );
    }
    if (filters.billingAccountId !== undefined) {
      owners.push(
        (
          await db.execute(
            statements.account(db.root, filters.billingAccountId),
          )
        )[0],
      );
    }
    const outsideScope = (owner: { connectionId: string } | undefined) =>
      !owner ||
      (filters.connectionId !== undefined &&
        owner.connectionId !== filters.connectionId);
    if (
      owners.some(outsideScope) ||
      new Set(owners.map((owner) => owner?.connectionId)).size > 1
    ) {
      throw new InvalidInputError("Inconsistent transaction scope");
    }
  }

  /**
   * Complete rows and, unscoped, every applied run. Sync application loads
   * narrow rows and dependent runs instead (`planApplication`).
   */
  async function loadPlan(
    tx: Db,
    connection: Connection,
    scope?: PlanScope,
    relatedIds: string[] = [],
    catalog = false,
  ) {
    // Lock acquisition is a preceding statement: READ COMMITTED must see post-lock versions.
    const joined = await statements.planRows(tx, connection.id, scope);
    for (const id of relatedIds) {
      if (joined.some(({ row }) => row.id === id)) {
        continue;
      }
      const row = (await statements.transaction(tx, id))[0];
      if (row) {
        joined.push({ row, annotation: null });
      }
    }
    const rows = joined.map(({ row }) => row);
    return new FinancialPlan({
      connection,
      rows,
      annotations: joined.flatMap(({ annotation }) =>
        annotation ? [annotation] : [],
      ),
      priorRuns: scope ? [] : await statements.priorRuns(tx, connection.id),
      removals: scope ? [] : await statements.removals(tx, connection.id),
      ...(catalog && { catalog: await loadCatalog(tx, connection.id) }),
    });
  }

  /**
   * The prior runs one application depends on, and the summary of every
   * applied run. Planner reads of run history are of three kinds:
   *
   * - folds over every applied run (collection health, latest partition
   *   captures, known accounts), which come from the stored summary;
   * - lookups of a run a stored row names (`historical`, `response`, source
   *   reference collapsing, absence and overlap witnesses), which load the
   *   runs `referencedRunIds` collects;
   * - the previous run's status, which is the latest applied run.
   *
   * Retained coverage also binds a response captured at or before it
   * (`prior` in source-absence.ts). When the summary cannot exclude that, or
   * is missing, stale or from another parser, every applied run loads and the
   * summary is folded again from all of them.
   */
  async function loadRunHistory(
    tx: Db,
    connectionId: string,
    run: Run,
    adapter: SourceAdapter,
    rows: Iterable<unknown>,
  ): Promise<RunHistoryLoad> {
    const latest = (await statements.runHistory(tx, connectionId))[0];
    const stored = latest && decodeRunHistory(latest.document);
    // Applied runs are never unapplied or deleted, so an equal count and last
    // run mean the summary folded exactly the runs applied now.
    const current = !latest
      ? emptyRunHistory()
      : stored?.provider === adapter.provider &&
          stored.parserVersion === adapter.parserVersion &&
          stored.appliedRuns === latest.appliedRuns &&
          stored.latestRunId === latest.id
        ? stored.summary
        : undefined;
    const latestCapture = current?.latestCapture;
    const scoped =
      current !== undefined &&
      (latestCapture === undefined ||
        run.snapshot.responses.every(
          (response) => response.capturedAt > latestCapture,
        ));
    const ids = scoped ? referencedRunIds(rows) : new Set<string>();
    ids.add(run.id);
    if (latest) {
      ids.delete(latest.id);
    }
    const fetched: OrderedRun[] = [];
    for (const batch of chunks([...ids], RUN_ID_BATCH)) {
      fetched.push(...(await statements.runsById(tx, connectionId, batch)));
    }
    const applying = fetched.find((candidate) => candidate.id === run.id);
    if (!applying) {
      throw new NotFoundError("Run not found");
    }
    if (!scoped) {
      const priorRuns = await statements.priorRuns(tx, connectionId);
      return {
        priorRuns,
        runHistory: summarizeRunHistory(priorRuns, adapter),
        dependent: [],
        applying,
        latest,
        scoped,
      };
    }
    return withDependentRuns(
      { runHistory: current, dependent: [], applying, latest, scoped },
      fetched,
    );
  }

  /** A scoped load with `fetched` added to its dependent runs. */
  function withDependentRuns(
    load: Omit<RunHistoryLoad, "priorRuns">,
    fetched: readonly OrderedRun[],
  ): RunHistoryLoad {
    const dependent = [
      ...load.dependent,
      ...fetched.filter(
        (candidate): candidate is OrderedRun & { appliedAt: string } =>
          candidate.appliedAt !== null,
      ),
    ].sort(applicationOrder);
    return {
      ...load,
      dependent,
      // Of the order, the planner reads only the last run's status; the
      // database's own ordering supplies that run.
      priorRuns: [...dependent, ...(load.latest ? [load.latest] : [])].map(
        priorRun,
      ),
    };
  }

  /** Adds to a scoped load the runs that newly loaded or hydrated `rows` name. */
  async function addReferencedRuns(
    tx: Db,
    connectionId: string,
    load: RunHistoryLoad,
    rows: readonly LedgerRow[],
  ): Promise<RunHistoryLoad> {
    if (!load.scoped) {
      return load;
    }
    const known = new Set(load.priorRuns.map(({ id }) => id));
    known.add(load.applying.id);
    const missing = [...referencedRunIds(rows)].filter((id) => !known.has(id));
    if (missing.length === 0) {
      return load;
    }
    const fetched: OrderedRun[] = [];
    for (const batch of chunks(missing, RUN_ID_BATCH)) {
      fetched.push(...(await statements.runsById(tx, connectionId, batch)));
    }
    return withDependentRuns(load, fetched);
  }

  /** Complete rows of `ids`; every one must exist. */
  async function hydrate(tx: Db, ids: readonly string[]) {
    const rows: Transaction[] = [];
    for (const batch of chunks(
      ids,
      db.backend === "d1" ? RUN_ID_BATCH : HYDRATION_BATCH,
    )) {
      rows.push(...(await statements.completeRows(tx, batch)));
    }
    if (new Set(rows.map(({ id }) => id)).size !== new Set(ids).size) {
      throw new Error("A hydrated transaction is missing");
    }
    return rows;
  }

  /** `clauses` split into statements within the driver's parameter limit. */
  function packed(clauses: readonly LedgerClause[]): LedgerClause[][] {
    const budget = db.backend === "d1" ? D1_SCOPE_PARAMETERS : SCOPE_PARAMETERS;
    const pieces = clauses.flatMap((clause): LedgerClause[] => {
      switch (clause.kind) {
        case "accounts":
          return [
            ...chunks(
              clause.accounts,
              Math.max(1, budget - clause.statuses.length - 3),
            ),
          ].map((accounts) => ({ ...clause, accounts }));
        case "keys":
          return [...chunks(clause.keys, budget)].map((keys) => ({
            kind: "keys",
            keys,
          }));
        case "ids":
          return [...chunks(clause.ids, budget)].map((ids) => ({
            kind: "ids",
            ids,
          }));
        case "dependents":
          return [...chunks(clause.ids, Math.floor(budget / 2))].map((ids) => ({
            kind: "dependents",
            ids,
          }));
        default:
          return [clause];
      }
    });
    const groups: LedgerClause[][] = [];
    let used = 0;
    for (const clause of pieces) {
      const size = clauseParameters(clause);
      if (groups.length === 0 || used + size > budget) {
        groups.push([]);
        used = 0;
      }
      groups.at(-1)!.push(clause);
      used += size;
    }
    return groups;
  }

  /**
   * The rows one sync application can decide on. The seed is what the scope
   * names: every row of its accounts in its statuses, linked, aliased,
   * undated or with an identity a narrow read cannot see, the padded
   * request and observation windows, and rows named by source key or
   * identity base. The seed is then closed, as a complete load would read
   * them, over:
   *
   * - supersession, both ways, and purchase families: the purchase of every
   *   billed line and every line of every purchase;
   * - stored pending-to-posted candidate lists, both ways;
   * - the observation radius around every named row, and the exact-date
   *   group of every row a decision can move between groups (pending and
   *   covered rows, named rows and rows whose identity is in doubt);
   * - then supersession, purchase families and candidates again.
   *
   * A row the final pass added decides no exact-date fold unless its group
   * is complete anyway (`LedgerScope.completeDate`). A reference that a
   * by-ID read did not find is recorded as missing, as a complete load
   * would not find it either.
   */
  async function loadBounded(
    tx: Db,
    connectionId: string,
    scope: SyncScope,
    provider: string,
    candidates: boolean,
  ): Promise<{
    ledger: LedgerLoad[];
    scope: LedgerScope;
    knownScopes: string[];
  }> {
    const loaded = new Map<string, LedgerLoad>();
    const take = (rows: readonly LedgerLoad[]) =>
      rows.filter((load) => {
        if (loaded.has(load.row.id)) {
          return false;
        }
        loaded.set(load.row.id, load);
        return true;
      });
    const read = async (clauses: readonly LedgerClause[]) => {
      const rows: LedgerLoad[] = [];
      for (const group of packed(clauses)) {
        rows.push(...(await statements.ledgerRows(tx, connectionId, group)));
      }
      return rows;
    };
    const selected = async (clauses: readonly LedgerClause[]) => {
      const ids = new Set<string>();
      for (const group of packed(clauses)) {
        for (const { id } of await statements.ledgerIds(
          tx,
          connectionId,
          group,
        )) {
          ids.add(id);
        }
      }
      return ids;
    };
    const keys = [...new Set([...scope.keys, ...scope.bases])];
    take(
      await read([
        ...(scope.accounts.length > 0
          ? [
              {
                kind: "accounts" as const,
                accounts: scope.accounts,
                statuses: scope.statuses,
              },
            ]
          : []),
        ...scope.windows.map((window) => ({
          kind: "window" as const,
          ...window,
        })),
        ...(keys.length > 0 ? [{ kind: "keys" as const, keys }] : []),
        ...scope.bases.map((base) => ({ kind: "base" as const, base })),
      ]),
    );
    const missing = new Set<string>();
    let windows = scope.windows;
    const groups = new Map<string, readonly [string, string]>();
    if (hydrationOptions.closure) {
      const lists: { id: string; candidates: string[] }[] = [];
      if (candidates) {
        for (const batch of chunks(scope.accounts, RUN_ID_BATCH)) {
          lists.push(
            ...(await statements.candidateLists(tx, connectionId, batch)),
          );
        }
      }
      const close = async (rows: LedgerLoad[]) => {
        let frontier = rows;
        while (frontier.length > 0) {
          const wanted = new Set<string>();
          const want = (id: string) => {
            if (!loaded.has(id) && !missing.has(id)) {
              wanted.add(id);
            }
          };
          const references = new Set<string>();
          for (const { row } of frontier) {
            for (const id of [row.supersededById, row.purchaseId]) {
              if (id !== null) {
                references.add(id);
              }
            }
            row.details.pendingPostingCandidates?.forEach(want);
          }
          references.forEach(want);
          (
            await selected([
              { kind: "dependents", ids: frontier.map(({ row }) => row.id) },
            ])
          ).forEach(want);
          for (const list of lists) {
            if (
              !loaded.has(list.id) &&
              list.candidates.some((id) => loaded.has(id) || wanted.has(id))
            ) {
              wanted.add(list.id);
            }
          }
          frontier =
            wanted.size > 0
              ? take(await read([{ kind: "ids", ids: [...wanted] }]))
              : [];
          for (const id of references) {
            if (!loaded.has(id)) {
              missing.add(id);
            }
          }
        }
      };
      await close([...loaded.values()]);
      const accounts = new Set(scope.accounts);
      const statuses = new Set<string>(scope.statuses);
      const named = scopeNames(scope, provider);
      const anchors = [...loaded.values()].filter(
        ({ row, doubt }) =>
          doubt ||
          named(row) ||
          (accounts.has(row.sourceScope) && statuses.has(row.status)),
      );
      // A named row can be marked seen at its stored date, so its stored
      // date is padded as an observed one is, which covers every row it
      // could be suggested with. A row whose identity is in doubt
      // may be named by an identity only its complete decode shows (one
      // left in the provider document), so it counts as named here too.
      const around = namedWindows(
        anchors
          .filter(
            ({ row, doubt }) =>
              accounts.has(row.sourceScope) && (doubt || named(row)),
          )
          .map(({ row }) => row),
        scope.radius,
      ).filter(
        (window) =>
          !scope.windows.some(
            (seed) =>
              seed.field === "transaction" &&
              seed.sourceScope === window.sourceScope &&
              seed.from <= window.from &&
              window.to <= seed.to,
          ),
      );
      windows = [...windows, ...around];
      for (const { row } of anchors) {
        if (
          !row.supersededById &&
          row.transactionDate !== null &&
          !windowHolds(windows, row.sourceScope, row.transactionDate)
        ) {
          groups.set(JSON.stringify([row.sourceScope, row.transactionDate]), [
            row.sourceScope,
            row.transactionDate,
          ]);
        }
      }
      const added = [
        ...(await selected([
          ...around.map((window) => ({ kind: "window" as const, ...window })),
          ...[...groups.values()].map(([sourceScope, transactionDate]) => ({
            kind: "date" as const,
            sourceScope,
            transactionDate,
          })),
        ])),
      ].filter((id) => !loaded.has(id));
      await close(
        added.length > 0 ? take(await read([{ kind: "ids", ids: added }])) : [],
      );
    }
    const known = new Set(
      [...loaded.values()].map(({ row }) => row.sourceScope),
    );
    for (const batch of chunks(
      scope.accounts.filter((account) => !known.has(account)),
      RUN_ID_BATCH,
    )) {
      for (const { sourceScope } of await statements.knownScopes(
        tx,
        connectionId,
        batch,
      )) {
        known.add(sourceScope);
      }
    }
    return {
      ledger: [...loaded.values()].sort((a, b) => a.position - b.position),
      scope: ledgerScope(windows, groups.values(), missing),
      knownScopes: scope.accounts.filter((account) => known.has(account)),
    };
  }

  /**
   * Plans one application from narrow rows, hydrating the rows the plan
   * needs complete. A round whose plan demanded hydration is speculative:
   * its result, and any planner error, is discarded, the demanded rows are
   * hydrated, and the application is planned again from pristine inputs with
   * the same clock and ID tape. Only a round without demands is returned, so
   * it decides exactly as a plan from complete rows would.
   *
   * A bounded load (`bounds`) holds only the rows its scope rule names. A
   * round that looks up a row it does not hold is discarded the same way,
   * and every row of the connection is loaded for the rounds that follow.
   */
  async function planApplication(
    tx: Db,
    input: {
      connection: Connection;
      ledger: LedgerLoad[];
      bounds: { scope: LedgerScope; knownScopes: string[] } | undefined;
      history: RunHistoryLoad;
      removals: FinancialSnapshot["removals"];
      catalog: NonNullable<FinancialSnapshot["catalog"]>;
      run: Run;
      extraction: ReturnType<typeof extractRun>;
      adapter: SourceAdapter;
      now: string;
      onRead: (reading: boolean) => void;
    },
  ) {
    const { connection, adapter } = input;
    let { ledger, bounds, history } = input;
    let read = ledger.length;
    let narrow = new Map(ledger.map(({ row }) => [row.id, row]));
    let doubtful = ledger.filter(({ doubt }) => doubt).map(({ row }) => row.id);
    let doubt = new Set(doubtful);
    let annotations = ledger.flatMap(({ annotation }) =>
      annotation ? [annotation] : [],
    );
    const complete = new Map<string, Transaction>();
    const wanted = new Set([
      ...doubtful,
      ...(hydrationOptions.predict
        ? predictHydration([...narrow.values()], input.extraction, adapter)
        : []),
    ]);
    const tape: string[] = [];
    for (let round = 1; ; round++) {
      while (wanted.size > complete.size) {
        input.onRead(true);
        const reading = [...wanted].filter((id) => !complete.has(id));
        await hydrationOptions.beforeRead?.(reading);
        const rows = await hydrate(tx, reading);
        history = await addReferencedRuns(tx, connection.id, history, rows);
        input.onRead(false);
        for (const row of rows) {
          complete.set(row.id, row);
          // A narrow decode that disagrees with the complete one is never
          // trusted: every row of this application is hydrated instead.
          if (
            !doubt.has(row.id) &&
            canonicalJson(narrowFacts(row)) !==
              canonicalJson(narrow.get(row.id))
          ) {
            for (const id of narrow.keys()) {
              wanted.add(id);
            }
          }
        }
      }
      const plan = new FinancialPlan({
        connection,
        rows: ledger.map(({ row }) => complete.get(row.id) ?? row),
        annotations,
        priorRuns: history.priorRuns,
        runHistory: history.runHistory,
        removals: input.removals,
        catalog: input.catalog,
        ...(bounds && { knownScopes: bounds.knownScopes, scope: bounds.scope }),
      });
      const { run, extraction } = structuredClone({
        run: input.run,
        extraction: input.extraction,
      });
      let cursor = 0;
      let result: SyncResult | undefined;
      let failure: unknown;
      try {
        result = planRun(plan, run, adapter, extraction, input.now, () => {
          if (cursor === tape.length) {
            tape.push(crypto.randomUUID());
          }
          return tape[cursor++]!;
        });
      } catch (error) {
        failure = error;
      }
      if (plan.misses.size > 0) {
        // A scope rule that missed a row cannot be trusted to have read
        // the rest of that row's decision: plan from every row instead.
        input.onRead(true);
        ledger = await statements.ledgerRows(tx, connection.id);
        read += ledger.length;
        history = await addReferencedRuns(
          tx,
          connection.id,
          history,
          ledger.map(({ row }) => row),
        );
        input.onRead(false);
        narrow = new Map(ledger.map(({ row }) => [row.id, row]));
        doubtful = ledger.filter(({ doubt }) => doubt).map(({ row }) => row.id);
        doubt = new Set(doubtful);
        annotations = ledger.flatMap(({ annotation }) =>
          annotation ? [annotation] : [],
        );
        bounds = undefined;
        for (const id of [...doubtful, ...plan.demands]) {
          wanted.add(id);
        }
        if (round >= hydrationOptions.rounds) {
          for (const id of narrow.keys()) {
            wanted.add(id);
          }
        }
        continue;
      }
      if (plan.demands.size === 0) {
        if (!result) {
          throw interpretationError(failure);
        }
        const written = [
          ...plan.transactionWrites.values(),
          ...plan.observationWrites.values(),
        ];
        if (
          written.some(
            (row) =>
              isNarrow(row) || (narrow.has(row.id) && !complete.has(row.id)),
          )
        ) {
          throw new Error("A write names a transaction that was not hydrated");
        }
        return {
          plan,
          result,
          history,
          tape,
          narrowRows: [...narrow.values()],
          hydrated: [...complete.keys()],
          doubtful,
          rounds: round,
          read,
          bounded: bounds !== undefined,
          fallback: input.bounds !== undefined && bounds === undefined,
        };
      }
      for (const id of plan.demands) {
        if (!narrow.has(id) || complete.has(id)) {
          throw new Error("A hydration demand names no narrow row");
        }
        wanted.add(id);
      }
      if (round >= hydrationOptions.rounds) {
        for (const id of narrow.keys()) {
          wanted.add(id);
        }
      }
    }
  }

  /** Plans the same application from complete rows and every applied run, and reports both. */
  async function compareLoading(
    verifier: (comparison: ApplicationLoadingComparison) => void,
    tx: Db,
    connection: Connection,
    dependent: {
      run: Run;
      extraction: ReturnType<typeof extractRun>;
      adapter: SourceAdapter;
      now: string;
      issued: string[];
      plan: FinancialPlan;
      result: SyncResult;
      history: RunHistoryLoad;
      runHistory: RunHistoryDocument | undefined;
      narrowRows: NarrowRow[];
      hydrated: string[];
      doubtful: string[];
      rounds: number;
      bounded: boolean;
      fallback: boolean;
    },
  ) {
    const { adapter, history, runHistory } = dependent;
    const plan = await loadPlan(tx, connection, undefined, [], true);
    let replayed = 0;
    const result = planRun(
      plan,
      dependent.run,
      adapter,
      dependent.extraction,
      dependent.now,
      () => dependent.issued[replayed++] ?? crypto.randomUUID(),
    );
    const update = plan.runUpdate;
    const priorRuns = plan.snapshot.priorRuns;
    verifier({
      scoped: history.scoped,
      loadedRuns: dependent.plan.snapshot.priorRuns.length,
      appliedRuns: priorRuns.length,
      narrowRows: dependent.narrowRows,
      plannedRows: dependent.plan.snapshot.rows.map((row) => ({
        id: row.id,
        narrow: isNarrow(row),
      })),
      completeRows: plan.snapshot.rows.map((row) => plan.full(row)),
      hydrated: dependent.hydrated,
      doubtful: dependent.doubtful,
      rounds: dependent.rounds,
      bounded: dependent.bounded,
      fallback: dependent.fallback,
      undecided: [...dependent.plan.rows.values()]
        .filter((row) => !dependent.plan.decides(row))
        .map(({ id }) => id),
      dependent: plannedApplication(
        dependent.plan,
        dependent.result,
        runHistory,
      ),
      complete: plannedApplication(
        plan,
        result,
        runHistory &&
          update &&
          encodeRunHistory({
            provider: adapter.provider,
            parserVersion: adapter.parserVersion,
            appliedRuns: priorRuns.length + 1,
            latestRunId: dependent.run.id,
            summary: summarizeRunHistory(
              [...priorRuns, appliedRun(history.applying, update)],
              adapter,
            ),
          }),
      ),
    });
  }

  async function mutateTransaction<Result>(
    tx: Db,
    id: string,
    scope: "annotation" | "lifecycle",
    command: (plan: FinancialPlan) => Result,
    relatedIds: string[] = [],
  ) {
    const connection = (await statements.lockConnectionOf(tx, id))[0];
    if (!connection) {
      throw new NotFoundError("Transaction not found");
    }
    const plan = await loadPlan(
      tx,
      connection,
      scope === "annotation" ? { transactionId: id } : { accountOf: id },
      relatedIds,
    );
    const result = command(plan);
    finishTransactionContent(
      plan,
      undefined,
      undefined,
      plan.events[0]?.createdAt ?? new Date().toISOString(),
      new Set(),
      plan.events[0]?.actor ?? "owner",
    );
    await savePlan(tx, plan);
    return result;
  }

  async function ingestRun(
    input: RunInput,
    adapter: SourceAdapter,
    onDiagnostic?: SyncDiagnosticSink,
  ) {
    const run = prepareRun(input, adapter);
    const digest = await runEvidenceDigest(run);
    const emit = syncDiagnostics(onDiagnostic);
    const ids = syncCorrelationIds({
      captureId: run.runId,
      refreshId: run.refreshId,
    });
    const started = performance.now();
    let staged = false;
    emit({ event: "fonds_sync", ...ids, stage: "archive", outcome: "started" });
    await db
      .transaction(async (tx) => {
        const connection = (
          await statements.lockConnection(tx, run.connectionId)
        )[0];
        if (!connection) {
          throw new NotFoundError("Connection not found");
        }
        if (connection.provider !== adapter.provider) {
          throw new Error("Connection provider mismatch");
        }
        const existing = (await statements.runState(tx, run.runId))[0];
        if (existing) {
          if (existing.evidenceDigest !== digest) {
            throw new Error("Run ID already refers to different evidence");
          }
        } else {
          const retained = retainedRun(run, adapter, digest);
          await commit(tx, connection, [
            statements.insertRun(tx, retained),
            statements.insertRunBody(tx, retained),
          ]);
          staged = true;
        }
      })
      .catch((error: unknown) => {
        emit({
          event: "fonds_sync",
          ...ids,
          stage: "archive",
          outcome: "failed",
          reason: "persistence_failure",
          failureCategory: "persistence",
        });
        throw error;
      });
    emit({
      event: "fonds_sync",
      ...ids,
      stage: "archive",
      outcome: "completed",
      reason: staged ? "body_staged" : "receipt_exists",
      durationMs: elapsedMs(started),
    });
    return applyRun(run.runId, adapter, onDiagnostic);
  }

  async function applyRun(
    id: string,
    adapter: SourceAdapter,
    onDiagnostic?: SyncDiagnosticSink,
    executionRefreshId?: string,
  ): Promise<SyncResult> {
    const emit = syncDiagnostics(onDiagnostic);
    const ids = syncCorrelationIds({
      captureId: id,
      refreshId: executionRefreshId,
    });
    try {
      requireEvidenceRetention(adapter);
    } catch (error) {
      emit({
        event: "fonds_sync",
        ...ids,
        stage: "read",
        outcome: "failed",
        failureCategory: "execution",
      });
      throw interpretationError(error);
    }
    const stored = (
      await db
        .execute(statements.runWithConnection(db.root, id))
        .catch((error: unknown) => {
          emit({
            event: "fonds_sync",
            ...ids,
            stage: "read",
            outcome: "failed",
            failureCategory: "persistence",
          });
          throw error;
        })
    )[0];
    if (!stored) {
      emit({
        event: "fonds_sync",
        ...ids,
        stage: "read",
        outcome: "failed",
        failureCategory: "execution",
      });
      throw interpretationError(new NotFoundError("Run not found"));
    }
    const { run: archived, connection } = stored;
    Object.assign(
      ids,
      syncCorrelationIds({
        refreshId: executionRefreshId ?? archived.refreshId ?? undefined,
      }),
    );
    if (connection.provider !== adapter.provider) {
      emit({
        event: "fonds_sync",
        ...ids,
        stage: "read",
        outcome: "failed",
        failureCategory: "execution",
      });
      throw interpretationError(new Error("Connection provider mismatch"));
    }
    if (archived.appliedAt) {
      return replayResult(archived);
    }
    if (archived.parserVersion !== adapter.parserVersion) {
      emit({
        event: "fonds_sync",
        ...ids,
        stage: "read",
        outcome: "failed",
        failureCategory: "execution",
      });
      throw interpretationError(
        new Error("Run parser version differs from adapter"),
      );
    }
    if (!archived.bodyAvailable) {
      emit({
        event: "fonds_sync",
        ...ids,
        stage: "read",
        outcome: "failed",
        failureCategory: "execution",
      });
      throw interpretationError(
        new Error("Unapplied run has no recoverable source body"),
      );
    }
    const started = performance.now();
    emit({
      event: "fonds_sync",
      ...ids,
      stage: "extraction",
      outcome: "started",
    });
    let extraction: ReturnType<typeof extractRun>;
    try {
      extraction = extractRun(archived, adapter);
    } catch (error) {
      emit({
        event: "fonds_sync",
        ...ids,
        stage: "extraction",
        outcome: "failed",
        failureCategory: "invalid_response",
      });
      throw interpretationError(error);
    }
    emit({
      event: "fonds_sync",
      ...ids,
      stage: "extraction",
      outcome: "completed",
      durationMs: elapsedMs(started),
      counts: {
        extracted: extraction.extracted.reduce(
          (count, item) => count + item.result.transactions.length,
          0,
        ),
      },
    });
    let phase: "read" | "reconciliation" | "commit" = "read";
    let commitStarted = performance.now();
    const result = await db
      .transaction(async (tx) => {
        const locked = (await statements.lockConnection(tx, connection.id))[0]!;
        const state = (await statements.runState(tx, id))[0]!;
        const run = { ...archived, ...state };
        if (run.appliedAt) {
          return replayResult(run);
        }
        const bounded = await loadBounded(
          tx,
          connection.id,
          syncScope(extraction, adapter, SYNC_SCOPE_DAYS),
          adapter.provider,
          adapter.pendingPostingCandidates === true &&
            extraction.extracted.some(({ result }) => !result.historical),
        );
        const ledger = bounded.ledger;
        const loadedHistory = await loadRunHistory(
          tx,
          connection.id,
          run,
          adapter,
          ledger.map(({ row }) => row),
        );
        const removals = await statements.removals(tx, connection.id);
        const catalog = await loadCatalog(tx, connection.id);
        phase = "reconciliation";
        const reconciliationStarted = performance.now();
        const loaded = {
          ledgerRows: ledger.length,
          priorRuns: loadedHistory.priorRuns.length,
          removals: removals.length,
        };
        emit({
          event: "fonds_sync",
          ...ids,
          stage: "reconciliation",
          outcome: "started",
          counts: loaded,
        });
        const now = new Date().toISOString();
        const planned = await planApplication(tx, {
          connection: locked,
          ledger,
          bounds: { scope: bounded.scope, knownScopes: bounded.knownScopes },
          history: loadedHistory,
          removals,
          catalog,
          run,
          extraction,
          adapter,
          now,
          onRead: (reading) => {
            phase = reading ? "read" : "reconciliation";
          },
        });
        const { plan, result, history } = planned;
        const runHistory = nextRunHistory(history, plan.runUpdate, adapter);
        if (loadingVerifier) {
          await compareLoading(loadingVerifier, tx, locked, {
            // Planning may adjust its inputs; the comparison plans pristine copies.
            ...structuredClone({ run, extraction }),
            adapter,
            now,
            issued: planned.tape,
            plan,
            result,
            history,
            runHistory,
            narrowRows: planned.narrowRows,
            hydrated: planned.hydrated,
            doubtful: planned.doubtful,
            rounds: planned.rounds,
            bounded: planned.bounded,
            fallback: planned.fallback,
          });
        }
        const dbBytesRead = db.bytesRead?.(tx);
        emit({
          event: "fonds_sync",
          ...ids,
          stage: "reconciliation",
          outcome: "completed",
          durationMs: elapsedMs(reconciliationStarted),
          counts: {
            observed: result.observed ?? 0,
            created: result.created,
            changed: result.updated,
            unchangedTransactions: result.unchanged ?? 0,
            absent: result.unlisted,
            deferred: plan.deferredCandidates.length,
            ...loaded,
            ledgerRows: planned.read,
            priorRuns: history.priorRuns.length,
            hydratedRows: planned.hydrated.length,
            hydrationRounds: planned.rounds,
            ...(dbBytesRead !== undefined && { dbBytesRead }),
          },
        });
        const deferred = await Promise.all(
          plan.deferredCandidates.map(async (candidate) => ({
            id: await contentDigest({
              digestSchema: "fonds-deferred-evidence-v1",
              connectionId: connection.id,
              ...candidate,
            }),
            connectionId: connection.id,
            ...candidate,
            firstSeenRunId: id,
            lastSeenRunId: id,
          })),
        );
        phase = "commit";
        commitStarted = performance.now();
        emit({
          event: "fonds_sync",
          ...ids,
          stage: "commit",
          outcome: "started",
        });
        const refreshId = executionRefreshId ?? run.refreshId;
        const refresh = refreshId
          ? (await statements.refresh(tx, refreshId))[0]
          : undefined;
        if (refreshId && (!refresh || refresh.connectionId !== connection.id)) {
          throw new Error("Run refresh does not belong to its connection");
        }
        const activeWindows =
          refresh &&
          refresh.rangeFrom !== null &&
          refresh.id === run.refreshId &&
          result.status !== "failed"
            ? (await statements.refreshWindows(tx, refresh.id)).filter(
                (window) => window.status === "running",
              )
            : [];
        const acceptedWindow =
          activeWindows.length === 1 && !activeWindows[0]!.hasAcceptedEvidence
            ? activeWindows[0]
            : undefined;
        const captures = run.snapshot.responses.length;
        const delta = {
          captures,
          observed: result.observed ?? 0,
          unchangedTransactions: result.unchanged ?? 0,
          created: result.created,
          updated: result.updated,
          unlisted: result.unlisted,
          failures: result.status === "completed" ? 0 : 1,
          unchanged:
            result.status === "completed" &&
            result.created === 0 &&
            result.updated === 0 &&
            result.unlisted === 0 &&
            result.observed !== undefined &&
            result.unchanged === result.observed
              ? captures
              : 0,
        };
        const refreshCounts = { ...delta };
        if (refresh) {
          for (const key of Object.keys(delta) as (keyof typeof delta)[]) {
            refreshCounts[key] += refresh[key];
            if (!Number.isSafeInteger(refreshCounts[key])) {
              throw new Error("Refresh count exhausted");
            }
          }
        }
        await savePlan(tx, plan, id, [
          ...(acceptedWindow
            ? [
                statements.markRefreshWindowAccepted(
                  tx,
                  acceptedWindow.refreshId,
                  acceptedWindow.rangeFrom,
                ),
              ]
            : []),
          ...(refresh
            ? [
                statements.updateRefresh(tx, refresh.id, {
                  ...refreshCounts,
                  hasAcceptedEvidence:
                    refresh.hasAcceptedEvidence ||
                    (refresh.id === run.refreshId &&
                      result.status !== "failed"),
                  providerStopReason:
                    refresh.providerStopReason ??
                    PROVIDER_STOP_REASONS.find((code) =>
                      run.snapshot.failures?.some(
                        (failure) => failure.code === code,
                      ),
                    ) ??
                    null,
                  failureCodes: [
                    ...new Set([
                      ...refresh.failureCodes,
                      ...refreshFailureCodes(
                        result,
                        run.snapshot.failures ?? [],
                        extraction.extracted,
                      ),
                    ]),
                  ].sort(),
                  requiresAttention:
                    refresh.requiresAttention ||
                    (run.snapshot.failures ?? []).some(
                      (failure) =>
                        failure.code === "authentication_failed" ||
                        failure.code === "authentication_challenge",
                    ),
                }),
              ]
            : []),
          ...[...new Map(deferred.map((row) => [row.id, row])).values()].map(
            (row) => statements.upsertDeferredEvidence(tx, row),
          ),
          ...statements.finishRunEvidence(tx, id, archived.bodyExpiresAt),
          ...(runHistory
            ? [statements.saveRunHistory(tx, connection.id, runHistory)]
            : []),
        ]);
        return result;
      })
      .catch((error: unknown) => {
        emit({
          event: "fonds_sync",
          ...ids,
          stage: phase,
          outcome: "failed",
          failureCategory:
            phase === "reconciliation" ? "execution" : "persistence",
        });
        throw error;
      });
    emit({
      event: "fonds_sync",
      ...ids,
      stage: "commit",
      outcome: "completed",
      durationMs: elapsedMs(commitStarted),
    });
    emit({
      event: "fonds_sync",
      ...ids,
      stage: "archive",
      outcome: "completed",
      reason:
        archived.bodyExpiresAt === null
          ? "body_released"
          : "debug_body_retained",
    });
    // Expiration is maintenance after the atomic financial commit; failure cannot undo it.
    try {
      await db.execute(
        statements.pruneDebugBodies(db.root, new Date().toISOString()),
      );
      emit({
        event: "fonds_sync",
        ...ids,
        stage: "purge",
        outcome: "completed",
      });
    } catch {
      emit({
        event: "fonds_sync",
        ...ids,
        stage: "purge",
        outcome: "failed",
        failureCategory: "persistence",
      });
    }
    return result;
  }

  async function latestEventId(connectionId?: string) {
    const id =
      (await db.execute(statements.latestEvent(db.root, connectionId)))[0]
        ?.id ?? 0;
    // A rounded or negative cursor would send unacknowledgeable events.
    if (!Number.isSafeInteger(id) || id < 0) {
      throw new Error("Invalid event cursor");
    }
    return id;
  }

  async function updateConfig(
    id: string,
    change: (config: ConnectionConfig) => ConnectionConfig,
  ) {
    return db.transaction(async (tx) => {
      const row = (await statements.lockConnection(tx, id))[0];
      if (!row) {
        throw new NotFoundError("Connection not found");
      }
      const config = configSchema.parse(change(configSchema.parse(row.config)));
      await commit(tx, row, [statements.setConfig(tx, id, config)]);
      return config;
    });
  }

  return {
    identity: db.identity,
    backend: db.backend,
    ...refreshes,
    listConnections: async () =>
      Promise.all(
        (await db.execute(statements.connections(db.root))).map(present),
      ),
    recordCardDiscovery: async (connectionId, input) => {
      const discovery = cardDiscoverySchema.parse(input);
      await db.transaction(async (tx) => {
        const connection = (
          await statements.lockConnection(tx, connectionId)
        )[0];
        if (!connection) {
          throw new NotFoundError("Connection not found");
        }
        const plan = new FinancialPlan({
          connection,
          rows: [],
          annotations: [],
          priorRuns: [],
          removals: [],
          catalog: await loadCatalog(tx, connectionId),
        });
        planCardDiscovery(plan, discovery, new Date().toISOString(), () =>
          crypto.randomUUID(),
        );
        await savePlan(tx, plan);
      });
    },
    listCards: async (input) => {
      const filters = catalogPageSchema.parse(input);
      const { limit } = filters;
      const rows = await db.execute(
        statements.cardPage(db.root, { ...filters, limit: limit + 1 }),
      );
      await checkEmpty(rows, filters.connectionId);
      return { cards: rows.slice(0, limit), hasMore: rows.length > limit };
    },
    getCard: async (id) => (await db.execute(statements.card(db.root, id)))[0],
    listAccounts: async (input) => {
      const filters = catalogPageSchema.parse(input);
      const { limit } = filters;
      const rows = await db.execute(
        statements.accountPage(db.root, { ...filters, limit: limit + 1 }),
      );
      await checkEmpty(rows, filters.connectionId);
      return { accounts: rows.slice(0, limit), hasMore: rows.length > limit };
    },
    getAccount: async (id) =>
      (await db.execute(statements.account(db.root, id)))[0],
    getStoredConnection: getConnection,
    getConnection: async (id) => {
      const connection = await getConnection(id);
      return connection && present(connection);
    },
    // Internal inspection retains history across every perspective; callers
    // needing current rows must name presence or use the public page API.
    listTransactions: async (input) => {
      const filters = filtersSchema.parse({
        perspective: "all",
        presence: "all",
        ...input,
      });
      await checkScope(filters);
      const rows = await db.execute(
        statements.transactionPage(db.root, filters),
      );
      return rows.map(({ row, annotation }) =>
        presentTransaction(row, annotation),
      );
    },
    listTransactionPage: async (input) => {
      const filters = pageSchema.parse(input ?? {});
      await checkScope(filters);
      const { limit } = filters;
      const rows = await db.execute(
        statements.transactionListPage(db.root, {
          ...filters,
          limit: limit + 1,
        }),
      );
      await checkEmpty(rows, filters.connectionId);
      return {
        transactions: rows
          .slice(0, limit)
          .map(({ row, annotation }) => presentTransaction(row, annotation)),
        hasMore: rows.length > limit,
      };
    },
    listTransactionSummaryPage: async (input) => {
      const filters = pageSchema.parse(input ?? {});
      await checkScope(filters);
      const { limit } = filters;
      const rows = await db.execute(
        statements.transactionSummaryPage(db.root, {
          ...filters,
          limit: limit + 1,
        }),
      );
      await checkEmpty(rows, filters.connectionId);
      return {
        transactions: rows.slice(0, limit),
        hasMore: rows.length > limit,
      };
    },
    getTransactionViews: async (ids) =>
      (await byIds(ids, statements.transactionsWithAnnotation)).map((row) =>
        presentTransaction(row.row, row.annotation),
      ),
    getTransactionListViews: async (ids) =>
      (await byIds(ids, statements.transactionListById)).map((row) =>
        presentTransaction(row.row, row.annotation),
      ),
    getTransactionSummaries: async (ids) =>
      byIds(ids, statements.transactionSummariesById),
    getTransaction: async (id) => {
      const row = (
        await db.execute(statements.transactionWithAnnotation(db.root, id))
      )[0];
      return row && presentTransaction(row.row, row.annotation);
    },
    getCoverage: async (connectionId) => {
      const connection = await getConnection(connectionId);
      if (!connection) {
        return undefined;
      }
      const months = await db.execute(
        statements.transactionMonths(
          db.root,
          connectionId,
          COVERAGE_MAX_MONTHS + 2,
        ),
      );
      const backfill = await db.execute(
        statements.backfillMonths(
          db.root,
          connectionId,
          COVERAGE_MAX_MONTHS + 1,
        ),
      );
      const recent = (
        await db.execute(statements.recentCompletion(db.root, connectionId))
      )[0];
      const finished = (
        await db.execute(statements.lastExecutedRefresh(db.root, connectionId))
      )[0];
      const dated = months.filter(
        (row): row is typeof row & { month: string } => row.month !== null,
      );
      return {
        connectionId,
        transactionCount: months[0]?.total ?? 0,
        undatedCount: months.find((row) => row.month === null)?.count ?? 0,
        earliestDate: months[0]?.earliest ?? null,
        latestDate: months[0]?.latest ?? null,
        transactionMonths: dated
          .slice(0, COVERAGE_MAX_MONTHS + 1)
          .map(({ month, count }) => ({ month, count })),
        backfillMonths: backfill.map(({ month, rank, completedAt }) => ({
          month,
          outcome: BACKFILL_OUTCOMES[rank - 1]!,
          completedAt,
        })),
        recentCompletedAt: recent?.finishedAt ?? null,
        lastFinished: finished
          ? {
              requiresAttention: finished.requiresAttention,
              failureCodes: finished.failureCodes,
            }
          : null,
      };
    },
    getTotals: async (input) => {
      const filters = totalsSchema.parse(input ?? {});
      await checkScope(filters);
      const rows = await db.execute(
        statements.totalsParts(db.root, {
          ...filters,
          perspective: filters.perspective,
        }),
      );
      await checkEmpty(rows, filters.connectionId);
      return totalsFromParts(
        rows.map((row) => ({
          ...row,
          amountMinor: exactSumValue(row.amountMinor),
          fxFeeMinor: exactSumValue(row.fxFeeMinor),
        })),
      );
    },
    getGroupedTotals: async (input, groupBy, limit) => {
      const filters = totalsSchema.parse(input);
      await checkScope(filters);
      const rows = await db.execute(
        statements.groupedTotals(
          db.root,
          { ...filters, perspective: filters.perspective },
          groupBy,
          limit + 1,
        ),
      );
      await checkEmpty(rows, filters.connectionId);
      const groups = new Map<unknown, TotalsGroup>();
      for (const row of rows) {
        const rank = exactInteger(row.groupRank);
        let group = groups.get(rank);
        if (!group) {
          group = {
            key: row.groupKey,
            includedCount: 0,
            totals: [],
          };
          groups.set(rank, group);
        }
        group.includedCount += row.count;
        group.totals.push({
          currency: row.currency,
          amountBasis: row.amountBasis,
          count: row.count,
          amountMinor: toSafeMinor(exactSumValue(row.amountMinor)),
          minMinor: toSafeMinor(exactInteger(row.minMinor)),
          maxMinor: toSafeMinor(exactInteger(row.maxMinor)),
        });
      }
      const ordered = [...groups.values()];
      for (const group of ordered) {
        group.totals.sort((left, right) =>
          compareStrings(
            `${left.amountBasis ?? ""}:${left.currency}`,
            `${right.amountBasis ?? ""}:${right.currency}`,
          ),
        );
      }
      return {
        groups: ordered.slice(0, limit),
        truncated: ordered.length > limit,
      };
    },
    listEvents: async (input) => {
      const filters = cursorSchema.parse(input ?? {});
      const rows = await db.execute(statements.events(db.root, filters));
      await checkEmpty(rows, filters.connectionId);
      return rows;
    },
    listWireEvents: async (input) => {
      const filters = cursorSchema.parse(input ?? {});
      const rows = await db.execute(statements.wireEvents(db.root, filters));
      await checkEmpty(rows, filters.connectionId);
      return rows.map((row) => ({
        ...row,
        before:
          row.before === null ? null : (JSON.parse(row.before) as unknown),
        after: row.after === null ? null : (JSON.parse(row.after) as unknown),
      }));
    },
    listSyncRuns: async (id, page) => {
      const rows = await db.execute(statements.syncRuns(db.root, id, page));
      await checkEmpty(rows, id);
      return rows;
    },
    ingestRun,
    applyRun,
    updateConfig,
    latestEventId,
    ledgerRevision: async (connectionId) => {
      const latest = await latestEventId();
      const rows = (
        await db.execute(statements.transactionCount(db.root, connectionId))
      )[0];
      return `${latest}:${rows?.count ?? 0}`;
    },
    ensureConnection: async (input, options = {}) => {
      const value = connectionInputSchema.parse(input);
      let row = await getConnection(value.id);
      if (row && options.requireNew) {
        throw new ConflictError("Connection already exists");
      }
      if (!row) {
        row = (
          await db.execute(
            statements.insertConnection(db.root, {
              id: value.id,
              provider: value.provider,
              displayName: value.displayName ?? value.id,
              config: { schemaVersion: 1 },
              createdAt: new Date().toISOString(),
            }),
          )
        )[0];
        if (!row && options.requireNew) {
          throw new ConflictError("Connection already exists");
        }
        row ??= await requireConnection(value.id);
      }
      if (row.provider !== value.provider) {
        throw new Error("Connection provider cannot change");
      }
      return row;
    },
    editAnnotation: async (input) => {
      const edit = editSchema.parse(input);
      return db.transaction((tx) =>
        mutateTransaction(tx, edit.transactionId, "annotation", (plan) =>
          planAnnotation(plan, edit, new Date().toISOString()),
        ),
      );
    },
    undoAnnotation: (input) =>
      db.transaction(async (tx) => {
        const event = (await statements.event(tx, input.eventId))[0];
        if (!event?.transactionId || event.type !== "annotation.updated") {
          throw new NotFoundError("Annotation event not found");
        }
        return mutateTransaction(
          tx,
          event.transactionId,
          "annotation",
          (plan) =>
            planUndoAnnotation(plan, event, input, new Date().toISOString()),
        );
      }),
    linkPendingTransaction: async (input) => {
      const command = postingSchema.parse(input);
      return db.transaction((tx) =>
        mutateTransaction(
          tx,
          command.pendingId,
          "lifecycle",
          (plan) => planPosting(plan, command, new Date().toISOString()),
          [command.postedId],
        ),
      );
    },
    unlinkPendingTransaction: async (input) => {
      const command = postingSchema.parse(input);
      return db.transaction((tx) =>
        mutateTransaction(
          tx,
          command.pendingId,
          "lifecycle",
          (plan) => planUnlinkPosting(plan, command, new Date().toISOString()),
          [command.postedId],
        ),
      );
    },
    confirmRemoval: async (input) => {
      const command = removalSchema.parse(input);
      return db.transaction((tx) =>
        mutateTransaction(tx, command.transactionId, "lifecycle", (plan) =>
          planRemoval(plan, command, new Date().toISOString()),
        ),
      );
    },
    getDeliveryCursor: async (connectionId, consumerId) => {
      consumerSchema.parse({ connectionId, consumerId });
      return cursorFor(
        configSchema.parse((await requireConnection(connectionId)).config),
        consumerId,
      );
    },
    claimOccurrence: async (occurrence, now) => {
      const scheduledAt = iso(occurrence.at);
      // A later claim means the clock moved back or this process lags behind.
      const latest = (await db.execute(statements.latestOccurrence(db.root)))[0]
        ?.scheduledAt;
      if (latest && latest > scheduledAt) {
        return undefined;
      }
      // Each claim's lease end is its token: a later claim's always differs.
      const leaseUntil = iso(now + OCCURRENCE_LEASE_MS);
      const claimed = await db.execute(
        statements.claimOccurrence(
          db.root,
          {
            occurrence: occurrence.key,
            scheduledAt,
            status: "running",
            leaseUntil,
          },
          iso(now),
        ),
      );
      if (!claimed.length) {
        return undefined;
      }
      await db.execute(
        statements.pruneOccurrences(
          db.root,
          iso(now - OCCURRENCE_RETENTION_MS),
        ),
      );
      return leaseUntil;
    },
    latestClaimedOccurrence: async () => {
      const latest = (await db.execute(statements.latestOccurrence(db.root)))[0]
        ?.scheduledAt;
      return latest ? Date.parse(latest) : undefined;
    },
    finishOccurrence: async (occurrence, claim) => {
      await db.execute(
        statements.finishOccurrence(db.root, occurrence.key, claim),
      );
    },
    releaseOccurrence: async (occurrence, claim) => {
      // Earlier than any lease: the next claim retakes it.
      await db.execute(
        statements.releaseOccurrence(db.root, occurrence.key, claim, iso(0)),
      );
    },
    getSetting: async (name) =>
      (await db.execute(statements.setting(db.root, name)))[0]?.value,
    ensureSetting: async (name, generate) => {
      const stored = (await db.execute(statements.setting(db.root, name)))[0];
      if (stored) {
        return stored.value;
      }
      // Concurrent first starts keep whichever value was inserted first.
      await db.execute(statements.insertSetting(db.root, name, generate()));
      return (await db.execute(statements.setting(db.root, name)))[0]!.value;
    },
    acknowledgeCursor: async (connectionId, consumerId, expected, next) => {
      consumerSchema.parse({ connectionId, consumerId });
      await updateConfig(connectionId, (config) =>
        acknowledgeConfig(config, consumerId, expected, next),
      );
    },
  };
}
