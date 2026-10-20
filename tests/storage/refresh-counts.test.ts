import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyCounts, type Refresh } from "../../src/application/refreshes.js";
import {
  backends,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

for (const backend of backends) {
  describe(`durable refresh counts: ${backend}`, () => {
    let db: Harness;
    const connectionId = "synthetic";
    beforeEach(async () => {
      db = await open(backend);
      await db.ensureConnection({ id: connectionId, provider: "cal" });
    });
    afterEach(async () => db?.close());

    async function refresh(id: string) {
      const value: Refresh = {
        id,
        connectionId,
        trigger: "manual",
        status: "running",
        skipReason: null,
        range: null,
        occurrence: null,
        scheduledAt: null,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        finishedAt: null,
        requiresAttention: false,
        counts: emptyCounts(),
        failureCodes: [],
        failureReason: null,
        missed: null,
        windows: [],
      };
      await db.admitRefresh(value, { operator: true, now: Date.now() });
    }

    function input(runId: string, refreshId: string) {
      return {
        runId,
        refreshId,
        connectionId,
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic",
            capturedAt: new Date().toISOString(),
            responseText: JSON.stringify([row("one")]),
          },
        ],
      };
    }

    it("commits counts with application exactly once and protects them from stale progress", async () => {
      await refresh("refresh");
      const first = input("first", "refresh");
      await db.ingestRun(first, synthetic);
      expect((await db.getRefresh("refresh"))!.counts).toEqual({
        ...emptyCounts(),
        captures: 1,
        observed: 1,
        created: 1,
      });
      await db.ingestRun(first, synthetic);
      await db.applyRun("first", synthetic);
      await db.withCollectionLock(connectionId, async (locked) => {
        await locked.updateRefresh("refresh", { counts: emptyCounts() });
      });
      expect((await db.getRefresh("refresh"))!.counts).toEqual({
        ...emptyCounts(),
        captures: 1,
        observed: 1,
        created: 1,
      });
      await db.ingestRun(input("second", "refresh"), synthetic);
      expect((await db.getRefresh("refresh"))!.counts).toEqual({
        ...emptyCounts(),
        captures: 2,
        observed: 2,
        created: 1,
        unchanged: 1,
        unchangedTransactions: 1,
      });
    });

    it("rolls counts back with failed ledger writes and attributes recovery to its executing refresh", async () => {
      await refresh("original");
      if (backend === "postgres") {
        await db.raw(
          "CREATE FUNCTION synthetic_fail_counts() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback'; END $$",
        );
        await db.raw(
          "CREATE TRIGGER synthetic_fail_counts BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION synthetic_fail_counts()",
        );
      } else {
        await db.raw(
          "CREATE TRIGGER synthetic_fail_counts BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
        );
      }
      try {
        await expect(
          db.ingestRun(input("recover", "original"), synthetic),
        ).rejects.toThrow();
        expect((await db.getRefresh("original"))!.counts).toEqual(
          emptyCounts(),
        );
        expect(await db.listTransactions()).toEqual([]);
      } finally {
        await db.raw(
          `DROP TRIGGER synthetic_fail_counts${backend === "postgres" ? " ON events" : ""}`,
        );
      }
      await db.withCollectionLock(connectionId, async (locked) => {
        await locked.updateRefresh("original", {
          status: "failed",
          finishedAt: new Date().toISOString(),
          counts: { ...emptyCounts(), failures: 1 },
        });
      });
      await refresh("executing");
      await db.withCollectionLock(connectionId, async (locked) => {
        await locked.recoverPendingRuns(synthetic, undefined, "executing");
        await locked.recoverPendingRuns(synthetic, undefined, "executing");
      });
      expect((await db.getRefresh("original"))!.counts).toEqual({
        ...emptyCounts(),
        failures: 1,
      });
      expect((await db.getRefresh("executing"))!.counts).toEqual({
        ...emptyCounts(),
        captures: 1,
        created: 1,
        observed: 1,
      });
      expect(await db.listTransactions()).toHaveLength(1);
    });
  });
}
