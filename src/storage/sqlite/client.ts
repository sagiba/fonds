import type { Client, InValue } from "@libsql/client/web";
import type { LibSQLDatabase } from "drizzle-orm/libsql/driver-core";

import type { LockedCollectionStore } from "../../application/collection-lock.js";
import {
  type CollectionLeaseOptions,
  withCollectionLease,
} from "../collection-lease.js";
import {
  createStore,
  lockedCollectionStore,
  type StoreDatabase,
  type StoreOptions,
} from "../store.js";
import { createSqliteCredentialStore } from "./credentials.js";
import { createSqliteEventStore } from "./events.js";
import type * as schema from "./schema.js";
import * as statements from "./statements.js";

export function storeForDatabase(
  orm: LibSQLDatabase<typeof schema>,
  client: Client,
  backend: "sqlite" | "turso",
  schedule: <T>(work: () => Promise<T>) => Promise<T> = (work) => work(),
  options: StoreOptions = {},
) {
  const database: StoreDatabase<statements.Executor> = {
    backend,
    identity: client,
    root: orm,
    execute: (statement) => schedule(async () => statement),
    transaction: (work) => schedule(() => orm.transaction(work)),
  };
  const store = createStore(database, statements, options);
  const execute = (sql: string, args: InValue[]) =>
    schedule(() => client.execute({ sql, args }));
  const query = async (sql: string, args: InValue[]) =>
    (await execute(sql, args)).rows as unknown as Record<string, unknown>[];

  /** A lease in the database, so separate processes and hosts serialize too. */
  function withCollectionLock<T>(
    connectionId: string,
    work: (store: LockedCollectionStore, signal: AbortSignal) => Promise<T>,
    leaseOptions?: CollectionLeaseOptions,
  ) {
    return withCollectionLease(
      {
        acquire: async (holder, leaseMs) =>
          (
            await database.execute(
              statements.acquireLease(orm, connectionId, holder, leaseMs),
            )
          )[0]?.holder === holder,
        renew: async (holder, leaseMs) =>
          (
            await database.execute(
              statements.renewLease(orm, connectionId, holder, leaseMs),
            )
          )[0]?.holder === holder,
        release: async (holder) => {
          await database.execute(
            statements.releaseLease(orm, connectionId, holder),
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
                return database.transaction(change);
              },
              fence: (tx) => statements.fenceLease(tx, connectionId, holder),
            },
            statements,
            connectionId,
            signal,
            options,
          ),
      },
      work,
      leaseOptions,
    );
  }

  return {
    ...store,
    orm,
    client,
    withCollectionLock,
    /** Encrypted provider credentials; their key never enters the database. */
    credentials: createSqliteCredentialStore(execute),
    /** Events subscription state for webhook delivery. */
    eventSubscriptions: createSqliteEventStore(query, store),
    close: async () => client.close(),
  };
}
