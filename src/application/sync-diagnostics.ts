import { z } from "zod";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const syncDiagnosticSchema = z.object({
  event: z.literal("fonds_sync"),
  refreshId: z.uuid().optional(),
  captureId: z.uuid().optional(),
  stage: z.enum([
    "refresh",
    "collection",
    "capture",
    "observation",
    "ingest",
    "recovery",
    "archive",
    "extraction",
    "reconciliation",
    "commit",
    "purge",
  ]),
  outcome: z.enum([
    "started",
    "completed",
    "partial",
    "failed",
    "skipped",
    "busy",
    "yielded",
    "interrupted",
  ]),
  reason: z
    .enum([
      "content_unchanged",
      "reconciliation_required",
      "content_applied",
      "capture_rejected",
      "body_staged",
      "body_released",
      "debug_body_retained",
      "legacy_body_retained",
      "evidence_deferred",
      "collection_failure",
      "card_discovery",
      "collector_exception",
      "cancelled",
      "persistence_failure",
      "pending_runs_recovered",
      "retry",
      "budget",
      "lease_busy",
      "execution_failed",
    ])
    .optional(),
  durationMs: count.optional(),
  counts: z
    .object({
      observed: count.optional(),
      extracted: count.optional(),
      deferred: count.optional(),
      created: count.optional(),
      changed: count.optional(),
      unchangedTransactions: count.optional(),
      absent: count.optional(),
      captures: count.optional(),
      unchanged: count.optional(),
      failures: count.optional(),
      recoveredRuns: count.optional(),
    })
    .optional(),
  failureCategory: z
    .enum([
      "network_error",
      "authentication_failed",
      "authentication_challenge",
      "rate_limited",
      "budget_exhausted",
      "invalid_response",
      "implausible_empty",
      "collection",
      "persistence",
      "execution",
    ])
    .optional(),
});

export type SyncDiagnostic = z.infer<typeof syncDiagnosticSchema>;

export type SyncDiagnosticSink = (entry: SyncDiagnostic) => unknown;

export function syncCorrelationIds(input: {
  captureId?: string | undefined;
  refreshId?: string | undefined;
}) {
  const capture = z.uuid().safeParse(input.captureId);
  const refresh = z.uuid().safeParse(input.refreshId);
  return {
    ...(capture.success ? { captureId: capture.data } : {}),
    ...(refresh.success ? { refreshId: refresh.data } : {}),
  };
}

/** Logs are advisory: even a rejected async callback cannot change committed work. */
export function safeLog<T>(sink: (entry: T) => unknown): (entry: T) => void {
  return (entry) => {
    try {
      void Promise.resolve(sink(entry)).catch(() => undefined);
    } catch {
      // Logger exceptions can contain arbitrary host or provider data.
    }
  };
}

/** Project a closed vocabulary; arbitrary provider fields never reach the sink. */
export function syncDiagnostics(sink?: SyncDiagnosticSink) {
  const emit = safeLog(sink ?? (() => {}));
  return (entry: SyncDiagnostic) => {
    try {
      const parsed = syncDiagnosticSchema.safeParse(entry);
      if (parsed.success) {
        emit(parsed.data);
      }
    } catch {
      // Getters and third-party objects are not trusted diagnostic payloads.
    }
  };
}

export function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

/** Operator-only, in-memory preview. It never stores raw response bodies. */
export function createSyncDiagnosticReport() {
  const entries: SyncDiagnostic[] = [];
  let dropped = 0;
  const emit = syncDiagnostics((entry) => {
    if (entries.length < 200) {
      entries.push(entry);
    } else {
      dropped++;
    }
  });
  return {
    log(entry: object) {
      emit(entry as SyncDiagnostic);
    },
    report: () => ({
      entries: structuredClone(entries),
      dropped,
      truncated: dropped > 0,
    }),
  };
}
