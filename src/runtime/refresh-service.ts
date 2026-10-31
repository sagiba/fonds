import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  collectFromStore,
  type CollectionSummary,
} from "../application/collection.js";
import {
  type CollectionLock,
  type LockedCollectionStore,
  ManualRecoveryRequiredError,
  RetryableRecoveryError,
} from "../application/collection-lock.js";
import type { InternalStore } from "../application/financial-store.js";
import {
  emptyCounts,
  isActive,
  monthWindows,
  PROVIDER_STOP_REASONS,
  type Refresh,
  REFRESH_MAX_AGE_MS,
  type RefreshStartResult,
  type RefreshTrigger,
  skippedRefresh,
  validateRefreshRange,
  type WindowStatus,
} from "../application/refreshes.js";
import type {
  MissedOccurrences,
  ScheduledOccurrence,
} from "../application/scheduled-collections.js";
import {
  elapsedMs,
  safeLog,
  syncDiagnostics,
} from "../application/sync-diagnostics.js";
import { NotFoundError } from "../domain/errors.js";
import type { CollectionFailure } from "../domain/records.js";
import type {
  CollectionRange,
  ProviderCollector,
} from "../domain/source-adapter.js";
import type {
  CollectionDiscovery,
  CollectionTarget,
} from "./collection-routes.js";

/** Any backend's store with its collection lock. */
export type RefreshDatabase = InternalStore & CollectionLock;

/** A month window, or a recent refresh, runs at most this long. */
export const UNIT_DEADLINE_MS = 600_000;

/**
 * Each execution logs in to the provider again; provider sessions are never
 * stored. A budgeted execution resuming a refresh waits this long after its
 * connection's last login attempt, so continuation slices do not log in back
 * to back. No longer than a unit: a yielding invocation, which started its last
 * unit with a unit's time left, can always wait it out before continuing.
 */
export const LOGIN_INTERVAL_MS = 600_000;

/** Connection config key: when an execution last began provider access. */
const LOGIN_ATTEMPT_KEY = "providerLoginAttemptAt";

/** Waits before retrying a held lease or a failed execution: past a lease's minute. */
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 32_000];

/** A read continues a refresh at most this often per process. */
const RECOVERY_INTERVAL_MS = 30_000;

/** Failures after which no further window of the refresh is requested. */
const STOPPING_CODES: ReadonlySet<CollectionFailure["code"]> = new Set(
  PROVIDER_STOP_REASONS,
);

export interface RefreshStart {
  trigger: RefreshTrigger;
  range?: CollectionRange | undefined;
  /** The operator's retry, past the attention block and the cooldown. */
  operator?: boolean;
  /** The scheduled occurrence a scheduled refresh belongs to. */
  occurrence?: ScheduledOccurrence;
}

export interface RefreshServiceOptions {
  store: RefreshDatabase;
  /** Resolved at every start: stored credentials can be added between runs. */
  targets(): Promise<CollectionDiscovery>;
  /** Runs after each finished refresh, such as Events delivery. */
  afterRefresh?: (signal: AbortSignal) => Promise<void>;
  /** Interrupts executions, as the service shuts down; they resume later. */
  signal?: AbortSignal;
  /** Keeps the host alive for work that outlasts its request (Neon's waitUntil). */
  background?: (work: Promise<unknown>) => void;
  /**
   * How long one invocation may execute. A refresh that would need longer
   * stops between windows and `continueLater` resumes it elsewhere.
   */
  budgetMs?: number;
  continueLater?: () => Promise<void>;
  /** Waits before each retry of a held lease or a failed execution. */
  retryDelaysMs?: readonly number[];
  /** The pause between a connection's logins in budgeted continuations. */
  loginIntervalMs?: number;
  log?: (entry: object) => void;
  debugArchiveDays?: number;
}

type Outcome = "done" | "yielded" | "paced" | "busy" | "interrupted";

/** Completed when every window completed; failed when none yielded evidence. */
function rangeStatus(statuses: readonly WindowStatus[]) {
  if (statuses.every((status) => status === "completed")) {
    return "completed" as const;
  }
  return statuses.some(
    (status) => status === "completed" || status === "partial",
  )
    ? ("partial" as const)
    : ("failed" as const);
}

/** Reports each failure the collector emits, passing every event through. */
function watched(
  collector: ProviderCollector,
  onFailure: (code: CollectionFailure["code"]) => void,
): ProviderCollector {
  return {
    ...collector,
    async *collect(options) {
      for await (const event of collector.collect(options)) {
        if (event.type === "failure") {
          onFailure(event.failure.code);
        }
        yield event;
      }
    },
  };
}

/**
 * Starts, executes and resumes refreshes on any backend. A start records the
 * refresh and returns at once; execution takes the connection's collection
 * lease, so it runs once across processes, and checkpoints each month of a
 * ranged refresh. A crashed, interrupted or yielded refresh stays active and
 * `resumeStalled` continues it, redoing only its unfinished months.
 */
export function createRefreshService(options: RefreshServiceOptions) {
  const { store } = options;
  const log = safeLog(
    options.log ?? ((entry: object) => console.info(JSON.stringify(entry))),
  );
  const emit = syncDiagnostics(log);
  const shutdown = options.signal ?? new AbortController().signal;
  const loginIntervalMs = options.loginIntervalMs ?? LOGIN_INTERVAL_MS;
  /** Executions in this process, by refresh, until each settles. */
  const running = new Map<string, Promise<void>>();
  /** When a read last tried to continue each refresh. */
  const recoveries = new Map<string, number>();
  const chains = new Set<Promise<void>>();

  async function discover(): Promise<CollectionDiscovery> {
    try {
      return await options.targets();
    } catch {
      log({ event: "fonds_refresh_discovery_failed" });
      return { targets: [], failures: 1 };
    }
  }

  function record(connectionId: string, input: RefreshStart): Refresh {
    const range = input.range ?? null;
    return {
      id: randomUUID(),
      connectionId,
      trigger: input.trigger,
      status: "pending",
      skipReason: null,
      range,
      occurrence: input.occurrence?.key ?? null,
      scheduledAt: input.occurrence
        ? new Date(input.occurrence.at).toISOString()
        : null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      requiresAttention: false,
      hasAcceptedEvidence: false,
      providerStopReason: null,
      counts: emptyCounts(),
      failureCodes: [],
      failureReason: null,
      missed: null,
      windows: range ? monthWindows(range) : [],
    };
  }

  /** Records a refresh, or why none started; a scheduled occurrence records its skip. */
  async function admit(
    connectionId: string,
    input: RefreshStart,
  ): Promise<{ result: RefreshStartResult; launch: string[] }> {
    const admission = await store.admitRefresh(record(connectionId, input), {
      operator: Boolean(input.operator),
      now: Date.now(),
    });
    if (admission.reason === null) {
      return {
        result: { connectionId, refresh: admission.created, reason: null },
        launch: [admission.created.id],
      };
    }
    if (admission.reason === "occurrence") {
      // A recorded occurrence, retried: report it, and run it if still active.
      const { existing } = admission;
      return {
        result: {
          connectionId,
          refresh: existing,
          reason: existing.skipReason,
        },
        launch: isActive(existing) ? [existing.id] : [],
      };
    }
    const { reason, met } = admission;
    return {
      result: { connectionId, refresh: admission.skipped ?? met, reason },
      // One nobody runs any more (its process died) resumes here, unless an
      // operator asked for its own refresh.
      launch: reason === "busy" && !input.operator ? [met.id] : [],
    };
  }

  /** When a resumed refresh may log in again: the login interval after its connection's last login attempt. */
  async function loginAllowedAt(refresh: Refresh) {
    if (refresh.startedAt === null) {
      return 0;
    }
    const attempted = (await store.getStoredConnection(refresh.connectionId))
      ?.config[LOGIN_ATTEMPT_KEY];
    return typeof attempted === "string"
      ? Date.parse(attempted) + loginIntervalMs
      : 0;
  }

  /** A budgeted continuation that arrived too soon after the last login. */
  async function awaitsLoginInterval(
    refresh: Refresh,
    deadline: number | undefined,
  ) {
    return (
      deadline !== undefined && Date.now() < (await loginAllowedAt(refresh))
    );
  }

  /** Delays a continuation until its login is due, within this invocation's budget. */
  async function paceContinuation(id: string, deadline: number) {
    try {
      const refresh = await store.getRefresh(id);
      if (!refresh || !isActive(refresh)) {
        return;
      }
      const waitMs = Math.min(
        (await loginAllowedAt(refresh)) - Date.now(),
        deadline - performance.now(),
      );
      if (waitMs > 0) {
        await delay(waitMs, undefined, { signal: shutdown }).catch(() => {});
      }
    } catch {
      // The continuation's own check paces it instead.
    }
  }

  async function run(
    locked: LockedCollectionStore,
    signal: AbortSignal,
    id: string,
    target: CollectionTarget | undefined,
    deadline: number | undefined,
  ): Promise<Outcome> {
    const current = await locked.getRefresh(id);
    if (!current || !isActive(current)) {
      return "done";
    }
    const cannotFinishUnit = () =>
      deadline !== undefined && deadline - performance.now() < UNIT_DEADLINE_MS;
    // A refresh that cannot finish one unit here stays as it is, for elsewhere.
    if (cannotFinishUnit()) {
      return "yielded";
    }
    const statuses = new Map(
      current.windows.map((window) => [window.from, window.status]),
    );
    let activeWindow = current.windows.find(
      (window) => window.status === "running",
    )?.from;
    let hasAcceptedEvidence = Boolean(current.hasAcceptedEvidence);
    const acceptedWindows = new Set(
      current.windows
        .filter((window) => window.hasAcceptedEvidence)
        .map((window) => window.from),
    );
    let activeWindowAccepted =
      activeWindow !== undefined && acceptedWindows.has(activeWindow);
    const finishActiveWindow = () => {
      if (!activeWindow || statuses.get(activeWindow) !== "running") {
        return undefined;
      }
      const status = activeWindowAccepted
        ? ("partial" as const)
        : ("failed" as const);
      statuses.set(activeWindow, status);
      return { from: activeWindow, status };
    };
    const failureStatus = () =>
      current.range
        ? rangeStatus([...statuses.values()])
        : hasAcceptedEvidence
          ? ("partial" as const)
          : ("failed" as const);
    const now = new Date().toISOString();
    if (Date.now() - Date.parse(current.createdAt) > REFRESH_MAX_AGE_MS) {
      const window = finishActiveWindow();
      await locked.updateRefresh(id, {
        status: "failed",
        ...(window && { window }),
        failureReason: "expired",
        startedAt: current.startedAt ?? now,
        finishedAt: now,
        // A failed refresh counts at least one failure.
        counts: {
          ...current.counts,
          failures: Math.max(1, current.counts.failures),
        },
      });
      return "done";
    }
    // A provider stop already recorded is final; it is never requested again.
    if (current.requiresAttention || current.providerStopReason) {
      const window = finishActiveWindow();
      await locked.updateRefresh(id, {
        status: failureStatus(),
        ...(window && { window }),
        startedAt: current.startedAt ?? now,
        finishedAt: now,
      });
      return "done";
    }
    if (await awaitsLoginInterval(current, deadline)) {
      return "paced";
    }
    let counts = current.counts;
    let requiresAttention: boolean = current.requiresAttention;
    let providerStopped = Boolean(current.providerStopReason);
    const reloadProgress = async () => {
      const persisted = await locked.getRefresh(id);
      if (!persisted) {
        throw new Error("Refresh progress disappeared");
      }
      counts = persisted.counts;
      requiresAttention = persisted.requiresAttention;
      hasAcceptedEvidence = Boolean(persisted.hasAcceptedEvidence);
      providerStopped = Boolean(persisted.providerStopReason);
      for (const window of persisted.windows) {
        statuses.set(window.from, window.status);
        if (window.hasAcceptedEvidence) {
          acceptedWindows.add(window.from);
        }
      }
      activeWindowAccepted =
        activeWindow !== undefined && acceptedWindows.has(activeWindow);
    };
    let recovering = false;
    let recoveryStarted = 0;
    await locked.updateRefresh(id, {
      status: "running",
      startedAt: current.startedAt ?? now,
    });
    let status: "completed" | "partial" | "failed";
    let failedWindow: ReturnType<typeof finishActiveWindow>;
    try {
      if (!target) {
        throw new Error("Refresh connection cannot be collected");
      }
      recoveryStarted = performance.now();
      recovering = true;
      emit({
        event: "fonds_sync",
        refreshId: id,
        stage: "recovery",
        outcome: "started",
      });
      const replayed = await locked.recoverPendingRuns(target.adapter, log, id);
      await reloadProgress();
      recovering = false;
      emit({
        event: "fonds_sync",
        refreshId: id,
        stage: "recovery",
        outcome: "completed",
        reason: "pending_runs_recovered",
        durationMs: elapsedMs(recoveryStarted),
        counts: { recoveredRuns: replayed.length },
      });
      if (requiresAttention || providerStopped) {
        const window = finishActiveWindow();
        await locked.updateRefresh(id, {
          status: failureStatus(),
          ...(window && { window }),
          finishedAt: new Date().toISOString(),
          counts,
          requiresAttention,
        });
        return "done";
      }
      // Recorded before any provider access, so a continuation after an
      // execution that died mid-login still waits for the login interval.
      await locked.updateConfig(current.connectionId, (config) => ({
        ...config,
        [LOGIN_ATTEMPT_KEY]: new Date().toISOString(),
      }));
      // Credentials are read only once this execution holds the lease.
      const collector = await target.collector();
      if (collector.provider !== target.adapter.provider) {
        throw new Error("Collector does not match the adapter");
      }
      const units = current.range
        ? current.windows.filter(
            (window) =>
              window.status === "pending" || window.status === "running",
          )
        : [undefined];
      let recent: CollectionSummary["status"] = "failed";
      for (const window of units) {
        if (cannotFinishUnit()) {
          return "yielded";
        }
        signal.throwIfAborted();
        if (window) {
          activeWindow = window.from;
          activeWindowAccepted = acceptedWindows.has(window.from);
          statuses.set(window.from, "running");
          await locked.updateRefresh(id, {
            window: { from: window.from, status: "running" },
          });
        }
        let stop = false;
        const summary = await collectFromStore(
          locked,
          {
            connectionId: current.connectionId,
            refreshId: id,
            onDiagnostic: log,
            ...(options.debugArchiveDays !== undefined && {
              debugArchiveDays: options.debugArchiveDays,
            }),
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(UNIT_DEADLINE_MS),
            ]),
            ...(window && { range: { from: window.from, to: window.to } }),
          },
          watched(collector, (code) => {
            stop ||= STOPPING_CODES.has(code);
          }),
          target.adapter,
        );
        await reloadProgress();
        // Financial commits already own these counts; a retried unit creates new
        // observations without charging its previous application twice.
        if (signal.aborted) {
          return "interrupted";
        }
        const accepted = window ? activeWindowAccepted : hasAcceptedEvidence;
        const unitStatus =
          summary.status === "failed" && accepted ? "partial" : summary.status;
        if (window) {
          statuses.set(window.from, unitStatus);
        } else {
          recent = unitStatus;
        }
        // A stop finishes the refresh in the same write as its checkpoint,
        // so no resume requests the provider again.
        await locked.updateRefresh(id, {
          counts,
          requiresAttention,
          ...(window && {
            window: { from: window.from, status: unitStatus },
          }),
          ...(stop
            ? {
                status: current.range
                  ? rangeStatus([...statuses.values()])
                  : unitStatus,
                finishedAt: new Date().toISOString(),
              }
            : {}),
        });
        activeWindow = undefined;
        activeWindowAccepted = false;
        if (stop) {
          return "done";
        }
      }
      status = current.range ? rangeStatus([...statuses.values()]) : recent;
    } catch (error) {
      // Some captures may have committed before a later capture or recovery failed.
      await reloadProgress();
      const manualRecovery = error instanceof ManualRecoveryRequiredError;
      if (manualRecovery) {
        requiresAttention = true;
      }
      const interrupted = signal.aborted && !manualRecovery;
      if (recovering) {
        emit({
          event: "fonds_sync",
          refreshId: id,
          stage: "recovery",
          outcome: interrupted ? "interrupted" : "failed",
          reason: manualRecovery
            ? "manual_recovery_required"
            : interrupted
              ? "cancelled"
              : "persistence_failure",
          requiresAttention,
          failureCategory: manualRecovery
            ? error.failureCategory
            : interrupted
              ? "execution"
              : "persistence",
          durationMs: elapsedMs(recoveryStarted),
        });
      }
      if (interrupted) {
        return "interrupted";
      }
      if (error instanceof RetryableRecoveryError) {
        throw error;
      }
      // Raw provider and driver errors can hold financial data or credentials.
      failedWindow = finishActiveWindow();
      status = failureStatus();
      counts = { ...counts, failures: Math.max(1, counts.failures) };
    }
    await locked.updateRefresh(id, {
      status,
      ...(failedWindow && { window: failedWindow }),
      finishedAt: new Date().toISOString(),
      counts,
      requiresAttention,
    });
    return "done";
  }

  async function execute(id: string, deadline: number | undefined) {
    const started = performance.now();
    emit({
      event: "fonds_sync",
      refreshId: id,
      stage: "refresh",
      outcome: "started",
    });
    const refresh = await store.getRefresh(id);
    if (!refresh || !isActive(refresh)) {
      return "done" as const;
    }
    const target = (await discover()).targets.find(
      (candidate) => candidate.connectionId === refresh.connectionId,
    );
    const attempt = await store.withCollectionLock(
      refresh.connectionId,
      (locked, lockSignal) =>
        run(
          locked,
          AbortSignal.any([shutdown, lockSignal]),
          id,
          target,
          deadline,
        ),
    );
    const outcome = attempt.acquired ? attempt.result : "busy";
    if (outcome === "done") {
      try {
        await options.afterRefresh?.(shutdown);
      } catch {
        log({ event: "fonds_refresh_delivery", status: "failed" });
      }
    }
    const final = await store.getRefresh(id);
    emit({
      event: "fonds_sync",
      refreshId: id,
      stage: "refresh",
      outcome:
        outcome === "done"
          ? final?.status === "partial"
            ? "partial"
            : final?.status === "failed"
              ? "failed"
              : "completed"
          : outcome === "paced"
            ? "yielded"
            : outcome,
      durationMs: elapsedMs(started),
      ...(outcome === "busy" && { reason: "lease_busy" }),
      ...(outcome === "yielded" && { reason: "budget" }),
      ...(outcome === "interrupted" && { reason: "cancelled" }),
      counts: {
        observed: final?.counts.observed,
        unchangedTransactions: final?.counts.unchangedTransactions,
        absent: final?.counts.unlisted,
        captures: final?.counts.captures,
        unchanged: final?.counts.unchanged,
        created: final?.counts.created,
        changed: final?.counts.updated,
        failures: final?.counts.failures,
      },
    });
    log({
      event: "fonds_refresh",
      provider: target?.adapter.provider ?? null,
      trigger: refresh.trigger,
      outcome,
      status: final?.status ?? null,
      ...final?.counts,
    });
    return outcome;
  }

  /** Executes one refresh, retrying a held lease or a failed execution. */
  async function executeWithRetries(
    id: string,
    deadline: number | undefined,
    retries: readonly number[],
  ): Promise<Outcome | "error"> {
    let outcome: Outcome | "error" = "error";
    for (let attempt = 0; attempt <= retries.length; attempt++) {
      if (attempt > 0) {
        emit({
          event: "fonds_sync",
          refreshId: id,
          stage: "refresh",
          outcome: "started",
          reason: "retry",
        });
        await delay(retries[attempt - 1]!, undefined, {
          signal: shutdown,
        }).catch(() => {});
      }
      if (shutdown.aborted) {
        break;
      }
      outcome = await execute(id, deadline).catch(() => {
        emit({
          event: "fonds_sync",
          refreshId: id,
          stage: "refresh",
          outcome: "failed",
          reason: "execution_failed",
          failureCategory: "execution",
        });
        log({ event: "fonds_refresh_failed" });
        return "error" as const;
      });
      if (outcome !== "busy" && outcome !== "error") {
        break;
      }
    }
    return outcome;
  }

  /**
   * Executes refreshes one after another. A lease
   * still held (a crashed holder's lasts a minute) or a failed execution is
   * retried with backoff; what stays unfinished resumes on a later tick, start
   * or read, and expires a day after its creation.
   */
  function launch(
    ids: readonly string[],
    retries = options.retryDelaysMs ?? RETRY_DELAYS_MS,
  ) {
    const fresh = [...new Set(ids)].filter((id) => !running.has(id));
    if (!fresh.length) {
      return;
    }
    const settled = new Map(
      fresh.map((id) => [id, Promise.withResolvers<void>()]),
    );
    for (const [id, { promise }] of settled) {
      running.set(id, promise);
    }
    const deadline =
      options.budgetMs === undefined
        ? undefined
        : performance.now() + options.budgetMs;
    const chain = (async () => {
      let yielded = false;
      for (const id of fresh) {
        if (!yielded && !shutdown.aborted) {
          const outcome = await executeWithRetries(id, deadline, retries);
          yielded = outcome === "yielded" || outcome === "paced";
          if (yielded && deadline !== undefined && options.continueLater) {
            // Still marked running here, so polls start no second waiter.
            await paceContinuation(id, deadline);
          }
        }
        running.delete(id);
        settled.get(id)!.resolve();
      }
      if (yielded) {
        await options
          .continueLater?.()
          .catch(() => log({ event: "fonds_refresh_continuation_failed" }));
      }
    })();
    chains.add(chain);
    void chain.finally(() => chains.delete(chain));
    options.background?.(chain);
  }

  return {
    /** Starts one connection's refresh; NotFoundError when it cannot be collected. */
    async start(connectionId: string, input: RefreshStart) {
      if (input.range) {
        validateRefreshRange(input.range);
      }
      const { targets, failures } = await discover();
      if (!targets.some((target) => target.connectionId === connectionId)) {
        // A connection that could not be discovered is not known to be missing.
        throw failures
          ? new Error("Refresh targets could not be discovered")
          : new NotFoundError("Refresh connection not found");
      }
      const { result, launch: ids } = await admit(connectionId, input);
      launch(ids);
      return result;
    },

    /** One refresh per collectable connection, executed in turn. */
    async startAll(input: RefreshStart) {
      if (input.range) {
        validateRefreshRange(input.range);
      }
      const admitted: Awaited<ReturnType<typeof admit>>[] = [];
      try {
        for (const target of (await discover()).targets) {
          admitted.push(await admit(target.connectionId, input));
        }
      } finally {
        // Refreshes recorded before a failure still run.
        launch(admitted.flatMap((entry) => entry.launch));
      }
      return admitted.map((entry) => entry.result);
    },

    /** The results' current state once their executions settle, or after `ms`. */
    async wait(results: readonly RefreshStartResult[], ms?: number) {
      // A refresh this start met rather than started is answered at once.
      const executions = results.flatMap((result) =>
        result.reason === null &&
        result.refresh &&
        running.has(result.refresh.id)
          ? [running.get(result.refresh.id)!]
          : [],
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(executions),
        ...(ms === undefined
          ? []
          : [
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, ms);
              }),
            ]),
      ]);
      clearTimeout(timer);
      return Promise.all(
        results.map(async (result) => ({
          ...result,
          refresh: result.refresh
            ? ((await store.getRefresh(result.refresh.id)) ?? result.refresh)
            : null,
        })),
      );
    },

    /** Continues every active refresh this process is not already running. */
    async resumeStalled() {
      launch((await store.activeRefreshes()).map((refresh) => refresh.id));
    },

    /**
     * A read of an active refresh: continues it here unless this process is
     * running it, at most every half minute, so polling alone finishes a
     * refresh whose process died.
     */
    recover(refresh: Refresh) {
      const last = recoveries.get(refresh.id) ?? 0;
      if (!isActive(refresh) || Date.now() - last < RECOVERY_INTERVAL_MS) {
        return;
      }
      recoveries.set(refresh.id, Date.now());
      launch([refresh.id], []);
    },

    /**
     * Records one skipped refresh per collectable connection for a gap of
     * occurrences that never ran: its first, its last and how many.
     */
    async recordMissed(gap: MissedOccurrences) {
      for (const target of (await discover()).targets) {
        await store.admitRefresh(
          {
            ...skippedRefresh(
              record(target.connectionId, {
                trigger: "scheduled",
                occurrence: gap.first,
              }),
              "missed",
              Date.now(),
            ),
            missed: {
              through: new Date(gap.last.at).toISOString(),
              count: gap.count,
            },
          },
          { operator: false, now: Date.now() },
        );
      }
    },

    /** Settles once every execution this process started has recorded its state. */
    async settled() {
      await Promise.allSettled([...chains]);
    },
  };
}

export type RefreshService = ReturnType<typeof createRefreshService>;

/** Owner and model starts: they return what finished within `waitMs`. */
export function ownerRefreshes(service: RefreshService, waitMs = 10_000) {
  return {
    start: async (connectionId: string, range?: CollectionRange) =>
      (
        await service.wait(
          [await service.start(connectionId, { trigger: "manual", range })],
          waitMs,
        )
      )[0]!,
    startAll: async (range?: CollectionRange) =>
      service.wait(
        await service.startAll({ trigger: "manual", range }),
        waitMs,
      ),
    recover: (refresh: Refresh) => service.recover(refresh),
  };
}

/**
 * An operator's foreground refresh of one connection, or of every collectable
 * one in turn, past the attention block and the cooldown: the same lease and
 * records as the server's, so the two serialize. Resolves once they settle.
 */
export async function runOperatorRefresh(input: {
  store: RefreshDatabase;
  targets(): Promise<CollectionDiscovery>;
  /** Every collectable connection when absent. */
  connectionId?: string | undefined;
  range?: CollectionRange | undefined;
  log?: (entry: object) => void;
  debugArchiveDays?: number;
}) {
  const service = createRefreshService({
    store: input.store,
    targets: input.targets,
    log: input.log ?? (() => {}),
    ...(input.debugArchiveDays !== undefined && {
      debugArchiveDays: input.debugArchiveDays,
    }),
  });
  const start: RefreshStart = {
    trigger: "manual",
    operator: true,
    range: input.range,
  };
  const results = await service.wait(
    input.connectionId === undefined
      ? await service.startAll(start)
      : [await service.start(input.connectionId, start)],
  );
  await service.settled();
  return results;
}
