import "../helpers/application-loading-differential.js";

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  collectFromStore,
  type CollectionStore,
} from "../../src/application/collection.js";
import type { RunInput } from "../../src/domain/plans/sync.js";
import type {
  CollectionEvent,
  ProviderCollector,
  SourceAdapter,
} from "../../src/domain/source-adapter.js";
import { createRefreshService } from "../../src/runtime/refresh-service.js";
import {
  backends,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";
import {
  dropFailure,
  failWrites,
  readRuns,
} from "../helpers/storage-inspection.js";

/** Reports complete partitions for whichever account the response was requested for. */
const accounts: SourceAdapter = {
  ...synthetic,
  extract: (text, context) => ({
    transactions: JSON.parse(text) as ReturnType<typeof row>[],
    partitions: (["posted", "pending"] as const).map((status) => ({
      accountKey: context.accountKey,
      status,
      success: true,
      comparable: true,
    })),
    historical: false,
    warnings: [],
  }),
};

function capture(
  account: string,
  rows: [sourceKey: string, amountMinor: number][],
  capturedAt: string,
  padding = 0,
): CollectionEvent {
  return {
    type: "capture",
    capture: {
      accountKey: account,
      endpoint: "synthetic",
      capturedAt,
      responseText:
        JSON.stringify(
          rows.map(([sourceKey, amountMinor]) =>
            row(sourceKey, {
              sourceScope: account,
              cardKey: `${account}-card`,
              amountMinor,
            }),
          ),
        ) + " ".repeat(padding),
    },
  };
}

function failure(account: string): CollectionEvent {
  return {
    type: "failure",
    failure: {
      accountKey: account,
      endpoint: "synthetic",
      code: "network_error",
    },
    fatal: false,
  };
}

function collector(events: CollectionEvent[]): ProviderCollector {
  return {
    provider: "cal",
    collectorVersion: "synthetic-v1",
    async *collect() {
      yield* events;
    },
  };
}

/** Rejects a wholly empty recent response while covered rows remain. */
const guarded: SourceAdapter = { ...accounts, rejectEmptyRecent: true };

const baselineAt = "2040-08-01T00:00:00.000Z";
const unitAt = "2040-08-02T00:00:00.000Z";
const baseline = [
  capture(
    "first",
    [
      ["first-kept", -100],
      ["first-changed", -200],
    ],
    baselineAt,
  ),
  capture("second", [["second-kept", -300]], baselineAt),
  capture(
    "third",
    [
      ["third-kept", -400],
      ["third-dropped", -500],
    ],
    baselineAt,
  ),
];
/** One change of each kind: an amount update, a new row and an absent row. */
const unit = [
  capture(
    "first",
    [
      ["first-kept", -100],
      ["first-changed", -250],
    ],
    unitAt,
  ),
  capture(
    "second",
    [
      ["second-kept", -300],
      ["second-new", -600],
    ],
    unitAt,
  ),
  capture("third", [["third-kept", -400]], unitAt),
];

const emptyThird = [unit[0]!, unit[1]!, capture("third", [], unitAt)];

for (const backend of backends) {
  describe(`batched collection units: ${backend}`, () => {
    let db: Harness;
    let connectionId: string;
    beforeEach(async () => {
      db = await open(backend);
      connectionId = `batched-${randomUUID()}`;
      await db.ensureConnection({ id: connectionId, provider: "cal" });
    });
    afterEach(() => db?.close());

    /** The unit's first and second captures apply; the empty third leaves its rows alone. */
    async function expectConfinedLedger(runId: string) {
      const rows = Object.fromEntries(
        (await db.listTransactions({ connectionId, presence: "all" })).map(
          (row) => [row.sourceKey, [row.amountMinor, row.presence]],
        ),
      );
      expect(rows).toEqual({
        "first-kept": [-100, "seen"],
        "first-changed": [-250, "seen"],
        "second-kept": [-300, "seen"],
        "second-new": [-600, "seen"],
        "third-kept": [-400, "seen"],
        "third-dropped": [-500, "seen"],
      });
      const events = (await db.listEvents({ connectionId, limit: 1000 }))
        .filter((event) => event.runId === runId)
        .map((event) => event.type)
        .sort();
      expect(events).toEqual(["transaction.created", "transaction.updated"]);
    }

    it("ingests a unit's captures as one run holding every response", async () => {
      const summary = await collectFromStore(
        db,
        { connectionId },
        collector(baseline),
        accounts,
      );
      expect(summary).toMatchObject({
        status: "completed",
        captures: 3,
        failures: 0,
        created: 5,
      });
      expect(summary.runIds).toHaveLength(1);
      const runs = await readRuns(db);
      expect(runs.map((run) => run.id)).toEqual(summary.runIds);
      expect(runs[0]!.status).toBe("completed");
      expect(
        runs[0]!.snapshot.responses.map((response) => response.accountKey),
      ).toEqual(["first", "second", "third"]);
      expect(runs[0]!.snapshot.failures).toEqual([]);
    });

    it("starts another run when a unit's source text would exceed the run bound", async () => {
      const nineMiB = 9 * 1024 * 1024;
      const summary = await collectFromStore(
        db,
        { connectionId },
        collector([
          capture("first", [["first-kept", -100]], baselineAt, nineMiB),
          capture("second", [["second-kept", -300]], baselineAt, nineMiB),
          capture("third", [["third-kept", -400]], baselineAt),
        ]),
        accounts,
      );
      expect(summary).toMatchObject({ status: "completed", captures: 3 });
      const runs = await readRuns(db);
      expect(
        runs.map((run) =>
          run.snapshot.responses.map((response) => response.accountKey),
        ),
      ).toEqual([["first"], ["second", "third"]]);
    });

    it("ingests the captures fetched before an abort with the interruption as one run", async () => {
      const controller = new AbortController();
      let requestedAfterAbort = false;
      const streaming: ProviderCollector = {
        provider: "cal",
        collectorVersion: "synthetic-v1",
        async *collect() {
          yield baseline[0]!;
          controller.abort();
          yield baseline[1]!;
          requestedAfterAbort = true;
          yield baseline[2]!;
        },
      };
      const summary = await collectFromStore(
        db,
        { connectionId, signal: controller.signal },
        streaming,
        accounts,
      );
      expect(requestedAfterAbort).toBe(false);
      expect(summary).toMatchObject({
        status: "partial",
        captures: 2,
        failures: 1,
        created: 3,
      });
      const runs = await readRuns(db);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("partial");
      expect(
        runs[0]!.snapshot.responses.map((response) => response.accountKey),
      ).toEqual(["first", "second"]);
      expect(runs[0]!.snapshot.failures).toEqual([
        {
          accountKey: null,
          endpoint: "collection",
          code: "network_error",
          failedAt: expect.any(String),
        },
      ]);
      expect(await db.listTransactions()).toHaveLength(3);
    });

    it("keeps a provider failure inside the unit's run and the refresh partial", async () => {
      const service = createRefreshService({
        store: db,
        targets: async () => ({
          targets: [
            {
              connectionId,
              adapter: accounts,
              collector: async () =>
                collector([baseline[0]!, failure("second"), baseline[2]!]),
            },
          ],
          failures: 0,
        }),
        log: () => {},
        retryDelaysMs: [],
      });
      const started = await service.start(connectionId, {
        trigger: "manual",
        operator: true,
      });
      await service.settled();
      expect(await db.getRefresh(started.refresh!.id)).toMatchObject({
        status: "partial",
        counts: { captures: 2, failures: 1, created: 4 },
        failureCodes: ["network_error"],
      });
      const runs = await readRuns(db);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("partial");
      expect(
        runs[0]!.snapshot.responses.map((response) => response.accountKey),
      ).toEqual(["first", "third"]);
      expect(runs[0]!.snapshot.failures).toEqual([
        {
          accountKey: "second",
          endpoint: "synthetic",
          code: "network_error",
          failedAt: expect.any(String),
        },
      ]);
      expect(runs[0]!.coverage).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ accountKey: "second", success: false }),
        ]),
      );
    });

    it("rejects a run whose only response is implausibly empty as a whole, without events", async () => {
      await collectFromStore(
        db,
        { connectionId },
        collector(baseline),
        guarded,
      );
      const before = await db.listTransactions({
        connectionId,
        presence: "all",
      });
      const summary = await collectFromStore(
        db,
        { connectionId },
        collector([capture("third", [], unitAt)]),
        guarded,
      );
      expect(summary).toMatchObject({
        status: "failed",
        captures: 1,
        failures: 1,
        failureCodes: ["implausible_empty"],
        created: 0,
        updated: 0,
        unlisted: 0,
      });
      const rejected = (await readRuns(db))[1]!;
      expect(rejected).toMatchObject({
        status: "failed",
        coverage: [],
        warnings: ["implausible_empty"],
      });
      expect(
        (await db.listEvents({ connectionId, limit: 1000 })).filter(
          (event) => event.runId === rejected.id,
        ),
      ).toEqual([]);
      expect(
        await db.listTransactions({ connectionId, presence: "all" }),
      ).toEqual(before);
    });

    it("confines an implausibly empty response's rejection to it, in the summary and the refresh", async () => {
      await collectFromStore(
        db,
        { connectionId },
        collector(baseline),
        guarded,
      );
      const log: { stage?: string; outcome?: string; counts?: object }[] = [];
      const service = createRefreshService({
        store: db,
        targets: async () => ({
          targets: [
            {
              connectionId,
              adapter: guarded,
              collector: async () => collector(emptyThird),
            },
          ],
          failures: 0,
        }),
        log: (entry) => log.push(entry as (typeof log)[number]),
        retryDelaysMs: [],
      });
      const started = await service.start(connectionId, {
        trigger: "manual",
        operator: true,
      });
      await service.settled();
      // The collection summary, as its closing diagnostic reports it.
      expect(
        log.find(
          (entry) =>
            entry.stage === "collection" && entry.outcome !== "started",
        ),
      ).toMatchObject({
        outcome: "partial",
        counts: {
          captures: 3,
          failures: 1,
          observed: 4,
          unchangedTransactions: 2,
          unchanged: 0,
          created: 1,
          changed: 1,
          absent: 0,
        },
      });
      expect(await db.getRefresh(started.refresh!.id)).toMatchObject({
        status: "partial",
        failureCodes: ["implausible_empty"],
        counts: {
          captures: 3,
          failures: 1,
          observed: 4,
          unchangedTransactions: 2,
          unchanged: 0,
          created: 1,
          updated: 1,
          unlisted: 0,
        },
      });
      const runs = await readRuns(db);
      expect(runs).toHaveLength(2);
      expect(runs[1]).toMatchObject({
        status: "partial",
        warnings: ["implausible_empty"],
      });
      expect(
        [...new Set(runs[1]!.coverage.map((part) => part.accountKey))].sort(),
      ).toEqual(["first", "second"]);
      await expectConfinedLedger(runs[1]!.id);
    });

    it("recovers an interrupted run with a confined rejection through pending-run recovery", async () => {
      await collectFromStore(
        db,
        { connectionId },
        collector(baseline),
        guarded,
      );
      await failWrites(
        db,
        "interrupt_unit",
        "transactions",
        "INSERT",
        "synthetic interruption",
      );
      await expect(
        collectFromStore(db, { connectionId }, collector(emptyThird), guarded),
      ).rejects.toThrow();
      await dropFailure(db, "interrupt_unit", "transactions");
      const pending = (await readRuns(db))[1]!;
      expect(pending.status).toBe("started");
      const recovered = await db.withCollectionLock(connectionId, (store) =>
        store.recoverPendingRuns(guarded),
      );
      expect(recovered).toEqual({
        acquired: true,
        result: [
          expect.objectContaining({
            runId: pending.id,
            replayed: false,
            status: "partial",
            failureCode: "implausible_empty",
            created: 1,
            updated: 1,
            unlisted: 0,
          }),
        ],
      });
      expect(await readRuns(db)).toHaveLength(2);
      await expectConfinedLedger(pending.id);
    });

    it.each([
      {
        split: "a repeated account",
        events: [
          capture("first", [["first-kept", -100]], baselineAt),
          capture("first", [["first-later", -200]], unitAt),
        ],
      },
      {
        split: "the size bound",
        events: [
          capture("first", [["first-kept", -100]], baselineAt, 9 * 1024 * 1024),
          capture(
            "second",
            [["second-kept", -300]],
            baselineAt,
            9 * 1024 * 1024,
          ),
        ],
      },
    ])(
      "keeps the capture that starts a new run at $split staged when the previous run fails to apply",
      async ({ events }) => {
        let requestedAfterFailure = false;
        const streaming: ProviderCollector = {
          provider: "cal",
          collectorVersion: "synthetic-v1",
          async *collect() {
            yield* events;
            requestedAfterFailure = true;
            yield capture("third", [["third-kept", -400]], unitAt);
          },
        };
        await failWrites(
          db,
          "interrupt_split",
          "transactions",
          "INSERT",
          "synthetic interruption",
        );
        await expect(
          collectFromStore(db, { connectionId }, streaming, accounts),
        ).rejects.toThrow();
        expect(requestedAfterFailure).toBe(false);
        await dropFailure(db, "interrupt_split", "transactions");
        const pending = await readRuns(db);
        expect(pending.map((run) => run.status)).toEqual([
          "started",
          "started",
        ]);
        expect(
          pending.map((run) =>
            run.snapshot.responses.map((response) => response.capturedAt),
          ),
        ).toEqual(
          events.map((event) =>
            event.type === "capture" ? [event.capture.capturedAt] : [],
          ),
        );
        expect(
          await db.withCollectionLock(connectionId, (store) =>
            store.recoverPendingRuns(accounts),
          ),
        ).toEqual({
          acquired: true,
          result: [
            expect.objectContaining({
              runId: pending[0]!.id,
              status: "completed",
              created: 1,
            }),
            expect.objectContaining({
              runId: pending[1]!.id,
              status: "completed",
              created: 1,
            }),
          ],
        });
        expect(
          (await db.listTransactions({ connectionId, presence: "all" }))
            .map((row) => row.sourceKey)
            .sort(),
        ).toEqual(
          events
            .flatMap((event) =>
              event.type === "capture"
                ? (JSON.parse(event.capture.responseText) as {
                    sourceKey: string;
                  }[])
                : [],
            )
            .map((row) => row.sourceKey)
            .sort(),
        );
      },
    );

    it("dates a partition's repeated failures by the latest, so a success between them recovers nothing", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2040-08-01T12:00:00.000Z"));
        await collectFromStore(
          db,
          { connectionId },
          collector(baseline),
          accounts,
        );
        const streaming: ProviderCollector = {
          provider: "cal",
          collectorVersion: "synthetic-v1",
          async *collect() {
            vi.setSystemTime(new Date("2040-08-02T00:01:00.000Z"));
            yield failure("first");
            vi.setSystemTime(new Date("2040-08-02T00:03:00.000Z"));
            yield failure("first");
            // Captured between the failures, but yielded after the second.
            vi.setSystemTime(new Date("2040-08-02T00:04:00.000Z"));
            yield capture(
              "first",
              [
                ["first-kept", -100],
                ["first-changed", -200],
              ],
              "2040-08-02T00:02:00.000Z",
            );
          },
        };
        const summary = await collectFromStore(
          db,
          { connectionId },
          streaming,
          accounts,
        );
        expect(summary.runIds).toHaveLength(2);
        const [failedRun] = summary.runIds;
        expect(
          (await readRuns(db, failedRun))[0]!.snapshot.failures?.map(
            (failed) => failed.failedAt,
          ),
        ).toEqual(["2040-08-02T00:01:00.000Z", "2040-08-02T00:03:00.000Z"]);
        const events = await db.listEvents({ connectionId, limit: 1000 });
        expect(
          events
            .filter((event) => event.type.startsWith("sync."))
            .map((event) => [event.type, event.runId]),
        ).toEqual([
          ["sync.baseline", expect.any(String)],
          ["sync.failed", failedRun],
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("dates a unit's failure by collection, so a later success of its account recovers it", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2040-08-01T12:00:00.000Z"));
        await collectFromStore(
          db,
          { connectionId },
          collector(baseline),
          accounts,
        );
        const streaming: ProviderCollector = {
          provider: "cal",
          collectorVersion: "synthetic-v1",
          async *collect() {
            vi.setSystemTime(new Date("2040-08-02T00:00:00.000Z"));
            yield failure("first");
            // Fetched a minute later; its run is ingested a minute after that.
            const fetched = capture(
              "first",
              [
                ["first-kept", -100],
                ["first-changed", -200],
              ],
              "2040-08-02T00:01:00.000Z",
            );
            vi.setSystemTime(new Date("2040-08-02T00:02:00.000Z"));
            yield fetched;
          },
        };
        const summary = await collectFromStore(
          db,
          { connectionId },
          streaming,
          accounts,
        );
        expect(summary.runIds).toHaveLength(2);
        const [failedRun, recoveredRun] = summary.runIds;
        expect((await readRuns(db, failedRun))[0]).toMatchObject({
          status: "failed",
          startedAt: "2040-08-02T00:00:00.000Z",
        });
        const events = await db.listEvents({ connectionId, limit: 1000 });
        expect(
          events
            .filter((event) => event.type.startsWith("sync."))
            .map((event) => [event.type, event.runId]),
        ).toEqual([
          ["sync.baseline", expect.any(String)],
          ["sync.failed", failedRun],
          ["sync.recovered", recoveredRun],
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("replays the batched run as already applied", async () => {
      const ingested: RunInput[] = [];
      const recording: CollectionStore = {
        ...db,
        async ingestRun(input, adapter, onDiagnostic) {
          ingested.push(structuredClone(input));
          return db.ingestRun(input, adapter, onDiagnostic);
        },
      };
      await collectFromStore(
        recording,
        { connectionId },
        collector(baseline),
        accounts,
      );
      expect(ingested).toHaveLength(1);
      const before = await db.listTransactions();
      expect(await db.ingestRun(ingested[0]!, accounts)).toMatchObject({
        runId: ingested[0]!.runId,
        replayed: true,
        status: "completed",
        created: 0,
        updated: 0,
        unlisted: 0,
      });
      expect(await db.listTransactions()).toEqual(before);
      expect(await readRuns(db)).toHaveLength(1);
    });

    it("reconciles a batched unit as the same captures applied one run each", async () => {
      const sequentialId = `${connectionId}-sequential`;
      await db.ensureConnection({ id: sequentialId, provider: "cal" });
      const note = async (target: string) => {
        const row = (await db.listTransactions({ connectionId: target })).find(
          (transaction) => transaction.sourceKey === "first-changed",
        )!;
        await db.editAnnotation({
          transactionId: row.id,
          expectedVersion: 0,
          notes: "Owner note",
        });
      };
      await collectFromStore(
        db,
        { connectionId },
        collector(baseline),
        accounts,
      );
      await note(connectionId);
      expect(
        await collectFromStore(db, { connectionId }, collector(unit), accounts),
      ).toMatchObject({
        status: "completed",
        captures: 3,
        created: 1,
        updated: 1,
        unlisted: 1,
      });
      for (const event of baseline) {
        await db.ingestRun(
          {
            runId: randomUUID(),
            connectionId: sequentialId,
            responses: event.type === "capture" ? [event.capture] : [],
          },
          accounts,
        );
      }
      await note(sequentialId);
      for (const event of unit) {
        await db.ingestRun(
          {
            runId: randomUUID(),
            connectionId: sequentialId,
            responses: event.type === "capture" ? [event.capture] : [],
          },
          accounts,
        );
      }
      const ledger = async (target: string) => {
        const rows = await db.listTransactions({
          connectionId: target,
          presence: "all",
        });
        const keys = new Map(rows.map((row) => [row.id, row.sourceKey]));
        const events = (
          await db.listEvents({ connectionId: target, limit: 1000 })
        ).map((event) => [
          event.type,
          event.transactionId ? keys.get(event.transactionId) : null,
        ]);
        return {
          rows: rows
            .map((row) => ({
              sourceKey: row.sourceKey,
              amountMinor: row.amountMinor,
              presence: row.presence,
              notes: row.annotation?.data.notes ?? null,
            }))
            .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)),
          versions: Object.fromEntries(
            rows.map((row) => [row.sourceKey, row.version]),
          ),
          events,
        };
      };
      const batched = await ledger(connectionId);
      expect(batched.rows).toEqual([
        {
          sourceKey: "first-changed",
          amountMinor: -250,
          presence: "seen",
          notes: "Owner note",
        },
        {
          sourceKey: "first-kept",
          amountMinor: -100,
          presence: "seen",
          notes: null,
        },
        {
          sourceKey: "second-kept",
          amountMinor: -300,
          presence: "seen",
          notes: null,
        },
        {
          sourceKey: "second-new",
          amountMinor: -600,
          presence: "seen",
          notes: null,
        },
        {
          sourceKey: "third-dropped",
          amountMinor: -500,
          presence: "not_returned",
          notes: null,
        },
        {
          sourceKey: "third-kept",
          amountMinor: -400,
          presence: "seen",
          notes: null,
        },
      ]);
      const sequential = await ledger(sequentialId);
      expect(sequential.rows).toEqual(batched.rows);
      expect(sequential.versions).toEqual(batched.versions);
      const changes = (events: (string | null | undefined)[][]) =>
        events
          .filter(([type]) => type !== "sync.baseline")
          .map((event) => event.join(" "))
          .sort();
      expect(changes(batched.events)).toEqual(changes(sequential.events));
      expect(changes(batched.events)).toEqual(
        expect.arrayContaining([
          "transaction.created second-new",
          "transaction.updated first-changed",
          "transaction.unlisted third-dropped",
        ]),
      );
      // A batched baseline announces its accounts once; one run each announces each.
      const baselines = (events: (string | null | undefined)[][]) =>
        events.filter(([type]) => type === "sync.baseline").length;
      expect(baselines(batched.events)).toBe(1);
      expect(baselines(sequential.events)).toBe(3);
    });
  });
}
