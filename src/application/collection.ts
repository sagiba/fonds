import type { ReconciliationFailureCode } from "../domain/model.js";
import type {
  CollectionFailure,
  FinancialResponse,
} from "../domain/records.js";
import type {
  CollectionEvent,
  CollectionRange,
  ProviderCollector,
  SourceAdapter,
} from "../domain/source-adapter.js";
import type { InternalStore } from "./financial-store.js";
import {
  elapsedMs,
  syncDiagnostics,
  type SyncDiagnosticSink,
} from "./sync-diagnostics.js";

export type {
  CollectionEvent,
  CollectionRange,
  ProviderCollector,
} from "../domain/source-adapter.js";

export type CollectionStore = Pick<
  InternalStore,
  "identity" | "getConnection" | "ingestRun" | "recordCardDiscovery"
>;

export interface CollectionSummary {
  status: "completed" | "partial" | "failed";
  captures: number;
  /**
   * Explicit collection failures plus captures with extraction failures. A
   * partial run of several captures counts at least one failure.
   */
  failures: number;
  failureCodes?: ReconciliationFailureCode[];
  /** Transaction identities observed once per capture. */
  observed: number;
  unchangedTransactions: number;
  created: number;
  updated: number;
  unlisted: number;
  /** Successful captures of runs that caused no retained transaction content changes. */
  unchanged: number;
  runIds: string[];
  requestedRange?: CollectionRange;
}

function isCalendarDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !value.startsWith("0000-") &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

export function validateCollectionRange(
  range: CollectionRange,
): CollectionRange {
  for (const value of [range.from, range.to]) {
    if (!isCalendarDate(value)) {
      throw new Error(
        "Collection dates must be real calendar dates (YYYY-MM-DD)",
      );
    }
  }
  if (range.from > range.to) {
    throw new Error("Collection date range is reversed");
  }
  return { from: range.from, to: range.to };
}

const activeCollections = new WeakSet<object>();

/** A fatal failure of the whole collection, scoped to the requested range if any. */
function collectionFailure(
  code: CollectionFailure["code"],
  range: CollectionRange | undefined,
): CollectionEvent {
  return {
    type: "failure",
    failure: {
      accountKey: null,
      endpoint: "collection",
      code,
      ...(range ? { scope: { kind: "history" as const, ...range } } : {}),
    },
    fatal: true,
  };
}

/** Whether a failure is scoped to exactly the requested range, with no narrower unit. */
function coversWholeRange(
  failure: CollectionFailure,
  range: CollectionRange | undefined,
): boolean {
  const scope = failure.scope;
  return (
    failure.accountKey === null &&
    scope?.kind === "history" &&
    scope.from === range?.from &&
    scope.to === range?.to &&
    !scope.month &&
    !scope.cardKey &&
    !scope.cardKeys &&
    !scope.filters &&
    !scope.windowFrom
  );
}

/**
 * Bounds a run's source text at the monthly aggregate providers already stop
 * at; a single larger response still forms its own run.
 */
const RUN_SOURCE_BYTES = 16 * 1024 * 1024;

type Unbatched = Exclude<CollectionEvent, { type: "card_discovery" }>;

/** The unit's events not yet ingested, in collector order. */
interface Batch {
  runId: string;
  /** When collection met the run's first event. */
  startedAt: string;
  responses: FinancialResponse[];
  failures: CollectionFailure[];
  sourceBytes: number;
}

/**
 * Applies a collection unit's captures and failures as one run, loading the
 * ledger once, and starts another run only where a run cannot hold an event or
 * would exceed its size bound. However the unit ends, what it fetched is
 * ingested before returning; a crash before then loses only that unit's
 * responses, which its resume requests again.
 */
export async function collectFromStore(
  store: CollectionStore,
  input: {
    connectionId: string;
    range?: CollectionRange;
    signal?: AbortSignal;
    /** The refresh whose sync runs these are. */
    refreshId?: string;
    onDiagnostic?: SyncDiagnosticSink;
    debugArchiveDays?: number;
  },
  collector: ProviderCollector,
  adapter: SourceAdapter,
): Promise<CollectionSummary> {
  const started = performance.now();
  const emit = syncDiagnostics(input.onDiagnostic);
  const diagnose = (
    entry: Omit<Parameters<typeof emit>[0], "event" | "refreshId">,
  ) =>
    emit({
      event: "fonds_sync",
      ...(input.refreshId && { refreshId: input.refreshId }),
      ...entry,
    });
  const range = input.range && validateCollectionRange(input.range);
  const connection = await store.getConnection(input.connectionId);
  if (
    !connection ||
    connection.provider !== collector.provider ||
    connection.provider !== adapter.provider ||
    !collector.collectorVersion
  ) {
    throw new Error("Connection, collector and source adapter must match");
  }
  if (activeCollections.has(store.identity)) {
    throw new Error("Collection is already running");
  }
  activeCollections.add(store.identity);
  const summary: CollectionSummary = {
    status: "failed",
    captures: 0,
    failures: 0,
    observed: 0,
    unchangedTransactions: 0,
    created: 0,
    updated: 0,
    unlisted: 0,
    unchanged: 0,
    runIds: [],
    ...(range ? { requestedRange: range } : {}),
  };
  diagnose({ stage: "collection", outcome: "started" });
  let acceptedRuns = 0;

  let batch: Batch | undefined;
  /** Ingests and applies one run of the unit's captures and failures. */
  const ingest = async (
    runId: string,
    startedAt: string,
    responses: FinancialResponse[],
    failures: CollectionFailure[],
  ) => {
    const started = performance.now();
    diagnose({
      captureId: runId,
      runId,
      stage: "ingest",
      outcome: "started",
      reason: "reconciliation_required",
      counts: { captures: responses.length, failures: failures.length },
    });
    const result = await store.ingestRun(
      {
        runId,
        startedAt,
        connectionId: input.connectionId,
        collectorVersion: collector.collectorVersion,
        ...(input.refreshId && { refreshId: input.refreshId }),
        ...(input.debugArchiveDays !== undefined && {
          debugArchiveDays: input.debugArchiveDays,
        }),
        responses,
        failures,
      },
      adapter,
      input.onDiagnostic,
    );
    diagnose({
      captureId: runId,
      runId,
      stage: "ingest",
      outcome: result.status,
      reason: result.replayed
        ? "capture_replayed"
        : result.status === "failed"
          ? "capture_rejected"
          : "content_applied",
      ...(result.status !== "completed" && {
        failureCategory:
          result.failureCode ?? failures[0]?.code ?? "invalid_response",
      }),
      durationMs: elapsedMs(started),
      counts: {
        observed: result.observed,
        unchangedTransactions: result.unchanged,
        created: result.created,
        changed: result.updated,
        absent: result.unlisted,
      },
    });
    summary.runIds.push(runId);
    return result;
  };
  /** Counts a run's result as the captures and failures it holds. */
  const account = (
    runId: string,
    result: Awaited<ReturnType<typeof ingest>>,
    responses: number,
    failures: number,
  ) => {
    summary.captures += responses;
    // A run reports one outcome: every capture of a failed run failed, and a
    // partial run without explicit failures had at least one failed capture.
    if (result.status === "failed") {
      summary.failures += failures + responses;
    } else if (result.status === "partial") {
      summary.failures += Math.max(failures, 1);
    }
    if (result.failureCode) {
      summary.failureCodes = [
        ...new Set([...(summary.failureCodes ?? []), result.failureCode]),
      ];
    }
    if (result.status !== "failed") {
      acceptedRuns++;
    }
    summary.observed += result.observed ?? 0;
    summary.unchangedTransactions += result.unchanged ?? 0;
    summary.created += result.created;
    summary.updated += result.updated;
    summary.unlisted += result.unlisted;
    // Every observation is reconciled and receives a durable receipt, even when
    // content is unchanged; freshness and owner decisions still need processing.
    if (
      responses > 0 &&
      result.status === "completed" &&
      result.created === 0 &&
      result.updated === 0 &&
      result.unlisted === 0 &&
      result.observed !== undefined &&
      result.unchanged === result.observed
    ) {
      summary.unchanged += responses;
      diagnose({
        captureId: runId,
        runId,
        stage: "observation",
        outcome: "completed",
        reason: "content_unchanged",
        counts: {
          observed: result.observed,
          unchangedTransactions: result.unchanged,
          captures: responses,
          unchanged: responses,
        },
      });
    }
  };
  /** Ingests the buffered events as one run, so the ledger is loaded once for them. */
  const flush = async () => {
    const pending = batch;
    batch = undefined;
    if (!pending) {
      return;
    }
    const { runId, startedAt, responses, failures } = pending;
    const result = await ingest(runId, startedAt, responses, failures);
    account(runId, result, responses.length, failures.length);
  };
  /** Whether the event cannot join the current run under the run's invariants or size bound. */
  const startsNewRun = (current: Batch, event: Unbatched, bytes: number) => {
    if (event.type === "failure") {
      const failure = event.failure;
      return (
        failure.affectsCoverage !== false &&
        failure.accountKey !== null &&
        current.responses.some(
          (response) => response.accountKey === failure.accountKey,
        )
      );
    }
    const key = event.capture.accountKey;
    return (
      current.responses.some((response) => response.accountKey === key) ||
      current.failures.some(
        (failure) =>
          failure.affectsCoverage !== false && failure.accountKey === key,
      ) ||
      (current.responses.length > 0 &&
        current.sourceBytes + bytes > RUN_SOURCE_BYTES)
    );
  };
  const recordEvent = async (event: CollectionEvent) => {
    const captureId = crypto.randomUUID();
    const captureStarted = performance.now();
    if (event.type === "card_discovery") {
      // Buffered captures are applied against the catalog that preceded this discovery.
      await flush();
      await store.recordCardDiscovery(input.connectionId, event.discovery);
      diagnose({
        captureId,
        stage: "capture",
        outcome: "completed",
        reason: "card_discovery",
        durationMs: elapsedMs(captureStarted),
      });
      return;
    }
    const bytes =
      event.type === "capture"
        ? new TextEncoder().encode(event.capture.responseText).length
        : 0;
    if (batch && startsNewRun(batch, event, bytes)) {
      await flush();
    }
    const collectedAt = new Date().toISOString();
    // A run is named by its first capture, so a one-event run keeps that ID.
    batch ??= {
      runId: captureId,
      startedAt: collectedAt,
      responses: [],
      failures: [],
      sourceBytes: 0,
    };
    if (event.type === "capture") {
      batch.responses.push(event.capture);
      batch.sourceBytes += bytes;
    } else {
      // Health orders a run's failures against its responses by these times.
      batch.failures.push({
        ...event.failure,
        failedAt: event.failure.failedAt ?? collectedAt,
      });
    }
    diagnose({
      captureId,
      runId: batch.runId,
      stage: "capture",
      outcome: "started",
      ...(event.type === "failure" && {
        reason: "collection_failure",
        failureCategory: event.failure.code,
      }),
    });
  };
  const interruptionEvent = () => collectionFailure("network_error", range);
  let iterator: AsyncIterator<CollectionEvent> | undefined;
  /** Records the collector's events in order until it ends, fails fatally or is interrupted. */
  const recordCollectedEvents = async () => {
    if (input.signal?.aborted) {
      diagnose({
        stage: "collection",
        outcome: "interrupted",
        reason: "cancelled",
      });
      await recordEvent(interruptionEvent());
      return;
    }
    try {
      iterator = collector
        .collect({
          ...(range ? { range } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        })
        [Symbol.asyncIterator]();
    } catch {
      diagnose({
        stage: "collection",
        outcome: "failed",
        reason: "collector_exception",
        failureCategory: "collection",
      });
      // Third-party adapter exceptions can contain credentials or response bodies.
      await recordEvent(interruptionEvent());
    }
    while (iterator) {
      if (input.signal?.aborted && !collector.drainsOnAbort) {
        await recordEvent(interruptionEvent());
        return;
      }
      let nextEvent: IteratorResult<CollectionEvent>;
      try {
        nextEvent = await iterator.next();
      } catch {
        diagnose({
          stage: "collection",
          outcome: "failed",
          reason: "collector_exception",
          failureCategory: "collection",
        });
        await recordEvent(interruptionEvent());
        return;
      }
      if (nextEvent.done) {
        return;
      }
      const event = nextEvent.value;
      // Application/storage errors deliberately propagate: do not fetch more data.
      await recordEvent(event);
      if (event.type === "failure" && event.fatal) {
        if (range && !coversWholeRange(event.failure, range)) {
          // The failed unit does not describe windows/accounts never attempted.
          // Preserve that uncertainty even after a narrower retry succeeds.
          await recordEvent(collectionFailure(event.failure.code, range));
        }
        return;
      }
    }
  };
  try {
    await recordCollectedEvents();
    if (!batch && summary.runIds.length === 0) {
      await recordEvent(collectionFailure("invalid_response", range));
    }
    await flush();
    summary.status =
      acceptedRuns === 0
        ? "failed"
        : summary.failures
          ? "partial"
          : "completed";
    diagnose({
      stage: "collection",
      outcome: summary.status,
      durationMs: elapsedMs(started),
      counts: {
        observed: summary.observed,
        unchangedTransactions: summary.unchangedTransactions,
        captures: summary.captures,
        unchanged: summary.unchanged,
        created: summary.created,
        changed: summary.updated,
        absent: summary.unlisted,
        failures: summary.failures,
      },
    });
    return summary;
  } catch (error) {
    diagnose({
      stage: "collection",
      outcome: "failed",
      reason: "persistence_failure",
      failureCategory: "persistence",
      durationMs: elapsedMs(started),
    });
    throw error;
  } finally {
    try {
      await iterator?.return?.();
    } catch {
      // Provider cleanup must not leak raw exceptions or mask a persistence failure.
    } finally {
      activeCollections.delete(store.identity);
    }
  }
}
