import { randomInt } from "node:crypto";

import type { RefreshStartResult } from "../application/refreshes.js";
import type {
  MissedOccurrences,
  ScheduledCollectionStore,
  ScheduledOccurrence,
} from "../application/scheduled-collections.js";

/** Fixed, value-free schedule configuration messages. */
export class CollectionScheduleError extends Error {}

/** Scheduled collection: local hours at one minute, in an IANA time zone. */
export interface CollectionSchedule {
  mode: "daily" | "hourly" | "hours";
  /** Local wall-clock hours, ascending and distinct. */
  hours: readonly number[];
  minute: number;
  timeZone: string;
}

export interface CollectionScheduleSettings {
  FONDS_REFRESH_SCHEDULE?: string | undefined;
  FONDS_REFRESH_TIME?: string | undefined;
  FONDS_REFRESH_TIMEZONE?: string | undefined;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ALL_HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const pad = (value: number) => String(value).padStart(2, "0");

/** The stored setting that keeps a generated `FONDS_REFRESH_TIME`. */
export const COLLECTION_TIME_SETTING = "collection_time";

/** A random `HH:MM`, generated once per installation and then persisted. */
export function generateCollectionTime(
  random: (max: number) => number = randomInt,
) {
  return `${pad(random(24))}:${pad(random(60))}`;
}

function scheduleHours(value: string | undefined) {
  const text = value?.trim() ?? "";
  if (text === "daily") {
    return "daily";
  }
  if (text === "hourly") {
    return "hourly";
  }
  // Anything with a digit or comma is meant as an hour list; other words are off.
  if (!/[\d,]/.test(text)) {
    return undefined;
  }
  const hours = text.split(",").map((part) => part.trim());
  if (!hours.every((hour) => /^\d{1,2}$/.test(hour) && Number(hour) <= 23)) {
    throw new CollectionScheduleError(
      "FONDS_REFRESH_SCHEDULE must be daily, hourly or hours 0-23 such as 9,13,18",
    );
  }
  return [...new Set(hours.map(Number))].sort((a, b) => a - b);
}

/** The canonical name of a valid IANA time zone. */
function timeZoneName(value: string | undefined) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: value?.trim() || "UTC",
    }).resolvedOptions().timeZone;
  } catch {
    throw new CollectionScheduleError(
      "FONDS_REFRESH_TIMEZONE must be an IANA time zone such as Europe/London",
    );
  }
}

/**
 * The configured schedule, or undefined when scheduled collection is off:
 * absent or any value other than `daily`, `hourly` or an hour list.
 * `missingTime` explains how this host obtains `FONDS_REFRESH_TIME`.
 */
export function parseCollectionSchedule(
  settings: CollectionScheduleSettings,
  missingTime: string,
): CollectionSchedule | undefined {
  const hours = scheduleHours(settings.FONDS_REFRESH_SCHEDULE);
  if (hours === undefined) {
    return undefined;
  }
  if (!settings.FONDS_REFRESH_TIME) {
    throw new CollectionScheduleError(missingTime);
  }
  const time = TIME.exec(settings.FONDS_REFRESH_TIME);
  if (!time) {
    throw new CollectionScheduleError(
      "FONDS_REFRESH_TIME must be a 24-hour HH:MM time",
    );
  }
  const timeZone = timeZoneName(settings.FONDS_REFRESH_TIMEZONE);
  const minute = Number(time[2]);
  if (hours === "daily") {
    return { mode: "daily", hours: [Number(time[1])], minute, timeZone };
  }
  if (hours === "hourly") {
    return { mode: "hourly", hours: ALL_HOURS, minute, timeZone };
  }
  return { mode: "hours", hours, minute, timeZone };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock fields of an instant in a time zone, to the minute. */
function wallClock(instant: number, timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  const fields = Object.fromEntries(
    formatter
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return Date.UTC(
    fields.year!,
    fields.month! - 1,
    fields.day!,
    fields.hour!,
    fields.minute!,
  );
}

/** The zone's UTC offset at an instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string) {
  const minute = instant - (((instant % MINUTE) + MINUTE) % MINUTE);
  return wallClock(minute, timeZone) - minute;
}

/**
 * The instant a local wall-clock time names. A time repeated when clocks go
 * back is its first instant; a time skipped when they go forward moves later
 * by the length of the gap (as Temporal's `compatible` disambiguation does).
 */
function localInstant(wall: number, timeZone: string) {
  const before = wall - offsetAt(wall - DAY, timeZone);
  const after = wall - offsetAt(wall + DAY, timeZone);
  const valid = [before, after].filter(
    (instant) => wallClock(instant, timeZone) === wall,
  );
  return valid.length ? Math.min(...valid) : before;
}

/** UTC-instant keys stay unique when local hours repeat or move. */
export function occurrenceKey(at: number) {
  return `scheduled-${new Date(at).toISOString().slice(0, 16)}Z`;
}

/** Every occurrence within two local days of `now`, in order. */
function occurrencesAround(schedule: CollectionSchedule, now: number) {
  const today = wallClock(now, schedule.timeZone);
  const midnight = today - (today % DAY);
  const instants = new Set<number>();
  for (let day = -2; day <= 2; day += 1) {
    for (const hour of schedule.hours) {
      instants.add(
        localInstant(
          midnight + day * DAY + hour * 60 * MINUTE + schedule.minute * MINUTE,
          schedule.timeZone,
        ),
      );
    }
  }
  return [...instants]
    .sort((a, b) => a - b)
    .map((at) => ({ key: occurrenceKey(at), at }));
}

/** The latest occurrence due at or before `now`. */
export function latestOccurrence(
  schedule: CollectionSchedule,
  now: number,
): ScheduledOccurrence {
  return occurrencesAround(schedule, now).findLast(({ at }) => at <= now)!;
}

/** The first occurrence after `now`. */
export function nextOccurrence(
  schedule: CollectionSchedule,
  now: number,
): ScheduledOccurrence {
  return occurrencesAround(schedule, now).find(({ at }) => at > now)!;
}

/**
 * A five-field UTC cron for hosts whose scheduler has no time zone. Local
 * hours convert with the zone's offset at `now`, so a daylight-saving change
 * shifts the local run time until the cron is derived again.
 */
export function utcCron(schedule: CollectionSchedule, now: number) {
  const offsetMinutes = Math.round(offsetAt(now, schedule.timeZone) / MINUTE);
  const minutesPerDay = 24 * 60;
  const wrapDay = (minutes: number) =>
    ((minutes % minutesPerDay) + minutesPerDay) % minutesPerDay;
  const utcMinutes = schedule.hours.map((hour) =>
    wrapDay(hour * 60 + schedule.minute - offsetMinutes),
  );
  const minute = utcMinutes[0]! % 60;
  const hours = [
    ...new Set(utcMinutes.map((value) => Math.floor(value / 60))),
  ].sort((a, b) => a - b);
  return `${minute} ${hours.length === 24 ? "*" : hours.join(",")} * * *`;
}

/** The durable occurrence records the scheduler claims runs in. */
export type OccurrenceClaims = Pick<
  ScheduledCollectionStore,
  | "claimOccurrence"
  | "finishOccurrence"
  | "releaseOccurrence"
  | "latestClaimedOccurrence"
>;

export interface EmbeddedSchedulerOptions {
  /** Without one, only Events delivery runs. */
  schedule?: CollectionSchedule | undefined;
  claims: OccurrenceClaims;
  /** Starts the occurrence's refreshes. */
  collect?:
    | ((occurrence: ScheduledOccurrence) => Promise<RefreshStartResult[]>)
    | undefined;
  /** Settles once the started refreshes finish; the claim is held until then. */
  settle?: (results: RefreshStartResult[]) => Promise<unknown>;
  /** Records the gap of occurrences no process ran, before a later one runs. */
  missed?: (gap: MissedOccurrences) => Promise<void>;
  /** One bounded Events delivery pass. */
  deliver: (signal: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: (max: number) => number;
  tickMs?: number;
  /** Each occurrence starts up to this much after its time, per process. */
  maxJitterMs?: number;
  log?: (event: string, fields: object) => void;
}

/**
 * The generic Node host's in-process schedule. Each tick (about a minute)
 * recomputes the latest due occurrence from the wall clock, so suspend,
 * clock changes and restarts need no timer state, and runs it only after
 * claiming it in the database: one run per occurrence across restarts,
 * replicas and the HTTP trigger. Missed occurrences never burst: only the
 * latest one runs, and only until the next one is due. Ticks without a due
 * occurrence run an Events delivery pass, so retries keep their backoff.
 */
export function createEmbeddedScheduler(options: EmbeddedSchedulerOptions) {
  const now = options.now ?? Date.now;
  const random = options.random ?? randomInt;
  const tickMs = options.tickMs ?? 60_000;
  const maxJitterMs = options.maxJitterMs ?? 3 * MINUTE;
  const log =
    options.log ??
    ((event: string, fields: object) =>
      console.info(JSON.stringify({ event, ...fields })));
  const stopping = new AbortController();
  let interval: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<unknown> | undefined;
  /** Trigger runs, which no tick tracks, until they record their claims. */
  const triggered = new Set<Promise<unknown>>();
  let jitter: { key: string; ms: number } | undefined;
  if (options.schedule && !options.collect) {
    throw new Error("A collection schedule needs a collection path");
  }

  function jitterFor(occurrence: ScheduledOccurrence) {
    if (jitter?.key !== occurrence.key) {
      jitter = { key: occurrence.key, ms: maxJitterMs && random(maxJitterMs) };
    }
    return jitter.ms;
  }

  /** The gap between the last claimed occurrence and `occurrence`, if any. */
  function missedBefore(
    occurrence: ScheduledOccurrence,
    last: number,
  ): MissedOccurrences | undefined {
    let gap: MissedOccurrences | undefined;
    let at = occurrence.at;
    for (;;) {
      const previous = latestOccurrence(options.schedule!, at - 1);
      if (previous.at <= last) {
        return gap;
      }
      gap = gap
        ? { ...gap, first: previous, count: gap.count + 1 }
        : { first: previous, last: previous, count: 1 };
      at = previous.at;
    }
  }

  /** Runs an occurrence once claimed; undefined when it was already handled. */
  async function runClaimed(
    occurrence: ScheduledOccurrence,
    onStarted?: (results: RefreshStartResult[]) => void,
  ) {
    const last = await options.claims.latestClaimedOccurrence();
    // The gap is recorded before the claim advances the baseline it is
    // measured from, so a failed write is retried at the next tick; its
    // records are keyed by their first occurrence, so a retry adds none.
    const gap = last === undefined ? undefined : missedBefore(occurrence, last);
    if (gap && options.missed) {
      try {
        await options.missed(gap);
      } catch {
        log("fonds_scheduled_missed_unrecorded", {});
        return undefined;
      }
    }
    const claim = await options.claims.claimOccurrence(occurrence, now());
    if (claim === undefined) {
      return undefined;
    }
    let result: RefreshStartResult[] | undefined;
    try {
      result = await options.collect!(occurrence);
      onStarted?.(result);
      await options.settle?.(result);
    } finally {
      // Shutdown interrupts the run, so a restarted process may retake it.
      // Any other failure still counts as the occurrence's one attempt.
      await (
        stopping.signal.aborted
          ? options.claims.releaseOccurrence(occurrence, claim)
          : options.claims.finishOccurrence(occurrence, claim)
      ).catch(() => log("fonds_scheduled_refresh_unrecorded", {}));
    }
    log("fonds_scheduled_refresh", {
      occurrence: occurrence.key,
      started: result?.filter((entry) => entry.reason === null).length ?? 0,
      skipped: result?.filter((entry) => entry.reason !== null).length ?? 0,
    });
    return result;
  }

  async function tick() {
    const schedule = options.schedule;
    const occurrence = schedule && latestOccurrence(schedule, now());
    if (
      occurrence &&
      now() >= occurrence.at + jitterFor(occurrence) &&
      (await runClaimed(occurrence))
    ) {
      return;
    }
    if (!stopping.signal.aborted) {
      await options.deliver(
        AbortSignal.any([stopping.signal, AbortSignal.timeout(30_000)]),
      );
    }
  }

  function scheduleTick() {
    if (inFlight || stopping.signal.aborted) {
      return;
    }
    inFlight = tick()
      .catch(() => log("fonds_scheduled_tick_failed", {}))
      .finally(() => {
        inFlight = undefined;
      });
  }

  return {
    start() {
      if (interval || stopping.signal.aborted) {
        return;
      }
      interval = setInterval(scheduleTick, tickMs);
      // Shutdown, not this timer, decides when the process ends.
      interval.unref();
      scheduleTick();
    },

    /**
     * The HTTP trigger's run while a schedule is on: the latest occurrence,
     * claimed like a tick's. An occurrence already claimed is never collected
     * again; the answer is then undefined, with nothing collected.
     */
    async runCurrent(): Promise<RefreshStartResult[] | undefined> {
      const started = Promise.withResolvers<RefreshStartResult[]>();
      const run = runClaimed(
        latestOccurrence(options.schedule!, now()),
        started.resolve,
      );
      const forget = () => triggered.delete(run);
      triggered.add(run);
      run.then(forget, forget);
      // Answers once the refreshes start; the claim settles in the background.
      return Promise.race([started.promise, run]);
    },

    /** Stops ticking at once; the caller interrupts the collection itself. */
    stop() {
      clearInterval(interval);
      stopping.abort();
    },

    /**
     * Settles once every running tick and trigger run has recorded its
     * state, so the database stays open until an interrupted claim is released.
     */
    async settled() {
      await Promise.allSettled([inFlight, ...triggered]);
    },
  };
}

export type EmbeddedScheduler = ReturnType<typeof createEmbeddedScheduler>;
