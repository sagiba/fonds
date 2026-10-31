import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  sql,
  type Table,
} from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

import type { SyncRunPageInput } from "../../application/financial-store.js";
import type {
  CatalogQuery,
  EventQuery,
  TransactionQuery,
} from "../../application/query-inputs.js";
import type { RefreshPageInput } from "../../application/refreshes.js";
import type { RunHistoryDocument } from "../../domain/plans/run-history.js";
import type { FinancialPlan } from "../../domain/plans/state.js";
import type { Connection, ConnectionConfig } from "../../domain/records.js";
import type { RetainedRun } from "../run-evidence.js";
import {
  chunks,
  connectionColumns,
  eventFilter,
  excludedSet,
  keysetSeek,
  listColumns,
  planCondition,
  type PlanScope,
  totalsColumns,
  transactionFilter,
  transactionOrder,
  transactionSeek,
} from "../sql.js";
import type { DeferredEvidenceWrite } from "../statements.js";
import {
  decodeTransaction,
  decodeTransactionListFacts,
  encodeObservation,
  encodeReconciliation,
  transactionContentWrites,
} from "../transaction-codec.js";
import * as schema from "./schema.js";

/** libSQL and D1 share these async SQLite-dialect builders. */
type Database = BaseSQLiteDatabase<"async", unknown, typeof schema>;

export type Executor = Pick<
  Database,
  "select" | "insert" | "update" | "delete"
>;

const transactionColumns = getTableColumns(schema.transactions);
const runColumns = getTableColumns(schema.syncRuns);

export const cards = (db: Executor, connectionId: string) =>
  db
    .select()
    .from(schema.cards)
    .where(eq(schema.cards.connectionId, connectionId))
    .orderBy(asc(schema.cards.createdAt), asc(schema.cards.id));
export const card = (db: Executor, id: string) =>
  db.select().from(schema.cards).where(eq(schema.cards.id, id));
export const cardPage = (db: Executor, input: CatalogQuery) => {
  const query = db
    .select()
    .from(schema.cards)
    .where(
      and(
        eq(schema.cards.connectionId, input.connectionId),
        keysetSeek(
          schema.cards.createdAt,
          schema.cards.id,
          input.after && { time: input.after.createdAt, id: input.after.id },
          "asc",
        ),
      ),
    )
    .orderBy(asc(schema.cards.createdAt), asc(schema.cards.id));
  return query.limit(input.limit);
};
export const accounts = (db: Executor, connectionId: string) =>
  db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.connectionId, connectionId))
    .orderBy(asc(schema.accounts.createdAt), asc(schema.accounts.id));
export const account = (db: Executor, id: string) =>
  db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
export const accountPage = (db: Executor, input: CatalogQuery) => {
  const query = db
    .select()
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.connectionId, input.connectionId),
        keysetSeek(
          schema.accounts.createdAt,
          schema.accounts.id,
          input.after && { time: input.after.createdAt, id: input.after.id },
          "asc",
        ),
      ),
    )
    .orderBy(asc(schema.accounts.createdAt), asc(schema.accounts.id));
  return query.limit(input.limit);
};

export const connection = (db: Executor, id: string) =>
  db.select().from(schema.connections).where(eq(schema.connections.id, id));
export const lockConnection = (db: Executor, id: string) => connection(db, id);
export const connectionOfTransaction = (id: string) =>
  eq(
    schema.connections.id,
    sql`(select ${schema.transactions.connectionId} from ${schema.transactions} where ${schema.transactions.id} = ${id})`,
  );
export const lockConnectionOf = (db: Executor, id: string) =>
  db.select().from(schema.connections).where(connectionOfTransaction(id));
export const connections = (db: Executor) =>
  db
    .select(connectionColumns(schema.connections))
    .from(schema.connections)
    .orderBy(asc(schema.connections.createdAt), asc(schema.connections.id));

function joinedTransactions(db: Executor) {
  return db
    .select({
      row: transactionColumns,
      observation: schema.transactionObservations,
      reconciliation: schema.transactionReconciliation,
      posting: schema.transactionPostingLinks,
      annotation: schema.annotations,
    })
    .from(schema.transactions)
    .innerJoin(
      schema.transactionObservations,
      eq(schema.transactionObservations.transactionId, schema.transactions.id),
    )
    .innerJoin(
      schema.transactionReconciliation,
      eq(
        schema.transactionReconciliation.transactionId,
        schema.transactions.id,
      ),
    )
    .innerJoin(
      schema.transactionPostingLinks,
      eq(schema.transactionPostingLinks.transactionId, schema.transactions.id),
    )
    .leftJoin(
      schema.annotations,
      eq(schema.annotations.transactionId, schema.transactions.id),
    )
    .$dynamic();
}

const decodedRows = async (query: ReturnType<typeof joinedTransactions>) =>
  (await query).map((input) => ({
    row: decodeTransaction(input),
    annotation: input.annotation,
  }));

export const transaction = async (db: Executor, id: string) =>
  (
    await decodedRows(
      joinedTransactions(db).where(eq(schema.transactions.id, id)),
    )
  ).map(({ row }) => row);

export const transactionWithAnnotation = (db: Executor, id: string) =>
  decodedRows(joinedTransactions(db).where(eq(schema.transactions.id, id)));

const pageCondition = (input: TransactionQuery) =>
  and(
    transactionFilter(schema.transactions, input, schema.cards),
    transactionSeek(schema.transactions, input.after),
  );

export function transactionPage(db: Executor, input: TransactionQuery) {
  const query = joinedTransactions(db)
    .where(pageCondition(input))
    .orderBy(...transactionOrder(schema.transactions));
  return decodedRows(
    input.limit === undefined ? query : query.limit(input.limit),
  );
}

/** List pages read only what `TransactionListFacts` presents. */
export function transactionListQuery(db: Executor, input: TransactionQuery) {
  const query = db
    .select({
      row: listColumns(schema.transactions),
      reconciliation: {
        pendingPostingCandidates:
          schema.transactionReconciliation.pendingPostingCandidates,
      },
      annotation: schema.annotations,
    })
    .from(schema.transactions)
    .innerJoin(
      schema.transactionReconciliation,
      eq(
        schema.transactionReconciliation.transactionId,
        schema.transactions.id,
      ),
    )
    .leftJoin(
      schema.annotations,
      eq(schema.annotations.transactionId, schema.transactions.id),
    )
    .where(pageCondition(input))
    .orderBy(...transactionOrder(schema.transactions))
    .$dynamic();
  return input.limit === undefined ? query : query.limit(input.limit);
}

export const transactionListPage = async (
  db: Executor,
  input: TransactionQuery,
) =>
  (await transactionListQuery(db, input)).map((listed) => ({
    row: decodeTransactionListFacts(listed),
    annotation: listed.annotation,
  }));

export const totals = (db: Executor, input: TransactionQuery) =>
  db
    .select(totalsColumns(schema.transactions))
    .from(schema.transactions)
    .where(transactionFilter(schema.transactions, input, schema.cards));
export const events = (db: Executor, input: EventQuery) =>
  db
    .select()
    .from(schema.events)
    .where(eventFilter(schema.events, input))
    .orderBy(asc(schema.events.id))
    .limit(input.limit);

export const transactionCount = (db: Executor, connectionId: string) =>
  db
    .select({ count: count() })
    .from(schema.transactions)
    .where(eq(schema.transactions.connectionId, connectionId));

export function latestEvent(db: Executor, connectionId?: string) {
  const query = db.select({ id: max(schema.events.id) }).from(schema.events);
  return connectionId === undefined
    ? query
    : query.where(eq(schema.events.connectionId, connectionId));
}

export const event = (db: Executor, id: number) =>
  db.select().from(schema.events).where(eq(schema.events.id, id));

function joinedRuns(db: Executor) {
  return db
    .select({
      run: runColumns,
      body: schema.syncRunBodies,
      connection: schema.connections,
    })
    .from(schema.syncRuns)
    .innerJoin(
      schema.connections,
      eq(schema.syncRuns.connectionId, schema.connections.id),
    )
    .leftJoin(
      schema.syncRunBodies,
      eq(schema.syncRunBodies.runId, schema.syncRuns.id),
    );
}

function decodeRun(input: Awaited<ReturnType<typeof joinedRuns>>[number]) {
  return {
    ...input.run,
    snapshot: input.body?.snapshot ?? {
      ...input.run.snapshot,
      responses: input.run.snapshot.responses.map((response) => ({
        ...response,
        responseText: "",
      })),
    },
    bodyAvailable: input.body !== null,
    bodyRetention: input.body?.retention ?? null,
    bodyExpiresAt: input.body?.expiresAt ?? null,
  };
}

export const run = async (db: Executor, id: string) =>
  (await joinedRuns(db).where(eq(schema.syncRuns.id, id))).map(decodeRun);
export const runWithConnection = async (db: Executor, id: string) =>
  (await joinedRuns(db).where(eq(schema.syncRuns.id, id))).map((input) => ({
    run: decodeRun(input),
    connection: input.connection,
  }));
export const runState = (db: Executor, id: string) =>
  db
    .select({
      appliedAt: schema.syncRuns.appliedAt,
      evidenceDigest: schema.syncRuns.evidenceDigest,
      status: schema.syncRuns.status,
      warnings: schema.syncRuns.warnings,
    })
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.id, id));
export const pendingRuns = (db: Executor, id: string, limit: number) =>
  db
    .select({
      id: schema.syncRuns.id,
      parserVersion: schema.syncRuns.parserVersion,
      refreshId: schema.syncRuns.refreshId,
    })
    .from(schema.syncRuns)
    .where(
      and(
        eq(schema.syncRuns.connectionId, id),
        isNull(schema.syncRuns.appliedAt),
      ),
    )
    .orderBy(asc(schema.syncRuns.startedAt), asc(schema.syncRuns.id))
    .limit(limit);
export const syncRuns = (db: Executor, id: string, page: SyncRunPageInput) =>
  db
    .select({
      id: schema.syncRuns.id,
      connectionId: schema.syncRuns.connectionId,
      startedAt: schema.syncRuns.startedAt,
      completedAt: schema.syncRuns.completedAt,
      status: schema.syncRuns.status,
      appliedAt: schema.syncRuns.appliedAt,
      collectorVersion: schema.syncRuns.collectorVersion,
      parserVersion: schema.syncRuns.parserVersion,
      refreshId: schema.syncRuns.refreshId,
    })
    .from(schema.syncRuns)
    .where(
      and(
        eq(schema.syncRuns.connectionId, id),
        keysetSeek(
          schema.syncRuns.startedAt,
          schema.syncRuns.id,
          page.after && { time: page.after.startedAt, id: page.after.id },
          "desc",
        ),
      ),
    )
    .orderBy(desc(schema.syncRuns.startedAt), desc(schema.syncRuns.id))
    .limit(page.limit);
export const planRows = (db: Executor, id: string, scope?: PlanScope) =>
  decodedRows(
    joinedTransactions(db)
      .where(planCondition(schema.transactions, id, scope))
      .orderBy(asc(sql`transactions.rowid`)),
  );
const priorRunColumns = {
  id: schema.syncRuns.id,
  status: schema.syncRuns.status,
  startedAt: schema.syncRuns.startedAt,
  coverage: schema.syncRuns.coverage,
  snapshot: schema.syncRuns.snapshot,
};
const applied = (id: string) =>
  and(
    eq(schema.syncRuns.connectionId, id),
    isNotNull(schema.syncRuns.appliedAt),
  );
export const priorRuns = (db: Executor, id: string) =>
  db
    .select(priorRunColumns)
    .from(schema.syncRuns)
    .where(applied(id))
    .orderBy(asc(schema.syncRuns.appliedAt), asc(sql`sync_runs.rowid`));
export const runHistory = (db: Executor, id: string) =>
  db
    .select({
      ...priorRunColumns,
      appliedAt: sql<string>`${schema.syncRuns.appliedAt}`,
      ingestionOrder: sql<number>`sync_runs.rowid`,
      // The window counts every applied run before the limit applies.
      appliedRuns: sql<number>`count(*) over ()`.mapWith(Number),
      document: schema.syncRunHistory.document,
    })
    .from(schema.syncRuns)
    .leftJoin(
      schema.syncRunHistory,
      eq(schema.syncRunHistory.connectionId, schema.syncRuns.connectionId),
    )
    .where(applied(id))
    .orderBy(desc(schema.syncRuns.appliedAt), desc(sql`sync_runs.rowid`))
    .limit(1);
export const runsById = (db: Executor, id: string, ids: string[]) =>
  db
    .select({
      ...priorRunColumns,
      appliedAt: schema.syncRuns.appliedAt,
      ingestionOrder: sql<number>`sync_runs.rowid`,
    })
    .from(schema.syncRuns)
    .where(
      and(
        eq(schema.syncRuns.connectionId, id),
        inArray(schema.syncRuns.id, ids),
      ),
    );
export const saveRunHistory = (
  db: Executor,
  id: string,
  document: RunHistoryDocument,
) =>
  db
    .insert(schema.syncRunHistory)
    .values({ connectionId: id, document })
    .onConflictDoUpdate({
      target: schema.syncRunHistory.connectionId,
      set: { document },
    });
export const removals = (db: Executor, id: string) =>
  db
    .select({
      transactionId: schema.events.transactionId,
      createdAt: schema.events.createdAt,
    })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.connectionId, id),
        eq(schema.events.type, "transaction.removed"),
      ),
    )
    .orderBy(desc(schema.events.id));
export const insertConnection = (db: Executor, row: Connection) =>
  db
    .insert(schema.connections)
    .values(row)
    .onConflictDoNothing({ target: schema.connections.id })
    .returning();
export const insertRun = (db: Executor, row: RetainedRun) =>
  db
    .insert(schema.syncRuns)
    .values({
      ...row,
      snapshot: {
        schemaVersion: 1,
        responses: row.snapshot.responses.map(
          ({ responseText: _responseText, ...metadata }) => metadata,
        ),
        failures: row.snapshot.failures,
      },
    })
    .onConflictDoNothing({ target: schema.syncRuns.id })
    .returning({ id: schema.syncRuns.id });
export const upsertDeferredEvidence = (
  db: Executor,
  row: DeferredEvidenceWrite,
) =>
  db
    .insert(schema.deferredEvidence)
    .values(row)
    .onConflictDoUpdate({
      target: schema.deferredEvidence.id,
      set: { lastSeenRunId: row.lastSeenRunId },
    });
export const insertRunBody = (db: Executor, row: RetainedRun) =>
  db.insert(schema.syncRunBodies).values({
    runId: row.id,
    snapshot: row.snapshot,
    retention: "staged",
    expiresAt: row.bodyExpiresAt,
  });

export function* finishRunEvidence(
  db: Executor,
  id: string,
  keepUntil: string | null,
) {
  if (keepUntil === null) {
    yield db
      .delete(schema.syncRunBodies)
      .where(
        and(
          eq(schema.syncRunBodies.runId, id),
          eq(schema.syncRunBodies.retention, "staged"),
        ),
      );
  } else {
    yield db
      .update(schema.syncRunBodies)
      .set({ retention: "debug", expiresAt: keepUntil })
      .where(
        and(
          eq(schema.syncRunBodies.runId, id),
          eq(schema.syncRunBodies.retention, "staged"),
        ),
      );
  }
}

export const pruneDebugBodies = (db: Executor, now: string) =>
  db
    .delete(schema.syncRunBodies)
    .where(
      and(
        eq(schema.syncRunBodies.retention, "debug"),
        sql`${schema.syncRunBodies.expiresAt} <= ${now}`,
      ),
    );
export const setConfig = (db: Executor, id: string, config: ConnectionConfig) =>
  db
    .update(schema.connections)
    .set({ config })
    .where(eq(schema.connections.id, id));

const refreshTable = schema.refreshes;
const windowTable = schema.refreshWindows;
const active = inArray(refreshTable.status, ["pending", "running"]);
const executed = inArray(refreshTable.status, [
  "completed",
  "partial",
  "failed",
]);

export const insertRefresh = (
  db: Executor,
  row: typeof refreshTable.$inferInsert,
) => db.insert(refreshTable).values(row);
/** Five parameters a row keeps every insert within D1's 100. */
export const insertRefreshWindows = (
  db: Executor,
  rows: (typeof windowTable.$inferInsert)[],
) => [...chunks(rows, 20)].map((chunk) => db.insert(windowTable).values(chunk));
export const refresh = (db: Executor, id: string) =>
  db.select().from(refreshTable).where(eq(refreshTable.id, id));
export const refreshWindows = (db: Executor, id: string) =>
  db
    .select()
    .from(windowTable)
    .where(eq(windowTable.refreshId, id))
    .orderBy(desc(windowTable.rangeFrom));
export const refreshPage = (
  db: Executor,
  connectionId: string,
  page: RefreshPageInput,
) =>
  db
    .select()
    .from(refreshTable)
    .where(
      and(
        eq(refreshTable.connectionId, connectionId),
        keysetSeek(
          refreshTable.createdAt,
          refreshTable.id,
          page.after && { time: page.after.createdAt, id: page.after.id },
          "desc",
        ),
      ),
    )
    .orderBy(desc(refreshTable.createdAt), desc(refreshTable.id))
    .limit(page.limit);
export const lastExecutedRefresh = (db: Executor, connectionId: string) =>
  db
    .select()
    .from(refreshTable)
    .where(and(eq(refreshTable.connectionId, connectionId), executed))
    .orderBy(desc(refreshTable.finishedAt), desc(refreshTable.id))
    .limit(1);
export const activeRefresh = (db: Executor, connectionId: string) =>
  db
    .select()
    .from(refreshTable)
    .where(and(eq(refreshTable.connectionId, connectionId), active));
export const activeRefreshes = (db: Executor) =>
  db
    .select()
    .from(refreshTable)
    .where(active)
    .orderBy(asc(refreshTable.createdAt), asc(refreshTable.id));
export const occurrenceRefresh = (
  db: Executor,
  connectionId: string,
  occurrence: string,
) =>
  db
    .select()
    .from(refreshTable)
    .where(
      and(
        eq(refreshTable.connectionId, connectionId),
        eq(refreshTable.occurrence, occurrence),
      ),
    );
export const updateRefresh = (
  db: Executor,
  id: string,
  set: Partial<typeof refreshTable.$inferInsert>,
) => db.update(refreshTable).set(set).where(eq(refreshTable.id, id));
export const updateRefreshWindow = (
  db: Executor,
  id: string,
  from: string,
  status: (typeof windowTable.$inferInsert)["status"],
) =>
  db
    .update(windowTable)
    .set({ status })
    .where(and(eq(windowTable.refreshId, id), eq(windowTable.rangeFrom, from)));

export const markRefreshWindowAccepted = (
  db: Executor,
  id: string,
  from: string,
) =>
  db
    .update(windowTable)
    .set({ hasAcceptedEvidence: true })
    .where(and(eq(windowTable.refreshId, id), eq(windowTable.rangeFrom, from)));

export const latestOccurrence = (db: Executor) =>
  db
    .select({ scheduledAt: max(schema.scheduledCollections.scheduledAt) })
    .from(schema.scheduledCollections);
/** Inserts a new claim, or retakes a running one whose lease has passed. */
export const claimOccurrence = (
  db: Executor,
  row: typeof schema.scheduledCollections.$inferInsert,
  now: string,
) =>
  db
    .insert(schema.scheduledCollections)
    .values(row)
    .onConflictDoUpdate({
      target: schema.scheduledCollections.occurrence,
      set: { leaseUntil: row.leaseUntil },
      // and() of two conditions is never undefined.
      setWhere: and(
        eq(schema.scheduledCollections.status, "running"),
        lt(schema.scheduledCollections.leaseUntil, now),
      )!,
    })
    .returning({ occurrence: schema.scheduledCollections.occurrence });
/** Both updates apply only while `claim`, the holder's lease, still holds it. */
const heldBy = (occurrence: string, claim: string) =>
  and(
    eq(schema.scheduledCollections.occurrence, occurrence),
    eq(schema.scheduledCollections.status, "running"),
    eq(schema.scheduledCollections.leaseUntil, claim),
  );
export const finishOccurrence = (
  db: Executor,
  occurrence: string,
  claim: string,
) =>
  db
    .update(schema.scheduledCollections)
    .set({ status: "finished" })
    .where(heldBy(occurrence, claim));
export const releaseOccurrence = (
  db: Executor,
  occurrence: string,
  claim: string,
  leaseUntil: string,
) =>
  db
    .update(schema.scheduledCollections)
    .set({ leaseUntil })
    .where(heldBy(occurrence, claim));
export const pruneOccurrences = (db: Executor, before: string) =>
  db
    .delete(schema.scheduledCollections)
    .where(lt(schema.scheduledCollections.scheduledAt, before));
export const setting = (db: Executor, name: string) =>
  db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.name, name));
export const insertSetting = (db: Executor, name: string, value: string) =>
  db
    .insert(schema.settings)
    .values({ name, value })
    .onConflictDoNothing({ target: schema.settings.name });
// Lease times come from the database clock, so processes and hosts sharing one
// database agree on expiry without trusting each other's clocks.
const leases = schema.collectionLeases;
const databaseNow = sql<number>`cast((julianday('now') - 2440587.5) * 86400000 as integer)`;

/** Takes a free or expired lease in one statement; returns a row only if taken. */
export const acquireLease = (
  db: Executor,
  connectionId: string,
  holder: string,
  durationMs: number,
) =>
  db
    .insert(leases)
    .values({
      connectionId,
      holder,
      expiresAt: sql`${databaseNow} + ${durationMs}`,
    })
    .onConflictDoUpdate({
      target: leases.connectionId,
      set: { holder, expiresAt: sql`${databaseNow} + ${durationMs}` },
      setWhere: sql`${leases.expiresAt} <= ${databaseNow}`,
    })
    .returning({ holder: leases.holder });
/** Extends a lease its holder still has; returns no row once it is lost. */
export const renewLease = (
  db: Executor,
  connectionId: string,
  holder: string,
  durationMs: number,
) =>
  db
    .update(leases)
    .set({ expiresAt: sql`${databaseNow} + ${durationMs}` })
    .where(
      and(
        eq(leases.connectionId, connectionId),
        eq(leases.holder, holder),
        sql`${leases.expiresAt} > ${databaseNow}`,
      ),
    )
    .returning({ holder: leases.holder });
/** Expires the lease now. The row stays, so a late fenced write still fails. */
export const releaseLease = (
  db: Executor,
  connectionId: string,
  holder: string,
) =>
  db
    .update(leases)
    .set({ expiresAt: 0 })
    .where(
      and(eq(leases.connectionId, connectionId), eq(leases.holder, holder)),
    );
/**
 * Leads every write of a leased collection, inside its transaction or batch:
 * a lease that expired or passed to another holder token makes the CHECK
 * fail. It returns the guarded row, so a missing row can fail the commit too.
 */
export const fenceLease = (
  db: Executor,
  connectionId: string,
  holder: string,
) =>
  db
    .update(leases)
    .set({
      expiresAt: sql`case when ${leases.holder} = ${holder} and ${leases.expiresAt} > ${databaseNow} then ${leases.expiresAt} else -1 end`,
    })
    .where(eq(leases.connectionId, connectionId))
    .returning({ holder: leases.holder });

// A row never changes connection. Leaving its connection out of each update set
// also spares SQLite the child-key scans that a parent key change requires.
const accountUpdates = excludedSet(schema.accounts, ["id", "connectionId"]);
const cardUpdates = excludedSet(schema.cards, ["id", "connectionId"]);
const transactionUpdates = excludedSet(schema.transactions, [
  "id",
  "connectionId",
]);
const annotationUpdates = excludedSet(schema.annotations, ["transactionId"]);
const transactionChanged = sql.join(
  Object.entries(getTableColumns(schema.transactions))
    .filter(([key]) => Object.hasOwn(transactionUpdates, key))
    .map(
      ([, column]) =>
        sql`${column} IS NOT excluded.${sql.identifier(column.name)}`,
    ),
  sql` OR `,
);
const observationUpdates = excludedSet(schema.transactionObservations, [
  "transactionId",
]);
const reconciliationUpdates = excludedSet(schema.transactionReconciliation, [
  "transactionId",
]);
const postingUpdates = excludedSet(schema.transactionPostingLinks, [
  "transactionId",
]);

/** Multi-row inserts stay within the driver's bound-parameter limit. */
function rowsPerInsert(table: Table, rows: number, maxParameters: number) {
  const columns = Object.keys(getTableColumns(table)).length;
  return Math.max(1, Math.min(rows, Math.floor(maxParameters / columns)));
}

export function* applyPlan(
  db: Executor,
  plan: FinancialPlan,
  runId?: string,
  maxParameters = Infinity,
) {
  if (plan.runUpdate && !runId) {
    throw new Error("Run update requires a run ID");
  }
  // Catalog rows precede the transactions that reference them.
  for (const rows of chunks(
    [...plan.accountWrites.values()],
    rowsPerInsert(schema.accounts, 100, maxParameters),
  )) {
    yield db.insert(schema.accounts).values(rows).onConflictDoUpdate({
      target: schema.accounts.id,
      set: accountUpdates,
    });
  }
  for (const rows of chunks(
    [...plan.cardWrites.values()],
    rowsPerInsert(schema.cards, 100, maxParameters),
  )) {
    yield db.insert(schema.cards).values(rows).onConflictDoUpdate({
      target: schema.cards.id,
      set: cardUpdates,
    });
  }
  for (const rows of chunks(
    transactionContentWrites(plan),
    rowsPerInsert(schema.transactions, 25, maxParameters),
  )) {
    yield db.insert(schema.transactions).values(rows).onConflictDoUpdate({
      target: schema.transactions.id,
      set: transactionUpdates,
      setWhere: transactionChanged,
    });
  }
  const transactionRows = plan.orderedTransactionWrites();
  const observations = new Map(transactionRows.map((row) => [row.id, row]));
  for (const [id, row] of plan.observationWrites) {
    observations.set(id, row);
  }
  for (const rows of chunks(
    [...observations.values()].map(encodeObservation),
    rowsPerInsert(schema.transactionObservations, 100, maxParameters),
  )) {
    yield db
      .insert(schema.transactionObservations)
      .values(rows)
      .onConflictDoUpdate({
        target: schema.transactionObservations.transactionId,
        set: observationUpdates,
      });
  }
  for (const rows of chunks(
    transactionRows.map(encodeReconciliation),
    rowsPerInsert(schema.transactionReconciliation, 100, maxParameters),
  )) {
    yield db
      .insert(schema.transactionReconciliation)
      .values(rows)
      .onConflictDoUpdate({
        target: schema.transactionReconciliation.transactionId,
        set: reconciliationUpdates,
      });
  }
  for (const rows of chunks(
    transactionRows.map((row) => ({
      transactionId: row.id,
      postingLink: row.details.postingLink ?? null,
    })),
    rowsPerInsert(schema.transactionPostingLinks, 100, maxParameters),
  )) {
    yield db
      .insert(schema.transactionPostingLinks)
      .values(rows)
      .onConflictDoUpdate({
        target: schema.transactionPostingLinks.transactionId,
        set: postingUpdates,
      });
  }
  for (const rows of chunks(
    [...plan.annotationWrites.values()],
    rowsPerInsert(schema.annotations, 100, maxParameters),
  )) {
    yield db.insert(schema.annotations).values(rows).onConflictDoUpdate({
      target: schema.annotations.transactionId,
      set: annotationUpdates,
    });
  }
  for (const rows of chunks(
    plan.events,
    rowsPerInsert(schema.events, 100, maxParameters),
  )) {
    yield db.insert(schema.events).values(rows);
  }
  if (plan.runUpdate && runId) {
    yield db
      .update(schema.syncRuns)
      .set(plan.runUpdate)
      .where(eq(schema.syncRuns.id, runId));
  }
}
