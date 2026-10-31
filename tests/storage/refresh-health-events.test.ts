import "../helpers/run-history-differential.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyCounts } from "../../src/application/refreshes.js";
import {
  backends,
  type Harness,
  open,
  synthetic,
} from "../helpers/storage-harness.js";

const connectionId = "synthetic";

for (const backend of backends) {
  describe(`refresh health events: ${backend}`, () => {
    let db: Harness;
    beforeEach(async () => {
      db = await open(backend);
      await db.ensureConnection({ id: connectionId, provider: "cal" });
    });
    afterEach(async () => db?.close());

    /** A running refresh whose one run failed with `code`. */
    async function failedRun(
      id: string,
      code: "authentication_failed" | "network_error",
    ) {
      await db.admitRefresh(
        {
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
        },
        { operator: true, now: Date.now() },
      );
      await db.ingestRun(
        {
          runId: `${id}-run`,
          refreshId: id,
          connectionId,
          responses: [],
          failures: [{ accountKey: null, endpoint: "synthetic", code }],
        },
        synthetic,
      );
    }

    function finish(
      id: string,
      finishedAt: string,
      status: "failed" | "completed" = "failed",
    ) {
      return db.withCollectionLock(connectionId, (locked) =>
        locked.updateRefresh(id, { status, finishedAt }),
      );
    }

    async function healthEvents() {
      return (await db.listEvents()).filter((event) =>
        event.type.startsWith("refresh."),
      );
    }

    it("commits health events with the finished state or not at all, once", async () => {
      await failedRun("blocked", "authentication_failed");
      if (backend === "postgres") {
        await db.raw(
          "CREATE FUNCTION synthetic_fail_health() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic health rollback'; END $$",
        );
        await db.raw(
          "CREATE TRIGGER synthetic_fail_health BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION synthetic_fail_health()",
        );
      } else {
        await db.raw(
          "CREATE TRIGGER synthetic_fail_health BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'synthetic health rollback'); END",
        );
      }
      try {
        await expect(
          finish("blocked", "2040-01-01T10:00:00.000Z"),
        ).rejects.toThrow();
      } finally {
        await db.raw(
          `DROP TRIGGER synthetic_fail_health${backend === "postgres" ? " ON events" : ""}`,
        );
      }
      const peer = await db.peer();
      try {
        expect(await peer.getRefresh("blocked")).toMatchObject({
          status: "running",
          finishedAt: null,
        });
      } finally {
        await peer.close();
      }
      expect(await healthEvents()).toEqual([]);

      await finish("blocked", "2040-01-01T10:01:00.000Z");
      const health = {
        refreshId: "blocked",
        trigger: "manual",
        status: "failed",
        failureCodes: ["authentication_failed"],
        requiresAttention: true,
      };
      expect(await healthEvents()).toMatchObject([
        {
          type: "refresh.failed",
          connectionId,
          transactionId: null,
          runId: null,
          createdAt: "2040-01-01T10:01:00.000Z",
          actor: "system",
          before: null,
          after: health,
        },
        {
          type: "refresh.attention_required",
          createdAt: "2040-01-01T10:01:00.000Z",
          before: null,
          after: health,
        },
      ]);

      // A repeated terminal write finds the refresh already finished.
      await finish("blocked", "2040-01-01T10:02:00.000Z");
      expect(await healthEvents()).toHaveLength(2);
    });

    it("keeps the block through a retry short of completion and ends it when one completes", async () => {
      await failedRun("blocked", "authentication_failed");
      await finish("blocked", "2040-01-01T10:00:00.000Z");
      await failedRun("network", "network_error");
      await finish("network", "2040-01-01T11:00:00.000Z");
      const network = {
        refreshId: "network",
        trigger: "manual",
        status: "failed",
        failureCodes: ["network_error"],
        requiresAttention: true,
      };
      // A failed retry is a failure only: the block neither restarts nor ends.
      expect((await healthEvents()).slice(2)).toMatchObject([
        {
          type: "refresh.failed",
          before: {
            refreshId: "blocked",
            failureCodes: ["authentication_failed"],
            requiresAttention: true,
          },
          after: network,
        },
      ]);
      expect(await healthEvents()).toHaveLength(3);

      await failedRun("completed", "network_error");
      await finish("completed", "2040-01-01T12:00:00.000Z", "completed");
      expect((await healthEvents()).slice(3)).toEqual([
        expect.objectContaining({
          type: "refresh.recovered",
          before: network,
          after: {
            refreshId: "completed",
            trigger: "manual",
            status: "completed",
            failureCodes: [],
            requiresAttention: false,
          },
        }),
      ]);

      // Another failure without attention is a failure only.
      await failedRun("again", "network_error");
      await finish("again", "2040-01-01T13:00:00.000Z");
      expect(
        (await healthEvents()).slice(4).map((event) => event.type),
      ).toEqual(["refresh.failed"]);
    });
  });
}
