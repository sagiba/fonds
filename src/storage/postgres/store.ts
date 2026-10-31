import { AsyncLocalStorage } from "node:async_hooks";

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
  FINANCIAL_SESSION_OPTIONS,
  initializePostgresDatabase,
} from "./initialize.js";

/**
 * Bytes the database has sent a transaction's connection since this call.
 * Drizzle keeps the transaction's checked-out pg client at `session.client`;
 * pg reads from `connection.stream`, which under `ssl` is the TLS socket, so
 * the count is decrypted protocol data, without TLS records or handshakes.
 * The reading is undefined when the driver exposes no such socket, and never
 * throws: a diagnostic must not change a transaction's outcome.
 */
export function bytesReadSince(tx: unknown): () => number | undefined {
  try {
    const stream = (
      tx as {
        session?: { client?: { connection?: { stream?: unknown } } };
      } | null
    )?.session?.client?.connection?.stream as { bytesRead?: unknown } | null;
    const start = stream?.bytesRead;
    if (typeof start !== "number") {
      return () => undefined;
    }
    return () => {
      try {
        const now = stream!.bytesRead;
        return typeof now === "number" && now >= start
          ? now - start
          : undefined;
      } catch {
        return undefined;
      }
    };
  } catch {
    return () => undefined;
  }
}

type BytesObserver = (bytesRead: number) => void;

/**
 * Attributes each transaction body's received bytes to the observer of the
 * async context that started it, once, whether the body returns or throws.
 */
export function transactionByteMeter() {
  const observers = new AsyncLocalStorage<BytesObserver>();
  const readings = new WeakMap<object, () => number | undefined>();
  return {
    run: <T>(work: () => Promise<T>, observe: BytesObserver) =>
      observers.run(observe, work),
    async measure<Tx extends object, T>(
      tx: Tx,
      work: (tx: Tx) => Promise<T>,
    ): Promise<T> {
      const reading = bytesReadSince(tx);
      readings.set(tx, reading);
      try {
        return await work(tx);
      } finally {
        // Read before the driver commits and releases the client to others.
        const bytesRead = reading();
        const observe = observers.getStore();
        if (observe && bytesRead !== undefined) {
          try {
            observe(bytesRead);
          } catch {
            // A failing observer never changes the transaction's result.
          }
        }
      }
    },
    bytesRead: (tx: object) => readings.get(tx)?.(),
  };
}

function postgresDatabase(
  orm: NodePgDatabase<typeof schema>,
  identity: object,
  meter: ReturnType<typeof transactionByteMeter>,
  beforeTransaction?: () => void,
): StoreDatabase<statements.Executor> {
  return {
    backend: "postgres",
    identity,
    root: orm,
    execute: async (statement) => statement,
    transaction: (work) => {
      beforeTransaction?.();
      return orm.transaction((tx) => meter.measure(tx, work), {
        isolationLevel: "read committed",
      });
    },
    bytesRead: meter.bytesRead,
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
  const meter = transactionByteMeter();

  const database = postgresDatabase(orm, orm, meter);

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
              ...postgresDatabase(orm, { holder }, meter, () =>
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
    /**
     * Runs work and tells `observe` the bytes the database sent each store
     * transaction it starts, BEGIN and COMMIT acknowledgements aside. Reads
     * outside a transaction share pooled clients the store never holds, so
     * they are not counted.
     */
    meterDbBytes: meter.run,
    close: () => pool.end(),
  };
}
