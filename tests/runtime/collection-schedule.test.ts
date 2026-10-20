import { afterEach, describe, expect, it, vi } from "vitest";

import type { RefreshStartResult } from "../../src/application/refreshes.js";
import type { ScheduledOccurrence } from "../../src/application/scheduled-collections.js";
import {
  type CollectionSchedule,
  createEmbeddedScheduler,
  generateCollectionTime,
  latestOccurrence,
  nextOccurrence,
  type OccurrenceClaims,
  occurrenceKey,
  parseCollectionSchedule,
  utcCron,
} from "../../src/runtime/collection-schedule.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (iso: string) => Date.parse(iso);
const iso = (instant: number) => new Date(instant).toISOString();
const missing = "synthetic missing-time message";

function schedule(
  value: string,
  time = "03:17",
  timeZone?: string,
): CollectionSchedule {
  return parseCollectionSchedule(
    {
      FONDS_REFRESH_SCHEDULE: value,
      FONDS_REFRESH_TIME: time,
      FONDS_REFRESH_TIMEZONE: timeZone,
    },
    missing,
  )!;
}

describe("collection schedule settings", () => {
  it("accepts daily, hourly and hour lists", () => {
    expect(schedule("daily")).toEqual({
      mode: "daily",
      hours: [3],
      minute: 17,
      timeZone: "UTC",
    });
    const hourly = schedule("hourly");
    expect(hourly.mode).toBe("hourly");
    expect(hourly.hours).toHaveLength(24);
    expect(hourly.minute).toBe(17);
    // Sorted and deduplicated; the time's hour is unused, only its minute.
    expect(schedule(" 18, 9,13,9 ")).toEqual({
      mode: "hours",
      hours: [9, 13, 18],
      minute: 17,
      timeZone: "UTC",
    });
    expect(schedule("0,23").hours).toEqual([0, 23]);
  });

  it("is off when absent or any other word, and needs no time then", () => {
    for (const value of [
      undefined,
      "",
      "off",
      "disabled",
      "enabled",
      "Daily",
      "weekly",
    ]) {
      expect(
        parseCollectionSchedule({ FONDS_REFRESH_SCHEDULE: value }, missing),
      ).toBeUndefined();
    }
  });

  it("rejects malformed hour lists, times and zones without echoing them", () => {
    for (const value of [
      "24",
      "9,,13",
      "9,25",
      ",",
      "1 2",
      "009",
      "-1,9",
      "9,13,x",
      "daily,9",
    ]) {
      expect(() => schedule(value)).toThrow(
        "FONDS_REFRESH_SCHEDULE must be daily, hourly or hours 0-23 such as 9,13,18",
      );
    }
    expect(() =>
      parseCollectionSchedule({ FONDS_REFRESH_SCHEDULE: "daily" }, missing),
    ).toThrow(missing);
    for (const time of ["3:17", "24:00", "12:60", "12:00:00", "noon"]) {
      expect(() => schedule("daily", time)).toThrow(
        "FONDS_REFRESH_TIME must be a 24-hour HH:MM time",
      );
    }
    let message = "";
    try {
      schedule("daily", "03:17", "Mars/Olympus_Mons");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      "FONDS_REFRESH_TIMEZONE must be an IANA time zone such as Europe/London",
    );
    expect(schedule("daily", "03:17", "asia/jerusalem").timeZone).toBe(
      "Asia/Jerusalem",
    );
  });

  it("generates an HH:MM time from the random source", () => {
    expect(generateCollectionTime((max) => max - 1)).toBe("23:59");
    expect(generateCollectionTime(() => 0)).toBe("00:00");
    for (let index = 0; index < 50; index += 1) {
      expect(generateCollectionTime()).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    }
  });
});

describe("occurrences in UTC", () => {
  it("finds the latest and next daily occurrence across day boundaries", () => {
    const daily = schedule("daily", "23:50");
    const now = at("2026-10-20T00:10:00Z");
    expect(iso(latestOccurrence(daily, now).at)).toBe(
      "2026-10-19T23:50:00.000Z",
    );
    expect(iso(nextOccurrence(daily, now).at)).toBe("2026-10-20T23:50:00.000Z");
    // Exactly at the time, the occurrence is due.
    const due = at("2026-10-20T23:50:00Z");
    expect(latestOccurrence(daily, due).at).toBe(due);
    expect(iso(nextOccurrence(daily, due).at)).toBe("2026-10-21T23:50:00.000Z");
    // Across a month and year end.
    expect(iso(nextOccurrence(daily, at("2026-12-31T23:55:00Z")).at)).toBe(
      "2027-01-01T23:50:00.000Z",
    );
  });

  it("finds hourly and listed hours across hour boundaries", () => {
    const hourly = schedule("hourly", "00:05");
    expect(iso(latestOccurrence(hourly, at("2026-10-20T13:04:59Z")).at)).toBe(
      "2026-10-20T12:05:00.000Z",
    );
    expect(iso(nextOccurrence(hourly, at("2026-10-20T23:30:00Z")).at)).toBe(
      "2026-10-21T00:05:00.000Z",
    );
    const listed = schedule("9,13,18", "00:40");
    expect(iso(nextOccurrence(listed, at("2026-10-20T13:40:00Z")).at)).toBe(
      "2026-10-20T18:40:00.000Z",
    );
    expect(iso(nextOccurrence(listed, at("2026-10-20T19:00:00Z")).at)).toBe(
      "2026-10-21T09:40:00.000Z",
    );
    expect(iso(latestOccurrence(listed, at("2026-10-21T09:00:00Z")).at)).toBe(
      "2026-10-20T18:40:00.000Z",
    );
  });

  it("keys each occurrence by its UTC instant", () => {
    expect(occurrenceKey(at("2026-10-20T06:42:00Z"))).toBe(
      "scheduled-2026-10-20T06:42Z",
    );
    const daily = schedule("daily", "06:42");
    expect(latestOccurrence(daily, at("2026-10-20T07:00:00Z")).key).toBe(
      "scheduled-2026-10-20T06:42Z",
    );
  });
});

describe("occurrences across daylight-saving changes", () => {
  it("runs a skipped London time once, later by the gap", () => {
    const daily = schedule("daily", "01:30", "Europe/London");
    // 01:30 does not exist on 2026-03-29: it runs at 02:30 BST (01:30Z).
    expect(iso(nextOccurrence(daily, at("2026-03-28T12:00:00Z")).at)).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    expect(iso(nextOccurrence(daily, at("2026-03-29T01:30:00Z")).at)).toBe(
      "2026-03-30T00:30:00.000Z",
    );
    const hourly = schedule("hourly", "00:30", "Europe/London");
    // 01:30 (moved to 02:30 BST) and 02:30 BST are one instant: one run.
    const after = [at("2026-03-29T00:00:00Z")];
    for (let index = 0; index < 3; index += 1) {
      after.push(nextOccurrence(hourly, after.at(-1)!).at);
    }
    expect(after.slice(1).map(iso)).toEqual([
      "2026-03-29T00:30:00.000Z",
      "2026-03-29T01:30:00.000Z",
      "2026-03-29T02:30:00.000Z",
    ]);
  });

  it("runs a repeated London hour once, at its first instant", () => {
    const daily = schedule("daily", "01:30", "Europe/London");
    const first = nextOccurrence(daily, at("2026-10-24T12:00:00Z"));
    expect(iso(first.at)).toBe("2026-10-25T00:30:00.000Z");
    expect(iso(nextOccurrence(daily, first.at).at)).toBe(
      "2026-10-26T01:30:00.000Z",
    );
    // At the repeated 01:30 GMT the due occurrence is still the first one.
    expect(latestOccurrence(daily, at("2026-10-25T01:45:00Z")).key).toBe(
      first.key,
    );
    const hourly = schedule("hourly", "00:30", "Europe/London");
    expect(iso(nextOccurrence(hourly, at("2026-10-25T00:30:00Z")).at)).toBe(
      "2026-10-25T02:30:00.000Z",
    );
  });

  it("handles Jerusalem's Friday spring change and its autumn change", () => {
    const listed = schedule("2,9", "00:30", "Asia/Jerusalem");
    // 02:30 is skipped on 2026-03-27 and runs at 03:30 IDT.
    expect(iso(nextOccurrence(listed, at("2026-03-26T12:00:00Z")).at)).toBe(
      "2026-03-27T00:30:00.000Z",
    );
    expect(iso(nextOccurrence(listed, at("2026-03-27T00:30:00Z")).at)).toBe(
      "2026-03-27T06:30:00.000Z",
    );
    const daily = schedule("daily", "01:30", "Asia/Jerusalem");
    const first = nextOccurrence(daily, at("2026-10-24T12:00:00Z"));
    expect(iso(first.at)).toBe("2026-10-24T22:30:00.000Z");
    expect(iso(nextOccurrence(daily, first.at).at)).toBe(
      "2026-10-25T23:30:00.000Z",
    );
  });
});

describe("UTC cron for Neon", () => {
  it("derives daily, hourly and listed crons in UTC", () => {
    const now = at("2026-10-20T12:00:00Z");
    expect(utcCron(schedule("daily", "03:17"), now)).toBe("17 3 * * *");
    expect(utcCron(schedule("hourly", "22:05"), now)).toBe("5 * * * *");
    expect(utcCron(schedule("18,9,13", "00:40"), now)).toBe("40 9,13,18 * * *");
  });

  it("converts local hours with the zone's offset on the deploy date", () => {
    const summer = at("2026-07-01T12:00:00Z");
    const winter = at("2026-12-01T12:00:00Z");
    const listed = schedule("9,13,18", "00:15", "Asia/Jerusalem");
    expect(utcCron(listed, summer)).toBe("15 6,10,15 * * *");
    expect(utcCron(listed, winter)).toBe("15 7,11,16 * * *");
    // Wrapping past midnight keeps the hours sorted.
    expect(utcCron(schedule("1,23", "00:15", "Asia/Jerusalem"), winter)).toBe(
      "15 21,23 * * *",
    );
    // A half-hour zone moves the minute too, for every hour alike.
    expect(utcCron(schedule("daily", "09:10", "Asia/Kolkata"), winter)).toBe(
      "40 3 * * *",
    );
    expect(utcCron(schedule("hourly", "00:10", "Asia/Kolkata"), winter)).toBe(
      "40 * * * *",
    );
    expect(
      utcCron(schedule("daily", "00:30", "America/New_York"), winter),
    ).toBe("30 5 * * *");
  });
});

/** The store's claim rules for scheduled_collections, in memory. */
function memoryClaims() {
  const rows = new Map<
    string,
    { at: number; status: "running" | "finished"; leaseUntil: number }
  >();
  const held = (key: string, claim: string) => {
    const row = rows.get(key);
    return row?.status === "running" && String(row.leaseUntil) === claim
      ? row
      : undefined;
  };
  const claims: OccurrenceClaims = {
    async claimOccurrence({ key, at: scheduledAt }, now) {
      if ([...rows.values()].some((row) => row.at > scheduledAt)) {
        return undefined;
      }
      const row = rows.get(key);
      if (row && !(row.status === "running" && row.leaseUntil < now)) {
        return undefined;
      }
      const leaseUntil = now + 15 * MINUTE;
      rows.set(key, { at: scheduledAt, status: "running", leaseUntil });
      return String(leaseUntil);
    },
    async finishOccurrence({ key }, claim) {
      const row = held(key, claim);
      if (row) {
        row.status = "finished";
      }
    },
    async latestClaimedOccurrence() {
      const ats = [...rows.values()].map((row) => row.at);
      return ats.length ? Math.max(...ats) : undefined;
    },
    async releaseOccurrence({ key }, claim) {
      const row = held(key, claim);
      if (row) {
        row.leaseUntil = -Infinity;
      }
    },
  };
  return { rows, claims };
}

const completed: RefreshStartResult[] = [];

/** Lets every pending promise chain of a tick settle. */
async function settle() {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("embedded scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(
    options: {
      value?: string;
      time?: string;
      start?: string;
      claims?: ReturnType<typeof memoryClaims>;
      collect?: (
        occurrence: ScheduledOccurrence,
      ) => Promise<RefreshStartResult[]>;
      /** How many gap writes fail before one succeeds. */
      missedFailures?: number;
    } = {},
  ) {
    const clock = { now: at(options.start ?? "2026-10-20T03:17:00Z") };
    const store = options.claims ?? memoryClaims();
    const runs: string[] = [];
    const missed: { first: string; last: string; count: number }[] = [];
    let failures = options.missedFailures ?? 0;
    const deliveries: number[] = [];
    const scheduler = createEmbeddedScheduler({
      schedule: schedule(options.value ?? "daily", options.time ?? "03:17"),
      claims: store.claims,
      collect:
        options.collect ??
        (async ({ key }) => {
          runs.push(key);
          return completed;
        }),
      missed: async (gap) => {
        if (failures > 0) {
          failures--;
          throw new Error("synthetic gap write failure");
        }
        missed.push({
          first: gap.first.key,
          last: gap.last.key,
          count: gap.count,
        });
      },
      deliver: async () => {
        deliveries.push(clock.now);
      },
      now: () => clock.now,
      random: () => 0,
      tickMs: MINUTE,
      log: () => {},
    });
    return { clock, store, runs, missed, deliveries, scheduler };
  }

  async function tickAt(
    target: ReturnType<typeof harness>,
    instant: string | number,
  ) {
    target.clock.now = typeof instant === "number" ? instant : at(instant);
    await vi.advanceTimersByTimeAsync(MINUTE);
    await settle();
  }

  it("runs a due occurrence once, and delivers on the other ticks", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const target = harness({ start: "2026-10-20T03:16:00Z" });
    target.scheduler.start();
    await settle();
    // Before 03:17 the latest occurrence is yesterday's, which never ran.
    expect(target.runs).toEqual(["scheduled-2026-10-19T03:17Z"]);
    await tickAt(target, "2026-10-20T03:17:00Z");
    await tickAt(target, "2026-10-20T03:18:00Z");
    await tickAt(target, "2026-10-20T15:00:00Z");
    expect(target.runs).toEqual([
      "scheduled-2026-10-19T03:17Z",
      "scheduled-2026-10-20T03:17Z",
    ]);
    expect(target.deliveries).toHaveLength(2);
    target.scheduler.stop();
  });

  it("waits for its jitter, under the same occurrence key", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const clock = { now: at("2026-10-20T03:17:00Z") };
    const store = memoryClaims();
    await store.claims.claimOccurrence(
      {
        key: "scheduled-2026-10-19T03:17Z",
        at: at("2026-10-19T03:17:00Z"),
      },
      clock.now,
    );
    const runs: string[] = [];
    const scheduler = createEmbeddedScheduler({
      schedule: schedule("daily"),
      claims: store.claims,
      collect: async ({ key }) => {
        runs.push(key);
        return completed;
      },
      deliver: async () => {},
      now: () => clock.now,
      random: (max) => {
        expect(max).toBe(3 * MINUTE);
        return 2 * MINUTE;
      },
      tickMs: MINUTE,
      log: () => {},
    });
    scheduler.start();
    await settle();
    clock.now = at("2026-10-20T03:18:59Z");
    await vi.advanceTimersByTimeAsync(MINUTE);
    await settle();
    expect(runs).toEqual([]);
    clock.now = at("2026-10-20T03:19:00Z");
    await vi.advanceTimersByTimeAsync(MINUTE);
    await settle();
    expect(runs).toEqual(["scheduled-2026-10-20T03:17Z"]);
    scheduler.stop();
  });

  it("never reruns an occurrence after a restart", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = harness();
    first.scheduler.start();
    await settle();
    first.scheduler.stop();
    const second = harness({
      claims: first.store,
      start: "2026-10-20T04:00:00Z",
    });
    second.scheduler.start();
    await settle();
    await tickAt(second, "2026-10-20T05:00:00Z");
    expect([...first.runs, ...second.runs]).toEqual([
      "scheduled-2026-10-20T03:17Z",
    ]);
    second.scheduler.stop();
  });

  it("runs one occurrence once across concurrent schedulers and the trigger", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runs: string[] = [];
    const collect = async ({ key }: ScheduledOccurrence) => {
      runs.push(key);
      await gate;
      return completed;
    };
    const a = harness({ collect });
    const b = harness({ collect, claims: a.store });
    a.scheduler.start();
    b.scheduler.start();
    await settle();
    // The trigger finds the occurrence claimed and collects nothing.
    expect(await b.scheduler.runCurrent()).toBeUndefined();
    release();
    await settle();
    expect(runs).toEqual(["scheduled-2026-10-20T03:17Z"]);
    expect(a.store.rows.get("scheduled-2026-10-20T03:17Z")?.status).toBe(
      "finished",
    );
    // Still claimed after it finished: neither ticks nor the trigger rerun it.
    expect(await a.scheduler.runCurrent()).toBeUndefined();
    await tickAt(a, "2026-10-20T03:30:00Z");
    expect(runs).toHaveLength(1);
    a.scheduler.stop();
    b.scheduler.stop();
  });

  it("runs only the latest missed occurrence after a suspend or clock jump", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const target = harness({ value: "9,13,18", time: "00:00" });
    target.clock.now = at("2026-10-20T09:00:00Z");
    target.scheduler.start();
    await settle();
    expect(target.runs).toEqual(["scheduled-2026-10-20T09:00Z"]);
    // Suspended through 13:00 and 18:00: only 18:00 runs, once.
    await tickAt(target, "2026-10-20T20:00:00Z");
    await tickAt(target, "2026-10-20T20:01:00Z");
    expect(target.runs).toEqual([
      "scheduled-2026-10-20T09:00Z",
      "scheduled-2026-10-20T18:00Z",
    ]);
    // The one it skipped is recorded as one missed gap.
    expect(target.missed).toEqual([
      {
        first: "scheduled-2026-10-20T13:00Z",
        last: "scheduled-2026-10-20T13:00Z",
        count: 1,
      },
    ]);
    // A clock set back never runs an earlier occurrence.
    await tickAt(target, "2026-10-20T13:30:00Z");
    expect(target.runs).toHaveLength(2);
    // Forward past several days: one run, the latest.
    await tickAt(target, "2026-10-25T10:00:00Z");
    expect(target.runs.at(-1)).toBe("scheduled-2026-10-25T09:00Z");
    expect(target.runs).toHaveLength(3);
    target.scheduler.stop();
  });

  it("keeps a missed gap whose write failed, retrying it before the occurrence runs", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const target = harness({
      value: "9,13,18",
      time: "00:00",
      missedFailures: 1,
    });
    target.clock.now = at("2026-10-20T09:00:00Z");
    target.scheduler.start();
    await settle();
    // The 13:00 gap fails to record: 18:00 neither runs nor becomes the baseline.
    await tickAt(target, "2026-10-20T18:00:00Z");
    expect(target.runs).toEqual(["scheduled-2026-10-20T09:00Z"]);
    expect(target.missed).toEqual([]);
    await tickAt(target, "2026-10-20T18:01:00Z");
    expect(target.missed).toEqual([
      {
        first: "scheduled-2026-10-20T13:00Z",
        last: "scheduled-2026-10-20T13:00Z",
        count: 1,
      },
    ]);
    expect(target.runs).toEqual([
      "scheduled-2026-10-20T09:00Z",
      "scheduled-2026-10-20T18:00Z",
    ]);
    target.scheduler.stop();
  });

  it("stops ticking on shutdown and releases an interrupted claim", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let finish!: () => void;
    const target = harness({
      collect: () =>
        new Promise((resolve) => {
          finish = () => resolve(completed);
        }),
    });
    target.scheduler.start();
    await settle();
    target.scheduler.stop();
    // The host interrupts the collection; the claim is released for a restart.
    finish();
    await target.scheduler.settled();
    const row = target.store.rows.get("scheduled-2026-10-20T03:17Z");
    expect(row).toMatchObject({ status: "running", leaseUntil: -Infinity });
    const deliveries = target.deliveries.length;
    await tickAt(target, "2026-10-21T03:17:00Z");
    expect(target.deliveries).toHaveLength(deliveries);
    // A restarted process retakes the released occurrence.
    const restarted = harness({
      claims: target.store,
      start: "2026-10-20T03:20:00Z",
    });
    restarted.scheduler.start();
    await settle();
    expect(restarted.runs).toEqual(["scheduled-2026-10-20T03:17Z"]);
    restarted.scheduler.stop();
  });

  it("waits on shutdown for a trigger run to record its claim", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let finish!: () => void;
    const target = harness({
      start: "2026-10-20T04:00:00Z",
      collect: () =>
        new Promise((resolve) => {
          finish = () => resolve(completed);
        }),
    });
    // A trigger claims today's occurrence before any tick starts.
    const triggered = target.scheduler.runCurrent();
    await settle();
    target.scheduler.stop();
    let settled = false;
    const waiting = target.scheduler.settled().then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false);
    finish();
    await waiting;
    await triggered;
    expect(target.store.rows.get("scheduled-2026-10-20T03:17Z")).toMatchObject({
      status: "running",
      leaseUntil: -Infinity,
    });
  });

  it("does not keep the process alive", async () => {
    // The scheduler's own timers, not a process-wide count that the test
    // runner's timers also change.
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    const intervals = vi.spyOn(globalThis, "setInterval");
    const target = harness({ start: "2026-10-20T04:00:00Z" });
    try {
      target.scheduler.start();
      await settle();
      const timers = [...timeouts.mock.results, ...intervals.mock.results].map(
        ({ value }) => value as NodeJS.Timeout,
      );
      expect(timers).not.toHaveLength(0);
      expect(timers.filter((timer) => timer.hasRef())).toEqual([]);
    } finally {
      target.scheduler.stop();
      timeouts.mockRestore();
      intervals.mockRestore();
    }
  });

  it("delivers Events without a schedule", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const deliveries: number[] = [];
    const scheduler = createEmbeddedScheduler({
      claims: memoryClaims().claims,
      deliver: async () => {
        deliveries.push(1);
      },
      tickMs: MINUTE,
      log: () => {},
    });
    scheduler.start();
    await settle();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await settle();
    expect(deliveries).toHaveLength(3);
    scheduler.stop();
    expect(() =>
      createEmbeddedScheduler({
        schedule: schedule("daily"),
        claims: memoryClaims().claims,
        deliver: async () => {},
      }),
    ).toThrow("A collection schedule needs a collection path");
  });
});

it("keeps hourly occurrences an hour apart", () => {
  const hourly = schedule("hourly", "00:59");
  const next = nextOccurrence(hourly, at("2026-10-20T10:00:00Z"));
  expect(nextOccurrence(hourly, next.at).at - next.at).toBe(HOUR);
});
