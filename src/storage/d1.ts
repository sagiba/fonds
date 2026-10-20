import type { D1Database } from "@cloudflare/workers-types";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";

import type { LockedCollectionStore } from "../application/collection-lock.js";
import { ConflictError } from "../domain/errors.js";
import type { Connection } from "../domain/records.js";
import {
  type CollectionLeaseOptions,
  withCollectionLease,
} from "./collection-lease.js";
import * as d1 from "./sqlite/d1-statements.js";
import { createSqliteEventStore } from "./sqlite/events.js";
import * as schema from "./sqlite/schema.js";
import * as sqlite from "./sqlite/statements.js";
import {
  createStore,
  lockedCollectionStore,
  type StoreDatabase,
  type WriteResults,
} from "./store.js";

function revisionOf(connection: Connection) {
  if (!("revision" in connection) || typeof connection.revision !== "number") {
    throw new Error("D1 writes require a connection read by lockConnection");
  }
  return connection.revision;
}

function isRevisionConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("CHECK constraint failed: connection_revision") ||
      isRevisionConflict(error.cause))
  );
}

/**
 * D1 has no interactive transactions. A store transaction reads directly, then sends
 * its writes as one atomic batch led by a connection revision guard. A concurrent
 * writer fails the batch with ConflictError instead of being silently overwritten.
 */
export function openD1Database(binding: D1Database) {
  const orm = drizzle(binding, { schema });

  async function commit<const Writes extends readonly PromiseLike<unknown>[]>(
    connection: Connection,
    writes: Writes,
  ): Promise<WriteResults<Writes>> {
    const guard = d1.guardRevision(orm, connection.id, revisionOf(connection));
    try {
      // The shared statements are unexecuted Drizzle builders, which D1 batches.
      const [, ...results] = await orm.batch([
        guard,
        ...(writes as readonly unknown[] as BatchItem<"sqlite">[]),
      ]);
      return results as WriteResults<Writes>;
    } catch (error) {
      if (isRevisionConflict(error)) {
        throw new ConflictError(
          "Financial data changed concurrently; retry the operation",
          { cause: error },
        );
      }
      throw error;
    }
  }

  const database: StoreDatabase<sqlite.Executor> = {
    backend: "d1",
    identity: binding,
    root: orm,
    execute: async (statement) => statement,
    transaction: (work) => work(orm),
    commit,
  };
  const statements = {
    ...sqlite,
    lockConnection: d1.lockConnection,
    lockConnectionOf: d1.lockConnectionOf,
    applyPlan: d1.applyPlan,
  };

  const query = async (sql: string, args: (string | number | null)[]) =>
    (
      await binding
        .prepare(sql)
        .bind(...args)
        .all<Record<string, unknown>>()
    ).results;

  /** The SQLite lease; its fence joins each guarded write batch. */
  function withCollectionLock<T>(
    connectionId: string,
    work: (store: LockedCollectionStore, signal: AbortSignal) => Promise<T>,
    options?: CollectionLeaseOptions,
  ) {
    return withCollectionLease(
      {
        acquire: async (holder, leaseMs) =>
          (
            await database.execute(
              sqlite.acquireLease(orm, connectionId, holder, leaseMs),
            )
          )[0]?.holder === holder,
        renew: async (holder, leaseMs) =>
          (
            await database.execute(
              sqlite.renewLease(orm, connectionId, holder, leaseMs),
            )
          )[0]?.holder === holder,
        release: async (holder) => {
          await database.execute(
            sqlite.releaseLease(orm, connectionId, holder),
          );
        },
        lockedStore: (holder, signal) =>
          lockedCollectionStore(
            {
              ...database,
              // Collections of other connections may run beside this one.
              identity: { holder },
              transaction: (change) => {
                signal.throwIfAborted();
                return change(orm);
              },
              fence: (tx) => sqlite.fenceLease(tx, connectionId, holder),
            },
            statements,
            connectionId,
            signal,
          ),
      },
      work,
      options,
    );
  }

  const store = createStore(database, statements);
  return {
    ...store,
    withCollectionLock,
    /** Events subscription state for webhook delivery. */
    eventSubscriptions: createSqliteEventStore(query, store),
  };
}
