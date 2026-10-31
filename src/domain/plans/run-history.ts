import { z } from "zod";

import type {
  CollectionFailure,
  CollectionScope,
  FinancialResponse,
  Run,
} from "../records.js";
import type { SourceAdapter } from "../source-adapter.js";
import { resourceKey, scopeKey } from "./source-membership.js";

/** Recovery is scoped: success for account A cannot clear a still-failed account B. */
export interface PriorRun {
  id: string;
  status: Run["status"];
  startedAt: string;
  coverage: Run["coverage"];
  snapshot: {
    responses: Omit<FinancialResponse, "responseText">[];
    failures?: CollectionFailure[];
  };
}

export function partitionKey(
  adapter: SourceAdapter,
  accountKey: string,
  endpoint: string,
  scope: CollectionScope | undefined,
  status: "posted" | "pending",
): string {
  return JSON.stringify([
    accountKey,
    resourceKey(adapter, endpoint),
    scopeKey(adapter, scope),
    status,
  ]);
}

/** Health keys, including `collection:<scope>` keys, to their latest evidence time. */
export interface CollectionHealth {
  readonly failed: Map<string, number>;
  readonly successful: Map<string, number>;
}

/**
 * Facts folded over every applied run of a connection in application order,
 * `(appliedAt, ingestionOrder)`. Collection health is order-sensitive at equal
 * times, so a summary stands for exactly the runs, in exactly the order, it
 * folded.
 */
export interface RunHistorySummary extends CollectionHealth {
  readonly latestComparable: Map<string, string>;
  readonly latestSuccessful: Map<string, string>;
  readonly knownAccounts: Set<string>;
  /**
   * The greatest response capture time of any folded run, in string order.
   * Retained coverage is a response's capture, so no folded run can hold
   * coverage captured after it.
   */
  latestCapture: string | undefined;
}

export function emptyRunHistory(): RunHistorySummary {
  return {
    failed: new Map(),
    successful: new Map(),
    latestComparable: new Map(),
    latestSuccessful: new Map(),
    knownAccounts: new Set(),
    latestCapture: undefined,
  };
}

export function copyRunHistory(summary: RunHistorySummary): RunHistorySummary {
  return {
    failed: new Map(summary.failed),
    successful: new Map(summary.successful),
    latestComparable: new Map(summary.latestComparable),
    latestSuccessful: new Map(summary.latestSuccessful),
    knownAccounts: new Set(summary.knownAccounts),
    latestCapture: summary.latestCapture,
  };
}

/** Applies one run's collection outcome to the health keys it touches. */
export function acceptCollectionHealth(
  health: CollectionHealth,
  run: Pick<PriorRun, "coverage" | "snapshot" | "startedAt">,
  adapter: SourceAdapter,
): void {
  const { failed, successful } = health;
  const fail = (key: string, time: number) => {
    // Import order cannot let an older failure replace newer successful evidence.
    if (time < (successful.get(key) ?? -Infinity)) {
      return;
    }
    failed.set(key, Math.max(failed.get(key) ?? -Infinity, time));
  };
  const recover = (key: string, time: number) => {
    successful.set(key, Math.max(successful.get(key) ?? -Infinity, time));
    const failureTime = failed.get(key);
    if (failureTime !== undefined && time >= failureTime) {
      failed.delete(key);
    }
  };
  // The archive's collection time survives replay; application completion does not.
  const started = Date.parse(run.startedAt);
  const attemptTime = Number.isFinite(started) ? started : Infinity;
  // A run can hold failures met before or after its responses.
  const failureTime = (failure: CollectionFailure) => {
    const failed = failure.failedAt ? Date.parse(failure.failedAt) : NaN;
    return Number.isFinite(failed) ? failed : attemptTime;
  };
  /** A partition's failures can repeat within a run; the latest one stands. */
  const latestFailureTime = (part: (typeof run.coverage)[number]) => {
    const times = (run.snapshot.failures ?? [])
      .filter(
        (failure) =>
          failure.affectsCoverage !== false &&
          failure.accountKey === part.accountKey &&
          resourceKey(adapter, failure.endpoint) ===
            resourceKey(adapter, part.resource) &&
          scopeKey(adapter, failure.scope) === scopeKey(adapter, part.scope),
      )
      .map(failureTime);
    return times.length > 0 ? Math.max(...times) : attemptTime;
  };
  for (const part of run.coverage) {
    // An unscoped legacy archive cannot establish recovery of a live collection.
    if (part.success && !part.comparable && !part.scope) {
      continue;
    }
    const response = run.snapshot.responses.find(
      (response) =>
        response.accountKey === part.accountKey &&
        resourceKey(adapter, response.endpoint) ===
          resourceKey(adapter, part.resource) &&
        scopeKey(adapter, response.scope) === scopeKey(adapter, part.scope),
    );
    const evidenceTime = response
      ? Date.parse(response.capturedAt)
      : latestFailureTime(part);
    if (part.success && response) {
      recover(`collection:${scopeKey(adapter, part.scope)}`, evidenceTime);
    }
    const key = JSON.stringify([
      part.accountKey,
      resourceKey(adapter, part.resource),
      part.status,
      scopeKey(adapter, part.scope),
    ]);
    if (part.success && response) {
      recover(key, evidenceTime);
    } else if (!part.success) {
      fail(key, evidenceTime);
    }
  }
  for (const failure of run.snapshot.failures ?? []) {
    if (failure.affectsCoverage !== false && failure.accountKey === null) {
      fail(
        `collection:${scopeKey(adapter, failure.scope)}`,
        failureTime(failure),
      );
    }
  }
}

/**
 * The one reducer for run history: folding every applied run in application
 * order from an empty summary, and appending a newly applied run that sorts
 * last, both go through here.
 */
export function foldRunHistory(
  summary: RunHistorySummary,
  run: PriorRun,
  adapter: SourceAdapter,
): void {
  acceptCollectionHealth(summary, run, adapter);
  const responses = new Map(
    run.snapshot.responses.map((response) => [response.accountKey, response]),
  );
  for (const part of run.coverage) {
    if (!part.success) {
      continue;
    }
    const response = responses.get(part.accountKey);
    if (!response) {
      continue;
    }
    const key = partitionKey(
      adapter,
      part.accountKey,
      part.resource,
      response.scope,
      part.status,
    );
    if (
      response.scope?.kind !== "history" &&
      response.capturedAt > (summary.latestSuccessful.get(key) ?? "")
    ) {
      summary.latestSuccessful.set(key, response.capturedAt);
    }
    if (!part.comparable) {
      continue;
    }
    summary.knownAccounts.add(part.accountKey);
    if (response.capturedAt > (summary.latestComparable.get(key) ?? "")) {
      summary.latestComparable.set(key, response.capturedAt);
    }
  }
  for (const response of run.snapshot.responses) {
    if (
      summary.latestCapture === undefined ||
      response.capturedAt > summary.latestCapture
    ) {
      summary.latestCapture = response.capturedAt;
    }
  }
}

/** Runs must be in application order. */
export function summarizeRunHistory(
  runs: readonly PriorRun[],
  adapter: SourceAdapter,
): RunHistorySummary {
  const summary = emptyRunHistory();
  for (const run of runs) {
    foldRunHistory(summary, run, adapter);
  }
  return summary;
}

/**
 * Every run a stored row names. The planner resolves prior runs by ID only
 * through a row's run-reference fields (receipts, source references, absence
 * proofs, overlap witnesses and retained pending components), so collecting
 * every `runId` and `…RunId` string at any depth is a superset that new
 * reference fields join without a change here.
 */
export function referencedRunIds(rows: Iterable<unknown>): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (value === null || typeof value !== "object") {
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (
        typeof item === "string" &&
        (key === "runId" || key.endsWith("RunId"))
      ) {
        ids.add(item);
      } else {
        visit(item);
      }
    }
  };
  for (const row of rows) {
    visit(row);
  }
  return ids;
}

/**
 * Change when the fold, or an adapter key function it uses, changes meaning;
 * a stored summary of another version is rebuilt from the complete history.
 */
export const RUN_HISTORY_VERSION = 1;

// Health times include Infinity and NaN, which JSON numbers cannot carry.
const timeText = z
  .string()
  .refine((value) => String(Number(value)) === value, "Non-canonical time");
const entries = <T extends z.ZodType>(value: T) =>
  z.array(z.tuple([z.string(), value]));

export const runHistoryDocumentSchema = z
  .object({
    schemaVersion: z.literal(RUN_HISTORY_VERSION),
    provider: z.string(),
    parserVersion: z.string(),
    /** The applied runs folded, and the last of them in application order. */
    appliedRuns: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    latestRunId: z.string().nullable(),
    latestCapture: z.string().nullable(),
    failed: entries(timeText),
    successful: entries(timeText),
    latestComparable: entries(z.string()),
    latestSuccessful: entries(z.string()),
    knownAccounts: z.array(z.string()),
  })
  .strict();

export type RunHistoryDocument = z.infer<typeof runHistoryDocumentSchema>;

export interface RunHistoryState {
  provider: string;
  parserVersion: string;
  appliedRuns: number;
  latestRunId: string | null;
  summary: RunHistorySummary;
}

export function encodeRunHistory(state: RunHistoryState): RunHistoryDocument {
  const { summary } = state;
  const times = (map: Map<string, number>) =>
    [...map].map(([key, time]) => [key, String(time)] as [string, string]);
  return {
    schemaVersion: RUN_HISTORY_VERSION,
    provider: state.provider,
    parserVersion: state.parserVersion,
    appliedRuns: state.appliedRuns,
    latestRunId: state.latestRunId,
    latestCapture: summary.latestCapture ?? null,
    failed: times(summary.failed),
    successful: times(summary.successful),
    latestComparable: [...summary.latestComparable],
    latestSuccessful: [...summary.latestSuccessful],
    knownAccounts: [...summary.knownAccounts],
  };
}

/** A malformed or duplicate-keyed document is unusable, never partially read. */
export function decodeRunHistory(value: unknown): RunHistoryState | undefined {
  const parsed = runHistoryDocumentSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const document = parsed.data;
  const times = (pairs: [string, string][]) =>
    new Map(pairs.map(([key, time]) => [key, Number(time)]));
  const summary: RunHistorySummary = {
    failed: times(document.failed),
    successful: times(document.successful),
    latestComparable: new Map(document.latestComparable),
    latestSuccessful: new Map(document.latestSuccessful),
    knownAccounts: new Set(document.knownAccounts),
    latestCapture: document.latestCapture ?? undefined,
  };
  if (
    summary.failed.size !== document.failed.length ||
    summary.successful.size !== document.successful.length ||
    summary.latestComparable.size !== document.latestComparable.length ||
    summary.latestSuccessful.size !== document.latestSuccessful.length ||
    summary.knownAccounts.size !== document.knownAccounts.length
  ) {
    return undefined;
  }
  return {
    provider: document.provider,
    parserVersion: document.parserVersion,
    appliedRuns: document.appliedRuns,
    latestRunId: document.latestRunId,
    summary,
  };
}
