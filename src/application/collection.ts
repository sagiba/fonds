import type { ReconciliationFailureCode } from "../domain/model.js";
import { RECONCILIATION_POLICY_VERSION } from "../domain/plans/sync.js";
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

export type {
  CollectionEvent,
  CollectionRange,
  ProviderCollector,
} from "../domain/source-adapter.js";

export type CollectionStore = Pick<
  InternalStore,
  "identity" | "getConnection" | "ingestRun" | "recordCardDiscovery"
> &
  /** These enable skipping identical repeat captures. */
  Partial<
    Pick<
      InternalStore,
      "getStoredConnection" | "updateConfig" | "ledgerRevision"
    >
  >;

/**
 * The connection's last archived capture. `capturedAt` is the newest capture
 * time seen; the other fields are present only while that capture may be reused.
 */
interface LastCapture {
  /** Normalized ISO time of the newest capture ingested through collection. */
  capturedAt: string;
  key?: string;
  fingerprint?: string;
  /** Ledger revision sampled before that capture was ingested. */
  revision?: string;
}

function captureKey(capture: FinancialResponse) {
  return JSON.stringify([
    capture.accountKey,
    capture.endpoint,
    capture.scope ?? null,
  ]);
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export interface CollectionSummary {
  status: "completed" | "partial" | "failed";
  captures: number;
  /** Explicit collection failures plus captures with extraction failures. */
  failures: number;
  failureCodes?: ReconciliationFailureCode[];
  created: number;
  updated: number;
  unlisted: number;
  /** Captures identical to the last archived one; nothing was stored for them. */
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
const FRESH_CAPTURE_MS = 10 * 60 * 1000;

function isSuccessfulCapture(capture: FinancialResponse): boolean {
  return (
    capture.httpStatus === undefined ||
    (capture.httpStatus >= 200 && capture.httpStatus < 300)
  );
}

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
  },
  collector: ProviderCollector,
  adapter: SourceAdapter,
): Promise<CollectionSummary> {
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
    created: 0,
    updated: 0,
    unlisted: 0,
    unchanged: 0,
    runIds: [],
    ...(range ? { requestedRange: range } : {}),
  };
  let acceptedRuns = 0;
  // Hourly recent rereads usually return identical content. Reconciling it again
  // would only archive another copy and rewrite every lastSeenAt, so a capture is
  // skipped only when it matches the connection's last archived capture and the
  // ledger has not changed since before that capture was ingested. Any other
  // capture, failure, crash, stale capture, removal or posting confirmation
  // therefore forces a full ingest. Non-2xx captures are never skipped.
  // Assumes captures reach collection in capture order, as the single locked
  // collector guarantees; an out-of-order capture can at worst leave the ledger
  // one run behind, corrected by the next fresh capture, which is then ingested.
  const fingerprinting = Boolean(
    adapter.contentFingerprint &&
    store.getStoredConnection &&
    store.updateConfig &&
    store.ledgerRevision,
  );
  let lastCapture: LastCapture | undefined;
  const saveLastCapture = async (next: LastCapture) => {
    lastCapture = next;
    await store.updateConfig!(input.connectionId, (config) => ({
      ...config,
      lastCapture: next,
    }));
  };
  const recordEvent = async (event: CollectionEvent) => {
    if (event.type === "card_discovery") {
      await store.recordCardDiscovery(input.connectionId, event.discovery);
      return;
    }
    let fingerprint: string | undefined;
    const capture = event.type === "capture" ? event.capture : undefined;
    const key = capture ? captureKey(capture) : undefined;
    if (fingerprinting && capture && isSuccessfulCapture(capture)) {
      fingerprint = await sha256(
        [
          adapter.parserVersion,
          collector.collectorVersion,
          RECONCILIATION_POLICY_VERSION,
          adapter.recentComparableDays ?? null,
          adapter.rejectEmptyRecentPosted ?? false,
          adapter.contentFingerprint!(capture.responseText),
        ].join("\n"),
      );
      if (
        lastCapture?.fingerprint === fingerprint &&
        lastCapture.key === key &&
        lastCapture.revision ===
          (await store.ledgerRevision!(input.connectionId))
      ) {
        summary.captures++;
        summary.unchanged++;
        acceptedRuns++;
        return;
      }
    }
    let revision: string | undefined;
    if (fingerprinting) {
      // Sample first, then forget the previous capture: any later mutation then
      // invalidates the new record, and an interrupted ingest leaves nothing to reuse.
      revision = await store.ledgerRevision!(input.connectionId);
      if (lastCapture?.fingerprint) {
        await saveLastCapture({ capturedAt: lastCapture.capturedAt });
      }
    }
    const runId = crypto.randomUUID();
    const result = await store.ingestRun(
      {
        runId,
        connectionId: input.connectionId,
        collectorVersion: collector.collectorVersion,
        ...(input.refreshId && { refreshId: input.refreshId }),
        responses: capture ? [capture] : [],
        failures: event.type === "failure" ? [event.failure] : [],
      },
      adapter,
    );
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
    summary.created += result.created;
    summary.updated += result.updated;
    summary.unlisted += result.unlisted;
    if (!fingerprinting || !capture) {
      return;
    }
    // Only a capture fetched moments ago can be reused or advance the newest
    // time seen: a delayed or skewed capture may conflict with evidence already
    // applied, and reconciliation ignores stale data.
    const capturedMs = Date.parse(capture.capturedAt);
    if (
      !Number.isFinite(capturedMs) ||
      Math.abs(Date.now() - capturedMs) >= FRESH_CAPTURE_MS ||
      capturedMs < Date.parse(lastCapture?.capturedAt ?? "")
    ) {
      return;
    }
    await saveLastCapture({
      capturedAt: new Date(capturedMs).toISOString(),
      ...(fingerprint !== undefined && result.status === "completed"
        ? { key: key!, fingerprint, revision: revision! }
        : {}),
    });
  };
  const interruptionEvent = () => collectionFailure("network_error", range);
  let iterator: AsyncIterator<CollectionEvent> | undefined;
  /** Records the collector's events in order until it ends, fails fatally or is interrupted. */
  const recordCollectedEvents = async () => {
    if (input.signal?.aborted) {
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
    if (fingerprinting) {
      lastCapture = (await store.getStoredConnection!(input.connectionId))
        ?.config.lastCapture as LastCapture | undefined;
    }
    await recordCollectedEvents();
    if (summary.runIds.length === 0 && summary.unchanged === 0) {
      await recordEvent(collectionFailure("invalid_response", range));
    }
    summary.status =
      acceptedRuns === 0
        ? "failed"
        : summary.failures
          ? "partial"
          : "completed";
    return summary;
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
