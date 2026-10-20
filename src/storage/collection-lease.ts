import type {
  CollectionLockAttempt,
  LockedCollectionStore,
} from "../application/collection-lock.js";

/** How long a lease lasts without renewal; its holder renews it four times as often. */
export const COLLECTION_LEASE_MS = 60_000;

export interface CollectionLeaseOptions {
  /** Overrides COLLECTION_LEASE_MS, for example to exercise expiry in tests. */
  leaseMs?: number;
}

/** Waits for `work` at most `ms`, ignoring its outcome. */
async function settledWithin(work: Promise<unknown>, ms: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.catch(() => {}),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timeout);
}

/** One connection's lease rows; each is a single statement outside transactions. */
export interface LeaseDatabase {
  /** Takes a free or expired lease; true only if `holder` now has it. */
  acquire(holder: string, leaseMs: number): Promise<boolean>;
  /** Extends a lease `holder` still has; false once it is lost. */
  renew(holder: string, leaseMs: number): Promise<boolean>;
  /** Expires the lease if `holder` still has it. */
  release(holder: string): Promise<void>;
  /** A store whose every commit is led by this holder token's fence. */
  lockedStore(holder: string, signal: AbortSignal): LockedCollectionStore;
}

/**
 * The collection lock on every backend: a `collection_leases` row whose holder
 * is a fresh random token per acquisition, with an expiry on the database
 * clock. Acquisition is one atomic upsert that only takes a free or expired
 * lease. The holder renews it while the work runs, aborts the work
 * when renewal finds it lost or has not confirmed it in time, and expires it
 * on completion. A holder that crashes leaves a lease the next
 * collector takes over once it expires. Every write the work makes is fenced,
 * so a holder that lost its lease cannot write after its successor started.
 */
export async function withCollectionLease<T>(
  database: LeaseDatabase,
  work: (store: LockedCollectionStore, signal: AbortSignal) => Promise<T>,
  options: CollectionLeaseOptions = {},
): Promise<CollectionLockAttempt<T>> {
  const leaseMs = options.leaseMs ?? COLLECTION_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 4) {
    throw new Error("Invalid collection lease duration");
  }
  // Conservative: a lease starts no earlier than the request that took it.
  let confirmedAt = performance.now();
  const holder = crypto.randomUUID();
  if (!(await database.acquire(holder, leaseMs))) {
    return { acquired: false };
  }
  const controller = new AbortController();
  const renewEveryMs = Math.floor(leaseMs / 4);
  let renewal: Promise<void> | undefined;
  const timer = setInterval(() => {
    // The work stops a renewal interval before the last confirmed lease could
    // lapse, even while a renewal is stalled in a busy or unreachable database.
    if (performance.now() - confirmedAt >= leaseMs - renewEveryMs) {
      controller.abort();
    }
    if (renewal || controller.signal.aborted) {
      return;
    }
    const startedAt = performance.now();
    renewal = (async () => {
      try {
        if (await database.renew(holder, leaseMs)) {
          confirmedAt = startedAt;
        } else {
          controller.abort();
        }
      } catch {
        // Retried on the next tick; the deadline above still applies.
      } finally {
        renewal = undefined;
      }
    })();
  }, renewEveryMs);
  try {
    return {
      acquired: true,
      result: await work(
        database.lockedStore(holder, controller.signal),
        controller.signal,
      ),
    };
  } finally {
    clearInterval(timer);
    // A stalled database must not hold the caller: an unreleased lease
    // expires, and its fence already stops late writes.
    await settledWithin(
      (async () => {
        await renewal;
        await database.release(holder);
      })(),
      leaseMs,
    );
  }
}
