import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyCounts, type Refresh } from "../../src/application/refreshes.js";
import {
  presentRefresh,
  presentRefreshDetail,
  refreshOutputSchema,
} from "../../src/application/wire-output.js";
import type { CollectionFailure } from "../../src/domain/records.js";
import {
  backends,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

const connectionId = "synthetic-codes";

const providerCodes = [
  "network_error",
  "authentication_failed",
  "authentication_challenge",
  "rate_limited",
  "budget_exhausted",
  "invalid_response",
] as const satisfies readonly CollectionFailure["code"][];

const decode = (value: unknown) =>
  typeof value === "string" ? (JSON.parse(value) as unknown) : value;

function failureRun(
  runId: string,
  code: CollectionFailure["code"],
  extra: Partial<CollectionFailure> = {},
) {
  return {
    runId,
    refreshId: "refresh",
    connectionId,
    responses: [],
    failures: [{ accountKey: null, endpoint: "synthetic", code, ...extra }],
  };
}

function captureRun(
  runId: string,
  responseText = JSON.stringify([row("one")]),
  httpStatus?: number,
) {
  return {
    runId,
    refreshId: "refresh",
    connectionId,
    responses: [
      {
        accountKey: "account",
        endpoint: "synthetic",
        capturedAt: new Date().toISOString(),
        responseText,
        ...(httpStatus !== undefined && { httpStatus }),
      },
    ],
  };
}

for (const backend of backends) {
  describe(`refresh failure codes: ${backend}`, () => {
    let db: Harness;
    beforeEach(async () => {
      db = await open(backend);
      await db.ensureConnection({ id: connectionId, provider: "cal" });
    });
    afterEach(async () => db?.close());

    async function refresh(id = "refresh") {
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

    /** Finishes a refresh, as its execution does, so another can start. */
    async function finish(id: string, status: "completed" | "failed") {
      await db.withCollectionLock(connectionId, (locked) =>
        locked.updateRefresh(id, {
          status,
          finishedAt: new Date().toISOString(),
        }),
      );
    }

    async function storedCodes(id = "refresh") {
      const rows = await db.raw(
        "SELECT failure_codes_json AS codes FROM refreshes WHERE id = ?",
        [id],
      );
      return decode(rows[0]!.codes);
    }

    it.each(providerCodes)(
      "commits the code of a %s failure with its run and publishes it without the stop reason",
      async (code) => {
        await refresh();
        expect(
          await db.ingestRun(failureRun("failed", code), synthetic),
        ).toMatchObject({ status: "failed" });
        const peer = await db.peer();
        try {
          const stored = (await peer.getRefresh("refresh"))!;
          expect(stored).toMatchObject({
            status: "running",
            failureCodes: [code],
            counts: { ...emptyCounts(), failures: 1 },
          });
          const wire = refreshOutputSchema.parse(presentRefreshDetail(stored));
          expect(wire.failureCodes).toEqual([code]);
          expect(presentRefresh(stored)).not.toHaveProperty(
            "providerStopReason",
          );
        } finally {
          await peer.close();
        }
        expect(await storedCodes()).toEqual([code]);
      },
    );

    it("deduplicates and sorts the codes of counted failures, once per application", async () => {
      await refresh();
      const limited = failureRun("limited", "rate_limited");
      await db.ingestRun(limited, synthetic);
      await db.ingestRun(failureRun("network-1", "network_error"), synthetic);
      await db.ingestRun(captureRun("accepted"), synthetic);
      await db.ingestRun(failureRun("network-2", "network_error"), synthetic);
      await db.ingestRun(
        failureRun("challenge", "authentication_challenge"),
        synthetic,
      );
      expect(await db.ingestRun(limited, synthetic)).toMatchObject({
        replayed: true,
      });
      await db.applyRun("limited", synthetic);
      const expected = [
        "authentication_challenge",
        "network_error",
        "rate_limited",
      ];
      expect(await db.getRefresh("refresh")).toMatchObject({
        failureCodes: expected,
        counts: { failures: 4, captures: 1 },
      });
      expect(await storedCodes()).toEqual(expected);
    });

    it("records no code for completed runs and clears codes when the refresh completes", async () => {
      await refresh();
      await db.ingestRun(captureRun("first"), synthetic);
      await db.ingestRun(captureRun("second"), synthetic);
      expect(await db.getRefresh("refresh")).toMatchObject({
        failureCodes: [],
        counts: { failures: 0, captures: 2 },
      });
      await finish("refresh", "completed");
      await refresh("retried");
      await db.ingestRun(
        { ...failureRun("interrupted", "network_error"), refreshId: "retried" },
        synthetic,
      );
      expect(await storedCodes("retried")).toEqual(["network_error"]);
      await finish("retried", "completed");
      // Counts keep the retried failure; no code explains a completed refresh.
      expect(await db.getRefresh("retried")).toMatchObject({
        status: "completed",
        failureCodes: [],
        counts: { failures: 1 },
      });
      expect(await storedCodes("retried")).toEqual([]);
    });

    it("reports optional enrichment failures, which make their runs partial or failed", async () => {
      await refresh();
      const optional = {
        accountKey: "account",
        affectsCoverage: false,
      } as const;
      expect(
        await db.ingestRun(
          {
            ...captureRun("with-detail-failure"),
            failures: [
              {
                endpoint: "synthetic-detail",
                code: "network_error",
                ...optional,
              },
            ],
          },
          synthetic,
        ),
      ).toMatchObject({ status: "partial", created: 1 });
      expect(
        await db.ingestRun(
          failureRun("detail-only", "budget_exhausted", optional),
          synthetic,
        ),
      ).toMatchObject({ status: "failed" });
      expect(await db.getRefresh("refresh")).toMatchObject({
        failureCodes: ["budget_exhausted", "network_error"],
        counts: { failures: 2 },
      });
    });

    it("reports a capture rejected without a provider failure as an invalid response", async () => {
      await refresh();
      expect(
        await db.ingestRun(
          captureRun("unavailable", JSON.stringify([row("one")]), 503),
          synthetic,
        ),
      ).toMatchObject({ status: "failed" });
      expect(await db.getRefresh("refresh")).toMatchObject({
        failureCodes: ["invalid_response"],
        counts: { failures: 1 },
      });
      await finish("refresh", "failed");
      await refresh("invalid-row");
      expect(
        await db.ingestRun(
          {
            ...captureRun(
              "invalid-row",
              JSON.stringify([row("invalid", { amountMinor: 1.5 })]),
            ),
            refreshId: "invalid-row",
          },
          synthetic,
        ),
      ).toMatchObject({ status: "partial" });
      expect(await db.getRefresh("invalid-row")).toMatchObject({
        failureCodes: ["invalid_response"],
        counts: { failures: 1 },
      });
    });

    it("reports both causes of a run that rejects a capture beside a provider failure", async () => {
      await refresh();
      expect(
        await db.ingestRun(
          {
            ...captureRun("mixed", JSON.stringify([row("one")]), 503),
            failures: [
              { accountKey: null, endpoint: "synthetic", code: "rate_limited" },
            ],
          },
          synthetic,
        ),
      ).toMatchObject({ status: "failed" });
      expect(await db.getRefresh("refresh")).toMatchObject({
        failureCodes: ["invalid_response", "rate_limited"],
        counts: { failures: 1 },
      });
    });

    it("reports a reconciliation rejection by its own code alone", async () => {
      const rejecting = { ...synthetic, rejectEmptyRecentPosted: true };
      await refresh();
      await db.ingestRun(captureRun("baseline"), rejecting);
      expect(
        await db.ingestRun(captureRun("empty", "[]"), rejecting),
      ).toMatchObject({ status: "failed", failureCode: "implausible_empty" });
      await db.ingestRun(failureRun("network", "network_error"), rejecting);
      expect(await db.getRefresh("refresh")).toMatchObject({
        failureCodes: ["implausible_empty", "network_error"],
        counts: { failures: 2 },
      });
    });

    it("rolls a code back with its failed application, then attributes the recovered failure to the executing refresh", async () => {
      await refresh("original");
      if (backend === "postgres") {
        await db.raw(
          "CREATE FUNCTION synthetic_fail_codes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic code rollback'; END $$",
        );
        await db.raw(
          "CREATE TRIGGER synthetic_fail_codes BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION synthetic_fail_codes()",
        );
      } else {
        await db.raw(
          "CREATE TRIGGER synthetic_fail_codes BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'synthetic code rollback'); END",
        );
      }
      try {
        await expect(
          db.ingestRun(
            {
              ...failureRun("pending", "budget_exhausted"),
              refreshId: "original",
            },
            synthetic,
          ),
        ).rejects.toThrow();
        expect((await db.getRefresh("original"))!.failureCodes).toEqual([]);
      } finally {
        await db.raw(
          `DROP TRIGGER synthetic_fail_codes${backend === "postgres" ? " ON events" : ""}`,
        );
      }
      await finish("original", "failed");
      await refresh("executing");
      await db.withCollectionLock(connectionId, async (locked) => {
        await locked.recoverPendingRuns(synthetic, undefined, "executing");
        await locked.recoverPendingRuns(synthetic, undefined, "executing");
      });
      expect((await db.getRefresh("original"))!.failureCodes).toEqual([]);
      expect(await db.getRefresh("executing")).toMatchObject({
        failureCodes: ["budget_exhausted"],
        counts: { failures: 1 },
      });
      expect(await storedCodes("executing")).toEqual(["budget_exhausted"]);
    });
  });
}
