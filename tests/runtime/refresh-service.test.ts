import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createApplication,
  inProcessInvoker,
} from "../../src/application/operations.js";
import { NotFoundError } from "../../src/domain/errors.js";
import type {
  CollectionEvent,
  ProviderCollector,
} from "../../src/domain/source-adapter.js";
import { calProvider } from "../../src/providers/cal/provider.js";
import { CAL_ENDPOINTS } from "../../src/providers/cal/transport.js";
import {
  createRefreshService,
  ownerRefreshes,
  type RefreshServiceOptions,
  runOperatorRefresh,
  UNIT_DEADLINE_MS,
} from "../../src/runtime/refresh-service.js";
import {
  type Database,
  openDatabase,
} from "../../src/storage/sqlite/database.js";
import { row, synthetic } from "../helpers/storage-harness.js";

const connectionId = "refresh-connection";
const range = { from: "2040-01-15", to: "2040-03-10" };

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

function source(
  collect: ProviderCollector["collect"],
  provider = "cal",
): ProviderCollector {
  return { provider, collectorVersion: "synthetic-v1", collect };
}

describe("refresh service", () => {
  let db: Database;
  beforeEach(async () => {
    db = await openDatabase(":memory:");
    await db.ensureConnection({ id: connectionId, provider: "cal" });
  });
  afterEach(async () => {
    await db.close();
  });

  function service(
    collector: () => Promise<ProviderCollector>,
    options: Partial<RefreshServiceOptions> = {},
  ) {
    return createRefreshService({
      store: db,
      targets: async () => ({
        targets: [{ connectionId, adapter: synthetic, collector }],
        failures: 0,
      }),
      log: () => {},
      retryDelaysMs: [],
      ...options,
    });
  }

  it("refuses a connection it cannot collect and a range over 120 months", async () => {
    const refreshes = service(async () => source(async function* () {}));
    await expect(
      refreshes.start("unknown", { trigger: "manual" }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      refreshes.start(connectionId, {
        trigger: "manual",
        range: { from: "2030-01-01", to: "2040-01-01" },
      }),
    ).rejects.toThrow("120 months");
    expect(await db.listRefreshes(connectionId, { limit: 10 })).toEqual([]);
  });

  it("records a credential or collector failure under the lease", async () => {
    for (const collector of [
      async () => {
        throw new Error("private-credential-value");
      },
      async () => source(async function* () {}, "other-provider"),
    ]) {
      await db.client.execute("DELETE FROM refreshes");
      const refreshes = service(collector);
      const [result] = await refreshes.wait([
        await refreshes.start(connectionId, {
          trigger: "manual",
          operator: true,
        }),
      ]);
      expect(result?.refresh).toMatchObject({
        status: "failed",
        counts: { failures: 1 },
      });
      expect(JSON.stringify(result)).not.toContain("private-credential-value");
    }
  });

  it("stops requesting months after an authentication failure and needs attention", async () => {
    const requested: string[] = [];
    const refreshes = service(async () =>
      source(async function* (options) {
        requested.push(options.range!.from);
        if (options.range!.from === "2040-02-01") {
          yield {
            type: "failure",
            failure: {
              accountKey: null,
              endpoint: "login",
              code: "authentication_failed",
            },
            fatal: true,
          };
          return;
        }
        yield capture(options.range!.from);
      }),
    );
    const [result] = await refreshes.wait([
      await refreshes.start(connectionId, { trigger: "manual", range }),
    ]);
    expect(requested).toEqual(["2040-03-01", "2040-02-01"]);
    expect(result?.refresh).toMatchObject({
      status: "partial",
      requiresAttention: true,
      windows: [
        { from: "2040-03-01", status: "completed" },
        { from: "2040-02-01", status: "failed" },
        { from: "2040-01-15", status: "pending" },
      ],
    });
  });

  it("yields between months when its invocation budget runs out, and continues elsewhere", async () => {
    const background: Promise<unknown>[] = [];
    const continueLater = vi.fn(async () => {});
    const requested: string[] = [];
    const collector = async () =>
      source(async function* (options) {
        requested.push(options.range!.from);
        await new Promise((resolve) => setTimeout(resolve, 60));
        yield capture(options.range!.from);
      });
    // Room for the first month only, as a host with a short invocation has.
    const bounded = service(collector, {
      budgetMs: UNIT_DEADLINE_MS + 30,
      background: (work) => background.push(work),
      continueLater,
    });
    const started = await bounded.start(connectionId, {
      trigger: "manual",
      range,
    });
    await bounded.settled();
    expect(background).toHaveLength(1);
    expect(continueLater).toHaveBeenCalledOnce();
    expect(await db.getRefresh(started.refresh!.id)).toMatchObject({
      status: "running",
      windows: [
        { status: "completed" },
        { status: "pending" },
        { status: "pending" },
      ],
    });
    // The continuation, in a new invocation, resumes the remaining months.
    const continued = service(collector);
    await continued.resumeStalled();
    await continued.settled();
    expect(requested).toEqual(["2040-03-01", "2040-02-01", "2040-01-15"]);
    expect(await db.getRefresh(started.refresh!.id)).toMatchObject({
      status: "completed",
      counts: { captures: 3, created: 3 },
    });
  });

  it("leaves a refresh interrupted by shutdown active, to redo its month on resume", async () => {
    const shutdown = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stopping = service(
      async () =>
        source(async function* (options) {
          entered();
          await new Promise((resolve) =>
            options.signal?.addEventListener("abort", resolve, { once: true }),
          );
        }),
      { signal: shutdown.signal },
    );
    const started = await stopping.start(connectionId, {
      trigger: "manual",
      range: { from: "2040-03-01", to: "2040-03-31" },
    });
    await ready;
    shutdown.abort();
    await stopping.settled();
    expect(await db.getRefresh(started.refresh!.id)).toMatchObject({
      status: "running",
      windows: [{ status: "running" }],
    });
    const restarted = service(async () =>
      source(async function* () {
        yield capture("after-restart");
      }),
    );
    await restarted.resumeStalled();
    await restarted.settled();
    expect(await db.getRefresh(started.refresh!.id)).toMatchObject({
      status: "completed",
      windows: [{ status: "completed" }],
    });
  });

  it("answers a start that meets an active refresh at once, ahead of the cooldown", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const refreshes = service(async () =>
      source(async function* () {
        calls += 1;
        if (calls === 2) {
          entered();
          await gate;
        }
        yield capture(`run-${calls}`);
      }),
    );
    const owner = ownerRefreshes(refreshes, 5_000);
    expect((await owner.start(connectionId)).refresh?.status).toBe("completed");
    // An operator run within the cooldown, still running.
    const operator = await refreshes.start(connectionId, {
      trigger: "manual",
      operator: true,
    });
    await ready;
    const started = performance.now();
    expect(await owner.start(connectionId)).toMatchObject({
      reason: "busy",
      refresh: { id: operator.refresh!.id },
    });
    expect(performance.now() - started).toBeLessThan(1_000);
    release();
    await refreshes.settled();
  });

  it("leaves an operator's run unstarted, and another process's refresh alone, while one is active", async () => {
    const now = new Date().toISOString();
    await db.admitRefresh(
      {
        id: "stale",
        connectionId,
        trigger: "manual",
        status: "running",
        skipReason: null,
        range: { from: "2040-01-01", to: "2040-01-31" },
        occurrence: null,
        scheduledAt: null,
        createdAt: now,
        startedAt: now,
        finishedAt: null,
        requiresAttention: false,
        counts: {
          captures: 0,
          unchanged: 0,
          failures: 0,
          created: 0,
          updated: 0,
        },
        failureCodes: [],
        failureReason: null,
        missed: null,
        windows: [{ from: "2040-01-01", to: "2040-01-31", status: "running" }],
      },
      { operator: true, now: Date.now() },
    );
    const collect = vi.fn(async function* () {
      yield capture("operator");
    });
    const [result] = await runOperatorRefresh({
      store: db,
      targets: async () => ({
        targets: [
          {
            connectionId,
            adapter: synthetic,
            collector: async () => source(collect),
          },
        ],
        failures: 0,
      }),
      connectionId,
      range: { from: "2041-05-01", to: "2041-05-31" },
    });
    expect(result).toMatchObject({ reason: "busy", refresh: { id: "stale" } });
    expect(collect).not.toHaveBeenCalled();
    expect(await db.getRefresh("stale")).toMatchObject({ status: "running" });
  });

  it("reads credentials only once the execution holds the lease", async () => {
    const collector = vi.fn(async () =>
      source(async function* () {
        yield capture("leased");
      }),
    );
    const refreshes = service(collector);
    let release!: () => void;
    const held = db.withCollectionLock(
      connectionId,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await refreshes.start(connectionId, { trigger: "manual", operator: true });
    await refreshes.settled();
    expect(collector).not.toHaveBeenCalled();
    release();
    await held;
    await refreshes.resumeStalled();
    await refreshes.settled();
    expect(collector).toHaveBeenCalledOnce();
  });

  /** An active refresh as a process that died left it. */
  async function abandoned(createdAt: string, extra: object = {}) {
    await db.admitRefresh(
      {
        id: "abandoned",
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
        counts: {
          captures: 0,
          unchanged: 0,
          failures: 0,
          created: 0,
          updated: 0,
        },
        failureCodes: [],
        failureReason: null,
        missed: null,
        windows: [
          { from: "2040-02-01", to: "2040-02-29", status: "completed" },
          { from: "2040-01-01", to: "2040-01-31", status: "pending" },
        ],
        ...extra,
      },
      { operator: true, now: Date.now() },
    );
  }

  it("retries a held lease with backoff until it frees", async () => {
    const collect = vi.fn(async function* () {
      yield capture("retried");
    });
    const refreshes = service(async () => source(collect), {
      retryDelaysMs: [50, 50, 50],
    });
    let release!: () => void;
    const held = db.withCollectionLock(
      connectionId,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const started = await refreshes.start(connectionId, { trigger: "manual" });
    setTimeout(() => release(), 20);
    await held;
    await refreshes.settled();
    expect(collect).toHaveBeenCalledOnce();
    expect(await db.getRefresh(started.refresh!.id)).toMatchObject({
      status: "completed",
    });
  });

  it("fails a refresh still unfinished a day after its creation, without the provider", async () => {
    await abandoned(new Date(Date.now() - 25 * 3_600_000).toISOString());
    const collector = vi.fn(async () => source(async function* () {}));
    const refreshes = service(collector);
    await refreshes.resumeStalled();
    await refreshes.settled();
    expect(collector).not.toHaveBeenCalled();
    expect(await db.getRefresh("abandoned")).toMatchObject({
      status: "failed",
      failureReason: "expired",
      counts: { failures: 1 },
    });
  });

  it("finishes an abandoned refresh when a read polls it", async () => {
    await abandoned(new Date().toISOString());
    const collect = vi.fn(async function* () {
      yield capture("recovered");
    });
    const refreshes = service(async () => source(collect));
    const application = createApplication(db, {
      refreshes: ownerRefreshes(refreshes),
    });
    // A read that can continue a refresh can reach the provider.
    expect(
      application.operations.find((entry) => entry.name === "get_refresh"),
    ).toMatchObject({ openWorld: true });
    const invoker = inProcessInvoker(application);
    expect(
      await invoker.invoke("get_refresh", { refreshId: "abandoned" }),
    ).toMatchObject({ refresh: { status: "running" } });
    await refreshes.settled();
    // Only its unfinished month is requested.
    expect(collect).toHaveBeenCalledOnce();
    expect(
      await invoker.invoke("get_refresh", { refreshId: "abandoned" }),
    ).toMatchObject({ refresh: { status: "completed" } });
  });

  it("finishes a stopped refresh in the same write as its checkpoint, and resume honors a recorded stop", async () => {
    const writes: object[] = [];
    const recording: Database = {
      ...db,
      withCollectionLock: (id, work) =>
        db.withCollectionLock(id, (locked, signal) =>
          work(
            {
              ...locked,
              updateRefresh: (refreshId, progress) => {
                writes.push(progress);
                return locked.updateRefresh(refreshId, progress);
              },
            },
            signal,
          ),
        ),
    };
    const stopped = service(
      async () =>
        source(async function* () {
          yield {
            type: "failure",
            failure: {
              accountKey: null,
              endpoint: "login",
              code: "rate_limited",
            },
            fatal: true,
          };
        }),
      { store: recording },
    );
    await stopped.wait([
      await stopped.start(connectionId, { trigger: "manual", range }),
    ]);
    const checkpoint = writes.find(
      (write) =>
        "window" in write &&
        (write as { window: { status: string } }).window.status !== "running",
    );
    expect(checkpoint).toMatchObject({
      window: { status: "failed" },
      status: "failed",
      finishedAt: expect.any(String),
    });
    expect(writes.at(-1)).toBe(checkpoint);

    await db.client.execute("DELETE FROM refresh_windows");
    await db.client.execute("DELETE FROM refreshes");
    await abandoned(new Date().toISOString(), { requiresAttention: true });
    const collector = vi.fn(async () => source(async function* () {}));
    const resumed = service(collector);
    await resumed.resumeStalled();
    await resumed.settled();
    expect(collector).not.toHaveBeenCalled();
    expect(await db.getRefresh("abandoned")).toMatchObject({
      status: "partial",
    });
  });

  it("extends a missed gap whose earlier write reached only some connections", async () => {
    await db.ensureConnection({ id: "second-connection", provider: "cal" });
    let failSecond = true;
    const flaky: Database = {
      ...db,
      admitRefresh: async (refresh, rules) => {
        if (refresh.connectionId === "second-connection" && failSecond) {
          failSecond = false;
          throw new Error("synthetic gap write failure");
        }
        return db.admitRefresh(refresh, rules);
      },
    };
    const refreshes = createRefreshService({
      store: flaky,
      targets: async () => ({
        targets: [connectionId, "second-connection"].map((id) => ({
          connectionId: id,
          adapter: synthetic,
          collector: async () => source(async function* () {}),
        })),
        failures: 0,
      }),
      log: () => {},
      retryDelaysMs: [],
    });
    const first = {
      key: "scheduled-2040-01-01T13:00Z",
      at: Date.UTC(2040, 0, 1, 13),
    };
    // The 13:00 gap reaches the first connection only.
    await expect(
      refreshes.recordMissed({ first, last: first, count: 1 }),
    ).rejects.toThrow("synthetic gap write failure");
    // Retried the next morning, the gap has grown through 18:00.
    await refreshes.recordMissed({
      first,
      last: {
        key: "scheduled-2040-01-01T18:00Z",
        at: Date.UTC(2040, 0, 1, 18),
      },
      count: 2,
    });
    for (const id of [connectionId, "second-connection"]) {
      expect(
        (await db.listRefreshes(id, { limit: 10 })).map(
          (refresh) => refresh.missed,
        ),
      ).toEqual([{ through: "2040-01-01T18:00:00.000Z", count: 2 }]);
    }
  });

  it("records one missed skip for a gap of occurrences", async () => {
    const refreshes = service(async () => source(async function* () {}));
    await refreshes.recordMissed({
      first: {
        key: "scheduled-2040-01-01T09:00Z",
        at: Date.UTC(2040, 0, 1, 9),
      },
      last: { key: "scheduled-2040-01-03T09:00Z", at: Date.UTC(2040, 0, 3, 9) },
      count: 3,
    });
    expect(
      (await db.listRefreshes(connectionId, { limit: 10 })).map((refresh) => ({
        status: refresh.status,
        skipReason: refresh.skipReason,
        scheduledAt: refresh.scheduledAt,
        missed: refresh.missed,
      })),
    ).toEqual([
      {
        status: "skipped",
        skipReason: "missed",
        scheduledAt: "2040-01-01T09:00:00.000Z",
        missed: { through: "2040-01-03T09:00:00.000Z", count: 3 },
      },
    ]);
  });
});

describe("provider sessions across a backfill", () => {
  const calConnection = "cal-session";
  let db: Database;
  beforeEach(async () => {
    db = await openDatabase(":memory:");
    await db.ensureConnection({ id: calConnection, provider: "cal" });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.close();
  });

  /** A synthetic CAL whose tokens expire once `expire` is called. */
  function syntheticCal(echo?: (search: number) => string | undefined) {
    let issued = 0;
    const valid = new Set<string>();
    const calls = { logins: 0, initializations: 0, searches: 0 };
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const endpoint = String(input);
      const headers = new Headers(init?.headers);
      const token = headers
        .get("authorization")
        ?.replace(/^CALAuthScheme /, "");
      if (endpoint === CAL_ENDPOINTS.login) {
        calls.logins++;
        const fresh = `SYNTHETIC-TOKEN-${++issued}`;
        valid.add(fresh);
        return json({ token: fresh });
      }
      if (!token || !valid.has(token)) {
        return json({ statusCode: 0 }, 401);
      }
      if (endpoint === CAL_ENDPOINTS.init) {
        calls.initializations++;
        return json({
          statusCode: 1,
          result: {
            bankAccounts: [{ bankAccountUniqueId: "SYNTHETIC-ACCOUNT" }],
            cards: [
              {
                cardUniqueId: "SYNTHETIC-CARD",
                bankAccountUniqueId: "SYNTHETIC-ACCOUNT",
              },
            ],
          },
        });
      }
      if (endpoint === CAL_ENDPOINTS.recent) {
        return json({
          statusCode: 1,
          result: { transactions: [], clearanceRequests: [] },
        });
      }
      calls.searches++;
      return json({
        statusCode: 1,
        result: { transArr: [] },
        ...(echo?.(calls.searches) && { echoed: echo(calls.searches) }),
      });
    });
    vi.stubGlobal("fetch", fetch);
    return { calls, expire: () => valid.clear() };
  }

  async function backfill(collector: ProviderCollector) {
    const [result] = await runOperatorRefresh({
      store: db,
      targets: async () => ({
        targets: [
          {
            connectionId: calConnection,
            adapter: calProvider.adapter,
            collector: async () => collector,
          },
        ],
        failures: 0,
      }),
      connectionId: calConnection,
      range: { from: "2040-01-01", to: "2040-03-31" },
    });
    return result?.refresh;
  }

  it("logs in to CAL once for a three-month backfill", async () => {
    const cal = syntheticCal();
    const refresh = await backfill(
      calProvider.createCollector({
        username: "SYNTHETIC-USER",
        password: "SYNTHETIC-PASSWORD",
      }),
    );
    expect(refresh?.status).toBe("completed");
    expect(refresh?.windows.map((window) => window.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(cal.calls).toEqual({ logins: 1, initializations: 3, searches: 3 });
  });

  it("logs in again exactly once when the session expires mid-backfill", async () => {
    const cal = syntheticCal();
    const collector = calProvider.createCollector({
      username: "SYNTHETIC-USER",
      password: "SYNTHETIC-PASSWORD",
    });
    let months = 0;
    const refresh = await backfill({
      ...collector,
      async *collect(options) {
        // The provider rejects the session from the second month on.
        if (++months === 2) {
          cal.expire();
        }
        yield* collector.collect(options);
      },
    });
    expect(refresh?.status).toBe("completed");
    expect(cal.calls).toEqual({ logins: 2, initializations: 3, searches: 3 });
  });

  it("logs in at most twice in one execution, however often CAL rejects", async () => {
    const cal = syntheticCal();
    const collector = calProvider.createCollector({
      username: "SYNTHETIC-USER",
      password: "SYNTHETIC-PASSWORD",
    });
    let months = 0;
    const refresh = await backfill({
      ...collector,
      async *collect(options) {
        // Every month after the first meets an expired session.
        if (++months > 1) {
          cal.expire();
        }
        yield* collector.collect(options);
      },
    });
    expect(cal.calls.logins).toBe(2);
    expect(refresh).toMatchObject({
      status: "partial",
      requiresAttention: true,
    });
  });

  it("refuses a later month's response that echoes the reused token", async () => {
    syntheticCal((search) => (search === 2 ? "SYNTHETIC-TOKEN-1" : undefined));
    const refresh = await backfill(
      calProvider.createCollector({
        username: "SYNTHETIC-USER",
        password: "SYNTHETIC-PASSWORD",
      }),
    );
    expect(refresh?.status).toBe("partial");
    const archived = await db.client.execute(
      "SELECT snapshot_json FROM sync_runs",
    );
    expect(JSON.stringify(archived.rows)).not.toContain("SYNTHETIC-TOKEN");
  });

  it("refuses a later month's response that echoes a token replaced by a re-login", async () => {
    const cal = syntheticCal((search) =>
      search === 3 ? "SYNTHETIC-TOKEN-1" : undefined,
    );
    const collector = calProvider.createCollector({
      username: "SYNTHETIC-USER",
      password: "SYNTHETIC-PASSWORD",
    });
    let months = 0;
    const refresh = await backfill({
      ...collector,
      async *collect(options) {
        // The second month replaces token 1 with token 2; the third echoes token 1.
        if (++months === 2) {
          cal.expire();
        }
        yield* collector.collect(options);
      },
    });
    expect(cal.calls.logins).toBe(2);
    expect(refresh?.status).toBe("partial");
    const archived = await db.client.execute(
      "SELECT snapshot_json FROM sync_runs",
    );
    expect(JSON.stringify(archived.rows)).not.toContain("SYNTHETIC-TOKEN");
  });
});
