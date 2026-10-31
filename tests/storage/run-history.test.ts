import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TransactionInput } from "../../src/domain/model.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { runHistoryComparisons } from "../helpers/run-history-differential.js";
import {
  backends,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

const endpoint = "synthetic:health";

function adapter(success: boolean): SourceAdapter {
  return {
    ...synthetic,
    extract: (text, context) => ({
      transactions: JSON.parse(text) as TransactionInput[],
      partitions: (["posted", "pending"] as const).map((status) => ({
        accountKey: context.accountKey,
        resource: endpoint,
        status,
        success,
        comparable: success,
      })),
      historical: false,
      warnings: [],
    }),
  };
}

const healthy = adapter(true);
const failing = adapter(false);
const interrupted: SourceAdapter = {
  ...healthy,
  extract: () => {
    throw new Error("Synthetic interrupted extraction");
  },
};

// Health keys of the synthetic account's two partitions, sorted.
const failedScopes = [
  '["account","synthetic:health","pending","{\\"kind\\":\\"recent\\"}"]',
  '["account","synthetic:health","posted","{\\"kind\\":\\"recent\\"}"]',
];

for (const backend of backends) {
  describe(`run history loading: ${backend}`, () => {
    let db: Harness;
    let connectionId: string;

    const capture = (
      runId: string,
      capturedAt: string,
      rows: TransactionInput[],
      source = healthy,
      accountKey = "account",
    ) =>
      db.ingestRun(
        {
          connectionId,
          runId,
          startedAt: capturedAt,
          responses: [
            {
              accountKey,
              endpoint,
              capturedAt,
              responseText: JSON.stringify(rows),
            },
          ],
        },
        source,
      );
    const healthEvents = async () =>
      (await db.listEvents({ connectionId, limit: 1000 }))
        .filter((event) => event.type.startsWith("sync."))
        .map(({ runId, type, before, after }) => ({
          runId,
          type,
          before,
          after,
        }));
    const recovered = (runId: string, previous: string) => ({
      runId,
      type: "sync.recovered",
      before: { status: previous, failedScopes },
      after: {
        status: "completed",
        recoveredScopes: failedScopes,
        failedScopes: [],
      },
    });
    const scopedFor = () => runHistoryComparisons.at(-1)?.scoped;
    const at = (time: string) => vi.setSystemTime(new Date(time));

    beforeEach(async () => {
      db = await open(backend);
      connectionId = `run-history-${randomUUID()}`;
      await db.ensureConnection({ id: connectionId, provider: "cal" });
      vi.useFakeTimers({ toFake: ["Date"] });
      at("2041-01-01T00:00:00.000Z");
      await capture("base", "2040-08-01T00:00:00.000Z", [row("k")]);
    });
    afterEach(async () => {
      vi.useRealTimers();
      await db?.close();
    });

    it("recovers a failure applied in the same millisecond before the recovery", async () => {
      await capture("failure", "2040-08-02T00:00:00.000Z", [], failing);
      await capture("recovery", "2040-08-02T00:00:00.000Z", [row("k")]);
      await capture("later", "2040-08-03T00:00:00.000Z", [row("k")]);
      expect(
        (await healthEvents()).filter(({ type }) => type === "sync.recovered"),
      ).toEqual([recovered("recovery", "failed")]);
      expect(scopedFor()).toBe(true);
    });

    it("keeps a failure applied in the same millisecond after a recovery", async () => {
      await capture("recovery", "2040-08-02T00:00:00.000Z", [row("k")]);
      await capture("failure", "2040-08-02T00:00:00.000Z", [], failing);
      await capture("later", "2040-08-03T00:00:00.000Z", [row("k")]);
      expect(
        (await healthEvents()).filter(({ type }) => type === "sync.recovered"),
      ).toEqual([recovered("later", "failed")]);
      expect(scopedFor()).toBe(true);
    });

    for (const [name, apply] of [
      [
        "staged before the failure and applied in the same millisecond",
        async () => {
          await expect(
            capture(
              "recovery",
              "2040-08-02T00:00:00.000Z",
              [row("k")],
              interrupted,
            ),
          ).rejects.toThrow("Synthetic interrupted extraction");
          await capture("failure", "2040-08-02T00:00:00.000Z", [], failing);
          await db.applyRun("recovery", healthy);
        },
      ],
      [
        "applied after the clock stepped back",
        async () => {
          await capture("failure", "2040-08-02T00:00:00.000Z", [], failing);
          at("2040-12-31T23:59:59.999Z");
          await capture("recovery", "2040-08-02T00:00:00.000Z", [row("k")]);
          at("2041-01-01T00:00:00.000Z");
        },
      ],
    ] as const) {
      it(`folds a recovery ${name} in application order`, async () => {
        await apply();
        // Application order puts the recovery before the failure, so the
        // failure is still open for the next capture.
        await capture("later", "2040-08-03T00:00:00.000Z", [row("k")]);
        expect(scopedFor()).toBe(false);
        await capture("settled", "2040-08-04T00:00:00.000Z", [row("k")]);
        expect(scopedFor()).toBe(true);
        expect(
          (await healthEvents()).filter(
            ({ type }) => type === "sync.recovered",
          ),
        ).toEqual([
          recovered("recovery", "failed"),
          recovered("later", "failed"),
        ]);
      });
    }

    it("builds a missing summary from every applied run once", async () => {
      await capture("failure", "2040-08-02T00:00:00.000Z", [], failing);
      await db.raw("DELETE FROM sync_run_history WHERE connection_id = ?", [
        connectionId,
      ]);
      await capture("recovery", "2040-08-03T00:00:00.000Z", [row("k")]);
      expect(scopedFor()).toBe(false);
      const [stored] = await db.raw(
        "SELECT document_json FROM sync_run_history WHERE connection_id = ?",
        [connectionId],
      );
      expect(JSON.parse(String(stored!.document_json))).toMatchObject({
        appliedRuns: 3,
        latestRunId: "recovery",
        failed: [],
        latestCapture: "2040-08-03T00:00:00.000Z",
      });
      await capture("later", "2040-08-04T00:00:00.000Z", [row("k")]);
      expect(scopedFor()).toBe(true);
      expect(
        (await healthEvents()).filter(({ type }) => type === "sync.recovered"),
      ).toEqual([recovered("recovery", "failed")]);
    });

    it("lets a backdated capture see newer retained coverage", async () => {
      await capture("late", "2040-08-05T00:00:00.000Z", [row("k")]);
      await capture("early", "2040-08-03T00:00:00.000Z", [
        row("k"),
        row("discovered"),
      ]);
      expect(scopedFor()).toBe(false);
      const discovered = (
        await db.listTransactions({
          connectionId,
          perspective: "all",
          presence: "all",
        })
      ).find((transaction) => transaction.lastSeenRunId === "early");
      expect(discovered?.sourceAbsence).toEqual({
        runId: "late",
        capturedAt: "2040-08-05T00:00:00.000Z",
      });
    });

    it("loads an omission witness older than the latest runs", async () => {
      await capture("witness", "2040-08-02T00:00:00.000Z", [row("m")]);
      const absent = async () =>
        (
          await db.listTransactions({
            connectionId,
            perspective: "all",
            presence: "all",
          })
        ).find((transaction) => transaction.lastSeenRunId !== "witness")!;
      expect((await absent()).sourceAbsence).toEqual({
        runId: "witness",
        capturedAt: "2040-08-02T00:00:00.000Z",
      });
      await capture(
        "other-a",
        "2040-08-03T00:00:00.000Z",
        [],
        healthy,
        "other",
      );
      await capture(
        "other-b",
        "2040-08-04T00:00:00.000Z",
        [],
        healthy,
        "other",
      );
      await capture("returned", "2040-08-05T00:00:00.000Z", [
        row("k"),
        row("m"),
      ]);
      expect(runHistoryComparisons.at(-1)).toMatchObject({
        scoped: true,
        appliedRuns: 4,
      });
      // The latest run, and the base and witness runs the rows name.
      expect(runHistoryComparisons.at(-1)!.loadedRuns).toBe(3);
      const restored = (
        await db.listTransactions({ connectionId, perspective: "all" })
      ).filter((transaction) => transaction.lastSeenRunId === "returned");
      expect(restored).toHaveLength(2);
      expect(restored.every((row) => row.sourceAbsence === undefined)).toBe(
        true,
      );
    });
  });
}
