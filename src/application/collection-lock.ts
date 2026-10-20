import type { SyncResult } from "../domain/plans/sync.js";
import type { SourceAdapter } from "../domain/source-adapter.js";
import type { InternalStore } from "./financial-store.js";
import type { RefreshWriter } from "./refreshes.js";
import type { SyncDiagnosticSink } from "./sync-diagnostics.js";

/**
 * What a collection may do while it holds its connection's lock: read the
 * connection and its refresh, archive and apply captures, record discovery and
 * capture state, and record the refresh's progress. Every write is fenced by
 * the lock, so a holder that lost it cannot commit.
 */
export interface LockedCollectionStore
  extends
    Pick<
      InternalStore,
      | "identity"
      | "getConnection"
      | "getStoredConnection"
      | "getRefresh"
      | "ingestRun"
      | "applyRun"
      | "recordCardDiscovery"
      | "updateConfig"
      | "ledgerRevision"
    >,
    RefreshWriter {
  /** Replay at most 100 already archived captures before requesting new data. */
  recoverPendingRuns(
    adapter: SourceAdapter,
    onDiagnostic?: SyncDiagnosticSink,
  ): Promise<SyncResult[]>;
}

export type CollectionLockAttempt<T> =
  { acquired: false } | { acquired: true; result: T };

/**
 * Runs one connection's collection exclusively across every process that
 * shares the database. Work never waits for a held lock: the attempt reports
 * `acquired: false` instead. The signal aborts when the lock is lost, and from
 * then on the locked store's writes fail rather than land as stale writes.
 */
export interface CollectionLock {
  withCollectionLock<T>(
    connectionId: string,
    work: (store: LockedCollectionStore, signal: AbortSignal) => Promise<T>,
  ): Promise<CollectionLockAttempt<T>>;
}
