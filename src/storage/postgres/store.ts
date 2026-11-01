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
  type StoreOptions,
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
 * Bytes the database has sent a checked-out pg client since this call. pg
 * reads from `connection.stream`, which under `ssl` is the TLS socket, so the
 * count is decrypted protocol data, without TLS records or handshakes. The
 * reading is undefined when the driver exposes no such socket, and never
 * throws: a diagnostic must not change a query's outcome.
 */
function clientBytesReadSince(client: unknown): () => number | undefined {
  try {
    const stream = (
      client as { connection?: { stream?: unknown } } | null | undefined
    )?.connection?.stream as { bytesRead?: unknown } | null | undefined;
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

/**
 * Bytes the database has sent a transaction's connection since this call.
 * Drizzle keeps the transaction's checked-out pg client at `session.client`.
 */
export function bytesReadSince(tx: unknown): () => number | undefined {
  try {
    return clientBytesReadSince(
      (tx as { session?: { client?: unknown } } | null)?.session?.client,
    );
  } catch {
    return () => undefined;
  }
}

type BytesObserver = (bytesRead: number) => void;

/** One `run`: its observer and the metered work it has started. */
interface MeterContext {
  observe: BytesObserver;
  pending: Set<Promise<unknown>>;
  /** False once `run`'s work has settled and its readings are being drained. */
  open: boolean;
}

function report(observe: BytesObserver | undefined, bytesRead?: number) {
  if (observe && bytesRead !== undefined) {
    try {
      observe(bytesRead);
    } catch {
      // A failing observer never changes the query's result.
    }
  }
}

/**
 * Attributes the bytes the database sends to the observer of the async
 * context that issued the work, once each, whether it returns or throws:
 * each transaction body passed to `measure`, and each statement a pool
 * returned by `pool` runs outside a transaction.
 */
export function databaseByteMeter() {
  const contexts = new AsyncLocalStorage<MeterContext>();
  const readings = new WeakMap<object, () => number | undefined>();

  /** The context still collecting readings, if the caller is inside one. */
  function collecting() {
    const context = contexts.getStore();
    return context?.open ? context : undefined;
  }

  /** Keeps `run` from settling before `unit` has reported its readings. */
  function pending<T>(context: MeterContext, unit: Promise<T>) {
    context.pending.add(unit);
    const settled = () => context.pending.delete(unit);
    unit.then(settled, settled);
    return unit;
  }

  /**
   * Runs one statement on a client of its own, as `Pool.query` would, so its
   * bytes are read before the client can serve another context.
   */
  async function meteredQuery(
    pool: Pool,
    observe: BytesObserver,
    args: unknown[],
  ) {
    const client = await pool.connect();
    const reading = clientBytesReadSince(client);
    let failure: unknown;
    // As in `Pool.query`: a client error during the statement discards it.
    const onError = (error: Error) => {
      failure ??= error;
    };
    client.on("error", onError);
    try {
      return (await Reflect.apply(client.query, client, args)) as unknown;
    } catch (error) {
      failure ??= error;
      throw error;
    } finally {
      client.off("error", onError);
      report(observe, reading());
      client.release(
        failure instanceof Error ? failure : failure !== undefined,
      );
    }
  }

  return {
    /**
     * Runs work, telling `observe` the bytes of each transaction and
     * statement it starts, and settles only once every one of them started
     * before `work` settled has reported. A failing `work` therefore waits
     * for its statements still in flight, at most their duration, and keeps
     * its own error. Work started after `work` settles, such as a background
     * task it left running, is not metered.
     */
    async run<T>(work: () => Promise<T>, observe: BytesObserver): Promise<T> {
      const context: MeterContext = {
        observe,
        pending: new Set(),
        open: true,
      };
      try {
        // Awaited inside the context: a lazy thenable such as a Drizzle query
        // starts its statement only when awaited.
        return await contexts.run(context, async () => await work());
      } finally {
        context.open = false;
        await Promise.allSettled(context.pending);
      }
    },
    measure<Tx extends object, T>(
      tx: Tx,
      work: (tx: Tx) => Promise<T>,
    ): Promise<T> {
      const context = collecting();
      const reading = bytesReadSince(tx);
      readings.set(tx, reading);
      const unit = (async () => {
        try {
          return await work(tx);
        } finally {
          // Read before the driver commits and releases the client to others.
          report(context?.observe, reading());
        }
      })();
      return context ? pending(context, unit) : unit;
    },
    bytesRead: (tx: object) => readings.get(tx)?.(),
    /**
     * Starts a unit, such as a transaction, whose metered work may begin
     * only after `run`'s work has settled: `run` waits for the whole unit,
     * which stays metered throughout.
     */
    track<T>(start: () => Promise<T>): Promise<T> {
      const context = collecting();
      return context
        ? pending(
            context,
            contexts.run({ ...context, open: true }, async () => await start()),
          )
        : start();
    },
    /**
     * The same pool, metering its promise-form `query` calls made inside
     * `run`. A proxy, not a wrapper, so Drizzle still recognizes a pool and
     * checks out a client for each transaction.
     */
    pool: (pool: Pool): Pool =>
      new Proxy(pool, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (property === "query") {
            return (...args: unknown[]) => {
              const context = collecting();
              // Callback and submittable forms (such as cursors) stay unmetered.
              return context &&
                typeof args.at(-1) !== "function" &&
                typeof (args[0] as { submit?: unknown } | null)?.submit !==
                  "function"
                ? pending(context, meteredQuery(target, context.observe, args))
                : Reflect.apply(value as Pool["query"], target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
  };
}

function postgresDatabase(
  orm: NodePgDatabase<typeof schema>,
  identity: object,
  meter: ReturnType<typeof databaseByteMeter>,
  beforeTransaction?: () => void,
): StoreDatabase<statements.Executor> {
  return {
    backend: "postgres",
    identity,
    root: orm,
    execute: async (statement) => statement,
    transaction: (work) => {
      beforeTransaction?.();
      // Checkout and BEGIN precede the measured body.
      return meter.track(() =>
        orm.transaction((tx) => meter.measure(tx, work), {
          isolationLevel: "read committed",
        }),
      );
    },
    bytesRead: meter.bytesRead,
  };
}

/** The returned store owns its pool lifetime; close() also ends a supplied Pool. */
export function openPostgresDatabase(
  config: PoolConfig | Pool,
  options: StoreOptions = {},
) {
  const supplied = config instanceof Pool ? config : new Pool(config);
  // pg removes failed idle clients before emitting this event. Active operations still
  // reject normally; never let an idle driver's raw error crash or enter service logs.
  if (supplied.listenerCount("error") === 0) {
    supplied.on("error", () =>
      console.error("PostgreSQL idle connection failed."),
    );
  }
  const meter = databaseByteMeter();
  const pool = meter.pool(supplied);
  const orm = drizzle(pool, { schema });

  const database = postgresDatabase(orm, orm, meter);

  /** The same renewed, token-fenced lease as SQLite: no session is held while a provider is called. */
  function withCollectionLock<T>(
    connectionId: string,
    work: (store: LockedCollectionStore, signal: AbortSignal) => Promise<T>,
    leaseOptions?: CollectionLeaseOptions,
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
            options,
          ),
      },
      work,
      leaseOptions,
    );
  }

  return {
    ...createStore(database, statements, options),
    orm,
    pool,
    withCollectionLock,
    /**
     * Runs work and tells `observe` the bytes the database sent each
     * transaction it starts and each statement it runs outside one, through
     * this store or `pool`. Connection setup and BEGIN and COMMIT
     * acknowledgements are not counted.
     */
    meterDbBytes: meter.run,
    close: () => pool.end(),
  };
}
