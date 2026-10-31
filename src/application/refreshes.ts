import type { RefreshFailureCode } from "../domain/model.js";
import type {
  EventType,
  LedgerEventWrite,
  RefreshHealthDocument,
} from "../domain/records.js";
import {
  FAILURE_REASONS,
  type FailureReason,
  PROVIDER_STOP_REASONS,
  type ProviderStopReason,
  REFRESH_STATUSES,
  REFRESH_TRIGGERS,
  type RefreshStatus,
  type RefreshTrigger,
  SKIP_REASONS,
  type SkipReason,
  WINDOW_STATUSES,
  type WindowStatus,
} from "../domain/refreshes.js";
import type { CollectionRange } from "../domain/source-adapter.js";
import { validateCollectionRange } from "./collection.js";

export {
  FAILURE_REASONS,
  type FailureReason,
  PROVIDER_STOP_REASONS,
  type ProviderStopReason,
  REFRESH_STATUSES,
  REFRESH_TRIGGERS,
  type RefreshStatus,
  type RefreshTrigger,
  SKIP_REASONS,
  type SkipReason,
  WINDOW_STATUSES,
  type WindowStatus,
};

/** Why a start did not create a refresh: the skip reasons a request can meet. */
export type NotStartedReason = Exclude<SkipReason, "missed">;

/** A finished refresh blocks the next ordinary start for this long. */
export const REFRESH_COOLDOWN_MS = 60_000;

/** A refresh still active this long after it was created fails as expired. */
export const REFRESH_MAX_AGE_MS = 24 * 60 * 60_000;

/** A ranged refresh is at most this many calendar months, one window each. */
export const MAX_REFRESH_MONTHS = 120;

/** Cumulative results across executions, including interrupted attempts. */
export interface RefreshCounts {
  /** Financial captures accepted, including unchanged ones. */
  captures: number;
  /** Successful captures that caused no retained transaction content changes. */
  unchanged: number;
  /** Transaction identities observed once per capture; overlaps can observe them again. */
  observed: number;
  /** Observed transaction rows whose retained content did not change. */
  unchangedTransactions: number;
  /** Transactions newly marked not returned by comparable evidence. */
  unlisted: number;
  failures: number;
  created: number;
  updated: number;
}

export interface RefreshWindow {
  from: string;
  to: string;
  status: WindowStatus;
  /** Internal evidence checkpoint, committed with the accepted run. */
  hasAcceptedEvidence?: boolean;
}

export interface Refresh {
  id: string;
  connectionId: string;
  trigger: RefreshTrigger;
  status: RefreshStatus;
  skipReason: SkipReason | null;
  range: CollectionRange | null;
  /** The scheduled occurrence's key; internal, never public. */
  occurrence: string | null;
  scheduledAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  requiresAttention: boolean;
  /** Internal durable provider stop; never part of the public refresh output. */
  providerStopReason?: ProviderStopReason | null;
  /** Internal evidence checkpoint, committed with this refresh's accepted run. */
  hasAcceptedEvidence?: boolean;
  counts: RefreshCounts;
  /** Committed with the runs that count as its failures; empty once completed. */
  failureCodes: RefreshFailureCode[];
  /** Why it failed without a provider outcome; null otherwise. */
  failureReason: FailureReason | null;
  /** A missed skip's gap: `scheduledAt` is its first occurrence, `through` its last. */
  missed: { through: string; count: number } | null;
  /** Month checkpoints of a ranged refresh, newest first; empty otherwise. */
  windows: RefreshWindow[];
}

export interface RefreshPageInput {
  limit: number;
  after?: { createdAt: string; id: string } | undefined;
}

export const ACTIVE_STATUSES: readonly RefreshStatus[] = ["pending", "running"];

export const isActive = (refresh: Pick<Refresh, "status">) =>
  ACTIVE_STATUSES.includes(refresh.status);

export const emptyCounts = (): RefreshCounts => ({
  captures: 0,
  unchanged: 0,
  observed: 0,
  unchangedTransactions: 0,
  unlisted: 0,
  failures: 0,
  created: 0,
  updated: 0,
});

/** A start: the refresh it created or met, and why none started when one did not. */
export interface RefreshStartResult {
  connectionId: string;
  refresh: Refresh | null;
  /** Null when this start created the refresh; a retried occurrence reports its skip. */
  reason: SkipReason | null;
}

/** What admitting a refresh did. */
export type Admission =
  | { reason: null; created: Refresh }
  /** Its scheduled occurrence is already recorded; a grown missed gap extends it. */
  | { reason: "occurrence"; existing: Refresh }
  /** A rule refused it; a scheduled occurrence records its skip. */
  | { reason: NotStartedReason; met: Refresh; skipped?: Refresh };

/** Refresh history, written outside a collection lease. */
export interface RefreshStore {
  /**
   * Records a refresh, evaluating every admission rule under its connection's
   * lock in the same transaction as the insert: an already recorded
   * occurrence, then an active refresh (busy) and, unless an operator asked,
   * the attention block and the cooldown. A skipped refresh is only
   * deduplicated, except that a retried missed gap that grew extends its record.
   */
  admitRefresh(
    refresh: Refresh,
    rules: { operator: boolean; now: number },
  ): Promise<Admission>;
  /** Every pending or running refresh, for resumption. */
  activeRefreshes(): Promise<Refresh[]>;
}

/** What a refresh records while it runs; every write is fenced by its lease. */
export interface RefreshProgress {
  status?: RefreshStatus;
  startedAt?: string;
  finishedAt?: string;
  requiresAttention?: boolean;
  counts?: RefreshCounts;
  failureReason?: FailureReason;
  window?: { from: string; status: WindowStatus };
}

/** The skip a scheduled occurrence records when a rule refuses it. */
export function skippedRefresh(
  refresh: Refresh,
  reason: SkipReason,
  now: number,
): Refresh {
  return {
    ...refresh,
    status: "skipped",
    skipReason: reason,
    finishedAt: new Date(now).toISOString(),
    requiresAttention: reason === "requires_attention",
    windows: [],
  };
}

/** What a refresh health event records of a finished refresh. */
export type RefreshHealth = Pick<
  Refresh,
  | "id"
  | "connectionId"
  | "trigger"
  | "status"
  | "failureCodes"
  | "requiresAttention"
>;

const FINISHED_STATUSES = ["completed", "partial", "failed"] as const;

function finishedStatus(status: RefreshStatus) {
  return FINISHED_STATUSES.find((finished) => finished === status);
}

function healthDocument(
  refresh: RefreshHealth,
  status: RefreshHealthDocument["status"],
): RefreshHealthDocument {
  return {
    refreshId: refresh.id,
    trigger: refresh.trigger,
    status,
    failureCodes: [...refresh.failureCodes],
    requiresAttention: refresh.requiresAttention,
  };
}

/**
 * The health events of an active refresh entering a finished state, committed
 * with that state. `previous` is the connection's last finished refresh, whose
 * attention flag is the block admission enforces, so attention is announced
 * when the block starts and when it ends, never per skipped occurrence.
 */
export function refreshHealthEvents(
  previous: RefreshHealth | undefined,
  refresh: RefreshHealth,
  createdAt: string,
): LedgerEventWrite[] {
  const status = finishedStatus(refresh.status);
  if (!status) {
    return [];
  }
  const previousStatus = previous && finishedStatus(previous.status);
  const before =
    previous && previousStatus
      ? healthDocument(previous, previousStatus)
      : null;
  const after = healthDocument(refresh, status);
  const blocked = before?.requiresAttention ?? false;
  const types: EventType[] = [];
  if (status !== "completed") {
    types.push("refresh.failed");
  }
  if (!blocked && after.requiresAttention) {
    types.push("refresh.attention_required");
  } else if (blocked && !after.requiresAttention) {
    types.push("refresh.recovered");
  }
  return types.map((type) => ({
    type,
    connectionId: refresh.connectionId,
    transactionId: null,
    runId: null,
    createdAt,
    actor: "system",
    before,
    after,
  }));
}

/** Refresh progress; only a collection's lease-fenced store offers it. */
export interface RefreshWriter {
  updateRefresh(id: string, progress: RefreshProgress): Promise<void>;
}

/** Inclusive calendar months covering a range, newest first, clipped to it. */
export function monthWindows(range: CollectionRange): RefreshWindow[] {
  const index = (date: string) =>
    Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
  const windows: RefreshWindow[] = [];
  for (let month = index(range.to); month >= index(range.from); month -= 1) {
    const year = Math.floor(month / 12);
    const monthNumber = (month % 12) + 1;
    const prefix = `${String(year).padStart(4, "0")}-${String(monthNumber).padStart(2, "0")}`;
    // Day 0 of the next month is this month's last day. setUTCFullYear keeps
    // years below 100 literal, which Date.UTC would shift into the 1900s.
    const lastDay = new Date(0);
    lastDay.setUTCFullYear(year, monthNumber, 0);
    const first = `${prefix}-01`;
    const end = `${prefix}-${String(lastDay.getUTCDate()).padStart(2, "0")}`;
    windows.push({
      from: first < range.from ? range.from : first,
      to: end > range.to ? range.to : end,
      status: "pending",
    });
  }
  return windows;
}

/** A refresh's inclusive date bounds: real dates, ascending, at most 120 months. */
export function validateRefreshRange(range: CollectionRange): CollectionRange {
  const valid = validateCollectionRange(range);
  if (monthWindows(valid).length > MAX_REFRESH_MONTHS) {
    throw new Error(
      `A refresh range spans at most ${MAX_REFRESH_MONTHS} months`,
    );
  }
  return valid;
}

/** A start that did not create a refresh, with the refresh it met. */
export class RefreshNotStartedError extends Error {
  constructor(
    readonly reason: NotStartedReason,
    readonly refresh: Refresh | undefined,
  ) {
    super(reason);
  }
}
