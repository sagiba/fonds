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
  type RefreshEstimate,
  type RefreshResumeResult,
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
 * stored. An execution resuming a refresh, whatever triggered it and whether
 * or not its host bounds invocations, waits this long after its connection's
 * last login attempt, so resumptions do not log in back to back. No longer
 * than a unit: a yielding invocation, which started its last unit with a
 * unit's time left, can always wait it out before continuing.
 */
export const LOGIN_INTERVAL_MS = 600_000;

/** Connection config key: when the connection last attempted a provider login. */
const LOGIN_ATTEMPT_KEY = "providerLoginAttemptAt";

/** Waits before retrying a held lease or a failed execution: past a lease's minute. */
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 32_000];

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
  /** The pause between a connection's logins when a refresh resumes. */
  loginIntervalMs?: number;
  /** Waits before a paced continuation; tests drive it with their own clock. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (entry: object) => void;
  debugArchiveDays?: number;
}

type Outcome = "done" | "yielded" | "paced" | "busy" | "interrupted";

/** One execution in this process: its outcome, then its settling. */
interface Execution {
  /** Undefined when the execution never ran, as after an earlier yield. */
  outcome: Promise<Outcome | "error" | undefined>;
  /** Resolves once a paced continuation has waited, too. */
  settled: Promise<void>;
}

/** Resolves to `work`'s value, or to undefined after `ms`. */
async function within<T>(work: Promise<T>, ms: number | undefined) {
  if (ms === undefined) {
    return work;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

/**
 * Reports each failure the collector emits, passing every event through, and
 * runs `beforeLogin` before each provider login it attempts.
 */
function watched(
  collector: ProviderCollector,
  onFailure: (code: CollectionFailure["code"]) => void,
  beforeLogin: () => Promise<void>,
): ProviderCollector {
  return {
    ...collector,
    async *collect(options) {
      for await (const event of collector.collect({
        ...options,
        beforeLogin,
      })) {
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
 * ranged refresh. A crashed, interrupted or yielded refresh stays active until
 * `resumeStalled` or `resume` continues it, redoing only its unfinished months.
 */
export function createRefreshService(options: RefreshServiceOptions) {
  const { store } = options;
  const log = safeLog(
    options.log ?? ((entry: object) => console.info(JSON.stringify(entry))),
  );
  const emit = syncDiagnostics(log);
  const shutdown = options.signal ?? new AbortController().signal;
  const loginIntervalMs = options.loginIntervalMs ?? LOGIN_INTERVAL_MS;
  const sleep =
    options.sleep ??
    ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  /** Executions in this process, by refresh, until each settles. */
  const running = new Map<string, Execution>();
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
    // A start never continues the active refresh it met: that is `resume`.
    return {
      result: { connectionId, refresh: admission.skipped ?? met, reason },
      launch: [],
    };
  }

  /** When a resumed refresh may log in again: the login interval after its connection's last login attempt. */
  async function loginAllowedAt(
    reader: Pick<RefreshDatabase, "getStoredConnection">,
    refresh: Refresh,
  ) {
    if (refresh.startedAt === null) {
      return 0;
    }
    const attempted = (await reader.getStoredConnection(refresh.connectionId))
      ?.config[LOGIN_ATTEMPT_KEY];
    return typeof attempted === "string"
      ? Date.parse(attempted) + loginIntervalMs
      : 0;
  }

  /**
   * Delays a continuation until the first of these refreshes may log in,
   * within this invocation's budget.
   */
  async function paceContinuation(ids: readonly string[], deadline: number) {
    try {
      let due = Number.POSITIVE_INFINITY;
      for (const id of ids) {
        const refresh = await store.getRefresh(id);
        if (refresh && isActive(refresh)) {
          due = Math.min(due, await loginAllowedAt(store, refresh));
        }
      }
      const waitMs = Math.min(due - Date.now(), deadline - performance.now());
      if (waitMs > 0) {
        await sleep(waitMs, shutdown).catch(() => {});
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
    // Checked under the lease against the persisted attempt, so no trigger,
    // process or host budget resumes with a login sooner than the interval.
    if (Date.now() < (await loginAllowedAt(locked, current))) {
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
      // Recorded before provider access, so a continuation after an execution
      // that died mid-login still waits for the login interval: once here,
      // for a collector that reports no logins, then before each login the
      // collector attempts, renewals included.
      const recordLoginAttempt = async () => {
        await locked.updateConfig(current.connectionId, (config) => ({
          ...config,
          [LOGIN_ATTEMPT_KEY]: new Date().toISOString(),
        }));
      };
      await recordLoginAttempt();
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
          watched(
            collector,
            (code) => {
              stop ||= STOPPING_CODES.has(code);
            },
            recordLoginAttempt,
          ),
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
   * retried with backoff; what stays unfinished resumes on a later tick,
   * continuation or explicit resume, and expires a day after its creation.
   */
  function launch(
    ids: readonly string[],
    retries = options.retryDelaysMs ?? RETRY_DELAYS_MS,
  ) {
    const fresh = [...new Set(ids)].filter((id) => !running.has(id));
    if (!fresh.length) {
      return;
    }
    const executions = new Map(
      fresh.map((id) => [
        id,
        {
          outcome: Promise.withResolvers<Outcome | "error" | undefined>(),
          settled: Promise.withResolvers<void>(),
        },
      ]),
    );
    for (const [id, { outcome, settled }] of executions) {
      running.set(id, {
        outcome: outcome.promise,
        settled: settled.promise,
      });
    }
    const deadline =
      options.budgetMs === undefined
        ? undefined
        : performance.now() + options.budgetMs;
    const settle = (id: string) => {
      const execution = executions.get(id)!;
      execution.outcome.resolve(undefined);
      running.delete(id);
      execution.settled.resolve();
    };
    const chain = (async () => {
      // An exhausted budget stops the batch; one connection's login pacing
      // only defers that refresh, so the others still execute.
      let yielded = false;
      const deferred: string[] = [];
      for (const id of fresh) {
        if (!yielded && !shutdown.aborted) {
          const outcome = await executeWithRetries(id, deadline, retries);
          executions.get(id)!.outcome.resolve(outcome);
          yielded = outcome === "yielded";
          if (yielded || outcome === "paced") {
            deferred.push(id);
            continue;
          }
        }
        settle(id);
      }
      if (deferred.length && deadline !== undefined && options.continueLater) {
        // Still marked running here, so a resume starts no second waiter.
        await paceContinuation(deferred, deadline);
      }
      deferred.forEach(settle);
      if (deferred.length) {
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

    /**
     * What a refresh of one connection, or of every collectable one, would
     * request, from the stored catalog; nothing is recorded or collected.
     */
    async estimate(
      connectionId: string | undefined,
      range?: CollectionRange,
    ): Promise<RefreshEstimate[]> {
      if (range) {
        validateRefreshRange(range);
      }
      const { targets, failures } = await discover();
      const chosen = targets.filter(
        (target) =>
          connectionId === undefined || target.connectionId === connectionId,
      );
      if (connectionId !== undefined && chosen.length === 0) {
        throw failures
          ? new Error("Refresh targets could not be discovered")
          : new NotFoundError("Refresh connection not found");
      }
      const windows = range ? monthWindows(range).length : null;
      const estimates: RefreshEstimate[] = [];
      for (const target of chosen) {
        const cards = await discoveredCount(
          store,
          "cards",
          target.connectionId,
        );
        const accounts = await discoveredCount(
          store,
          "accounts",
          target.connectionId,
        );
        estimates.push({
          connectionId: target.connectionId,
          range: range ?? null,
          windows: windows ?? 1,
          cards,
          providerCalls:
            target.estimateRequests && cards > 0
              ? target.estimateRequests({ windows, cards, accounts })
              : null,
        });
      }
      return estimates;
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
          ? [running.get(result.refresh.id)!.settled]
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
     * Continues one existing refresh, keeping its identity, range and
     * checkpoints. Admission is not repeated, so a manual retry admitted past
     * an attention block stays resumable; a finished refresh is never reopened,
     * and execution still honors a recorded stop and the login interval.
     * Answers once the execution's outcome is known, or after `ms`.
     */
    async resume(refreshId: string, ms?: number): Promise<RefreshResumeResult> {
      const refresh = await store.getRefresh(refreshId);
      if (!refresh) {
        throw new NotFoundError("Refresh not found");
      }
      if (!isActive(refresh)) {
        return { refresh, outcome: "terminal", retryAt: null };
      }
      launch([refreshId]);
      const execution = running.get(refreshId);
      const outcome = execution && (await within(execution.outcome, ms));
      const current = (await store.getRefresh(refreshId)) ?? refresh;
      if (!isActive(current)) {
        return { refresh: current, outcome: "terminal", retryAt: null };
      }
      if (outcome === "paced") {
        const retryAt = await loginAllowedAt(store, current);
        return {
          refresh: current,
          outcome: "held",
          retryAt: new Date(retryAt).toISOString(),
        };
      }
      return { refresh: current, outcome: "accepted", retryAt: null };
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

/**
 * How many cards or accounts discovery has recorded for a connection. A card
 * known only from transactions was never discovered (`lastSeenAt` null), so it
 * says nothing about what a refresh would request.
 */
async function discoveredCount(
  store: RefreshDatabase,
  kind: "cards" | "accounts",
  connectionId: string,
) {
  let size = 0;
  let after: { createdAt: string; id: string } | undefined;
  for (;;) {
    const page =
      kind === "cards"
        ? await store
            .listCards({ connectionId, limit: 200, after })
            .then(({ cards, hasMore }) => ({ rows: cards, hasMore }))
        : await store
            .listAccounts({ connectionId, limit: 200, after })
            .then(({ accounts, hasMore }) => ({ rows: accounts, hasMore }));
    size += page.rows.filter((row) => row.lastSeenAt !== null).length;
    const last = page.rows.at(-1);
    if (!page.hasMore || !last) {
      return size;
    }
    after = { createdAt: last.createdAt, id: last.id };
  }
}

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
    resume: (refreshId: string) => service.resume(refreshId, waitMs),
    estimate: (connectionId: string | undefined, range?: CollectionRange) =>
      service.estimate(connectionId, range),
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

/**
 * An operator's foreground resume of one active refresh, under the same lease
 * and rules as the server's resume. Resolves once its execution settles.
 */
export async function runOperatorResume(input: {
  store: RefreshDatabase;
  targets(): Promise<CollectionDiscovery>;
  refreshId: string;
  log?: (entry: object) => void;
}) {
  const service = createRefreshService({
    store: input.store,
    targets: input.targets,
    log: input.log ?? (() => {}),
  });
  const result = await service.resume(input.refreshId);
  await service.settled();
  return result;
}
