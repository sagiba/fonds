import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import type { LockedCollectionStore } from "../../application/collection-lock.js";
import {
  type CollectionLeaseOptions,
  withCollectionLease,
} from "../collection-lease.js";
import {
  createStore,
  lockedCollectionStore,
  type StoreDatabase,
} from "../store.js";
import * as schema from "./schema.js";
import * as statements from "./statements.js";

export {
  ensurePostgresSchema,
  FINANCIAL_SCHEMA,
  initializePostgresDatabase,
} from "./initialize.js";

function postgresDatabase(
  orm: NodePgDatabase<typeof schema>,
  identity: object,
  beforeTransaction?: () => void,
): StoreDatabase<statements.Executor> {
  return {
    backend: "postgres",
    identity,
    root: orm,
    execute: async (statement) => statement,
    transaction: (work) => {
      beforeTransaction?.();
      return orm.transaction((tx) => work(tx), {
        isolationLevel: "read committed",
      });
    },
  };
}

/** The returned store owns its pool lifetime; close() also ends a supplied Pool. */
export function openPostgresDatabase(config: PoolConfig | Pool) {
  const pool = config instanceof Pool ? config : new Pool(config);
  // pg removes failed idle clients before emitting this event. Active operations still
  // reject normally; never let an idle driver's raw error crash or enter service logs.
  if (pool.listenerCount("error") === 0) {
    pool.on("error", () => console.error("PostgreSQL idle connection failed."));
  }
  const orm = drizzle(pool, { schema });

  const database = postgresDatabase(orm, orm);

  /** The same renewed, token-fenced lease as SQLite: no session is held while a provider is called. */
  function withCollectionLock<T>(
    connectionId: string,
    work: (store: LockedCollectionStore, signal: AbortSignal) => Promise<T>,
    options?: CollectionLeaseOptions,
  ) {
    return withCollectionLease(
      {
        acquire: async (holder, leaseMs) =>
          (await statements.acquireLease(orm, connectionId, holder, leaseMs))[0]
            ?.holder === holder,
        renew: async (holder, leaseMs) =>
          (await statements.renewLease(orm, connectionId, holder, leaseMs))[0]
            ?.holder === holder,
        release: async (holder) => {
          await statements.releaseLease(orm, connectionId, holder);
        },
        lockedStore: (holder, signal) =>
          lockedCollectionStore(
            {
              ...postgresDatabase(orm, { holder }, () =>
                signal.throwIfAborted(),
              ),
              fence: (tx) => statements.fenceLease(tx, connectionId, holder),
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

  return {
    ...createStore(database, statements),
    orm,
    pool,
    withCollectionLock,
    close: () => pool.end(),
  };
}
