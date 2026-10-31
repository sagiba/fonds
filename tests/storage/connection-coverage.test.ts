import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createApplication,
  inProcessInvoker,
} from "../../src/application/operations.js";
import {
  emptyCounts,
  monthWindows,
  type Refresh,
  type RefreshProgress,
} from "../../src/application/refreshes.js";
import type { CollectionRange } from "../../src/domain/source-adapter.js";
import { seedRun, storedRow } from "../helpers/ledger-rows.js";
import {
  backends,
  type Harness,
  insertTransactionFixture,
  open,
} from "../helpers/storage-harness.js";

for (const backend of backends) {
  describe(`connection coverage: ${backend}`, () => {
    let db: Harness;
    const connectionId = "coverage";
    beforeEach(async () => {
      db = await open(backend);
      await db.ensureConnection({ id: connectionId, provider: "cal" });
      await seedRun(db, connectionId);
    });
    afterEach(() => db?.close());

    /** Records a refresh, then the window outcomes and finish it reached. */
    async function refresh(
      range: CollectionRange | null,
      windows: Record<string, RefreshProgress["status"] & string>,
      finish: RefreshProgress | null,
    ) {
      const id = randomUUID();
      const recorded: Refresh = {
        id,
        connectionId,
        trigger: "manual",
        status: "pending",
        skipReason: null,
        range,
        occurrence: null,
        scheduledAt: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        requiresAttention: false,
        counts: emptyCounts(),
        failureCodes: [],
        failureReason: null,
        missed: null,
        windows: range ? monthWindows(range) : [],
      };
      await db.admitRefresh(recorded, { operator: true, now: Date.now() });
      await db.withCollectionLock(connectionId, async (locked) => {
        await locked.updateRefresh(id, {
          status: "running",
          startedAt: "2040-06-30T00:00:00.000Z",
        });
        for (const [from, status] of Object.entries(windows)) {
          await locked.updateRefresh(id, {
            window: { from, status: status as "completed" },
          });
        }
        if (finish) {
          await locked.updateRefresh(id, finish);
        }
      });
    }

    it("separates months without purchases from months never requested", async () => {
      await insertTransactionFixture(db, [
        storedRow(connectionId, "june-a", { transactionDate: "2040-06-03" }),
        storedRow(connectionId, "june-b", { transactionDate: "2040-06-01" }),
        storedRow(connectionId, "april", { transactionDate: "2040-04-10" }),
        storedRow(connectionId, "undated", { transactionDate: null }),
        storedRow(connectionId, "retired", {
          transactionDate: "2040-05-01",
          supersededById: "june-a",
        }),
        storedRow(connectionId, "absent", {
          transactionDate: "2040-03-02",
          presence: "not_returned",
          sourceAbsence: {
            runId: "seed-run",
            capturedAt: "2040-07-02T12:00:00Z",
          },
        }),
        storedRow(connectionId, "removed", {
          transactionDate: "2040-02-02",
          presence: "removed",
        }),
      ]);
      await refresh(
        { from: "2040-02-01", to: "2040-05-31" },
        {
          "2040-05-01": "completed",
          "2040-04-01": "completed",
          "2040-03-01": "failed",
        },
        { status: "partial", finishedAt: "2040-07-01T00:00:00.000Z" },
      );
      await refresh(
        null,
        {},
        { status: "completed", finishedAt: "2040-07-02T00:00:00.000Z" },
      );
      await refresh(
        { from: "2040-03-01", to: "2040-03-31" },
        { "2040-03-01": "partial" },
        {
          status: "partial",
          finishedAt: "2040-07-03T00:00:00.000Z",
          requiresAttention: true,
        },
      );
      // Still running: its month is in progress.
      await refresh({ from: "2040-01-01", to: "2040-01-31" }, {}, null);

      const operations = inProcessInvoker(createApplication(db));
      expect(
        await operations.invoke("get_connection_coverage", { connectionId }),
      ).toEqual({
        coverage: {
          connectionId,
          transactionCount: 4,
          undatedCount: 1,
          earliestDate: "2040-04-10",
          latestDate: "2040-06-03",
          months: [
            {
              month: "2040-06",
              transactionCount: 2,
              backfill: "not_requested",
              backfilledAt: null,
            },
            {
              month: "2040-05",
              transactionCount: 0,
              backfill: "completed",
              backfilledAt: "2040-07-01T00:00:00.000Z",
            },
            {
              month: "2040-04",
              transactionCount: 1,
              backfill: "completed",
              backfilledAt: "2040-07-01T00:00:00.000Z",
            },
            {
              month: "2040-03",
              transactionCount: 0,
              backfill: "partial",
              backfilledAt: null,
            },
            {
              month: "2040-02",
              transactionCount: 0,
              backfill: "failed",
              backfilledAt: null,
            },
            {
              month: "2040-01",
              transactionCount: 0,
              backfill: "in_progress",
              backfilledAt: null,
            },
          ],
          monthsTruncated: false,
          recentRefreshCompletedAt: "2040-07-02T00:00:00.000Z",
          requiresAttention: true,
          failureCodes: [],
        },
      });
    });

    it("reports an empty connection and refuses an unknown one", async () => {
      const operations = inProcessInvoker(createApplication(db));
      expect(
        await operations.invoke("get_connection_coverage", { connectionId }),
      ).toEqual({
        coverage: {
          connectionId,
          transactionCount: 0,
          undatedCount: 0,
          earliestDate: null,
          latestDate: null,
          months: [],
          monthsTruncated: false,
          recentRefreshCompletedAt: null,
          requiresAttention: false,
          failureCodes: [],
        },
      });
      await expect(
        operations.invoke("get_connection_coverage", {
          connectionId: "missing",
        }),
      ).rejects.toThrow("not_found");
    });

    it("keeps the newest months of a long history and says so", async () => {
      await insertTransactionFixture(db, [
        storedRow(connectionId, "old", { transactionDate: "2010-01-15" }),
        storedRow(connectionId, "new", { transactionDate: "2040-06-15" }),
      ]);
      const operations = inProcessInvoker(createApplication(db));
      const { coverage } = (await operations.invoke("get_connection_coverage", {
        connectionId,
      })) as {
        coverage: {
          months: { month: string }[];
          monthsTruncated: boolean;
          earliestDate: string;
        };
      };
      expect(coverage.months).toHaveLength(240);
      expect(coverage.months[0]!.month).toBe("2040-06");
      expect(coverage.months.at(-1)!.month).toBe("2020-07");
      expect(coverage.monthsTruncated).toBe(true);
      expect(coverage.earliestDate).toBe("2010-01-15");
    });
  });
}
