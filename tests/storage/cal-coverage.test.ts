import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CollectionScope } from "../../src/domain/records.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import { backends, type Harness, open } from "../helpers/storage-harness.js";

type SourceRow = Record<string, unknown>;

const fixture = JSON.parse(
  readFileSync(
    new URL("../providers/cal/fixtures/recent-01.json", import.meta.url),
    "utf8",
  ),
) as {
  result: { transactions: SourceRow[]; clearanceRequests: SourceRow[] };
};
const purchase = {
  ...fixture.result.transactions[0]!,
  trnPurchaseDate: "2040-06-20T12:00:00",
  debCrdDate: "2040-07-01T00:00:00",
};
const pending = fixture.result.clearanceRequests[0]!;
const connectionId = "synthetic-cal-coverage";

describe.each(backends)("%s actual CAL omission authority", (backend) => {
  let db: Harness;
  beforeEach(async () => {
    db = await open(backend);
    await db.ensureConnection({ id: connectionId, provider: "cal" });
  });
  afterEach(() => db.close());

  function capture(
    runId: string,
    capturedAt: string,
    transactions: SourceRow[],
    clearanceRequests: SourceRow[] = [],
    scope?: CollectionScope,
  ) {
    return db.ingestRun(
      {
        connectionId,
        runId,
        responses: [
          {
            accountKey: "synthetic-account",
            endpoint:
              scope?.kind === "history"
                ? "synthetic:cal/search"
                : "synthetic:cal/recent",
            capturedAt,
            responseText: JSON.stringify({
              statusCode: 1,
              result: { daysRange: 90, transactions, clearanceRequests },
            }),
            ...(scope ? { scope } : {}),
          },
        ],
      },
      calAdapter,
    );
  }

  it.each([false, true])(
    "preserves posted money omitted within the stated window after billing rollover (empty: %s)",
    async (empty) => {
      await capture("before-billing", "2040-06-30T12:00:00Z", [purchase]);
      const [before] = await db.listTransactions();
      const annotation = await db.editAnnotation({
        transactionId: before!.id,
        expectedVersion: 0,
        notes: "Retain source evidence",
      });
      const cursor = await db.latestEventId();
      const sibling = {
        ...purchase,
        trnIntId: "SYNTHETIC-OTHER",
        amountForDisplay: 10,
        amtBeforeConvAndIndex: 10,
      };
      expect(
        await capture(
          "after-billing",
          "2040-07-02T12:00:00Z",
          empty ? [] : [sibling],
        ),
      ).toMatchObject({ status: "completed", unlisted: 0 });
      expect(await db.getTransaction(before!.id)).toMatchObject({
        id: before!.id,
        presence: "seen",
        amountMinor: -8640,
        version: before!.version,
        annotation,
      });
      expect(
        (await db.getTransaction(before!.id))!.sourceAbsence,
      ).toBeUndefined();
      expect(
        (
          await db.listTransactionPage({ connectionId, limit: 100 })
        ).transactions.some((row) => row.id === before!.id),
      ).toBe(true);
      expect(await db.getTotals({ connectionId })).toMatchObject({
        includedCount: empty ? 1 : 2,
        totals: [{ currency: "ILS", amountMinor: empty ? -8640 : -9640 }],
      });
      expect(
        (await db.listEvents({ after: cursor })).some(
          (event) => event.type === "transaction.unlisted",
        ),
      ).toBe(false);
    },
  );

  it.each(["before", "after"] as const)(
    "does not infer absence for in-window history imported %s an empty recent capture",
    async (order) => {
      const history = () =>
        capture("history", "2040-06-30T12:00:00Z", [purchase], [], {
          kind: "history",
          from: "2040-06-01",
          to: "2040-06-30",
        });
      if (order === "before") {
        await history();
      }
      expect(
        await capture("recent-empty", "2040-07-02T12:00:00Z", []),
      ).toMatchObject({ status: "completed", unlisted: 0 });
      if (order === "after") {
        await history();
      }
      const [retained] = await db.listTransactions();
      expect(retained).toMatchObject({
        presence: "not_returned",
        amountMinor: -8640,
      });
      expect(
        (await db.listTransactionPage({ connectionId, limit: 100 }))
          .transactions,
      ).toMatchObject([{ id: retained!.id }]);
      expect(retained!.sourceAbsence).toBeUndefined();
      expect(await db.getTotals({ connectionId })).toMatchObject({
        includedCount: 1,
        totals: [{ currency: "ILS", amountMinor: -8640 }],
      });
    },
  );

  it.each([
    ["future", "2040-07-03T12:00:00", undefined],
    ["undated", "unknown", undefined],
    [
      "outside-request",
      "2040-06-11T12:00:00",
      { kind: "recent", from: "2040-06-20", to: "2040-07-02" },
    ],
  ] as const)(
    "does not absent a %s pending observation",
    async (_label, date, scope) => {
      await capture(
        "pending-baseline",
        "2040-06-30T12:00:00Z",
        [],
        [{ ...pending, trnPurchaseDate: date }],
        scope,
      );
      const [before] = await db.listTransactions();
      expect(before).toMatchObject({
        status: "pending",
        presence: "seen",
        amountMinor: -5875,
      });
      expect(
        await capture(
          "pending-omission",
          "2040-07-02T12:00:00Z",
          [],
          [],
          scope,
        ),
      ).toMatchObject({ status: "completed", unlisted: 0 });
      expect(await db.getTransaction(before!.id)).toEqual(before);
    },
  );

  it("applies same-origin pending disappearance while the posted partition remains populated", async () => {
    await capture("baseline", "2040-06-30T12:00:00Z", [purchase], [pending]);
    const pendingRow = (await db.listTransactions()).find(
      (row) => row.status === "pending",
    )!;
    expect(
      await capture("pending-empty", "2040-07-02T12:00:00Z", [purchase]),
    ).toMatchObject({
      status: "completed",
      unlisted: 1,
    });
    expect(await db.getTransaction(pendingRow.id)).toMatchObject({
      presence: "not_returned",
      sourceAbsence: { runId: "pending-empty" },
    });
    expect(
      (await db.listTransactionPage({ connectionId, limit: 100 })).transactions,
    ).toMatchObject([{ status: "posted", amountMinor: -8640 }]);
    expect(await db.getTotals({ connectionId })).toMatchObject({
      includedCount: 1,
      totals: [{ currency: "ILS", amountMinor: -8640 }],
    });
  });
});
