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
  type InternalStore,
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
  type NotStartedReason,
  type Refresh,
  REFRESH_COOLDOWN_MS,
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
import { cardDiscoverySchema } from "../domain/cards.js";
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from "../domain/errors.js";
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
import { FinancialPlan } from "../domain/plans/state.js";
import {
  extractRun,
  finishTransactionContent,
  planRun,
  refreshFailureCodes,
  type RunInput,
  type SyncResult,
} from "../domain/plans/sync.js";
import { calculateTotals, presentTransaction } from "../domain/read-model.js";
import type { Connection, ConnectionConfig } from "../domain/records.js";
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
import type { PlanScope } from "./sql.js";
import type { RefreshRow, RefreshWindowRow, Statements } from "./statements.js";

// Keep public error identity (for example version conflicts) while classifying recovery.
const interpretationErrors = new WeakSet<Error>();

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

/** Why the last executed refresh holds back a new one, if it does. */
function heldBackBy(
  last: RefreshRow | undefined,
  now: number,
): NotStartedReason | null {
  if (last?.requiresAttention) {
    return "requires_attention";
  }
  if (
    last?.finishedAt &&
    now - Date.parse(last.finishedAt) < REFRESH_COOLDOWN_MS
  ) {
    return "cooldown";
  }
  return null;
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
            reason = heldBackBy(met, rules.now);
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
        await commit(tx, connection, [
          ...(Object.keys(set).length
            ? [statements.updateRefresh(tx, id, set)]
            : []),
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
    return new FinancialPlan({
      connection,
      rows: joined.map(({ row }) => row),
      annotations: joined.flatMap(({ annotation }) =>
        annotation ? [annotation] : [],
      ),
      priorRuns: scope ? [] : await statements.priorRuns(tx, connection.id),
      removals: scope ? [] : await statements.removals(tx, connection.id),
      ...(catalog && { catalog: await loadCatalog(tx, connection.id) }),
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
        const plan = await loadPlan(tx, locked, undefined, [], true);
        phase = "reconciliation";
        const reconciliationStarted = performance.now();
        emit({
          event: "fonds_sync",
          ...ids,
          stage: "reconciliation",
          outcome: "started",
        });
        let result: SyncResult;
        try {
          result = planRun(
            plan,
            run,
            adapter,
            extraction,
            new Date().toISOString(),
            () => crypto.randomUUID(),
          );
        } catch (error) {
          throw interpretationError(error);
        }
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
        statements.transactionPage(db.root, {
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
    getTransaction: async (id) => {
      const row = (
        await db.execute(statements.transactionWithAnnotation(db.root, id))
      )[0];
      return row && presentTransaction(row.row, row.annotation);
    },
    getTotals: async (input) => {
      const filters = totalsSchema.parse(input ?? {});
      await checkScope(filters);
      const rows = await db.execute(statements.totals(db.root, filters));
      await checkEmpty(rows, filters.connectionId);
      return calculateTotals(rows, filters.perspective);
    },
    listEvents: async (input) => {
      const filters = cursorSchema.parse(input ?? {});
      const rows = await db.execute(statements.events(db.root, filters));
      await checkEmpty(rows, filters.connectionId);
      return rows;
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
