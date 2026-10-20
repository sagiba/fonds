import type { ReconciliationFailureCode } from "../domain/model.js";
import type { CollectionFailure } from "../domain/records.js";
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
  /** Explicit collection failures plus captures with extraction failures. */
  failures: number;
  failureCodes?: ReconciliationFailureCode[];
  /** Transaction identities observed once per capture. */
  observed: number;
  unchangedTransactions: number;
  created: number;
  updated: number;
  unlisted: number;
  /** Successful captures that caused no retained transaction content changes. */
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

/** Persist each response before requesting the next window; never hold years in RAM. */
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
  const recordEvent = async (event: CollectionEvent) => {
    const captureId = crypto.randomUUID();
    const captureStarted = performance.now();
    if (event.type === "card_discovery") {
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
    const capture = event.type === "capture" ? event.capture : undefined;
    diagnose({
      captureId,
      stage: "capture",
      outcome: "started",
      ...(event.type === "failure" && {
        reason: "collection_failure",
        failureCategory: event.failure.code,
      }),
    });
    const runId = captureId;
    diagnose({
      captureId,
      stage: "ingest",
      outcome: "started",
      reason: "reconciliation_required",
    });
    const result = await store.ingestRun(
      {
        runId,
        connectionId: input.connectionId,
        collectorVersion: collector.collectorVersion,
        ...(input.refreshId && { refreshId: input.refreshId }),
        ...(input.debugArchiveDays !== undefined && {
          debugArchiveDays: input.debugArchiveDays,
        }),
        responses: capture ? [capture] : [],
        failures: event.type === "failure" ? [event.failure] : [],
      },
      adapter,
      input.onDiagnostic,
    );
    diagnose({
      captureId,
      stage: "ingest",
      outcome: result.status,
      reason:
        result.status === "failed" ? "capture_rejected" : "content_applied",
      ...(result.status !== "completed" && {
        failureCategory:
          result.failureCode ??
          (event.type === "failure" ? event.failure.code : "invalid_response"),
      }),
      durationMs: elapsedMs(captureStarted),
      counts: {
        observed: result.observed,
        unchangedTransactions: result.unchanged,
        created: result.created,
        changed: result.updated,
        absent: result.unlisted,
      },
    });
    summary.runIds.push(runId);
    if (capture) {
      summary.captures++;
    }
    if (result.status !== "completed") {
      summary.failures++;
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
      capture &&
      result.status === "completed" &&
      result.created === 0 &&
      result.updated === 0 &&
      result.unlisted === 0 &&
      result.observed !== undefined &&
      result.unchanged === result.observed
    ) {
      summary.unchanged++;
      diagnose({
        captureId,
        stage: "observation",
        outcome: "completed",
        reason: "content_unchanged",
        counts: {
          observed: result.observed,
          unchangedTransactions: result.unchanged,
          captures: 1,
          unchanged: 1,
        },
      });
    }
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
    if (summary.runIds.length === 0) {
      await recordEvent(collectionFailure("invalid_response", range));
    }
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
