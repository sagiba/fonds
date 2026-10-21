import { inspect } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createApplication,
  inProcessInvoker,
} from "../../src/application/operations.js";
import { createSyncDiagnosticReport } from "../../src/application/sync-diagnostics.js";
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

function capture(sourceKey: string, amountMinor = -100): CollectionEvent {
  return {
    type: "capture",
    capture: {
      accountKey: "account",
      endpoint: "synthetic",
      capturedAt: new Date().toISOString(),
      responseText: JSON.stringify([row(sourceKey, { amountMinor })]),
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

  it("commits refresh and ledger results even when the operational logger throws or rejects", async () => {
    for (const mode of ["throw", "reject"]) {
      const log = vi.fn(() => {
        if (mode === "throw") {
          throw new Error("private-log-error");
        }
        return Promise.reject(new Error("private-log-error"));
      });
      const refreshes = service(
        async () =>
          source(async function* () {
            yield capture(mode);
          }),
        { log },
      );
      const [result] = await refreshes.wait([
        await refreshes.start(connectionId, {
          trigger: "manual",
          operator: true,
        }),
      ]);
      await refreshes.settled();
      expect(result?.refresh).toMatchObject({
        status: "completed",
        counts: { observed: 1, created: 1, updated: 0 },
      });
      expect(
        (await db.listTransactions()).some(
          (transaction) => transaction.sourceKey === mode,
        ),
      ).toBe(true);
      expect(log).toHaveBeenCalled();
    }
  });

  it("returns observed, unchanged and meaningful enrichment changes in the ordinary refresh response", async () => {
    let address = "First invented address";
    let observation = 0;
    const refreshes = service(async () =>
      source(async function* () {
        const event = capture("same") as Extract<
          CollectionEvent,
          { type: "capture" }
        >;
        const transaction = row("same");
        transaction.details.merchant.address = address;
        event.capture.responseText = JSON.stringify([transaction]);
        event.capture.capturedAt = new Date(
          Date.now() + ++observation * 1_000,
        ).toISOString();
        yield event;
      }),
    );
    const invoker = inProcessInvoker(
      createApplication(db, { refreshes: ownerRefreshes(refreshes) }),
    );

    async function refresh() {
      const [result] = await refreshes.wait([
        await refreshes.start(connectionId, {
          trigger: "manual",
          operator: true,
        }),
      ]);
      return invoker.invoke("get_refresh", { refreshId: result!.refresh!.id });
    }

    expect(await refresh()).toMatchObject({
      refresh: {
        counts: {
          observed: 1,
          unchangedTransactions: 0,
          created: 1,
          updated: 0,
        },
      },
    });
    const first = (await db.listTransactions())[0]!;
    const annotation = await db.editAnnotation({
      transactionId: first.id,
      expectedVersion: 0,
      notes: "Independent owner annotation",
    });
    expect(await refresh()).toMatchObject({
      refresh: {
        counts: {
          observed: 1,
          unchangedTransactions: 1,
          unchanged: 1,
          created: 0,
          updated: 0,
        },
      },
    });
    address = "Corrected invented address";
    expect(await refresh()).toMatchObject({
      refresh: {
        counts: {
          observed: 1,
          unchangedTransactions: 0,
          unchanged: 0,
          created: 0,
          updated: 1,
          unlisted: 0,
        },
      },
    });
    expect(await db.getTransaction(first.id)).toMatchObject({
      version: first.version + 1,
      details: { merchant: { address } },
      annotation,
    });
  });

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

  it.each(["credential loading", "collection"] as const)(
    "keeps secrets from %s failures out of stored refreshes, sync runs and every logging sink",
    async (stage) => {
      const secret = "private-credential-value";
      const log = vi.fn();
      const consoleMethods = [
        "log",
        "info",
        "warn",
        "error",
        "debug",
        "trace",
        "dir",
        "table",
      ] as const;
      const consoleSpies = consoleMethods.map((method) =>
        vi.spyOn(console, method).mockImplementation(() => {}),
      );
      const stdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        const collect = vi.fn(async function* () {
          throw new Error(secret);
        });
        const refreshes = service(
          async () => {
            if (stage === "credential loading") {
              throw new Error(secret);
            }
            return source(collect);
          },
          { log },
        );
        const [result] = await refreshes.wait([
          await refreshes.start(connectionId, {
            trigger: "manual",
            operator: true,
          }),
        ]);
        await refreshes.settled();
        expect(collect).toHaveBeenCalledTimes(stage === "collection" ? 1 : 0);
        const stored = await db.getRefresh(result!.refresh!.id);
        expect(stored).toMatchObject({
          status: "failed",
          failureCodes: stage === "collection" ? ["network_error"] : [],
          failureReason: null,
          counts: { failures: 1 },
        });
        expect(JSON.stringify(stored)).not.toContain(secret);
        const runs = await db.listSyncRuns(connectionId, { limit: 10 });
        expect(runs).toHaveLength(stage === "collection" ? 1 : 0);
        const persistedRuns = await db.client.execute(
          "SELECT * FROM sync_runs",
        );
        expect(persistedRuns.rows).toHaveLength(stage === "collection" ? 1 : 0);
        expect(JSON.stringify(persistedRuns.rows)).not.toContain(secret);
        if (stage === "collection") {
          expect(runs[0]).toMatchObject({ status: "failed" });
          expect(log).toHaveBeenCalledWith(
            expect.objectContaining({
              event: "fonds_sync",
              stage: "collection",
              outcome: "failed",
              reason: "collector_exception",
              failureCategory: "collection",
            }),
          );
        }
        expect(log).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "fonds_refresh",
            status: "failed",
          }),
        );
        expect(inspect(log.mock.calls, { depth: null })).not.toContain(secret);
        for (const sink of [...consoleSpies, stdout, stderr]) {
          expect(inspect(sink.mock.calls, { depth: null })).not.toContain(
            secret,
          );
        }
        for (const sink of [stdout, stderr]) {
          for (const [chunk] of sink.mock.calls) {
            expect(String(chunk)).not.toContain(secret);
          }
        }
      } finally {
        for (const sink of [...consoleSpies, stdout, stderr]) {
          sink.mockRestore();
        }
      }
    },
  );

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
      failureCodes: ["authentication_failed"],
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
    // The interrupted attempt stays counted; the redone month leaves no failure.
    expect(await db.getRefresh(started.refresh!.id)).toMatchObject({
      status: "completed",
      windows: [{ status: "completed" }],
      counts: { failures: 1 },
      failureCodes: [],
    });
  });

  it("preserves committed unit counts across interruption and counts resumed observations without duplicating creations", async () => {
    const shutdown = new AbortController();
    const ready = Promise.withResolvers<void>();
    const stopping = service(
      async () =>
        source(async function* (options) {
          yield capture("observed-before-interruption");
          ready.resolve();
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
    await ready.promise;
    shutdown.abort();
    await stopping.settled();
    expect(await db.getRefresh(started.refresh!.id)).toMatchObject({
      status: "running",
      windows: [{ status: "running" }],
      counts: {
        captures: 1,
        observed: 1,
        created: 1,
        updated: 0,
        unchanged: 0,
        unchangedTransactions: 0,
      },
    });
    const restarted = service(async () =>
      source(async function* () {
        yield capture("observed-before-interruption");
      }),
    );
    await restarted.resumeStalled();
    await restarted.settled();
    expect(await db.getRefresh(started.refresh!.id)).toMatchObject({
      status: "completed",
      windows: [{ status: "completed" }],
      counts: {
        captures: 2,
        observed: 2,
        created: 1,
        updated: 0,
        unchanged: 1,
        unchangedTransactions: 1,
      },
    });
    expect(await db.listTransactions()).toHaveLength(1);
    expect(
      (await db.listEvents()).filter(
        (event) => event.type === "transaction.imported",
      ),
    ).toHaveLength(1);
  });

  it.each([false, true])(
    "finishes a thrown ranged capture with terminal window status and prior evidence preserved (accepted=%s)",
    async (accepted) => {
      await db.client.execute(
        "CREATE TRIGGER reject_later_ranged_capture BEFORE INSERT ON transactions WHEN NEW.amount_minor = -200 BEGIN SELECT RAISE(ABORT, 'private-ranged-capture-failure'); END",
      );
      const requested: string[] = [];
      const refreshes = service(async () =>
        source(async function* (options) {
          requested.push(options.range!.from);
          if (options.range!.from === "2040-03-01") {
            yield capture("completed-march");
            return;
          }
          if (accepted) {
            yield capture("accepted-february");
          }
          yield capture("rejected-february", -200);
        }),
      );
      const [result] = await refreshes.wait([
        await refreshes.start(connectionId, { trigger: "manual", range }),
      ]);
      expect(requested).toEqual(["2040-03-01", "2040-02-01"]);
      expect(result!.refresh).toMatchObject({
        status: "partial",
        finishedAt: expect.any(String),
        windows: [
          { status: "completed" },
          { status: accepted ? "partial" : "failed" },
          { status: "pending" },
        ],
        counts: {
          created: accepted ? 2 : 1,
          captures: accepted ? 2 : 1,
          observed: accepted ? 2 : 1,
          failures: 1,
        },
      });
      expect(
        result!.refresh!.windows.some((window) => window.status === "running"),
      ).toBe(false);
      await refreshes.resumeStalled();
      await refreshes.settled();
      expect(requested).toHaveLength(2);
    },
  );

  it("keeps committed counts when a later capture fails and charges recovery to its executing refresh once", async () => {
    await db.client.execute(
      "CREATE TRIGGER interrupt_second_capture BEFORE INSERT ON transactions WHEN NEW.amount_minor = -200 BEGIN SELECT RAISE(ABORT, 'private-second-capture-failure'); END",
    );
    const first = service(async () =>
      source(async function* () {
        yield capture("committed-first");
        yield capture("pending-second", -200);
      }),
    );
    const [failed] = await first.wait([
      await first.start(connectionId, { trigger: "manual", operator: true }),
    ]);
    expect(failed!.refresh).toMatchObject({
      status: "partial",
      counts: { captures: 1, observed: 1, created: 1, failures: 1 },
    });
    const pending = (await db.listSyncRuns(connectionId, { limit: 10 })).find(
      (run) => run.status === "started",
    )!;
    await db.client.execute("DROP TRIGGER interrupt_second_capture");
    const report = createSyncDiagnosticReport();
    const resumed = service(
      async () =>
        source(async function* () {
          yield capture("pending-second", -200);
        }),
      { log: report.log },
    );
    const [finished] = await resumed.wait([
      await resumed.start(connectionId, { trigger: "manual", operator: true }),
    ]);
    expect(finished!.refresh).toMatchObject({
      status: "completed",
      counts: {
        captures: 2,
        observed: 2,
        created: 1,
        updated: 0,
        unchanged: 1,
        unchangedTransactions: 1,
        failures: 0,
      },
    });
    expect((await db.getRefresh(failed!.refresh!.id))!.counts).toEqual(
      failed!.refresh!.counts,
    );
    expect(report.report().entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          refreshId: finished!.refresh!.id,
          captureId: pending.id,
          stage: "commit",
          outcome: "completed",
        }),
      ]),
    );
    await db.applyRun(pending.id, synthetic, undefined, finished!.refresh!.id);
    expect((await db.getRefresh(finished!.refresh!.id))!.counts).toEqual(
      finished!.refresh!.counts,
    );
  });

  it("retries a temporary recovery commit failure without losing earlier counts or requiring attention", async () => {
    await db.client.execute(
      "CREATE TRIGGER stage_recovery_runs BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT, 'synthetic-stage-recovery'); END",
    );
    const stagedAt = Date.now() - 2_000;
    for (const [key, amount] of [
      ["recover-first", -100],
      ["recover-second", -200],
    ] as const) {
      const event = capture(key, amount) as Extract<
        CollectionEvent,
        { type: "capture" }
      >;
      await expect(
        db.ingestRun(
          {
            runId: crypto.randomUUID(),
            connectionId,
            startedAt: new Date(
              stagedAt + (key === "recover-first" ? 0 : 1),
            ).toISOString(),
            responses: [event.capture],
          },
          synthetic,
        ),
      ).rejects.toThrow();
    }
    await db.client.execute("DROP TRIGGER stage_recovery_runs");
    await db.client.execute(
      "CREATE TRIGGER interrupt_second_recovery BEFORE INSERT ON transactions WHEN NEW.amount_minor = -200 BEGIN SELECT RAISE(ABORT, 'private-second-recovery-failure'); END",
    );
    let interruptedProgress: Awaited<ReturnType<Database["getRefresh"]>>;
    let interruptOnce = true;
    const transientStore: Database = {
      ...db,
      withCollectionLock: (id, work) =>
        db.withCollectionLock(id, (locked, signal) =>
          work(
            {
              ...locked,
              async recoverPendingRuns(...args) {
                try {
                  return await locked.recoverPendingRuns(...args);
                } catch (error) {
                  if (interruptOnce) {
                    interruptOnce = false;
                    interruptedProgress = await locked.getRefresh(args[2]!);
                    await db.client.execute(
                      "DROP TRIGGER interrupt_second_recovery",
                    );
                  }
                  throw error;
                }
              },
            },
            signal,
          ),
        ),
    };
    const collect = vi.fn(async function* () {
      yield capture("recover-second", -200);
    });
    const report = createSyncDiagnosticReport();
    const refreshes = service(async () => source(collect), {
      log: report.log,
      store: transientStore,
      retryDelaysMs: [0],
    });
    const [result] = await refreshes.wait([
      await refreshes.start(connectionId, {
        trigger: "manual",
        operator: true,
      }),
    ]);
    expect(interruptedProgress).toMatchObject({
      status: "running",
      requiresAttention: false,
      counts: { captures: 1, created: 1, observed: 1, failures: 0 },
    });
    expect(result!.refresh).toMatchObject({
      status: "completed",
      requiresAttention: false,
      counts: {
        captures: 3,
        observed: 3,
        created: 2,
        unchanged: 1,
        unchangedTransactions: 1,
        failures: 0,
      },
    });
    expect(collect).toHaveBeenCalledTimes(1);
    expect(
      (await db.listTransactions())
        .map((transaction) => transaction.sourceKey)
        .sort(),
    ).toEqual(["recover-first", "recover-second"]);
    expect(report.report().entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "commit",
          outcome: "failed",
          failureCategory: "persistence",
        }),
        expect.objectContaining({
          stage: "recovery",
          outcome: "failed",
          reason: "persistence_failure",
          requiresAttention: false,
          failureCategory: "persistence",
        }),
        expect.objectContaining({
          stage: "recovery",
          outcome: "completed",
          counts: { recoveredRuns: 1 },
        }),
      ]),
    );
    expect(JSON.stringify(report.report())).not.toContain("private-");
  });

  it.each([
    { code: "authentication_failed", attention: true },
    { code: "authentication_challenge", attention: true },
    { code: "rate_limited", attention: false },
    { code: "budget_exhausted", attention: false },
  ] as const)(
    "finishes a recovered $code stop before constructing a collector",
    async ({ code, attention }) => {
      await db.client.execute(
        "CREATE TRIGGER stage_provider_stop BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'synthetic-stage-provider-stop'); END",
      );
      await expect(
        db.ingestRun(
          {
            runId: crypto.randomUUID(),
            connectionId,
            responses: [],
            failures: [{ accountKey: null, endpoint: "collection", code }],
          },
          synthetic,
        ),
      ).rejects.toThrow();
      await db.client.execute("DROP TRIGGER stage_provider_stop");
      const collect = vi.fn(async function* () {
        yield capture("must-not-request-after-provider-stop");
      });
      const collector = vi.fn(async () => source(collect));
      const refreshes = service(collector);
      const [result] = await refreshes.wait([
        await refreshes.start(connectionId, {
          trigger: "manual",
          operator: true,
        }),
      ]);
      expect(result!.refresh).toMatchObject({
        status: "failed",
        providerStopReason: code,
        requiresAttention: attention,
        counts: { failures: 1, captures: 0, created: 0, observed: 0 },
      });
      expect(collector).not.toHaveBeenCalled();
      expect(collect).not.toHaveBeenCalled();
      expect(
        (await refreshes.start(connectionId, { trigger: "manual" })).reason,
      ).toBe(attention ? "requires_attention" : "cooldown");
    },
  );

  it.each([
    { empty: false, stagedStop: false },
    { empty: true, stagedStop: false },
    { empty: false, stagedStop: true },
    { empty: true, stagedStop: true },
  ])(
    "preserves recent acceptance across a stopped execution crash (empty=$empty, stagedStop=$stagedStop)",
    async ({ empty, stagedStop }) => {
      await abandoned(new Date().toISOString(), { range: null, windows: [] });
      const accepted = capture("recent-accepted-before-stop") as Extract<
        CollectionEvent,
        { type: "capture" }
      >;
      if (empty) {
        accepted.capture.responseText = "[]";
      }
      await db.ingestRun(
        {
          runId: crypto.randomUUID(),
          connectionId,
          refreshId: "abandoned",
          responses: [accepted.capture],
        },
        synthetic,
      );
      expect((await db.getRefresh("abandoned"))!.hasAcceptedEvidence).toBe(
        true,
      );
      const stopped: CollectionEvent = {
        type: "failure",
        failure: {
          accountKey: null,
          endpoint: "collection",
          code: "rate_limited",
        },
        fatal: true,
      };
      const stopInput = {
        runId: crypto.randomUUID(),
        connectionId,
        refreshId: "abandoned",
        responses: [],
        failures: [stopped.failure],
      };
      if (stagedStop) {
        await db.client.execute(
          "CREATE TRIGGER stage_recent_stop BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'synthetic-stage-recent-stop'); END",
        );
        await expect(db.ingestRun(stopInput, synthetic)).rejects.toThrow();
        await db.client.execute("DROP TRIGGER stage_recent_stop");
      } else {
        await db.ingestRun(stopInput, synthetic);
      }
      const collector = vi.fn(async () => source(async function* () {}));
      const resumed = service(collector);
      await resumed.resumeStalled();
      await resumed.settled();
      const resumedRefresh = (await db.getRefresh("abandoned"))!;
      expect(resumedRefresh).toMatchObject({
        status: "partial",
        hasAcceptedEvidence: true,
        windows: [],
        counts: {
          captures: 1,
          created: empty ? 0 : 1,
          observed: empty ? 0 : 1,
          failures: 1,
        },
      });
      expect(collector).not.toHaveBeenCalled();
      const uninterrupted = service(async () =>
        source(async function* () {
          yield accepted;
          yield stopped;
        }),
      );
      const [normal] = await uninterrupted.wait([
        await uninterrupted.start(connectionId, {
          trigger: "manual",
          operator: true,
        }),
      ]);
      expect(resumedRefresh.status).toBe(normal!.refresh!.status);
    },
  );

  it.each([false, true])(
    "keeps earlier recent acceptance when a resumed attempt only fails (empty=%s)",
    async (empty) => {
      await abandoned(new Date().toISOString(), { range: null, windows: [] });
      const accepted = capture("recent-accepted-before-retry") as Extract<
        CollectionEvent,
        { type: "capture" }
      >;
      if (empty) {
        accepted.capture.responseText = "[]";
      }
      await db.ingestRun(
        {
          runId: crypto.randomUUID(),
          connectionId,
          refreshId: "abandoned",
          responses: [accepted.capture],
        },
        synthetic,
      );
      const resumed = service(async () =>
        source(async function* () {
          yield {
            type: "failure",
            failure: {
              accountKey: null,
              endpoint: "collection",
              code: "network_error",
            },
            fatal: false,
          };
        }),
      );
      await resumed.resumeStalled();
      await resumed.settled();
      expect(await db.getRefresh("abandoned")).toMatchObject({
        status: "partial",
        hasAcceptedEvidence: true,
        counts: {
          captures: 1,
          created: empty ? 0 : 1,
          observed: empty ? 0 : 1,
          failures: 1,
        },
      });
    },
  );

  it("does not claim recent acceptance from unrelated recovery counts", async () => {
    await abandoned(new Date().toISOString(), { range: null, windows: [] });
    const stagedAt = Date.now() - 2_000;
    const foreign = capture("unrelated-recovery") as Extract<
      CollectionEvent,
      { type: "capture" }
    >;
    await db.client.execute(
      "CREATE TRIGGER stage_foreign_recovery BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'synthetic-stage-foreign-recovery'); END",
    );
    await expect(
      db.ingestRun(
        {
          runId: crypto.randomUUID(),
          startedAt: new Date(stagedAt).toISOString(),
          connectionId,
          responses: [foreign.capture],
        },
        synthetic,
      ),
    ).rejects.toThrow();
    await expect(
      db.ingestRun(
        {
          runId: crypto.randomUUID(),
          startedAt: new Date(stagedAt + 1).toISOString(),
          connectionId,
          responses: [],
          failures: [
            { accountKey: null, endpoint: "collection", code: "rate_limited" },
          ],
        },
        synthetic,
      ),
    ).rejects.toThrow();
    await db.client.execute("DROP TRIGGER stage_foreign_recovery");
    const collector = vi.fn(async () => source(async function* () {}));
    const resumed = service(collector);
    await resumed.resumeStalled();
    await resumed.settled();
    expect(await db.getRefresh("abandoned")).toMatchObject({
      status: "failed",
      hasAcceptedEvidence: false,
      counts: { created: 1, observed: 1, captures: 1, failures: 1 },
    });
    expect(collector).not.toHaveBeenCalled();
  });

  it.each([
    { empty: false, stagedStop: false },
    { empty: true, stagedStop: false },
    { empty: false, stagedStop: true },
    { empty: true, stagedStop: true },
  ])(
    "preserves partial window acceptance across a stopped checkpoint crash (empty=$empty, stagedStop=$stagedStop)",
    async ({ empty, stagedStop }) => {
      const requestedRange = { from: "2040-01-01", to: "2040-01-31" };
      await abandoned(new Date().toISOString(), {
        range: requestedRange,
        windows: [{ ...requestedRange, status: "running" }],
      });
      const accepted = capture("accepted-before-stop") as Extract<
        CollectionEvent,
        { type: "capture" }
      >;
      if (empty) {
        accepted.capture.responseText = "[]";
      }
      await db.ingestRun(
        {
          runId: crypto.randomUUID(),
          connectionId,
          refreshId: "abandoned",
          responses: [accepted.capture],
        },
        synthetic,
      );
      expect(
        (await db.getRefresh("abandoned"))!.windows[0]!.hasAcceptedEvidence,
      ).toBe(true);
      const stopped: CollectionEvent = {
        type: "failure",
        failure: {
          accountKey: null,
          endpoint: "collection",
          code: "rate_limited",
        },
        fatal: true,
      };
      const stopInput = {
        runId: crypto.randomUUID(),
        connectionId,
        refreshId: "abandoned",
        responses: [],
        failures: [stopped.failure],
      };
      if (stagedStop) {
        await db.client.execute(
          "CREATE TRIGGER stage_window_stop BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'synthetic-stage-window-stop'); END",
        );
        await expect(db.ingestRun(stopInput, synthetic)).rejects.toThrow();
        await db.client.execute("DROP TRIGGER stage_window_stop");
      } else {
        await db.ingestRun(stopInput, synthetic);
      }
      const collector = vi.fn(async () => source(async function* () {}));
      const resumed = service(collector);
      await resumed.resumeStalled();
      await resumed.settled();
      const resumedRefresh = (await db.getRefresh("abandoned"))!;
      expect(resumedRefresh).toMatchObject({
        status: "partial",
        windows: [{ status: "partial", hasAcceptedEvidence: true }],
        counts: {
          captures: 1,
          created: empty ? 0 : 1,
          observed: empty ? 0 : 1,
          failures: 1,
        },
      });
      expect(collector).not.toHaveBeenCalled();
      const uninterrupted = service(async () =>
        source(async function* () {
          yield accepted;
          yield stopped;
        }),
      );
      const [normal] = await uninterrupted.wait([
        await uninterrupted.start(connectionId, {
          trigger: "manual",
          operator: true,
          range: requestedRange,
        }),
      ]);
      expect(resumedRefresh.status).toBe(normal!.refresh!.status);
      expect(resumedRefresh.windows[0]!.status).toBe(
        normal!.refresh!.windows[0]!.status,
      );
    },
  );

  it.each([false, true])(
    "keeps earlier accepted evidence when the resumed window attempt only fails (empty=%s)",
    async (empty) => {
      const requestedRange = { from: "2040-01-01", to: "2040-01-31" };
      await abandoned(new Date().toISOString(), {
        range: requestedRange,
        windows: [{ ...requestedRange, status: "running" }],
      });
      const accepted = capture("accepted-before-retry") as Extract<
        CollectionEvent,
        { type: "capture" }
      >;
      if (empty) {
        accepted.capture.responseText = "[]";
      }
      await db.ingestRun(
        {
          runId: crypto.randomUUID(),
          connectionId,
          refreshId: "abandoned",
          responses: [accepted.capture],
        },
        synthetic,
      );
      const resumed = service(async () =>
        source(async function* () {
          yield {
            type: "failure",
            failure: {
              accountKey: null,
              endpoint: "collection",
              code: "network_error",
            },
            fatal: false,
          };
        }),
      );
      await resumed.resumeStalled();
      await resumed.settled();
      expect(await db.getRefresh("abandoned")).toMatchObject({
        status: "partial",
        windows: [{ status: "partial", hasAcceptedEvidence: true }],
        counts: {
          captures: 1,
          created: empty ? 0 : 1,
          observed: empty ? 0 : 1,
          failures: 1,
        },
      });
    },
  );

  it.each([
    { code: "authentication_failed", attention: true },
    { code: "authentication_challenge", attention: true },
    { code: "rate_limited", attention: false },
    { code: "budget_exhausted", attention: false },
  ] as const)(
    "resumes a persisted $code stop without restarting the provider or leaving a running month",
    async ({ code, attention }) => {
      await abandoned(new Date().toISOString(), {
        windows: [
          { from: "2040-02-01", to: "2040-02-29", status: "completed" },
          { from: "2040-01-01", to: "2040-01-31", status: "running" },
        ],
      });
      await db.ingestRun(
        {
          runId: crypto.randomUUID(),
          connectionId,
          refreshId: "abandoned",
          responses: [],
          failures: [{ accountKey: null, endpoint: "collection", code }],
        },
        synthetic,
      );
      const collector = vi.fn(async () => source(async function* () {}));
      const refreshes = service(collector);
      await refreshes.resumeStalled();
      await refreshes.settled();
      expect(await db.getRefresh("abandoned")).toMatchObject({
        status: "partial",
        providerStopReason: code,
        requiresAttention: attention,
        finishedAt: expect.any(String),
        windows: [{ status: "completed" }, { status: "failed" }],
        counts: { failures: 1 },
      });
      expect(collector).not.toHaveBeenCalled();
      expect(
        (await refreshes.start(connectionId, { trigger: "manual" })).reason,
      ).toBe(attention ? "requires_attention" : "cooldown");
    },
  );

  it("blocks deterministic extraction failures during recovery and reports their phase without retrying automatically", async () => {
    await db.client.execute(
      "CREATE TRIGGER stage_poisoned_capture BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT, 'synthetic-stage-poisoned'); END",
    );
    const event = capture("poisoned") as Extract<
      CollectionEvent,
      { type: "capture" }
    >;
    await expect(
      db.ingestRun(
        {
          runId: crypto.randomUUID(),
          connectionId,
          responses: [event.capture],
        },
        synthetic,
      ),
    ).rejects.toThrow();
    await db.client.execute("DROP TRIGGER stage_poisoned_capture");
    const extract = vi.fn(() => {
      throw new Error("private-extraction-payload");
    });
    const collector = vi.fn(async () =>
      source(async function* () {
        yield capture("must-not-collect");
      }),
    );
    const report = createSyncDiagnosticReport();
    const refreshes = service(collector, {
      log: report.log,
      targets: async () => ({
        targets: [
          { connectionId, adapter: { ...synthetic, extract }, collector },
        ],
        failures: 0,
      }),
    });
    const [result] = await refreshes.wait([
      await refreshes.start(connectionId, {
        trigger: "manual",
        operator: true,
      }),
    ]);
    expect(result!.refresh).toMatchObject({
      status: "failed",
      requiresAttention: true,
      counts: { created: 0, captures: 0, failures: 1 },
    });
    expect(report.report().entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "extraction", outcome: "failed" }),
        expect.objectContaining({
          stage: "recovery",
          outcome: "failed",
          reason: "manual_recovery_required",
          failureCategory: "execution",
          requiresAttention: true,
        }),
      ]),
    );
    await refreshes.resumeStalled();
    await refreshes.settled();
    expect(
      (await refreshes.start(connectionId, { trigger: "scheduled" })).reason,
    ).toBe("requires_attention");
    expect(extract).toHaveBeenCalledTimes(1);
    expect(collector).not.toHaveBeenCalled();
    expect(JSON.stringify(report.report())).not.toContain("private-");
  });

  it("reports parser-incompatible pending evidence as a bounded manual recovery block", async () => {
    await db.client.execute(
      "CREATE TRIGGER stage_incompatible_capture BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT, 'synthetic-stage-incompatible'); END",
    );
    const event = capture("incompatible") as Extract<
      CollectionEvent,
      { type: "capture" }
    >;
    await expect(
      db.ingestRun(
        {
          runId: crypto.randomUUID(),
          connectionId,
          responses: [event.capture],
        },
        { ...synthetic, parserVersion: "private-incompatible-parser-version" },
      ),
    ).rejects.toThrow();
    await db.client.execute("DROP TRIGGER stage_incompatible_capture");
    const collect = vi.fn(async function* () {
      yield capture("never-requested");
    });
    const report = createSyncDiagnosticReport();
    const refreshes = service(async () => source(collect), { log: report.log });
    const [result] = await refreshes.wait([
      await refreshes.start(connectionId, {
        trigger: "manual",
        operator: true,
      }),
    ]);
    expect(result!.refresh).toMatchObject({
      status: "failed",
      requiresAttention: true,
      counts: { captures: 0, created: 0, observed: 0, failures: 1 },
    });
    expect(report.report().entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          refreshId: result!.refresh!.id,
          stage: "recovery",
          outcome: "failed",
          reason: "manual_recovery_required",
          requiresAttention: true,
          failureCategory: "collection",
        }),
      ]),
    );
    expect(collect).not.toHaveBeenCalled();
    expect(
      (await refreshes.start(connectionId, { trigger: "manual" })).reason,
    ).toBe("requires_attention");
    expect(JSON.stringify(report.report())).not.toContain("private-");
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
          observed: 0,
          unchangedTransactions: 0,
          unlisted: 0,
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
          observed: 0,
          unchangedTransactions: 0,
          unlisted: 0,
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

  it.each([false, true])(
    "expires unfinished ranges without a running checkpoint or provider call (prior completed=%s)",
    async (completedBefore) => {
      await abandoned(new Date(Date.now() - 25 * 3_600_000).toISOString(), {
        range: {
          from: "2040-01-01",
          to: completedBefore ? "2040-02-29" : "2040-01-31",
        },
        windows: [
          ...(completedBefore
            ? [{ from: "2040-02-01", to: "2040-02-29", status: "completed" }]
            : []),
          { from: "2040-01-01", to: "2040-01-31", status: "running" },
        ],
      });
      const collector = vi.fn(async () => source(async function* () {}));
      const refreshes = service(collector);
      await refreshes.resumeStalled();
      await refreshes.settled();
      expect(collector).not.toHaveBeenCalled();
      const expired = (await db.getRefresh("abandoned"))!;
      expect(expired).toMatchObject({
        status: "failed",
        failureReason: "expired",
        counts: { failures: 1 },
      });
      expect(expired.windows.map((window) => window.status)).toEqual(
        completedBefore ? ["completed", "failed"] : ["failed"],
      );
    },
  );

  it("preserves an accepted partial window when expiry requires the overall refresh to fail", async () => {
    await abandoned(new Date(Date.now() - 25 * 3_600_000).toISOString(), {
      range: { from: "2040-01-01", to: "2040-01-31" },
      windows: [{ from: "2040-01-01", to: "2040-01-31", status: "running" }],
    });
    const accepted = capture("accepted-before-expiry") as Extract<
      CollectionEvent,
      { type: "capture" }
    >;
    await db.ingestRun(
      {
        runId: crypto.randomUUID(),
        connectionId,
        refreshId: "abandoned",
        responses: [accepted.capture],
      },
      synthetic,
    );
    const collector = vi.fn(async () => source(async function* () {}));
    const refreshes = service(collector);
    await refreshes.resumeStalled();
    await refreshes.settled();
    expect(await db.getRefresh("abandoned")).toMatchObject({
      status: "failed",
      failureReason: "expired",
      windows: [{ status: "partial", hasAcceptedEvidence: true }],
      counts: { created: 1, observed: 1, failures: 1 },
    });
    expect(collector).not.toHaveBeenCalled();
  });

  it("traces recovered ingestion stages through the refresh logger with original correlation IDs", async () => {
    const refreshId = crypto.randomUUID();
    const captureId = crypto.randomUUID();
    await abandoned(new Date().toISOString(), {
      id: refreshId,
      range: null,
      windows: [],
    });
    await db.client.execute(
      "CREATE TRIGGER interrupt_financial_application BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT, 'synthetic interrupted application'); END",
    );
    const event = capture("recovered-for-diagnostics") as Extract<
      CollectionEvent,
      { type: "capture" }
    >;
    await expect(
      db.ingestRun(
        {
          runId: captureId,
          refreshId,
          connectionId,
          responses: [event.capture],
        },
        synthetic,
      ),
    ).rejects.toThrow();
    await db.client.execute("DROP TRIGGER interrupt_financial_application");
    const report = createSyncDiagnosticReport();
    const refreshes = service(
      async () =>
        source(async function* () {
          yield capture("fresh-after-recovery");
        }),
      { log: report.log },
    );
    await refreshes.resumeStalled();
    await refreshes.settled();
    expect(await db.getRefresh(refreshId)).toMatchObject({
      status: "completed",
      counts: { created: 2, observed: 2 },
    });
    expect(report.report().entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          refreshId,
          captureId,
          stage: "extraction",
          outcome: "completed",
          counts: { extracted: 1 },
        }),
        expect.objectContaining({
          refreshId,
          captureId,
          stage: "commit",
          outcome: "completed",
        }),
        expect.objectContaining({
          refreshId,
          stage: "recovery",
          outcome: "completed",
          counts: { recoveredRuns: 1 },
        }),
      ]),
    );
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

  async function backfill(
    collector: ProviderCollector,
    debugArchiveDays?: number,
  ) {
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
      ...(debugArchiveDays !== undefined && { debugArchiveDays }),
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
      2,
    );
    expect(refresh?.status).toBe("partial");
    const archived = await db.client.execute(
      "SELECT metadata_json AS evidence FROM sync_runs UNION ALL SELECT snapshot_json AS evidence FROM sync_run_bodies",
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
    const refresh = await backfill(
      {
        ...collector,
        async *collect(options) {
          // The second month replaces token 1 with token 2; the third echoes token 1.
          if (++months === 2) {
            cal.expire();
          }
          yield* collector.collect(options);
        },
      },
      2,
    );
    expect(cal.calls.logins).toBe(2);
    expect(refresh?.status).toBe("partial");
    const archived = await db.client.execute(
      "SELECT metadata_json AS evidence FROM sync_runs UNION ALL SELECT snapshot_json AS evidence FROM sync_run_bodies",
    );
    expect(JSON.stringify(archived.rows)).not.toContain("SYNTHETIC-TOKEN");
  });
});
