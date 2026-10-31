import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createApplication,
  inProcessInvoker,
  publicError,
} from "../../src/application/operations.js";
import type { Refresh } from "../../src/application/refreshes.js";
import type {
  CollectionEvent,
  ProviderCollector,
} from "../../src/domain/source-adapter.js";
import {
  createRefreshService,
  ownerRefreshes,
  type RefreshServiceOptions,
  UNIT_DEADLINE_MS,
} from "../../src/runtime/refresh-service.js";
import {
  type Database,
  openDatabase,
} from "../../src/storage/sqlite/database.js";
import { row, synthetic } from "../helpers/storage-harness.js";

const connectionId = "resume-connection";
const HOUR = 60 * 60_000;

function capture(sourceKey: string): CollectionEvent {
  return {
    type: "capture",
    capture: {
      accountKey: "account",
      endpoint: "synthetic",
      capturedAt: new Date().toISOString(),
      responseText: JSON.stringify([row(sourceKey)]),
    },
  };
}

const zeroCounts = {
  captures: 0,
  unchanged: 0,
  observed: 0,
  unchangedTransactions: 0,
  unlisted: 0,
  failures: 0,
  created: 0,
  updated: 0,
};

/** A refresh as storage holds it; a ranged one with February done and January not. */
function stored(id: string, overrides: Partial<Refresh> = {}): Refresh {
  const createdAt = new Date().toISOString();
  return {
    id,
    connectionId,
    trigger: "manual",
    status: "running",
    skipReason: null,
    range: { from: "2040-01-01", to: "2040-02-29" },
    occurrence: null,
    scheduledAt: null,
    createdAt,
    startedAt: createdAt,
    finishedAt: null,
    requiresAttention: false,
    counts: { ...zeroCounts, captures: 1, observed: 1, created: 1 },
    failureCodes: [],
    failureReason: null,
    missed: null,
    windows: [
      { from: "2040-02-01", to: "2040-02-29", status: "completed" },
      { from: "2040-01-01", to: "2040-01-31", status: "pending" },
    ],
    ...overrides,
  };
}

describe("refresh status reads and explicit resume", () => {
  let db: Database;
  beforeEach(async () => {
    db = await openDatabase(":memory:");
    await db.ensureConnection({ id: connectionId, provider: "cal" });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await db.close();
  });

  /** A service whose discovery, credentials and provider calls are counted. */
  function counted(
    collect: ProviderCollector["collect"] = async function* (options) {
      yield capture(`month-${options.range?.from ?? "recent"}`);
    },
    options: Partial<RefreshServiceOptions> = {},
  ) {
    const calls = {
      discoveries: 0,
      credentials: 0,
      requests: [] as (string | undefined)[],
    };
    const refreshes = createRefreshService({
      store: db,
      targets: async () => {
        calls.discoveries++;
        return {
          targets: [
            {
              connectionId,
              adapter: synthetic,
              collector: async () => {
                calls.credentials++;
                return {
                  provider: "cal",
                  collectorVersion: "synthetic-v1",
                  async *collect(input) {
                    calls.requests.push(input.range?.from);
                    yield* collect(input);
                  },
                };
              },
            },
          ],
          failures: 0,
        };
      },
      log: () => {},
      retryDelaysMs: [],
      ...options,
    });
    return { refreshes, calls };
  }

  const loginAttempt = async () =>
    (await db.getStoredConnection(connectionId))!.config.providerLoginAttemptAt;

  const refreshEvents = async () =>
    (await db.listEvents()).filter((event) =>
      event.type.startsWith("refresh."),
    );

  describe("status reads", () => {
    const now = Date.now();
    const iso = (offset: number) => new Date(now + offset).toISOString();
    const finished = { finishedAt: iso(-HOUR), startedAt: iso(-2 * HOUR) };
    const scenarios: [string, Partial<Refresh>][] = [
      ["pending", { status: "pending", startedAt: null }],
      ["running", {}],
      // Its process died mid-month; nothing marks that apart from staleness.
      [
        "interrupted but still active",
        {
          windows: [
            { from: "2040-02-01", to: "2040-02-29", status: "completed" },
            { from: "2040-01-01", to: "2040-01-31", status: "running" },
          ],
        },
      ],
      ["overdue", { createdAt: iso(-25 * HOUR), startedAt: iso(-25 * HOUR) }],
      ["completed", { status: "completed", ...finished }],
      [
        "partial",
        {
          status: "partial",
          ...finished,
          windows: [
            { from: "2040-02-01", to: "2040-02-29", status: "completed" },
            { from: "2040-01-01", to: "2040-01-31", status: "failed" },
          ],
        },
      ],
      [
        "failed",
        {
          status: "failed",
          requiresAttention: true,
          failureCodes: ["authentication_failed"],
          ...finished,
        },
      ],
      [
        "skipped",
        {
          status: "skipped",
          skipReason: "cooldown",
          trigger: "scheduled",
          occurrence: "synthetic-occurrence",
          scheduledAt: iso(-HOUR),
          startedAt: null,
          finishedAt: iso(-HOUR),
          range: null,
          windows: [],
          counts: zeroCounts,
        },
      ],
    ];

    it.each(scenarios)(
      "reads a %s refresh without collecting, leasing or writing",
      async (_, overrides) => {
        await db.updateConfig(connectionId, (config) => ({
          ...config,
          providerLoginAttemptAt: iso(-HOUR),
        }));
        await db.admitRefresh(stored("read", overrides), {
          operator: true,
          now,
        });
        const before = {
          refresh: await db.getRefresh("read"),
          attempt: await loginAttempt(),
          events: await db.listEvents(),
        };
        const writes: string[] = [];
        const watched = new Proxy(db, {
          get(target, property) {
            const value = Reflect.get(target, property, target) as unknown;
            if (typeof value !== "function") {
              return value;
            }
            return (...input: unknown[]) => {
              if (
                typeof property === "string" &&
                /^(withCollectionLock|admit|update|record|apply|ingest|ensure)/.test(
                  property,
                )
              ) {
                writes.push(property);
              }
              return (value as (...args: unknown[]) => unknown).apply(
                target,
                input,
              );
            };
          },
        });
        const { refreshes, calls } = counted();
        const invoker = inProcessInvoker(
          createApplication(watched, { refreshes: ownerRefreshes(refreshes) }),
        );
        for (let poll = 0; poll < 3; poll++) {
          expect(
            await invoker.invoke("get_refresh", { refreshId: "read" }),
          ).toMatchObject({ refresh: { id: "read" } });
          expect(
            await invoker.invoke("list_refreshes", { connectionId }),
          ).toMatchObject({ data: [{ id: "read" }] });
        }
        await refreshes.settled();
        expect(writes).toEqual([]);
        expect(calls).toEqual({ discoveries: 0, credentials: 0, requests: [] });
        expect({
          refresh: await db.getRefresh("read"),
          attempt: await loginAttempt(),
          events: await db.listEvents(),
        }).toEqual(before);
      },
    );

    it("leaves a dead execution as it is under polling; a scheduler tick then continues it", async () => {
      await db.admitRefresh(stored("dead"), {
        operator: true,
        now: Date.now(),
      });
      const { refreshes, calls } = counted();
      const invoker = inProcessInvoker(
        createApplication(db, { refreshes: ownerRefreshes(refreshes) }),
      );
      for (let poll = 0; poll < 3; poll++) {
        await invoker.invoke("get_refresh", { refreshId: "dead" });
      }
      await refreshes.settled();
      expect(calls.requests).toEqual([]);
      expect(await db.getRefresh("dead")).toMatchObject({ status: "running" });
      await refreshes.resumeStalled();
      await refreshes.settled();
      expect(calls.requests).toEqual(["2040-01-01"]);
      expect(
        await invoker.invoke("get_refresh", { refreshId: "dead" }),
      ).toMatchObject({ refresh: { status: "completed" } });
    });
  });

  describe("resume", () => {
    it("continues the same refresh and range, requesting only its unfinished months", async () => {
      const original = stored("abandoned");
      await db.admitRefresh(original, { operator: true, now: Date.now() });
      const { refreshes, calls } = counted();
      const invoker = inProcessInvoker(
        createApplication(db, { refreshes: ownerRefreshes(refreshes) }),
      );
      const result = (await invoker.invoke("resume_refresh", {
        refreshId: "abandoned",
      })) as { refresh: Record<string, unknown> };
      expect(result).toMatchObject({
        outcome: "terminal",
        retryAt: null,
        refresh: {
          id: "abandoned",
          trigger: "manual",
          range: { from: "2040-01-01", to: "2040-02-29" },
          createdAt: original.createdAt,
          startedAt: original.startedAt,
          status: "completed",
          // The checkpointed February counts once; January adds one.
          counts: { captures: 2, created: 2 },
          windows: [
            { from: "2040-02-01", status: "completed" },
            { from: "2040-01-01", status: "completed" },
          ],
        },
      });
      expect(calls.requests).toEqual(["2040-01-01"]);
      expect(
        (await db.listRefreshes(connectionId, { limit: 10 })).map(
          (refresh) => refresh.id,
        ),
      ).toEqual(["abandoned"]);
    });

    it.each([
      ["completed", { status: "completed" as const }],
      [
        "skipped",
        {
          status: "skipped" as const,
          skipReason: "busy" as const,
          trigger: "scheduled" as const,
          occurrence: "synthetic-occurrence",
          scheduledAt: "2040-01-01T09:00:00.000Z",
          startedAt: null,
          range: null,
          windows: [],
        },
      ],
    ])("never reopens a %s refresh", async (_, overrides) => {
      const finishedAt = new Date(Date.now() - HOUR).toISOString();
      await db.admitRefresh(stored("finished", { ...overrides, finishedAt }), {
        operator: true,
        now: Date.now(),
      });
      const before = await db.getRefresh("finished");
      const { refreshes, calls } = counted();
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await refreshes.resume("finished")).toEqual({
          refresh: before,
          outcome: "terminal",
          retryAt: null,
        });
      }
      await refreshes.settled();
      expect(calls).toEqual({ discoveries: 0, credentials: 0, requests: [] });
      expect(await db.getRefresh("finished")).toEqual(before);
    });

    it("answers not_found for an unknown refresh", async () => {
      const { refreshes } = counted();
      const invoker = inProcessInvoker(
        createApplication(db, { refreshes: ownerRefreshes(refreshes) }),
      );
      const failure = await invoker
        .invoke("resume_refresh", { refreshId: "missing" })
        .catch((error: unknown) => error);
      expect(publicError(failure).code).toBe("not_found");
      expect(await db.listRefreshes(connectionId, { limit: 10 })).toEqual([]);
    });

    it("finalizes an overdue refresh without provider access, even within the login interval", async () => {
      await db.updateConfig(connectionId, (config) => ({
        ...config,
        providerLoginAttemptAt: new Date().toISOString(),
      }));
      const created = new Date(Date.now() - 25 * HOUR).toISOString();
      await db.admitRefresh(
        stored("overdue", { createdAt: created, startedAt: created }),
        { operator: true, now: Date.now() },
      );
      const { refreshes, calls } = counted();
      expect(await refreshes.resume("overdue")).toMatchObject({
        outcome: "terminal",
        refresh: {
          status: "failed",
          failureReason: "expired",
          windows: [{ status: "completed" }, { status: "pending" }],
        },
      });
      expect(calls.credentials).toBe(0);
      expect(calls.requests).toEqual([]);
    });

    it("honors a provider stop the refresh already recorded", async () => {
      await db.admitRefresh(
        stored("stopped", { providerStopReason: "rate_limited" }),
        { operator: true, now: Date.now() },
      );
      const { refreshes, calls } = counted();
      expect(await refreshes.resume("stopped")).toMatchObject({
        outcome: "terminal",
        refresh: { status: "partial" },
      });
      expect(calls.credentials).toBe(0);
      expect(calls.requests).toEqual([]);
    });

    it("continues a manual retry admitted past an attention block, announcing recovery only when it completes", async () => {
      // The connection's last executed refresh needs attention.
      const blockedAt = new Date(Date.now() - 2 * HOUR).toISOString();
      await db.admitRefresh(
        stored("blocked", {
          trigger: "scheduled",
          status: "failed",
          requiresAttention: true,
          failureCodes: ["authentication_failed"],
          range: null,
          windows: [],
          createdAt: blockedAt,
          startedAt: blockedAt,
          finishedAt: blockedAt,
        }),
        { operator: true, now: Date.now() },
      );
      const shutdown = new AbortController();
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const dying = counted(
        async function* (options) {
          entered();
          await new Promise((resolve) =>
            options.signal?.addEventListener("abort", resolve, { once: true }),
          );
        },
        { signal: shutdown.signal },
      );
      const admitted = await dying.refreshes.start(connectionId, {
        trigger: "manual",
      });
      expect(admitted.reason).toBeNull();
      await ready;
      shutdown.abort();
      await dying.refreshes.settled();
      const id = admitted.refresh!.id;
      expect(await db.getRefresh(id)).toMatchObject({ status: "running" });
      // A new start is still refused; the admitted retry is what continues.
      const { refreshes, calls } = counted(undefined, { loginIntervalMs: 0 });
      expect(
        (await refreshes.start(connectionId, { trigger: "manual" })).reason,
      ).toBe("busy");
      expect(await refreshEvents()).toEqual([]);
      expect(await refreshes.resume(id)).toMatchObject({
        outcome: "terminal",
        refresh: { id, status: "completed", requiresAttention: false },
      });
      expect(calls.requests).toEqual([undefined]);
      expect((await refreshEvents()).map((event) => event.type)).toEqual([
        "refresh.recovered",
      ]);
      // Resuming the finished retry adds nothing.
      await refreshes.resume(id);
      expect(await refreshEvents()).toHaveLength(1);
    });
  });

  describe.each([
    ["without an execution budget", {}],
    ["with an execution budget", { budgetMs: 2 * UNIT_DEADLINE_MS }],
  ] as const)("resumption login pacing %s", (_, budget) => {
    const start = Date.parse("2040-06-01T08:00:00.000Z");

    /** A ranged refresh whose execution logged in at 08:00 and died before any capture. */
    async function diedDuringLogin() {
      vi.useFakeTimers({ toFake: ["Date", "performance"], now: start });
      const shutdown = new AbortController();
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const dying = counted(
        async function* (options) {
          entered();
          await new Promise((resolve) =>
            options.signal?.addEventListener("abort", resolve, { once: true }),
          );
        },
        { signal: shutdown.signal },
      );
      const started = await dying.refreshes.start(connectionId, {
        trigger: "manual",
        range: { from: "2040-01-01", to: "2040-02-29" },
      });
      await ready;
      shutdown.abort();
      await dying.refreshes.settled();
      expect(await loginAttempt()).toBe("2040-06-01T08:00:00.000Z");
      return started.refresh!.id;
    }

    it("holds an explicit resume until ten minutes after the last login attempt, however often it is repeated", async () => {
      const id = await diedDuringLogin();
      const before = await db.getRefresh(id);
      const { refreshes, calls } = counted(undefined, budget);
      for (const at of [1, 5 * 60_000, 10 * 60_000 - 1]) {
        vi.setSystemTime(start + at);
        expect(await refreshes.resume(id)).toEqual({
          refresh: before,
          outcome: "held",
          retryAt: "2040-06-01T08:10:00.000Z",
        });
      }
      await refreshes.settled();
      expect(calls.credentials).toBe(0);
      expect(await loginAttempt()).toBe("2040-06-01T08:00:00.000Z");
      expect(await db.getRefresh(id)).toEqual(before);
      expect(await refreshEvents()).toEqual([]);
      vi.setSystemTime(start + 10 * 60_000);
      expect(await refreshes.resume(id)).toMatchObject({
        outcome: "terminal",
        refresh: { status: "completed" },
      });
      expect(calls.requests).toEqual(["2040-02-01", "2040-01-01"]);
      expect(await loginAttempt()).toBe("2040-06-01T08:10:00.000Z");
    });

    it("paces a scheduler tick's recovery the same way", async () => {
      const id = await diedDuringLogin();
      const { refreshes, calls } = counted(undefined, budget);
      vi.setSystemTime(start + 10 * 60_000 - 1);
      await refreshes.resumeStalled();
      await refreshes.settled();
      expect(calls.credentials).toBe(0);
      expect(await db.getRefresh(id)).toMatchObject({ status: "running" });
      vi.setSystemTime(start + 10 * 60_000);
      await refreshes.resumeStalled();
      await refreshes.settled();
      expect(calls.credentials).toBe(1);
      expect(await db.getRefresh(id)).toMatchObject({ status: "completed" });
    });
  });
});
